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

function setUp(on: Parameters<Parameters<typeof test>[1]>[1], gh: { exitCode: number; stdout: string; stderr: string }) {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('command.register', () => ({ value: { command: 'ready-prs' } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', () => ({ value: { ...gh, isStdoutTruncated: false, isStderrTruncated: false } }))
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
  const clock = setUp(on, { exitCode: 1, stdout: '', stderr: 'not a git repository' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await clock.advance(5)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /gh failed/ }))?.text).toBe('ready-prs: gh failed: not a git repository')
  await ui.unmount()
})

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
