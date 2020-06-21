"use strict";
import { applyPatch } from "diff";
import * as path from "path";
import { MessageType } from "../api/apiProvider";
import { Container, SessionContainer } from "../container";
import { Logger } from "../logger";
import {
	CheckPullRequestBranchPreconditionsRequest,
	CheckPullRequestBranchPreconditionsRequestType,
	CheckPullRequestBranchPreconditionsResponse,
	CheckPullRequestPreconditionsRequest,
	CheckPullRequestPreconditionsRequestType,
	CheckPullRequestPreconditionsResponse,
	CheckReviewPreconditionsRequest,
	CheckReviewPreconditionsRequestType,
	CheckReviewPreconditionsResponse,
	CreatePullRequestRequest,
	CreatePullRequestRequestType,
	CreatePullRequestResponse,
	DeleteReviewRequest,
	DeleteReviewRequestType,
	EndReviewRequest,
	EndReviewRequestType,
	EndReviewResponse,
	FetchReviewsRequest,
	FetchReviewsRequestType,
	FetchReviewsResponse,
	GetAllReviewContentsRequest,
	GetAllReviewContentsRequestType,
	GetAllReviewContentsResponse,
	GetReviewContentsLocalRequest,
	GetReviewContentsLocalRequestType,
	GetReviewContentsRequest,
	GetReviewContentsRequestType,
	GetReviewContentsResponse,
	GetReviewRequest,
	GetReviewRequestType,
	GetReviewResponse,
	PauseReviewRequest,
	PauseReviewRequestType,
	PauseReviewResponse,
	ReviewFileContents,
	ReviewRepoContents,
	StartReviewRequest,
	StartReviewRequestType,
	StartReviewResponse,
	UpdateReviewRequest,
	UpdateReviewRequestType,
	UpdateReviewResponse
} from "../protocol/agent.protocol";
import {
	CSReview,
	CSReviewChangeset,
	CSReviewCheckpoint,
	CSReviewDiffs,
	CSTransformedReviewChangeset,
	FileStatus
} from "../protocol/api.protocol";
import {
	getRemotePaths,
	ThirdPartyIssueProvider,
	ThirdPartyProviderSupportsPullRequests
} from "../providers/provider";
import { log, lsp, lspHandler, Strings } from "../system";
import { gate } from "../system/decorators/gate";
import { xfs } from "../xfs";
import { CachedEntityManagerBase, Id } from "./entityManager";

const uriRegexp = /codestream-diff:\/\/(\w+)\/(\w+)\/(\w+)\/(\w+)\/(.+)/;

@lsp
export class ReviewsManager extends CachedEntityManagerBase<CSReview> {
	static parseUri(
		uri: string
	): {
		reviewId: string;
		checkpoint: CSReviewCheckpoint;
		repoId: string;
		version: string;
		path: string;
	} {
		const match = uriRegexp.exec(uri);
		if (match == null) throw new Error(`URI ${uri} doesn't match codestream-diff format`);

		const [, reviewId, checkpoint, repoId, version, path] = match;

		return {
			reviewId,
			checkpoint: checkpoint === "undefined" ? undefined : parseInt(checkpoint, 10),
			repoId,
			version,
			path
		};
	}

	@lspHandler(FetchReviewsRequestType)
	async get(request?: FetchReviewsRequest): Promise<FetchReviewsResponse> {
		let reviews = await this.getAllCached();
		if (request != null) {
			if (request.reviewIds?.length ?? 0 > 0) {
				reviews = reviews.filter(r => request.reviewIds!.includes(r.id));
			}
		}

		return { reviews };
	}

	@lspHandler(GetReviewRequestType)
	@log()
	async getReview(request: GetReviewRequest): Promise<GetReviewResponse> {
		const review = await this.getById(request.reviewId);
		return { review };
	}

	async getDiffs(
		reviewId: string,
		repoId: string
	): Promise<{ checkpoint: CSReviewCheckpoint; diff: CSReviewDiffs }[]> {
		const diffsByRepo = await this.getAllDiffs(reviewId);
		return diffsByRepo[repoId];
	}

