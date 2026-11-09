export type PullRequest = {
  number: number
  title: string
  url: string
  author: string
  branch: string
  isDraft: boolean
  /** GitHub's mergeable: MERGEABLE, CONFLICTING or UNKNOWN (still computing). */
  mergeable: string
  /** GitHub's mergeStateStatus: CLEAN, BLOCKED, BEHIND, DIRTY, UNSTABLE, HAS_HOOKS, DRAFT, UNKNOWN. */
  mergeState: string
  /** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or '' when no review is required. */
  reviewDecision: string
}

/** An open PR that asks the signed-in gh user for a review. */
export type ReviewRequest = {
  number: number
  title: string
  url: string
  author: string
}

export type Snapshot = {
  prs: PullRequest[]
  /** PRs waiting for the signed-in user's review; [] when the `reviews` setting is off. */
  reviews: ReviewRequest[]
  /** Milliseconds since the epoch of the last finished check; 0 before the first. */
  checkedAt: number
  isChecking: boolean
  /** True when the session's folder has no GitHub repository to ask about; the band stays hidden. */
  noRepo: boolean
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'ready-prs': { snapshot: Shaped<Snapshot> }
  }
}
