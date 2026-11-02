# Issue tracking

Lightweight stand-in for Linear/GitHub Issues: one markdown file per issue,
committed to the repo, so the tracker lives in the same history `PROCESS.md`
already cites. `ls issues/` is the index — there's no separate index file to
keep in sync (it would conflict constantly across parallel worktrees anyway).

A GitHub autolink is wired on this repo: `ANU-007` typed anywhere on GitHub
(commit messages, PR titles/bodies, issue text) renders as a link straight to
`issues/ANU-007.md` on `main`.

## Opening an issue

1. **Do it from the `main` checkout, not a feature worktree**, and commit it
   there before branching off it. Numbers are allocated by scanning
   `issues/` for the highest existing one — a worktree that hasn't pushed yet
   is invisible to that scan, so opening from a worktree risks two issues
   claiming the same number.
2. Pick the next number: `ls issues/*.md | sort | tail -1` (or just count —
   `pnpm check:issues` will catch a collision either way).
3. Copy the template below into `issues/ANU-<NNN>.md` (zero-padded to 3
   digits, numeric only — the autolink's URL template requires this exact
   shape, no slugs).
4. Commit it directly to `main` (`git commit -m "ANU-007: open — <title>"`).
   Opening an issue is exempt from the pre-push check-passing gate (see
   `.githooks/pre-push`) — it doesn't touch app code, so it shouldn't need a
   green `pnpm check` to record.

## Template

```markdown
---
id: ANU-007
title: One-line summary
status: open
type: feature
opened: 2026-11-03
---

## Why

What this is for, and why it matters to the game's definition of good.

## Done when

Concrete, checkable completion condition.

## Resolution

(Add once `status` moves to `done`/`dropped`.) What actually fixed it, and a
link to the commit/PR. For a `bug` or `harness` issue this is the point: a
sentence that just says "fixed" is not resolution, a sentence that says what
was wrong and what changed is.

## Notes

Links to commits, PRs, or other issues (`[[ANU-003]]`-style references).
```

## When something goes wrong

Open an issue for it as soon as you notice, even if the fix is two minutes
away — the point is the written trail, not the ceremony. This applies beyond
app bugs: a harness rule that turned out wrong, a hook that didn't catch what
it was supposed to, an agent confidently doing the wrong thing, a design
decision that didn't survive contact with testing. If it cost you time to
find or understand, it's worth a file.

- **`type: bug`** — something in the *app* didn't work as intended.
- **`type: harness`** — something in the *process* (a `CLAUDE.md` rule, a
  hook, a `spec/` check, an agent's approach) was wrong, and the fix changed
  that harness rather than just the one place it went wrong. This is the
  type the brief is pointing at with "corrections belong in the harness":
  the strongest account shows the fix landing here — a new rule, a tightened
  check, a hook that now catches the thing it missed — not a silent retry.

Close it in the same commit/PR that fixes the underlying thing, with
`status: done` and a filled-in `Resolution` section. `PROCESS.md` can then
cite the issue (`[[ANU-003]]`) alongside the commit that closed it, which is
exactly the "legibility of process" the marker reads `PROCESS.md` against the
commit history for.

## Fields

- `id` — must match `ANU-\d{3}` and the filename exactly.
- `status` — one of `open`, `in-progress`, `done`, `dropped`. Updated in the
  PR that does the work — e.g. the PR that closes it sets `status: done` in
  the same diff, since there's no bot to flip it on merge the way Linear's
  GitHub integration did. **Never delete a closed issue file** — a `done` or
  `dropped` issue is still process evidence.
- `type` — `feature`, `bug`, or `harness`. `harness` is for the issues most
  worth citing in `PROCESS.md`: a case where the agent got something wrong
  and the fix landed as a rule in `CLAUDE.md` or a check in `spec/`, not just
  a retry. The brief rewards exactly this ("corrections belong in the
  harness").
- `opened` — ISO date.

## Referencing issues

- Branch names: `ANU-007-name_of_the_issue` (the id, then the title
  lowercased with runs of non-alphanumerics collapsed to underscores —
  `pnpm run issue:start` generates this for you, so you never have to
  hand-type it)
- Commit messages: lead with `ANU-007: <what this commit does>`
- PR titles: prefix with `ANU-007: `

`pnpm check:issues` (part of `pnpm check`) validates every file in this
directory: unique ids, id/filename match, a valid `status`, and well-formed
frontmatter. It does not live in `spec/` — `spec/` is the app's promises to
its users, and the issue tracker is process scaffolding, not a user-facing
claim.

## Starting and finishing work on an issue

One issue, one branch, one worktree (docs/git-workflow.md rule 1) — these two
scripts automate the parts that are easy to get wrong by hand:

```bash
pnpm run issue:start ANU-007    # creates ANU-007-<slug>, a sibling worktree,
                                 # flips status to in-progress as its first commit
#  ... do the work in that worktree, commit as normal ...
#  ... before finishing, edit issues/ANU-007.md: status: done + a Resolution ...

pnpm run issue:finish ANU-007   # from the main checkout: merges with --no-ff,
                                 # then removes the worktree and deletes the branch
```

`issue:start` resolves the branch name from the issue's own title, so a typo
in a hand-typed branch name can't drift from what the issue file says.
`issue:finish` only deletes the branch once `git merge-base --is-ancestor`
independently confirms it actually landed on `main` first (docs/git-workflow.md
rule 9) — it does not trust `git branch -d`'s own check, which compares
against the branch's upstream rather than local `HEAD` and can be wrong in a
multi-worktree setup ([[ANU-004]]). If the merge conflicts, it stops and
leaves the conflict for you to resolve normally; `issue:finish --no-delete`
then just does the cleanup once you've committed the resolution. Neither
script flips `status` to `done` for you — what actually fixed it belongs in
the `Resolution` section, written by whoever did the work, not guessed by a
script.