	@gate()
	async getAllDiffs(
		reviewId: string
	): Promise<{ [repoId: string]: { checkpoint: CSReviewCheckpoint; diff: CSReviewDiffs }[] }> {
		const diffs = new Map<
			string,
			{ [repoId: string]: { checkpoint: CSReviewCheckpoint; diff: CSReviewDiffs }[] }
		>();
		const responses = await this.session.api.fetchReviewCheckpointDiffs({ reviewId });
		if (responses && responses.length) {
			const result: {
				[repoId: string]: { checkpoint: CSReviewCheckpoint; diff: CSReviewDiffs }[];
			} = {};
			if (responses.length === 1 && responses[0].checkpoint === undefined) {
				const response = responses[0];
				result[response.repoId].push({ checkpoint: 0, diff: response.diffs });
			} else {
				for (const response of responses) {
					if (!result[response.repoId]) {
						result[response.repoId] = [];
					}
					result[response.repoId].push({ checkpoint: response.checkpoint, diff: response.diffs });
				}
			}
			diffs.set(reviewId, result);
		}

		const diffsByRepo = diffs.get(reviewId);
		if (!diffsByRepo) {
			throw new Error(`Cannot find diffs for review ${reviewId}`);
		}

		return diffsByRepo;
	}

	@lspHandler(GetReviewContentsLocalRequestType)
	@log()
	async getContentsLocal(
		request: GetReviewContentsLocalRequest
	): Promise<GetReviewContentsResponse> {
		const { git, reviews } = SessionContainer.instance();

		const repo = await git.getRepositoryById(request.repoId);
		if (!repo) {
			throw new Error(`Could not load repo with ID ${request.repoId}`);
		}

		const leftBasePath = path.join(repo.path, request.path);
		let leftContents;
		if (request.editingReviewId) {
			const latestContentsInReview = await reviews.getContents({
				repoId: request.repoId,
				path: request.path,
				reviewId: request.editingReviewId,
				checkpoint: undefined
			});
			leftContents = latestContentsInReview.right;
		}
		if (leftContents === undefined) {
			// either we're not amending a review, or the file was not included in any previous checkpoint
			leftContents = (await git.getFileContentForRevision(leftBasePath, request.baseSha)) || "";
		}

		let rightContents: string | undefined = "";
		switch (request.rightVersion) {
			case "head":
				const revision = await git.getFileCurrentRevision(leftBasePath);
				if (revision) {
					rightContents = await git.getFileContentForRevision(leftBasePath, revision);
				}
				break;
			case "staged":
				rightContents = await git.getFileContentForRevision(leftBasePath, "");
				break;
			case "saved":
				rightContents = await xfs.readText(leftBasePath);
				break;
		}

		return {
			left: Strings.normalizeFileContents(leftContents),
			right: Strings.normalizeFileContents(rightContents || "")
		};
	}

	@lspHandler(GetAllReviewContentsRequestType)
	@log()
	async getAllContents(
		request: GetAllReviewContentsRequest
	): Promise<GetAllReviewContentsResponse> {
		const { reviewId, checkpoint } = request;
		const review = await this.getById(reviewId);
		const repos: ReviewRepoContents[] = [];

		const changesetByRepo = new Map<string, CSReviewChangeset>();
		for (const changeset of review.reviewChangesets) {
			if (checkpoint === undefined || checkpoint === changeset.checkpoint) {
				changesetByRepo.set(changeset.repoId, changeset);
			}
		}

		for (const changeset of Array.from(changesetByRepo.values())) {
			const files: ReviewFileContents[] = [];
			const modifiedFiles =
				checkpoint !== undefined ? changeset.modifiedFilesInCheckpoint : changeset.modifiedFiles;
			for (const file of modifiedFiles) {
				const contents = await this.getContents({
					reviewId: review.id,
					repoId: changeset.repoId,
					checkpoint,
					path: file.file
				});
				files.push({
					leftPath: file.oldFile,
					rightPath: file.file,
					path: file.file,
					left: contents.left || "",
					right: contents.right || ""
				});
			}

			repos.push({
				repoId: changeset.repoId,
				files
			});
		}
		return { repos };
	}

