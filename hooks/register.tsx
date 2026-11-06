import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { PullRequest, ReviewRequest, Snapshot } from '../types'

// The desktop app may start the session without Homebrew's bin on PATH,
// so the bare name is tried first and the usual install spots after it.
const GH = ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh']
const FIELDS =
  'number,title,url,author,headRefName,isDraft,mergeable,mergeStateStatus,reviewDecision'
// PRs that ask the signed-in user (or a team they are on) for a review.
const REVIEW_ARGS = [
  'pr', 'list', '--state', 'open', '--limit', '50',
  '--search', 'review-requested:@me', '--json', 'number,title,url,author',
]
// The review line links this many PRs, then counts the rest.
const REVIEW_LINKS = 3

// Bump the tag when Snapshot's fields change: values stored under an older
// tag outlive a reload and are read as the initial value instead.
const snapshot = atom(
  { plugin: 'ready-prs', key: 'snapshot' } as const,
  { prs: [], reviews: [], checkedAt: 0, isChecking: false } as Snapshot,
  { shape: 'snapshot-2' },
)

/** The `readiness` option: which PRs count as ready to merge. */
export type Readiness = 'clean' | 'clean-or-unstable' | 'approved'
/** The `scope` option: every open PR, or only the signed-in user's own. */
export type Scope = 'all' | 'mine'

/**
 * Whether a pull request counts as ready to merge under `rule`.
 *
 * GitHub's mergeStateStatus already folds several things together:
 *   CLEAN     mergeable, checks green, branch protection satisfied
 *   UNSTABLE  mergeable, but some non-required check failed
 *   HAS_HOOKS mergeable, with pre-receive hooks (GitHub Enterprise)
 *   BLOCKED   a required review or required check is missing
 *   BEHIND    the base moved on and protection wants the branch updated
 * On a repo with no branch protection, CLEAN does not mean anyone approved,
 * which is what the `approved` rule is for.
 */
export function isReady(pr: PullRequest, rule: Readiness = 'clean'): boolean {
  if (pr.isDraft) return false
  switch (rule) {
    case 'clean-or-unstable':
      return ['CLEAN', 'UNSTABLE', 'HAS_HOOKS'].includes(pr.mergeState)
    case 'approved':
      return pr.mergeState === 'CLEAN' && pr.reviewDecision === 'APPROVED'
    default:
      return pr.mergeState === 'CLEAN'
  }
}

/** The gh arguments that list the open PRs the band is about. */
export function listArgs(scope: Scope): string[] {
  const args = ['pr', 'list', '--state', 'open', '--limit', '50', '--json', FIELDS]
  return scope === 'mine' ? [...args, '--author', '@me'] : args
}

type Settings = {
  rule: Readiness
  scope: Scope
  showReviews: boolean
  maxRows: number
  pollMs: number
}

/** Reads the mod's options, falling back to the defaults for anything odd. */
function settingsFrom(options: PluginOptions): Settings {
  const rule = options.readiness
  const rows = Number(options.maxRows)
  const minutes = Number(options.pollMinutes)

  return {
    rule: rule === 'clean-or-unstable' || rule === 'approved' ? rule : 'clean',
    scope: options.scope === 'mine' ? 'mine' : 'all',
    showReviews: options.reviews !== false,
    maxRows: Number.isFinite(rows) ? Math.min(10, Math.max(1, Math.round(rows))) : 3,
    pollMs: (Number.isFinite(minutes) && minutes >= 1 ? minutes : 2) * 60_000,
  }
}

type RawPr = {
  number: number
  title: string
  url: string
  author?: { login?: string } | null
  headRefName?: string
  isDraft?: boolean
  mergeable?: string
  mergeStateStatus?: string
  reviewDecision?: string | null
}

function toPr(raw: RawPr): PullRequest {
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    author: raw.author?.login ?? '',
    branch: raw.headRefName ?? '',
    isDraft: raw.isDraft ?? false,
    mergeable: raw.mergeable ?? 'UNKNOWN',
    mergeState: raw.mergeStateStatus ?? 'UNKNOWN',
    reviewDecision: raw.reviewDecision ?? '',
  }
}

