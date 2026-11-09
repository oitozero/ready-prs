import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'ready-prs',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

const pr = (number: number, title: string, mergeStateStatus: string, extra = {}) => ({
  number, title, url: `https://github.com/o/r/pull/${number}`,
  author: { login: 'sam' }, headRefName: `feat/${number}`, isDraft: false,
  mergeable: 'MERGEABLE', mergeStateStatus, reviewDecision: 'APPROVED', ...extra,
})

type Gh = { exitCode: number; stdout: string; stderr: string }
type TestBody = Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>

/**
 * Stands for the engine and gh. `reviews` is what the review-request search
 * prints; every gh call's arguments land in `calls`.
 */
function setUp(on: Parameters<TestBody>[1], gh: Gh, { reviews = '[]', calls = [] as string[][] } = {}) {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('command.register', () => ({ value: { command: 'ready-prs' } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => {
    calls.push([...e.argv])
    const answer = e.argv.includes('review-requested:@me') && gh.exitCode === 0 ? { ...gh, stdout: reviews } : gh
    return { value: { ...answer, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // Stands for the engine: what the band shows when the mod draws nothing.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  return clock
}

test('the band lists the ready PRs above the prompt, on every surface', async ($, on) => {
  // Synthetic gh output: one ready, one blocked on review, one draft.
  const stdout = JSON.stringify([
    pr(12, 'Add dark mode', 'CLEAN'),
    pr(13, 'Rework the settings page', 'BLOCKED', { reviewDecision: 'REVIEW_REQUIRED' }),
    pr(14, 'WIP footer', 'DRAFT', { isDraft: true }),
  ])
  const clock = setUp(on, { exitCode: 0, stdout, stderr: '' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(5)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /ready to merge/ }))?.text).toContain('1 ready to merge · 2 not ready')
    expect((await ui.find({ type: 'Text', text: /Add dark mode/ }))?.text).toContain('#12')
    expect(await ui.find({ type: 'Text', text: /Rework the settings page/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('more than three ready PRs end in a count', async ($, on) => {
  const stdout = JSON.stringify([1, 2, 3, 4, 5].map(n => pr(n, `PR ${n}`, 'CLEAN')))
  const clock = setUp(on, { exitCode: 0, stdout, stderr: '' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(5)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /more/ }))?.text).toContain('+2 more')
  expect(await ui.find({ type: 'Text', text: /PR 4/ })).toBeUndefined()
  await ui.unmount()
})

test('with nothing ready the band is left to the engine', async ($, on) => {
  const clock = setUp(on, { exitCode: 0, stdout: '[]', stderr: '' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(5)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})

test('a gh failure shows as one line', async ($, on) => {
  const signedOut = 'To get started with GitHub CLI, please run:  gh auth login'
  const clock = setUp(on, { exitCode: 4, stdout: '', stderr: signedOut })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(5)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /gh failed/ }))?.text).toBe(`ready-prs: gh failed: ${signedOut}`)
  await ui.unmount()
})

// gh's exact words, captured from gh 2.x in each kind of folder.
const noRepoErrors = {
  'no git repository': 'failed to run git: fatal: not a git repository (or any of the parent directories): .git',
  'a repository with no remote': 'no git remotes found',
  'only non-GitHub remotes':
    'none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`',
}

for (const [where, stderr] of Object.entries(noRepoErrors)) {
  test(`in a folder with ${where}, the band stays hidden and shows no error`, async ($, on) => {
    const clock = setUp(on, { exitCode: 1, stdout: '', stderr })
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await clock.advance(5)

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...BAND, surface })
      expect(await ui.find({ type: 'Text', text: /gh failed/ })).toBeUndefined()
      expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
      await ui.unmount()
    }
  })
}

test('the approved rule leaves out a clean PR nobody approved', { options: { readiness: 'approved' } }, async ($, on) => {
  const stdout = JSON.stringify([
    pr(20, 'Approved change', 'CLEAN'),
    pr(21, 'Unreviewed change', 'CLEAN', { reviewDecision: '' }),
  ])
  const clock = setUp(on, { exitCode: 0, stdout, stderr: '' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(5)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /ready to merge/ }))?.text).toContain('1 ready to merge · 1 not ready')
  expect(await ui.find({ type: 'Text', text: /Unreviewed change/ })).toBeUndefined()
  await ui.unmount()
})

test('clean-or-unstable counts a PR whose only failure is an optional check', { options: { readiness: 'clean-or-unstable', maxRows: 1 } }, async ($, on) => {
  const stdout = JSON.stringify([pr(30, 'Green', 'CLEAN'), pr(31, 'Lint warning', 'UNSTABLE')])
  const clock = setUp(on, { exitCode: 0, stdout, stderr: '' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(5)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /ready to merge/ }))?.text).toContain('2 ready to merge')
  expect((await ui.find({ type: 'Text', text: /more/ }))?.text).toContain('+1 more')
  await ui.unmount()
})

const reviewRequests = JSON.stringify([51, 53, 54, 57].map(n => ({
  number: n, title: `Review me ${n}`, url: `https://github.com/o/r/pull/${n}`, author: { login: 'kim' },
})))

test('the mine scope asks gh only for your own PRs', { options: { scope: 'mine' } }, async ($, on) => {
  const calls: string[][] = []
  const clock = setUp(on, { exitCode: 0, stdout: '[]', stderr: '' }, { calls })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(5)

  const list = calls.find(argv => !argv.includes('review-requested:@me'))
  expect(list?.join(' ')).toContain('--author @me')
})

test('the all scope lists every open PR', async ($, on) => {
  const calls: string[][] = []
  const clock = setUp(on, { exitCode: 0, stdout: '[]', stderr: '' }, { calls })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(5)

  expect(calls.some(argv => argv.includes('--author'))).toBe(false)
})

test('review requests show the band even when nothing is ready', async ($, on) => {
  const clock = setUp(on, { exitCode: 0, stdout: '[]', stderr: '' }, { reviews: reviewRequests })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(5)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    const line = (await ui.find({ type: 'Text', text: /waiting for your review/ }))?.text
    expect(line).toContain('4 waiting for your review')
    expect(line).toContain('#51')
    expect(line).toContain('+1')
    expect(line).not.toContain('#57')
    expect(await ui.find({ type: 'Text', text: /ready to merge/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('review requests sit under the ready PRs', async ($, on) => {
  const stdout = JSON.stringify([pr(12, 'Add dark mode', 'CLEAN')])
  const clock = setUp(on, { exitCode: 0, stdout, stderr: '' }, { reviews: reviewRequests })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(5)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /ready to merge/ }))?.text).toContain('1 ready to merge')
  expect((await ui.find({ type: 'Text', text: /waiting for your review/ }))?.text).toContain('4 waiting for your review')
  await ui.unmount()
})

test('with reviews off, review requests are not asked for or shown', { options: { reviews: false } }, async ($, on) => {
  const calls: string[][] = []
  const clock = setUp(on, { exitCode: 0, stdout: '[]', stderr: '' }, { reviews: reviewRequests, calls })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(5)

  expect(calls.some(argv => argv.includes('review-requested:@me'))).toBe(false)
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('engine')
  await ui.unmount()
})