	@lspHandler(GetReviewContentsRequestType)
	@log()
	async getContents(request: GetReviewContentsRequest): Promise<GetReviewContentsResponse> {
		const { reviewId, repoId, checkpoint, path } = request;
		if (checkpoint === undefined) {
			const review = await this.getById(request.reviewId);

			const containsFile = (c: CSReviewChangeset) =>
				c.repoId === request.repoId &&
				c.modifiedFilesInCheckpoint.find(mf => mf.file === request.path);
			const firstChangesetContainingFile = review.reviewChangesets.slice().find(containsFile);
			const latestChangesetContainingFile = review.reviewChangesets
				.slice()
				.reverse()
				.find(containsFile);

			if (!firstChangesetContainingFile || !latestChangesetContainingFile) {
				return { fileNotIncludedInReview: true };
			}

			const firstContents = await this.getContentsForCheckpoint(
				reviewId,
				repoId,
				firstChangesetContainingFile.checkpoint,
				path
			);
			const latestContents = await this.getContentsForCheckpoint(
				reviewId,
				repoId,
				latestChangesetContainingFile.checkpoint,
				path
			);

			return {
				left: firstContents.left,
				right: latestContents.right
			};
		} else if (checkpoint === 0) {
			return this.getContentsForCheckpoint(reviewId, repoId, 0, path);
		} else {
			const review = await this.getById(request.reviewId);
			const containsFilePriorCheckpoint = (c: CSReviewChangeset) =>
				c.repoId === request.repoId &&
				(c.checkpoint || 0) < checkpoint &&
				c.modifiedFilesInCheckpoint.find(mf => mf.file === request.path);
			const previousChangesetContainingFile = review.reviewChangesets
				.slice()
				.reverse()
				.find(containsFilePriorCheckpoint);

			const previousContents =
				previousChangesetContainingFile &&
				(
					await this.getContentsForCheckpoint(
						reviewId,
						repoId,
						previousChangesetContainingFile.checkpoint,
						path
					)
				).right;
			const atRequestedCheckpoint = await this.getContentsForCheckpoint(
				reviewId,
				repoId,
				checkpoint,
				path
			);
			return {
				left: previousContents || atRequestedCheckpoint.left,
				right: atRequestedCheckpoint.right
			};
		}
	}

	async getContentsForCheckpoint(
		reviewId: string,
		repoId: string,
		checkpoint: CSReviewCheckpoint,
		filePath: string
	): Promise<GetReviewContentsResponse> {
		const { git } = SessionContainer.instance();
		const review = await this.getById(reviewId);
		const changeset = review.reviewChangesets.find(
			c => c.repoId === repoId && c.checkpoint === checkpoint
		);
		if (!changeset) throw new Error(`Could not find changeset with repoId ${repoId}`);
		const fileInfo =
			changeset.modifiedFilesInCheckpoint.find(f => f.file === filePath) ||
			changeset.modifiedFiles.find(f => f.file === filePath);
		if (!fileInfo) throw new Error(`Could not find changeset file information for ${filePath}`);

		const diffs = await this.getDiffs(reviewId, repoId);
		const checkpointDiff = diffs.find(d => d.checkpoint === changeset.checkpoint)!;
		const diff = checkpointDiff.diff;
		const leftDiff = diff.leftDiffs.find(
			d => d.newFileName === fileInfo.oldFile || d.oldFileName === fileInfo.oldFile
		);
		const leftBaseRelativePath = (leftDiff && leftDiff.oldFileName) || fileInfo.oldFile;
		const rightDiff = diff.rightDiffs?.find(
			d => d.newFileName === fileInfo.file || d.oldFileName === fileInfo.file
		);
		const rightBaseRelativePath = (rightDiff && rightDiff.oldFileName) || fileInfo.file;

		const repo = await git.getRepositoryById(repoId);
		if (!repo) {
			throw new Error(`Could not load repo with ID ${repoId}`);
		}

		const leftBasePath = path.join(repo.path, leftBaseRelativePath);
		const rightBasePath = path.join(repo.path, rightBaseRelativePath);

		const isNewFile =
			fileInfo.statusX === FileStatus.added || fileInfo.statusX === FileStatus.untracked;
		const leftBaseContents = isNewFile
			? ""
			: (await git.getFileContentForRevision(leftBasePath, diff.leftBaseSha)) || "";
		const normalizedLeftBaseContents = Strings.normalizeFileContents(leftBaseContents);
		const leftContents =
			leftDiff !== undefined
				? applyPatch(normalizedLeftBaseContents, leftDiff)
				: normalizedLeftBaseContents;
		const rightBaseContents = isNewFile
			? ""
			: diff.leftBaseSha === diff.rightBaseSha
			? leftBaseContents
			: (await git.getFileContentForRevision(rightBasePath, diff.rightBaseSha)) || "";
		const normalizedRightBaseContents = Strings.normalizeFileContents(rightBaseContents);
		const rightContents =
			rightDiff !== undefined
				? applyPatch(normalizedRightBaseContents, rightDiff)
				: normalizedRightBaseContents;

		return {
			left: leftContents,
			right: rightContents
		};
	}

