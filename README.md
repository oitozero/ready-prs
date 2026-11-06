# ready-prs

A [Claude Code](https://claude.com/claude-code) mod that shows your repository's open pull requests that are **ready to merge**, in a small band just above the prompt.

```text
  … conversation …

  ✓ 2 ready to merge · 3 not ready
    #42 Add dark mode  feat/dark-mode · approved
    #45 Bump eslint to 9  deps/eslint-9
 ╭──────────────────────────────────────────────────────────╮
 │ >                                                        │
 ╰──────────────────────────────────────────────────────────╯
```

The band appears only when something is ready, so it takes no space the rest of the time. It refreshes every two minutes, and `/ready-prs` checks right away.

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [What you'll see](#what-youll-see)
- [The `/ready-prs` command](#the-ready-prs-command)
- [Settings](#settings)
- [What "ready" means](#what-ready-means)
- [How it works](#how-it-works)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License](#license)

## Requirements

- **Claude Code** with mod support (function hooks).
- **GitHub CLI (`gh`)**, installed and signed in:

  ```bash
  gh auth login
  ```

  The mod looks for `gh` on your `PATH`, then at `/opt/homebrew/bin/gh` and `/usr/local/bin/gh`. That covers sessions the desktop app starts, which may not get Homebrew's folder on their `PATH`.
- A session started **inside a git repository with a GitHub remote**. The mod asks `gh` about whichever repository the session's folder belongs to.

## Install

At the prompt of a Claude Code terminal session:

```text
/plugin install ready-prs --marketplace oitozero/ready-prs
```

Answer `y` to add the marketplace, then pick a scope. User scope, the first choice, turns the mod on for every session. The mod starts working in the current session right away.

From a shell:

```bash
claude plugin install ready-prs --marketplace oitozero/ready-prs
```

In the desktop app, where `/plugin` doesn't run: click **+** next to the prompt box, then **Plugins**, then **Add marketplace** with `oitozero/ready-prs`, then **Add plugin**.

To remove it:

```bash
claude plugin uninstall ready-prs
```

## What you'll see

The band has four states.

**Some PRs are ready.** A summary line, then one row per ready PR: its number (a link to the PR on GitHub), its title, its branch, and whether it was approved.

```text
✓ 1 ready to merge · 2 not ready
  #12 Add dark mode  feat/dark-mode · approved
```

**Many PRs are ready.** The band lists the first three, which you can change with [`maxRows`](#settings), and counts the rest.

```text
✓ 5 ready to merge
  #31 Fix login redirect  fix/login-redirect · approved
  #32 Cache avatars  perf/avatars · approved
  #34 Add CSV export  feat/csv-export
  +2 more
```

**Nothing is ready.** There's no band at all. The prompt sits where it always does.

**`gh` failed.** One red line, so a broken setup never looks like "nothing to merge":

```text
ready-prs: gh failed: To get started with GitHub CLI, please run:  gh auth login
```

When a check fails, the band keeps showing the last list it got, so a network blip doesn't wipe it out.

The status line also shows `N PRs ready to merge` while any are ready. The band steps aside while Claude Code shows a feedback survey in the same spot.

## The `/ready-prs` command

`/ready-prs` asks GitHub right away instead of waiting for the next check, and answers in the transcript:

```text
> /ready-prs
Ready to merge: #42 Add dark mode; #45 Bump eslint to 9
```

```text
> /ready-prs
No open pull requests are ready to merge (4 open).
```

```text
> /ready-prs
Could not list pull requests: no git remotes found
```

## Settings

The mod has three settings. Change them from the config menu (`/config`, under **ready-prs**). Each change reloads the mod with the new values.

| Setting | Values | Default | What it does |
| --- | --- | --- | --- |
| `readiness` | `clean`, `clean-or-unstable`, `approved` | `clean` | Which PRs count as ready. See [What "ready" means](#what-ready-means). |
| `maxRows` | 1 to 10 | `3` | How many ready PRs the band lists before it says `+N more`. |
| `pollMinutes` | 1 or more | `2` | How often the mod asks GitHub again. |

You can also set them in `~/.claude/settings.json`, under `pluginConfigs`, keyed by the plugin and its marketplace:

```json
{
  "pluginConfigs": {
    "ready-prs@ready-prs": {
      "options": {
        "readiness": "approved",
        "maxRows": 5,
        "pollMinutes": 5
      }
    }
  }
}
```

The mod repairs values that don't make sense instead of failing. An unknown `readiness` falls back to `clean`, `maxRows` is held between 1 and 10, and a `pollMinutes` below 1 goes back to 2.

### Examples

**Your team requires approvals, but branch protection doesn't enforce them.** GitHub reports a PR with green checks as `CLEAN` even if nobody reviewed it. Use the `approved` rule so only reviewed PRs show up:

```json
{ "readiness": "approved" }
```

**Some of your checks are optional.** A failing optional check, such as a lint warning or a coverage report, makes GitHub report `UNSTABLE`, even though you can still merge. Count those PRs too:

```json
{ "readiness": "clean-or-unstable" }
```

**A busy repository, and a quieter band.** Show one row and check less often:

```json
{ "maxRows": 1, "pollMinutes": 10 }
```

## What "ready" means

Draft PRs never count. Beyond that, the mod reads GitHub's `mergeStateStatus` for each open PR. This is the same verdict GitHub uses for the merge button, and it already combines conflicts, checks and branch protection:

| `mergeStateStatus` | Meaning | `clean` | `clean-or-unstable` | `approved` |
| --- | --- | :-: | :-: | :-: |
| `CLEAN` | Mergeable, checks green, protection satisfied | ✓ | ✓ | ✓ if approved |
| `UNSTABLE` | Mergeable, but a non-required check failed | | ✓ | |
| `HAS_HOOKS` | Mergeable, with pre-receive hooks (GitHub Enterprise) | | ✓ | |
| `BLOCKED` | A required review or check is missing | | | |
| `BEHIND` | The base branch moved on and must be merged in first | | | |
| `DIRTY` | Merge conflicts | | | |
| `DRAFT` / `UNKNOWN` | Draft, or GitHub is still working it out | | | |

"Approved" means the PR's `reviewDecision` is `APPROVED`.

## How it works

The whole mod is one hooks module, [`hooks/register.tsx`](hooks/register.tsx):

1. **On `session.start`** it registers `/ready-prs`, checks once a second after startup, then sets a timer for every `pollMinutes`.
2. **Each check** runs

   ```bash
   gh pr list --state open --limit 50 \
     --json number,title,url,author,headRefName,isDraft,mergeable,mergeStateStatus,reviewDecision
   ```

   and stores the result in the session's state (`$.state`), which survives reloads. Two checks never run at once.
3. **A `ui.render` hook on `AbovePrompt`** draws the band from that stored result. Each time the state changes, the band redraws. When nothing is ready and `gh` works, the hook passes the spot back to Claude Code (`next(e)`), so the band takes no room.

The mod only reads. It never merges, comments on or changes a PR, and the one command it runs is `gh pr list`.

## Troubleshooting

| You see | Why | Fix |
| --- | --- | --- |
| `gh failed: gh was not found` | `gh` isn't installed, or it's somewhere the mod doesn't look | Install it (`brew install gh`), or start Claude Code from a shell where `gh` works |
| `gh failed: … gh auth login` | `gh` isn't signed in | Run `gh auth login` |
| `gh failed: not a git repository` | The session's folder isn't in a git repository | Start the session inside your repository |
| `gh failed: no git remotes found` | The repository has no GitHub remote | `git remote add origin <url>` |
| No band, but you expected one | No PR meets the `readiness` rule | Run `/ready-prs` to see how many are open, or try `clean-or-unstable` |
| A PR you just approved isn't listed yet | The next check hasn't run | Run `/ready-prs` |

## Development

Clone the repository and load the mod from the folder for one session:

```bash
git clone https://github.com/oitozero/ready-prs.git
cd ready-prs
claude --plugin-dir .
```

In an interactive session, saving a file reloads the mod.

Check the manifest and module, then run the tests:

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

The tests in [`tests/band.test.tsx`](tests/band.test.tsx) mock `gh` and the clock. They cover the band on the terminal, desktop, VS Code and mobile surfaces, the `+N more` count, the hidden state, a `gh` failure, and the `approved` and `clean-or-unstable` rules.

To type-check, run `tsc -p .`. The `tsconfig.json` extends the types Claude Code writes into `.claude-plugin/types/` once it has loaded the mod.

| File | What it is |
| --- | --- |
| `.claude-plugin/plugin.json` | Manifest: name, version, settings (`userConfig`) |
| `.claude-plugin/marketplace.json` | Makes this repository a marketplace, so it installs with one line |
| `hooks/hooks.json` | Points Claude Code at the hooks module |
| `hooks/register.tsx` | The mod: polling, the command, the band |
| `types/index.d.ts` | Types for the stored snapshot (`PluginState`) |
| `tests/band.test.tsx` | Tests |

## License

[MIT](LICENSE)
