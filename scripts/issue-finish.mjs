#!/usr/bin/env node
// Finishes an issue's branch: merges it into main (--no-ff, per
// docs/git-workflow.md rule 2 --- never squash, or PROCESS.md's cited
// commits can go unreachable), then removes its worktree and deletes the
// branch, but only once `git merge-base --is-ancestor` confirms it actually
// landed on main (rule 9 --- `git branch -d`'s own safe-delete check
// compares against the wrong worktree's HEAD in a multi-worktree setup).
//
// Does NOT flip the issue's status to done --- that's a content decision
// (what actually fixed it goes in the Resolution section, issues/README.md)
// made in the branch before merging, not something this script should guess.
//
// Usage: node scripts/issue-finish.mjs ANU-007
//        node scripts/issue-finish.mjs ANU-007 --no-delete   (merge only)
import { existsSync, readFileSync } from "node:fs";
import {
  findWorktreeForBranch,
  git,
  gitOk,
  issuePath,
  parseFrontmatter,
  requireOnMainClean,
  resolveBranch,
} from "./lib/issue-utils.mjs";

const ref = process.argv[2];
const noDelete = process.argv.includes("--no-delete");

if (!ref) {
  console.error("usage: node scripts/issue-finish.mjs ANU-007 [--no-delete]");
  process.exit(1);
}

let branch;
try {
  requireOnMainClean();
  branch = resolveBranch(ref);
} catch (err) {
  console.error(`issue-finish: ${err.message}`);
  process.exit(1);
}

console.log(`merging ${branch} into main...`);

try {
  git(["fetch", "origin", "--prune"], { stdio: "pipe" });
} catch {
  console.warn("issue-finish: couldn't fetch origin (offline?) --- merging local main as-is");
}

if (!gitOk(["merge", "--no-ff", "-m", `Merge ${branch}`, branch])) {
  console.error(`issue-finish: merge of '${branch}' has conflicts --- resolve them, commit, then rerun with --no-delete to skip straight to cleanup`);
  process.exit(1);
}

console.log(`merged. checking whether the issue's status reflects that before pushing...`);

const idMatch = branch.match(/^(ANU-\d{3})-/);
if (idMatch) {
  const path = issuePath(idMatch[1]);
  if (existsSync(path)) {
    const frontmatter = parseFrontmatter(readFileSync(path, "utf8"));
    if (frontmatter?.status !== "done" && frontmatter?.status !== "dropped") {
      console.warn(
        `issue-finish: ${path} still says status: ${frontmatter?.status ?? "(unknown)"} --- ` +
          `update it to 'done' (with a Resolution section) and amend, or do it in a follow-up commit`,
      );
    }
  }
}

console.log("");
console.log("next: run 'pnpm check' and push main (the pre-push hook checks for exactly that).");

if (noDelete) {
  console.log(`--no-delete passed: leaving the '${branch}' worktree/branch in place`);
  process.exit(0);
}

console.log(`cleaning up '${branch}'...`);

const worktree = findWorktreeForBranch(branch);
if (worktree) {
  if (!gitOk(["worktree", "remove", worktree.path])) {
    console.warn(`issue-finish: 'git worktree remove ${worktree.path}' failed (uncommitted changes in it?) --- leaving it; re-run 'node scripts/issue-finish.mjs ${ref} --no-delete' is a no-op, just remove it by hand`);
    process.exit(0);
  }
  console.log(`removed worktree ${worktree.path}`);
}

// `git branch -d` runs its own safe-delete check, which (per
// docs/git-workflow.md rule 9) can give a false "not fully merged" here: it
// compares against the branch's upstream, not local HEAD, so it doesn't yet
// know about the merge commit just made on main until that's pushed. The
// merge-base check above is the independent confirmation rule 9 calls for,
// so once it passes, `-D` is the correct, deliberate choice here --- not a
// bypass of a safety check, but the one the rule says to trust instead.
if (!gitOk(["merge-base", "--is-ancestor", branch, "HEAD"])) {
  console.warn(`issue-finish: '${branch}' isn't actually an ancestor of HEAD yet --- not deleting it (see docs/git-workflow.md rule 9)`);
  process.exit(0);
}

git(["branch", "-D", branch]);
console.log(`deleted local branch '${branch}' (confirmed merged into HEAD first)`);

if (gitOk(["rev-parse", "--verify", `refs/remotes/origin/${branch}`])) {
  console.log(`a remote branch 'origin/${branch}' still exists --- delete it once its PR is confirmed merged:`);
  console.log(`  git push origin --delete ${branch}`);
}