	@lspHandler(UpdateReviewRequestType)
	async update(request: UpdateReviewRequest): Promise<UpdateReviewResponse> {
		let isAmending = false;
		let reviewChangesets: CSTransformedReviewChangeset[] = [];
		if (request.repoChanges && request.repoChanges.length) {
			isAmending = true;
			const { posts } = SessionContainer.instance();
			reviewChangesets = (await Promise.all(
				request.repoChanges
					.map(rc => posts.buildChangeset(rc, request.id))
					.filter(_ => _ !== undefined)
			)) as CSTransformedReviewChangeset[];
			request.$addToSet = {
				reviewChangesets: reviewChangesets
			};
			delete request.repoChanges;
		}

		const updateResponse = await this.session.api.updateReview(request);
		const [review] = await this.resolve({
			type: MessageType.Reviews,
			data: [updateResponse.review]
		});

		if (isAmending && reviewChangesets.length) {
			this.trackReviewCheckpointCreation(request.id, reviewChangesets);
		}

		return { review };
	}

	@lspHandler(DeleteReviewRequestType)
	delete(request: DeleteReviewRequest) {
		return this.session.api.deleteReview(request);
	}

	@lspHandler(CheckReviewPreconditionsRequestType)
	async checkReviewPreconditions(
		request: CheckReviewPreconditionsRequest
	): Promise<CheckReviewPreconditionsResponse> {
		const { git, repositoryMappings } = SessionContainer.instance();
		const review = await this.getById(request.reviewId);
		const diffsByRepo = await this.getAllDiffs(review.id);
		for (const repoId in diffsByRepo) {
			const repo = await git.getRepositoryById(repoId);
			let repoPath;
			if (repo === undefined) {
				repoPath = await repositoryMappings.getByRepoId(repoId);
			} else {
				repoPath = repo.path;
			}
			if (repoPath == null) {
				return {
					success: false,
					error: {
						message: "The git repository for this review is not currently open in the IDE",
						type: "REPO_NOT_FOUND"
					}
				};
			}

			const diffs = diffsByRepo[repoId];
			for (const d of diffs) {
				let leftCommit = await git.getCommit(repoPath, d.diff.leftBaseSha);
				let rightCommit = await git.getCommit(repoPath, d.diff.rightBaseSha);
				if (leftCommit == null || rightCommit == null) {
					const didFetch = await git.fetchAllRemotes(repoPath);
					if (didFetch) {
						leftCommit = leftCommit || (await git.getCommit(repoPath, d.diff.leftBaseSha));
						rightCommit = rightCommit || (await git.getCommit(repoPath, d.diff.rightBaseSha));
					}
				}

				function missingCommitError(sha: string, author: string) {
					const shortSha = sha.substr(0, 8);
					return {
						success: false,
						error: {
							message: `A commit required to perform this review (${shortSha}, authored by ${author}) was not found in the local git repository. Fetch all remotes and try again.`,
							type: "COMMIT_NOT_FOUND"
						}
					};
				}

				if (leftCommit == null) {
					return missingCommitError(d.diff.leftBaseSha, d.diff.leftBaseAuthor);
				}
				if (rightCommit == null) {
					return missingCommitError(d.diff.rightBaseSha, d.diff.rightBaseAuthor);
				}
			}
		}

		return {
			success: true
		};
	}

