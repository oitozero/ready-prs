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

export type Snapshot = {
  prs: PullRequest[]
  /** Milliseconds since the epoch of the last finished check; 0 before the first. */
  checkedAt: number
  isChecking: boolean
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'ready-prs': { snapshot: Shaped<Snapshot> }
  }
}