function toReview(raw: RawPr): ReviewRequest {
  return { number: raw.number, title: raw.title, url: raw.url, author: raw.author?.login ?? '' }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** The status line entry: what is ready and what waits on you, or nothing. */
function statusText(ready: number, reviews: number): string | undefined {
  const parts = [
    ready > 0 ? `${plural(ready, 'PR', 'PRs')} ready to merge` : '',
    reviews > 0 ? `${reviews} to review` : '',
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : undefined
}

/** Runs gh with `args` in the session's folder and resolves its stdout. */
async function gh($: EngineInterface, args: string[]): Promise<string> {
  let lastError = 'gh was not found'
  for (const bin of GH) {
    let ran
    try {
      ran = await $.process.run([bin, ...args], { timeoutMs: 30_000 })
    } catch (err) {
      // Could not start this candidate: try the next spot.
      lastError = err instanceof Error ? err.message : String(err)
      continue
    }
    if (ran.exitCode !== 0) throw new Error(ran.stderr.trim() || `gh exited ${ran.exitCode}`)
    return ran.stdout
  }
  throw new Error(lastError)
}

// A module variable on purpose: a reload clears it, and a reload also
// cancels the timer whose refresh it guards.
let isRefreshing = false

async function refresh($: EngineInterface, settings: Settings): Promise<void> {
  if (isRefreshing) return
  isRefreshing = true
  try {
    await update($, snapshot, s => ({ ...s, isChecking: true }))
    try {
      // Both lists in parallel; the review search is skipped when the setting is off.
      const [listed, requested] = await Promise.all([
        gh($, listArgs(settings.scope)),
        settings.showReviews ? gh($, REVIEW_ARGS) : Promise.resolve('[]'),
      ])
      const prs = (JSON.parse(listed) as RawPr[]).map(toPr)
      const reviews = (JSON.parse(requested) as RawPr[]).map(toReview)
      const checkedAt = await $.clock.now()
      await update($, snapshot, () => ({ prs, reviews, checkedAt, isChecking: false }))
      const ready = prs.filter(pr => isReady(pr, settings.rule)).length
      $.ui.status(statusText(ready, reviews.length))
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      const checkedAt = await $.clock.now()
      // Keep the last good lists on screen; the error line says they are stale.
      await update($, snapshot, s => ({ ...s, checkedAt, isChecking: false, error }))
    }
  } finally {
    isRefreshing = false
  }
}

export const register: Register = (on, options) => {
  const settings = settingsFrom(options)
  const { rule, scope, showReviews, maxRows, pollMs } = settings
  const readyIn = (prs: PullRequest[]) => prs.filter(pr => isReady(pr, rule))

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ready-prs',
      description: 'Check GitHub again for pull requests ready to merge or waiting for your review',
    })
    // First check once the session is up, then on the configured interval.
    $.clock.after(1, () => void refresh($, settings))
    $.clock.every(pollMs, () => void refresh($, settings))

    return next(e)
  })

  on('command.run', { command: 'ready-prs' }, async $ => {
    await refresh($, settings)
    const { prs, reviews, error } = await read($, snapshot)
    if (error) return { text: `Could not list pull requests: ${error}` }
    const ready = readyIn(prs)
    const open = scope === 'mine' ? `${prs.length} of yours open` : `${prs.length} open`
    const lines = [
      ready.length === 0
        ? `No open pull requests are ready to merge (${open}).`
        : `Ready to merge: ${ready.map(pr => `#${pr.number} ${pr.title}`).join('; ')}`,
    ]
    if (showReviews) {
      lines.push(
        reviews.length === 0
          ? 'Nothing is waiting for your review.'
          : `Waiting for your review: ${reviews.map(r => `#${r.number} ${r.title}`).join('; ')}`,
      )
    }

    return { text: lines.join('\n') }
  })

  // The band just above the prompt. It draws nothing (next(e)) while nothing
  // is ready, nothing waits for your review and gh works, so it never takes a
  // row for nothing.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const s = await read($, snapshot)
    const ready = readyIn(s.prs)
    const waiting = s.prs.length - ready.length
    const reviews = showReviews ? s.reviews : []
    if (ready.length === 0 && reviews.length === 0 && !s.error) return next(e)

    const { Box, Text, Link } = $.ui.resolve(e)
    const shown = ready.slice(0, maxRows)
    const linked = reviews.slice(0, REVIEW_LINKS)

    return (
      <Box flexDirection="column">
        {ready.length > 0 && (
          <Text>
            <Text color="success">✓ {ready.length} ready to merge</Text>
            <Text dimColor>{waiting > 0 ? ` · ${waiting} not ready` : ''}</Text>
          </Text>
        )}
        {shown.map(pr => (
          <Text wrap="truncate-end">
            {'  '}
            <Link href={pr.url} label={`#${pr.number}`} /> {pr.title}{' '}
            <Text dimColor>
              {pr.branch}
              {pr.reviewDecision === 'APPROVED' ? ' · approved' : ''}
            </Text>
          </Text>
        ))}
        {ready.length > shown.length && (
          <Text dimColor>  +{ready.length - shown.length} more</Text>
        )}
        {reviews.length > 0 && (
          <Text wrap="truncate-end">
            <Text color="warning">◆ {reviews.length} waiting for your review</Text>
            {': '}
            {linked.flatMap((r, i) => [i > 0 ? ' ' : '', <Link href={r.url} label={`#${r.number}`} />])}
            <Text dimColor>{reviews.length > linked.length ? ` +${reviews.length - linked.length}` : ''}</Text>
          </Text>
        )}
        {s.error && (
          <Text color="error" wrap="truncate-end">
            ready-prs: gh failed: {s.error}
          </Text>
        )}
      </Box>
    )
  })
}
