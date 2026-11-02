// Shared by issue-start.mjs and issue-finish.mjs. Frontmatter is parsed by
// hand (same approach as check-issues.mjs) rather than pulling in a YAML
// dependency — the schema is flat string fields.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const ID_RE = /^ANU-\d{3}$/;

export function git(args, opts = {}) {
  return execFileSync("git", args, { encoding: "utf8", ...opts }).trim();
}

export function gitOk(args, opts = {}) {
  try {
    git(args, { stdio: "pipe", ...opts });
    return true;
  } catch {
    return false;
  }
}

export function parseFrontmatter(src) {
  const match = src.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const frontmatter = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) frontmatter[kv[1]] = kv[2].trim();
  }
  return frontmatter;
}

export function issuePath(id) {
  return `issues/${id}.md`;
}

export function readIssue(id) {
  const path = issuePath(id);
  let src;
  try {
    src = readFileSync(path, "utf8");
  } catch {
    throw new Error(`no such issue: ${path}`);
  }
  const frontmatter = parseFrontmatter(src);
  if (!frontmatter) throw new Error(`${path}: missing frontmatter`);
  return { path, src, frontmatter };
}

// Replaces only the status line in frontmatter, leaving everything else
// (including any hand-written Resolution prose) untouched.
export function withStatus(src, newStatus) {
  const re = /^(status:\s*).*/m;
  if (!re.test(src)) throw new Error("no 'status:' line found in frontmatter");
  return src.replace(re, `$1${newStatus}`);
}

// ANU-007 + "pre-push hook checked the wrong commit" -> anu_007 name slug:
// lowercase, non-alphanumeric runs collapse to a single underscore, trimmed.
export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function branchName(id, title) {
  return `${id}-${slugify(title)}`;
}

export function requireOnMainClean() {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== "main") {
    throw new Error(`must be run from the main checkout, currently on '${branch}'`);
  }
  const dirty = git(["status", "--porcelain"]);
  if (dirty) {
    throw new Error("main checkout has uncommitted changes — commit or stash them first");
  }
}

export function repoName() {
  const toplevel = git(["rev-parse", "--show-toplevel"]);
  return toplevel.split("/").filter(Boolean).pop();
}

export function worktreesRoot() {
  return `../${repoName()}-worktrees`;
}

// Parses `git worktree list --porcelain` into [{path, branch}], branch
// stripped of the refs/heads/ prefix (absent — e.g. detached HEAD — if null).
export function listWorktrees() {
  const raw = git(["worktree", "list", "--porcelain"]);
  const entries = [];
  let current = {};
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path) entries.push(current);
      current = { path: line.slice("worktree ".length), branch: null };
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch refs/heads/".length);
    }
  }
  if (current.path) entries.push(current);
  return entries;
}

export function findWorktreeForBranch(branch) {
  return listWorktrees().find((w) => w.branch === branch) ?? null;
}

// Resolves a user-supplied "ANU-007" or exact branch name to the one local
// branch it refers to. Errors (rather than guessing) on zero or multiple
// matches, since silently picking the wrong branch is worse than asking.
export function resolveBranch(ref) {
  const localBranches = git(["for-each-ref", "--format=%(refname:short)", "refs/heads/"])
    .split("\n")
    .filter(Boolean);

  if (localBranches.includes(ref)) return ref;

  if (ID_RE.test(ref)) {
    const matches = localBranches.filter((b) => b.startsWith(`${ref}-`));
    if (matches.length === 1) return matches[0];
    if (matches.length === 0) throw new Error(`no local branch starting with '${ref}-'`);
    throw new Error(`multiple branches match '${ref}': ${matches.join(", ")} — pass the exact branch name`);
  }

  throw new Error(`no local branch named '${ref}'`);
}
