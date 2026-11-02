#!/usr/bin/env node
// Validates issues/*.md: part of `pnpm check`, not spec/ --- this is process
// scaffolding (see issues/README.md), not a promise the app makes to users.
//
// Frontmatter is parsed by hand rather than pulling in a YAML dependency: the
// schema is five flat string fields, so a line-by-line `key: value` reader is
// enough and keeps this script dependency-free.
import { existsSync, readdirSync, readFileSync } from "node:fs";

const DIR = "issues";
const VALID_STATUS = new Set(["open", "in-progress", "done", "dropped"]);
const VALID_TYPE = new Set(["feature", "bug", "harness"]);
const ID_RE = /^ANU-\d{3}$/;

let failed = false;
const fail = (msg) => {
  console.error(`✗ ${msg}`);
  failed = true;
};

if (!existsSync(DIR)) {
  console.log("✓ no issues/ directory yet, nothing to check");
  process.exit(0);
}

const files = readdirSync(DIR).filter((f) => f.endsWith(".md") && f !== "README.md");
const seenIds = new Map();

for (const file of files) {
  const path = `${DIR}/${file}`;
  const src = readFileSync(path, "utf8");

  const match = src.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    fail(`${path}: missing frontmatter (--- ... --- block at the top)`);
    continue;
  }

  const frontmatter = {};
  for (const line of match[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) frontmatter[kv[1]] = kv[2].trim();
  }

  const { id, status, type } = frontmatter;

  if (!id || !ID_RE.test(id)) {
    fail(`${path}: frontmatter id '${id ?? ""}' must match ANU-NNN (three digits)`);
  } else {
    const expectedFile = `${id}.md`;
    if (file !== expectedFile) {
      fail(`${path}: id '${id}' doesn't match its filename (expected ${expectedFile})`);
    }
    if (seenIds.has(id)) {
      fail(`${path}: id '${id}' is already used by ${seenIds.get(id)}`);
    } else {
      seenIds.set(id, path);
    }
  }

  if (!status || !VALID_STATUS.has(status)) {
    fail(`${path}: status '${status ?? ""}' must be one of ${[...VALID_STATUS].join(", ")}`);
  }

  if (!type || !VALID_TYPE.has(type)) {
    fail(`${path}: type '${type ?? ""}' must be one of ${[...VALID_TYPE].join(", ")}`);
  }

  if (!frontmatter.title) {
    fail(`${path}: missing a title`);
  }
  if (!frontmatter.opened) {
    fail(`${path}: missing an opened date`);
  }
}

if (failed) process.exit(1);
console.log(files.length > 0 ? `✓ issues/: ${files.length} issue(s), all valid` : "✓ issues/: none yet");