	@lspHandler(CheckPullRequestBranchPreconditionsRequestType)
	async checkPullRequestBranchPreconditions(
		request: CheckPullRequestBranchPreconditionsRequest
	): Promise<CheckPullRequestBranchPreconditionsResponse> {
		const { git } = SessionContainer.instance();
		try {
			const review = await this.getById(request.reviewId);
			const repo = await git.getRepositoryById(review.reviewChangesets[0].repoId);
			if (!repo) {
				return {
					success: false,
					error: {
						type: "REPO_NOT_FOUND"
					}
				};
			}

			const { providerRegistry } = SessionContainer.instance();
			const user = await this.session.api.getMe();

			const gitRemotes = await repo!.getRemotes();
			let remoteUrl = "";
			let providerId = "";

			const providers = providerRegistry.getConnectedProviders(
				user.user,
				(p): p is ThirdPartyIssueProvider & ThirdPartyProviderSupportsPullRequests => {
					const thirdPartyIssueProvider = p as ThirdPartyIssueProvider;
					const name = thirdPartyIssueProvider.getConfig().name;
					return (
						name === "github" ||
						name === "gitlab" ||
						name === "github_enterprise" ||
						name === "gitlab_enterprise" ||
						name === "bitbucket"
					);
				}
			);

			const _projectsByRemotePath = new Map(gitRemotes.map(obj => [obj.path, obj]));
			for (const provider of providers) {
				const id = provider.getConfig().id;
				if (id !== request.providerId) continue;
				providerId = id;

				const remotePaths = await getRemotePaths(
					repo,
					provider.getIsMatchingRemotePredicate(),
					_projectsByRemotePath
				);
				if (remotePaths && remotePaths.length) {
					// just need any url here...
					remoteUrl = "https://example.com/" + remotePaths[0];
					const providerRepoInfo = await providerRegistry.getRepoInfo({
						providerId: providerId,
						remote: remoteUrl
					});
					if (providerRepoInfo) {
						if (providerRepoInfo.pullRequests && request.baseRefName && request.headRefName) {
							const existingPullRequest = providerRepoInfo.pullRequests.find(
								(_: any) =>
									_.baseRefName === request.baseRefName && _.headRefName === request.headRefName
							);
							if (existingPullRequest) {
								return {
									success: false,
									error: {
										type: "ALREADY_HAS_PULL_REQUEST",
										url: existingPullRequest.url
									}
								};
							}
						}
						// break out of providers loop
						break;
					}
				}
			}

			return {
				success: true,
				remote: remoteUrl,
				providerId: providerId
			};
		} catch (ex) {
			return {
				success: false,
				error: {
					message: ex.message,
					type: "UNKNOWN"
				}
			};
		}
	}

