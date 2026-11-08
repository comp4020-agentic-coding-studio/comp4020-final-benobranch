# Your harness

This file is yours, and it arrives empty on purpose. The rules you hold the
agent to are part of what gets marked, so they should be rules you decided on.

Nothing about the template is recorded here. What the repo ships is explained
where it lives --- `fly.toml`, the `Dockerfile`, the CI workflow and
`spec/README.md` each say what they fix --- and the course website publishes the
[final project brief](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/assessments/final-project/)
(mirrored for offline reference in `ASSIGNMENT-SPEC.md`).
What the agent needs to carry from any of it is your call.

## Working across parallel sessions

This project is built solo but across several parallel Claude Code sessions
at once (one per subsystem, in worktrees), in the week between the week-9
crit and the deadline. [`docs/git-workflow.md`](docs/git-workflow.md) has the
rules that keep branches from drifting out of step with `main` under that
setup — worktree placement, merge-vs-squash (it affects whether
`PROCESS.md`'s cited commits stay valid), the pre-push check
(`.githooks/pre-push`) that refuses to push `main` without a recent, clean
`pnpm check` run, and [`issues/README.md`](issues/README.md)'s lightweight
`ANU-NNN` issue tracker (one markdown file per issue, since there's no
hosted tracker here). Read it before opening a second worktree.

Work on an issue through `pnpm run issue:start ANU-007` /
`pnpm run issue:finish ANU-007` (branch + worktree creation, and the
merge + worktree/branch cleanup, respectively) rather than doing the
equivalent `git` commands by hand — the scripts encode the sibling-worktree
placement, the `--no-ff` merge, and the `merge-base`-before-delete check that
rules 1, 2 and 9 require.

Deploy by hand with `pnpm run deploy`, never `flyctl deploy` directly — the
former re-checks the same marker the pre-push hook does before shelling out
to flyctl, which matters while the repo is private and a stray worktree's
manual deploy is the one path CI's own `check`-gated deploy job doesn't cover.

What belongs in *this* file, once the game's rules are settled, is the
standards derived from `README.md`'s definition of good — what the app must
never do, what every page must hold to, what a change must not break — not
the git mechanics, which stay in the referenced doc.

## Standards from `README.md`'s definition of good

The game's rules are settled now, so these hold for any change from here on:

- **A corridor cut has to be visible fast, not just correct.** `README.md`'s
  whole argument is that losing a suburb mid-game has to read as a real,
  immediate event, not a stat that quietly updated. `spec/realtime.test.ts`
  already enforces the mechanical floor (a lobby's state change reaches every
  other connection in that lobby within ~1s) — any change that touches
  ownership, capture or broadcast logic must keep that test green, and a new
  write path that changes shared state needs its own broadcast coverage, not
  an assumption that the existing tests happen to catch it.
- **No chat, friends list, matchmaking, skill rating, or any other social
  feature.** `README.md`'s "What I left out" section argues this
  specifically: a chat box in a game this adversarial becomes a channel for
  coordinating against whoever's losing, which undercuts the thing the game
  is testing (acting on your own, under pressure, against people you don't
  know). Don't add one "for convenience" on some later feature — if a future
  issue seems to need player-to-player communication, that's a sign the
  design has drifted from this README's argument, and the issue should say
  so explicitly rather than quietly adding the feature.
- **The map has to stay legible at phone width under real contention, not
  just empty.** `README.md`'s "What the tests cover" section is explicit that
  this is judged, not tested — no `spec/` assertion can check whether the map
  "reads clearly," so the agent has to hold itself to it directly: any UI
  change to the map, HUD, or unit/suburb rendering should be sanity-checked
  against a narrow viewport with several owned/contested suburbs on screen at
  once (not just one empty suburb), since that's the actual marking
  condition (two Chrome profiles, both acting, at least one on a narrow
  viewport) — per the cost-discipline rules below, this is a visual/code
  read, not a live headless-browser session.

## Cost discipline (temporary, while burning course credit)

Two things that quietly eat agent budget without being required by
`spec/README.md` or any issue's "done when":

- **No manual end-to-end/browser verification for now.** Don't drive headless
  Chrome (DevTools Protocol or otherwise) to manually re-prove a feature works
  before calling an issue done, the way `ANU-007` did. `pnpm check`
  (typecheck + `spec/*.test.ts` against the running app) is the bar for
  "done" until this is turned back on. This is a deliberate, temporary
  loosening for cost reasons, not a claim that e2e checks don't matter — note
  it in an issue (`type: harness`) and revisit in `PROCESS.md`/a reflection:
  in a real deployment this verification would run externally (CI, a
  separate QA pass) against its own budget, not an interactive session's.
- **Don't read every file under `issues/` at session start.** Read
  `issues/README.md` once if unfamiliar with the convention, then only the
  specific `ANU-NNN` issue(s) the session is actually working on (and
  anything it directly links to via `[[ANU-NNN]]`). Don't survey the whole
  backlog to "get oriented" — `ls issues/` plus the one issue's frontmatter
  (`status`, `title`) is enough to confirm it's the right one to pick up.

## Before opening a new issue for a `pnpm check` failure

[[ANU-032]] opened a new issue investigating two test failures from scratch,
duplicating [[ANU-012]] and [[ANU-026]], which had already diagnosed the
same two root causes days earlier in sibling worktrees. Before filing a new
issue for a failing test, `grep -l <test file or test name> issues/*.md` —
if it's already tracked, add a Resolution/update there instead of opening a
duplicate. This is cheaper than the full-backlog read the rule above warns
against, and `ls issues/` alone doesn't surface it.
