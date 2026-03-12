#!/usr/bin/env node

/**
 * Read scratchpad files — secondary observation source.
 *
 * Scratchpads are free-form text files agents use for working notes,
 * intermediate reasoning, or inter-agent messages. Read after the board.
 *
 * Usage:
 *   node read-scratchpad.mjs [scratchpad-dir] [--agent <agent-id>] [--latest N]
 */

import { readdirSync, readFileSync, existsSync, statSync } from "fs";
import { join } from "path";

const args = process.argv.slice(2);
const dir = args.find(a => !a.startsWith("--")) ?? "./scratchpad";
const agentFilter = (() => { const i = args.indexOf("--agent"); return i >= 0 ? args[i + 1] : null; })();
const latestN = (() => { const i = args.indexOf("--latest"); return i >= 0 ? parseInt(args[i + 1]) : 10; })();

if (!existsSync(dir)) {
  console.log(JSON.stringify({ scratchpads: [], message: `No scratchpad directory: ${dir}` }));
  process.exit(0);
}

const files = readdirSync(dir)
  .filter(f => {
    if (!f.endsWith(".md") && !f.endsWith(".txt") && !f.endsWith(".json")) return false;
    if (agentFilter && !f.includes(agentFilter)) return false;
    return true;
  })
  .map(f => {
    const fullPath = join(dir, f);
    const stat = statSync(fullPath);
    return { name: f, path: fullPath, modified: stat.mtimeMs, size: stat.size };
  })
  .sort((a, b) => b.modified - a.modified)
  .slice(0, latestN);

const scratchpads = files.map(f => ({
  name: f.name,
  modified: new Date(f.modified).toISOString(),
  size: f.size,
  content: readFileSync(f.path, "utf-8").substring(0, 5000),
}));

console.log(JSON.stringify({ scratchpads, total: files.length }, null, 2));
