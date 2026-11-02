#!/usr/bin/env node
// Run only after `pnpm check` exits 0 (see package.json). Drops a timestamped
// marker recording which commit last passed, so the pre-push hook (and the
// deploy script) can refuse to ship anything the marker doesn't vouch for.
//
// Written via `git rev-parse --git-path`, which resolves to a per-worktree
// location (.git/worktrees/<name>/CHECK_OK) when run inside a linked
// worktree, and to .git/CHECK_OK in the main checkout. That means two
// worktrees checking different branches at once don't stomp on each other's
// marker — each worktree's "last good" state is tracked separately.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim();
const markerPath = execFileSync("git", ["rev-parse", "--git-path", "CHECK_OK"], {
  encoding: "utf8",
}).trim();

writeFileSync(
  markerPath,
  JSON.stringify(
    {
      sha,
      dirty: dirty.length > 0,
      checkedAt: new Date().toISOString(),
    },
    null,
    2,
  ) + "\n",
);
