# Git & worktree workflow

Referenced from `CLAUDE.md`. This project is built solo but across several
parallel Claude Code sessions (one per subsystem — map/combat, real-time
transport, persistence/seasons, UI) in the ~week between the week-9 crit and
the deadline. The rules below exist so a branch never drifts silently out of
step with `main`, and so two sessions scaffolding related code don't produce
an unmergeable mess. Adapted from a stricter version used on a production
multi-dev codebase; the version here is cut down for one person and a
week-long build.

## Why this is stricter than "just commit to main"

Pushing to `main` **is** the deploy here — `checks.yml` deploys on every push
to `main` once the repo is public, and there's no staging environment. That
raises the cost of a broken `main` higher than it would be with a review
step in between, so the rules below substitute for a reviewer: they catch
drift and conflicts before they reach the one branch that ships.

## Rules

**1. One worktree, one branch, one PR, opened the same day.**
For an issue, `pnpm run issue:start ANU-007` does this for you — see rule 10.
Otherwise, create a worktree by hand with
`git worktree add ../comp4020-final-benobranch-worktrees/<branch> -b <branch> origin/main` —
as a sibling directory. This repo's `tsconfig.json` (`include: ["*.ts",
"spec", "scripts"]`) and `vitest.config.ts` (`include: ["spec/**/*.test.ts"]`)
are both non-recursive from the root, so they wouldn't reach into a nested
worktree directory anyway, and `.claude/` specifically is already excluded
from both `.gitignore` and `.dockerignore` — but a manual `flyctl deploy`
uploads everything *not* in `.dockerignore` as build context, so any other
nested location still risks shipping a worktree's contents to a deploy. A
sibling directory sidesteps the question entirely rather than relying on
remembering which nested path is covered by which ignore file. If using a
tool that manages worktrees for you, confirm where it places them before
trusting this.

Open a PR the same session you start the branch, even unfinished — an
unopened branch is invisible work. Draft PRs don't gate CI specially here
(`checks.yml` runs on every PR regardless of draft state, since there's no
staging deploy to protect), so "draft" is purely a visibility signal: mark it
ready when you intend to merge next.

**2. Merge commits, not squash.** `PROCESS.md` cites commit hashes, and
`pnpm check:evidence` confirms each one still resolves with
`git cat-file -e <sha>^{commit}`. Squash-merging a branch and then deleting it
risks those granular commits becoming unreachable (and eventually
garbage-collected), silently breaking citations written against them. Merge
with `git merge --no-ff` (or GitHub's "Create a merge commit") so the
original commits stay reachable from `main`.

**3. No stacking past one level.** If branch B needs something from branch A
before A merges, that's a stack — keep it to one level, merge A the moment
it's ready, then immediately rebase B onto `main`. Don't let a third branch
stack on an already-stacked one.

**4. Check for an existing branch before scaffolding a new subsystem.** Two
sessions independently bootstrapping the same new piece (say, both adding
the WebSocket layer with different message shapes) produce add/add conflicts
on the foundational files themselves — not a mergeable diff, two incompatible
decisions. Before starting work that creates a new top-level module, run
`git branch -r` and check open PRs first.

**5. Before any push to `main`, run `pnpm check` against your own working
tree.** `scripts/record-check-ok.mjs` (wired into `pnpm check`) stamps a
per-worktree marker recording the commit and whether the tree was clean; the
`.githooks/pre-push` hook refuses a push to `main` if that marker is missing,
stale (>4h), dirty, or doesn't match the commit actually being pushed. Note
what this guards and what it doesn't: once the repo is public, CI's own
`deploy` job already `needs: check`, so a red build is stopped there too —
this hook just catches it sooner, locally. What it's the *only* guard for is
a manual `flyctl deploy` run while the repo is still private: run
`pnpm run deploy` (checks the same marker, then shells out to flyctl) rather
than `flyctl deploy` directly. Issue files (`issues/*.md`) are exempt from
this marker check — see rule 10.

**6. Local ports and data don't collide across worktrees.** Running two
sessions' dev servers at once needs distinct `PORT`/`APP_URL` per worktree
(e.g. 8080 for `main`, 8081+ per feature worktree) and a distinct SQLite path
if testing persistence locally — `pnpm check` always targets `APP_URL`
(default `http://localhost:8080`), so pointing it at the wrong server passes
checks against the wrong app.

**7. Periodic sweep.** Every so often, or whenever picking this project back
up after a break:

```bash
git fetch origin --prune
git branch -r --no-merged origin/main   # every remote branch not yet in main
```

For each, confirm a PR exists (`gh pr list --head <branch>`) and check how far
behind it's fallen (`git rev-list --left-right --count origin/main...origin/<branch>`).
A branch with commits and no PR is exactly what this rule exists to catch.

**8. Don't trust `git merge-tree <base> <A> <B>` (3-arg form) as a conflict
predictor** — it can report zero conflicts where a real merge produces some.
To check mergeability, do an actual test merge and abort it:
`git merge --no-commit --no-ff origin/<branch>` then `git merge --abort`.

**9. `git branch -d`/`-D` safety.** The safe-delete check compares against
whatever `HEAD` the *current* worktree happens to be on, not `origin/main` —
in a multi-worktree setup that's often unrelated, giving false "not fully
merged" warnings. Before force-deleting, confirm independently with
`git merge-base --is-ancestor <branch> origin/main`, then `-D` with
confidence.

**10. Issue tracking.** [`issues/README.md`](../issues/README.md) has the
full convention; the short version:
- Branch names: `ANU-007-name_of_the_issue` — `pnpm run issue:start ANU-007`
  generates this from the issue's title and creates the branch + sibling
  worktree (rule 1) in one step, so the name is never hand-typed
- `pnpm run issue:finish ANU-007` (from `main`) merges that branch with
  `--no-ff` (rule 2), then removes the worktree and deletes the branch — but
  only once `git merge-base --is-ancestor` independently confirms the merge
  landed, per rule 9's warning about `git branch -d`'s own check
- Commit messages lead with `ANU-007: ...`; PR titles prefix with `ANU-007: `
  (a configured GitHub autolink turns `ANU-007` into a link to its file on
  GitHub)
- Open issues from the `main` checkout, not a worktree, since numbering is
  allocated by scanning `issues/` and a worktree that hasn't pushed yet is
  invisible to that scan
- `pnpm check:issues` (part of `pnpm check`) validates the directory; a push
  that touches only `issues/*.md` is exempt from rule 5's marker check

## What this buys, relative to the brief

`PROCESS.md` is 50% of the mark and is read against the commit history.
Keeping branches short-lived, merged (not squashed), and always backed by an
open PR means the commit history itself is legible evidence of how the work
happened — not just an assertion in prose.
