#!/usr/bin/env node

/**
 * Clone, index, and search across multiple git repos in one shot.
 *
 * This is the "single strip" action: give it repos + a query,
 * get back ranked results across all of them.
 *
 * Usage:
 *   node batch-search.mjs "<query>" --repo <url-or-path> [--repo ...] [--top N] [--lang py|ts|js|all] [--context]
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join, basename } from "path";

const args = process.argv.slice(2);
const query = args.find(a => !a.startsWith("--"));

function getAllArgs(name) {
  const results = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}` && i + 1 < args.length) results.push(args[++i]);
  }
  return results;
}
function getArg(name) {
  const vals = getAllArgs(name);
  return vals.length > 0 ? vals[0] : null;
}
const hasFlag = (name) => args.includes(`--${name}`);

const repos = getAllArgs("repo");
const topN = getArg("top") ?? "10";
const lang = getArg("lang") ?? "all";
const showContext = hasFlag("context");

if (!query || repos.length === 0) {
  console.error('Usage: node batch-search.mjs "<query>" --repo <url-or-path> [--repo ...] [--top N] [--lang py|ts|js|all]');
  process.exit(1);
}

const scriptDir = new URL(".", import.meta.url).pathname;
const indexScript = join(scriptDir, "index-repo.mjs");
const searchScript = join(scriptDir, "search.mjs");
const workDir = join("/tmp", `code-search-batch-${Date.now().toString(36)}`);
mkdirSync(workDir, { recursive: true });

// ── Step 1: Index all repos ─────────────────────────────

const indexFiles = [];
console.error(`\n  Batch Code Search`);
console.error(`  Query: "${query}"`);
console.error(`  Repos: ${repos.length}`);
console.error(`  ${"─".repeat(50)}\n`);

for (const repo of repos) {
  const repoName = basename(repo).replace(/\.git$/, "");
  const indexPath = join(workDir, `${repoName}.json`);

  console.error(`  📦 Indexing ${repoName}...`);

  try {
    execSync(
      `node ${indexScript} "${repo}" --output "${indexPath}" --lang ${lang}`,
      { encoding: "utf-8", timeout: 180000, stdio: ["pipe", "pipe", "pipe"] }
    );
    if (existsSync(indexPath)) {
      indexFiles.push(indexPath);
      console.error(`     ✓ Indexed → ${indexPath}`);
    } else {
      console.error(`     ✗ No index produced`);
    }
  } catch (err) {
    console.error(`     ✗ Failed: ${err.message?.substring(0, 100)}`);
  }
}

if (indexFiles.length === 0) {
  console.error("\n  No repos indexed successfully.");
  process.exit(1);
}

// ── Step 2: Search across all indices ───────────────────

console.error(`\n  🔍 Searching ${indexFiles.length} indices...`);

const indexArgs = indexFiles.map(f => `--index "${f}"`).join(" ");
const contextFlag = showContext ? "--context" : "";

try {
  const result = execSync(
    `node ${searchScript} "${query}" ${indexArgs} --top ${topN} ${contextFlag}`,
    { encoding: "utf-8", timeout: 60000, maxBuffer: 10 * 1024 * 1024 }
  );
  console.log(result);
} catch (err) {
  console.error(`  Search failed: ${err.message?.substring(0, 200)}`);
  process.exit(1);
}