	@lspHandler(CheckPullRequestPreconditionsRequestType)
	async checkPullRequestPreconditions(
		request: CheckPullRequestPreconditionsRequest
	): Promise<CheckPullRequestPreconditionsResponse> {
		const { git, providerRegistry } = SessionContainer.instance();
		let warning = undefined;
		try {
			const review = await this.getById(request.reviewId);
			const repo = await git.getRepositoryById(review.reviewChangesets[0].repoId);

			if (!repo) {
				return {
					success: false,
					error: { type: "REPO_NOT_FOUND" }
				};
			}
			const branch = review.reviewChangesets[0].branch;
			const branches = await git.getBranches(repo!.path);
			const user = await this.session.api.getMe();

			const localCommits = await git.getLocalCommits(repo.path);
			if (localCommits && localCommits.length > 0) {
				return {
					success: false,
					error: { type: "HAS_LOCAL_COMMITS" }
				};
			}

			const localModifications = await git.getHasModifications(repo.path);
			if (localModifications) {
				return {
					success: false,
					error: { type: "HAS_LOCAL_MODIFICATIONS" }
				};
			}

			const gitRemotes = await repo!.getRemotes();
			let remoteUrl = "";
			let providerId = "";
			let defaultBranch: string | undefined = "";
			let isConnected = false;

			const providers = providerRegistry.getConnectedProviders(
				user.user,
				(p): p is ThirdPartyIssueProvider & ThirdPartyProviderSupportsPullRequests => {
					const thirdPartyIssueProvider = p as ThirdPartyIssueProvider;
					const name = thirdPartyIssueProvider.getConfig().name;
					return (
						name === "github" ||
						name === "gitlab" ||
						name === "github_enterprise" ||
						name === "gitlab_enterprise" ||
						name === "bitbucket"
					);
				}
			);
			let success = false;
			let foundOne = false;
			const _projectsByRemotePath = new Map(gitRemotes.map(obj => [obj.path, obj]));
			for (const provider of providers) {
				const remotePaths = await provider.getRemotePaths(repo, _projectsByRemotePath);
				if (remotePaths && remotePaths.length) {
					if (foundOne) {
						// if we've already found one matching remote,
						// and there's another that matches... stop processing
						// we will have to let the user choose which provider
						// they want to connect to
						providerId = "";
						isConnected = false;
						success = false;
						break;
					}
					providerId = provider.getConfig().id;
					isConnected = true;
					// just need any url here...
					remoteUrl = "https://example.com/" + remotePaths[0];
					const providerRepoInfo = await providerRegistry.getRepoInfo({
						providerId: providerId,
						remote: remoteUrl
					});
					if (providerRepoInfo) {
						if (providerRepoInfo.error) {
							return {
								success: false,
								error: providerRepoInfo.error
							};
						}

						defaultBranch = providerRepoInfo.defaultBranch;
						if (providerRepoInfo.pullRequests) {
							if (defaultBranch && branch) {
								const existingPullRequest = providerRepoInfo.pullRequests.find(
									(_: any) => _.baseRefName === defaultBranch && _.headRefName === branch
								);
								if (existingPullRequest) {
									warning = {
										type: "ALREADY_HAS_PULL_REQUEST",
										url: existingPullRequest.url
									};
								}
							}
						}
						success = true;
						foundOne = true;
					}
				}
			}
			if (!success) {
				// if we couldn't match a provider against a remote or there are multiple
				// we need the user to choose which provider.
				return {
					success: false,
					error: {
						type: "REQUIRES_PROVIDER"
					}
				};
			}

			return {
				success: success,
				remote: remoteUrl,
				providerId: providerId,
				pullRequestProvider: {
					isConnected: isConnected,
					defaultBranch: defaultBranch
				},
				review: {
					title: review.title,
					text: review.text
				},
				branch: branch,
				branches: branches!.branches,
				warning: warning
			};
		} catch (ex) {
			return {
				success: false,
				error: {
					message: ex.message,
					type: "UNKNOWN"
				}
			};
		}
	}

