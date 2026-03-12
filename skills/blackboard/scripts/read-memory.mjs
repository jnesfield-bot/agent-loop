#!/usr/bin/env node

/**
 * Read memory store files — secondary observation source.
 *
 * Memory is the agent's persistent key-value state. This script reads
 * the memory directory and returns all keys, optionally filtered.
 *
 * Usage:
 *   node read-memory.mjs [memory-dir] [--keys key1,key2,...] [--agent <agent-id>]
 */

import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";

const args = process.argv.slice(2);
const dir = args.find(a => !a.startsWith("--")) ?? "./memory";
const keyFilter = (() => { const i = args.indexOf("--keys"); return i >= 0 ? new Set(args[i + 1].split(",")) : null; })();
const agentFilter = (() => { const i = args.indexOf("--agent"); return i >= 0 ? args[i + 1] : null; })();

if (!existsSync(dir)) {
  console.log(JSON.stringify({ memory: {}, message: `No memory directory: ${dir}` }));
  process.exit(0);
}

// Try state.json first (primary memory file)
const stateFile = join(dir, "state.json");
if (existsSync(stateFile)) {
  try {
    const memory = JSON.parse(readFileSync(stateFile, "utf-8"));
    const filtered = keyFilter
      ? Object.fromEntries(Object.entries(memory).filter(([k]) => keyFilter.has(k)))
      : memory;
    console.log(JSON.stringify({ memory: filtered, source: stateFile }, null, 2));
    process.exit(0);
  } catch {}
}

// Otherwise, read individual files as keys
const memory = {};
for (const f of readdirSync(dir)) {
  const key = f.replace(/\.(json|txt|md)$/, "");
  if (keyFilter && !keyFilter.has(key)) continue;
  if (agentFilter && !f.includes(agentFilter)) continue;
  try {
    const content = readFileSync(join(dir, f), "utf-8");
    try { memory[key] = JSON.parse(content); } catch { memory[key] = content.substring(0, 5000); }
  } catch {}
}

console.log(JSON.stringify({ memory, source: dir }, null, 2));
