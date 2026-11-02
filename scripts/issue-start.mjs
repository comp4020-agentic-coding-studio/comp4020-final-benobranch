#!/usr/bin/env node
// Starts work on an existing issue: creates its branch + sibling worktree
// (docs/git-workflow.md rule 1), flips the issue's status to in-progress as
// the branch's first commit, and installs deps in the new worktree.
//
// Usage: node scripts/issue-start.mjs ANU-007
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  branchName,
  findWorktreeForBranch,
  git,
  readIssue,
  requireOnMainClean,
  withStatus,
  worktreesRoot,
} from "./lib/issue-utils.mjs";

const id = process.argv[2];
if (!id || !/^ANU-\d{3}$/.test(id)) {
  console.error("usage: node scripts/issue-start.mjs ANU-007");
  process.exit(1);
}

try {
  requireOnMainClean();
} catch (err) {
  console.error(`issue-start: ${err.message}`);
  process.exit(1);
}

const { frontmatter } = readIssue(id);
if (frontmatter.status === "done" || frontmatter.status === "dropped") {
  console.error(`issue-start: ${id} is already '${frontmatter.status}' --- nothing to start`);
  process.exit(1);
}

const branch = branchName(id, frontmatter.title);
console.log(`branch: ${branch}`);

const existingWorktree = findWorktreeForBranch(branch);
if (existingWorktree) {
  console.log(`a worktree for this branch already exists: ${existingWorktree.path}`);
  console.log(`cd ${existingWorktree.path}`);
  process.exit(0);
}

try {
  git(["fetch", "origin", "--prune"], { stdio: "pipe" });
} catch {
  console.warn("issue-start: couldn't fetch origin (offline?) --- branching off local main");
}

const base = (() => {
  try {
    git(["rev-parse", "--verify", "origin/main"], { stdio: "pipe" });
    return "origin/main";
  } catch {
    return "main";
  }
})();

const root = worktreesRoot();
const worktreePath = `${root}/${branch}`;

if (existsSync(worktreePath)) {
  console.error(`issue-start: ${worktreePath} already exists but isn't registered as a worktree`);
  process.exit(1);
}

const branchExistsLocally = git(["for-each-ref", "--format=%(refname:short)", `refs/heads/${branch}`]) === branch;

if (branchExistsLocally) {
  console.log(`branch '${branch}' already exists locally, attaching a worktree to it`);
  git(["worktree", "add", worktreePath, branch]);
} else {
  git(["worktree", "add", worktreePath, "-b", branch, base]);
}

// Flip status in the new worktree, not main --- the status change belongs to
// the branch/PR doing the work (issues/README.md), not a separate main commit.
if (frontmatter.status !== "in-progress") {
  const issueFile = `${worktreePath}/issues/${id}.md`;
  const src = readFileSync(issueFile, "utf8");
  writeFileSync(issueFile, withStatus(src, "in-progress"));
  git(["-C", worktreePath, "add", `issues/${id}.md`]);
  git(["-C", worktreePath, "commit", "-m", `${id}: start work`]);
  console.log(`${id} marked in-progress`);
}

try {
  execFileSync("pnpm", ["install"], { cwd: worktreePath, stdio: "inherit" });
} catch {
  console.warn(`issue-start: 'pnpm install' failed in ${worktreePath} --- run it by hand`);
}

console.log("");
console.log(`ready: cd ${worktreePath}`);
console.log(`remember a distinct PORT/APP_URL for this worktree (docs/git-workflow.md rule 6)`);
console.log(`open a PR the same session (docs/git-workflow.md rule 1): gh pr create --draft --title "${id}: ${frontmatter.title}"`);
