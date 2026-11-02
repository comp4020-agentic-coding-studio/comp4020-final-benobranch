#!/usr/bin/env node
// Gate in front of `flyctl deploy` for the one path `.githooks/pre-push`
// cannot cover: deploying by hand while the repo is still private (CI's own
// `deploy` job already `needs: check`, so a push-triggered deploy is covered
// once the repo is public). Run via `pnpm run deploy`, never `flyctl deploy`
// directly --- see CLAUDE.md.
//
// Reuses the same CHECK_OK marker `pnpm check` writes (scripts/record-check-ok.mjs)
// and applies the same three conditions as the pre-push hook: marker matches
// the commit being deployed, the tree was clean, and it's recent.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const MAX_AGE_MS = 4 * 60 * 60 * 1000;

const run = (args) => execFileSync("git", args, { encoding: "utf8" }).trim();

const fail = (msg) => {
  console.error(`deploy blocked: ${msg}`);
  process.exit(1);
};

const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]);
if (branch !== "main") {
  fail(`deploying from '${branch}', not 'main' --- switch to main first`);
}

const markerPath = run(["rev-parse", "--git-path", "CHECK_OK"]);
if (!existsSync(markerPath)) {
  fail("no record of 'pnpm check' passing --- run it first");
}

const marker = JSON.parse(readFileSync(markerPath, "utf8"));
const headSha = run(["rev-parse", "HEAD"]);

if (marker.sha !== headSha) {
  fail(`'pnpm check' last passed at ${marker.sha}, but HEAD is ${headSha} --- re-run it`);
}
if (marker.dirty) {
  fail("'pnpm check' last ran with uncommitted changes --- commit everything and re-run it");
}
const ageMs = Date.now() - new Date(marker.checkedAt).getTime();
if (!Number.isFinite(ageMs) || ageMs > MAX_AGE_MS) {
  fail(`last passing 'pnpm check' is more than ${MAX_AGE_MS / 3_600_000}h old --- re-run it`);
}

// fly.toml has no `app` line (the course names it after the repo) --- derive
// it from the origin remote the same way a student would read it off GitHub.
const remoteUrl = run(["remote", "get-url", "origin"]);
const appName = remoteUrl.replace(/\.git$/, "").split(/[/:]/).pop();
if (!appName) {
  fail("couldn't work out the Fly app name from 'origin' --- pass it with FLY_APP_NAME=<name>");
}

console.log(`deploy guard: ${headSha} checked clean at ${marker.checkedAt}, deploying to ${appName}`);
execFileSync(
  "flyctl",
  ["deploy", "--remote-only", "--ha=false", "-a", process.env.FLY_APP_NAME || appName],
  { stdio: "inherit" },
);