	@lspHandler(CreatePullRequestRequestType)
	async createPullRequest(request: CreatePullRequestRequest): Promise<CreatePullRequestResponse> {
		const { providerRegistry, users } = SessionContainer.instance();
		try {
			const review = await this.getById(request.reviewId);
			const approvers: { name: string }[] = [];
			if (review.approvedBy) {
				for (const userId of Object.keys(review.approvedBy)) {
					try {
						const user = await users.getById(userId);
						if (user) {
							approvers.push({ name: user.username });
						}
					} catch {}
				}
			}

			const data = {
				...request,
				metadata: {
					reviewPermalink: review.permalink,
					approvedAt: review.approvedAt,
					reviewers: approvers
				}
			};
			const result = await providerRegistry.createPullRequest(data);
			if (!result || result.error) {
				return {
					success: false,
					error: {
						message: result && result.error && result.error.message ? result.error.message : "",
						type: "PROVIDER"
					}
				};
			}

			const updateReviewResult = await this.update({
				id: review.id,
				pullRequestProviderId: request.providerId,
				pullRequestTitle: result.title,
				pullRequestUrl: result.url
			});

			return {
				success: true,
				url: result.url
			};
		} catch (ex) {
			Logger.error(ex, "createPullRequest");
			return {
				success: false,
				error: {
					message: ex.message,
					type: "UNKNOWN"
				}
			};
		}
	}

	@lspHandler(StartReviewRequestType)
	async startReview(request: StartReviewRequest): Promise<StartReviewResponse> {
		return {
			success: true
		};
	}

	@lspHandler(PauseReviewRequestType)
	async pauseReview(request: PauseReviewRequest): Promise<PauseReviewResponse> {
		return {
			success: true
		};
	}

	@lspHandler(EndReviewRequestType)
	async endReview(request: EndReviewRequest): Promise<EndReviewResponse> {
		return {
			success: true
		};
	}

	private trackReviewCheckpointCreation(
		reviewId: string,
		reviewChangesets: CSTransformedReviewChangeset[]
	) {
		process.nextTick(() => {
			try {
				const telemetry = Container.instance().telemetry;
				// get the highest number checkpoint by sorting by checkpoint descending
				const totalCheckpoints = reviewChangesets
					.map(_ => _!.checkpoint || 0)
					.sort((a, b) => (b || 0) - (a || 0))[0];
				const reviewProperties: {
					[key: string]: any;
				} = {
					"Review ID": reviewId,
					"Checkpoint Total": totalCheckpoints,
					"Files Added": reviewChangesets
						.map(_ => _.modifiedFiles.length)
						.reduce((acc, x) => acc + x),
					"Pushed Commits Added": reviewChangesets
						.map(_ => _.commits.filter(c => !c.localOnly).length)
						.reduce((acc, x) => acc + x),
					"Local Commits Added": reviewChangesets
						.map(_ => _.commits.filter(c => c.localOnly).length)
						.reduce((acc, x) => acc + x),
					"Staged Changes Added": reviewChangesets.some(_ => _.includeStaged),
					"Saved Changes Added": reviewChangesets.some(_ => _.includeSaved)
				};

				telemetry.track({
					eventName: "Checkpoint Added",
					properties: reviewProperties
				});
			} catch (ex) {
				Logger.error(ex);
			}
		});
	}
	/**
	 * Sets any undefined checkpoint properties to 0 and copy modifiedFiles to modifiedFilesInCheckpoint.
	 * Used with legacy reviews.
	 * @param  {CSReview} review
	 */
	private polyfillCheckpoints(review: CSReview) {
		if (review && review.reviewChangesets && review.reviewChangesets.length) {
			for (const rc of review.reviewChangesets) {
				if (rc.checkpoint === undefined) {
					rc.checkpoint = 0;
				}
				if (rc.modifiedFilesInCheckpoint === undefined) {
					rc.modifiedFilesInCheckpoint = rc.modifiedFiles;
				}
			}
		}
	}

	protected async loadCache() {
		const response = await this.session.api.fetchReviews({});
		response.reviews.forEach(this.polyfillCheckpoints);
		this.cache.reset(response.reviews);
	}

	async getById(id: Id, options?: { avoidCachingOnFetch?: boolean }): Promise<CSReview> {
		const review = await super.getById(id, options);
		this.polyfillCheckpoints(review);
		return review;
	}

	protected async fetchById(reviewId: Id): Promise<CSReview> {
		const response = await this.session.api.getReview({ reviewId });
		this.polyfillCheckpoints(response.review);
		return response.review;
	}

	protected getEntityName(): string {
		return "Review";
	}
}
