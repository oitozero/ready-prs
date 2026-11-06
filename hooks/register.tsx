import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { PullRequest, Snapshot } from '../types'

// The desktop app may start the session without Homebrew's bin on PATH,
// so the bare name is tried first and the usual install spots after it.
const GH = ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh']
const FIELDS =
  'number,title,url,author,headRefName,isDraft,mergeable,mergeStateStatus,reviewDecision'

// Bump the tag when Snapshot's fields change: values stored under an older
// tag outlive a reload and are read as the initial value instead.
const snapshot = atom(
  { plugin: 'ready-prs', key: 'snapshot' } as const,
  { prs: [], checkedAt: 0, isChecking: false } as Snapshot,
  { shape: 'snapshot-1' },
)

/** The `readiness` option: which PRs count as ready to merge. */
export type Readiness = 'clean' | 'clean-or-unstable' | 'approved'

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

type Settings = { rule: Readiness; maxRows: number; pollMs: number }

/** Reads the mod's options, falling back to the defaults for anything odd. */
function settingsFrom(options: PluginOptions): Settings {
  const rule = options.readiness
  const rows = Number(options.maxRows)
  const minutes = Number(options.pollMinutes)

  return {
    rule: rule === 'clean-or-unstable' || rule === 'approved' ? rule : 'clean',
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

async function refresh($: EngineInterface, rule: Readiness): Promise<void> {
  if (isRefreshing) return
  isRefreshing = true
  try {
    await update($, snapshot, s => ({ ...s, isChecking: true }))
    try {
      const out = await gh($, ['pr', 'list', '--state', 'open', '--limit', '50', '--json', FIELDS])
      const prs = (JSON.parse(out) as RawPr[]).map(toPr)
      const checkedAt = await $.clock.now()
      await update($, snapshot, () => ({ prs, checkedAt, isChecking: false }))
      const ready = prs.filter(pr => isReady(pr, rule)).length
      $.ui.status(ready > 0 ? `${ready} PR${ready === 1 ? '' : 's'} ready to merge` : undefined)
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      const checkedAt = await $.clock.now()
      // Keep the last good list on screen; the error line says it is stale.
      await update($, snapshot, s => ({ ...s, checkedAt, isChecking: false, error }))
    }
  } finally {
    isRefreshing = false
  }
}

export const register: Register = (on, options) => {
  const { rule, maxRows, pollMs } = settingsFrom(options)
  const readyIn = (prs: PullRequest[]) => prs.filter(pr => isReady(pr, rule))

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ready-prs',
      description: 'Check GitHub again for open pull requests ready to merge',
    })
    // First check once the session is up, then on the configured interval.
    $.clock.after(1, () => void refresh($, rule))
    $.clock.every(pollMs, () => void refresh($, rule))

    return next(e)
  })

  on('command.run', { command: 'ready-prs' }, async $ => {
    await refresh($, rule)
    const { prs, error } = await read($, snapshot)
    if (error) return { text: `Could not list pull requests: ${error}` }
    const ready = readyIn(prs)

    return {
      text:
        ready.length === 0
          ? `No open pull requests are ready to merge (${prs.length} open).`
          : `Ready to merge: ${ready.map(pr => `#${pr.number} ${pr.title}`).join('; ')}`,
    }
  })

  // The band just above the prompt. It draws nothing (next(e)) while no PR
  // is ready and gh works, so it never takes a row for nothing.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const s = await read($, snapshot)
    const ready = readyIn(s.prs)
    const waiting = s.prs.length - ready.length
    if (ready.length === 0 && !s.error) return next(e)

    const { Box, Text, Link } = $.ui.resolve(e)
    const shown = ready.slice(0, maxRows)

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
        {s.error && (
          <Text color="error" wrap="truncate-end">
            ready-prs: gh failed: {s.error}
          </Text>
        )}
      </Box>
    )
  })
}
