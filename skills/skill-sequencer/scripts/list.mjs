#!/usr/bin/env node

/**
 * List compiled sequences in a directory.
 *
 * Usage:
 *   node list.mjs [sequences-dir]   (default: ./sequences)
 */

import { readdirSync, readFileSync, existsSync } from "fs";
import { join } from "path";

const dir = process.argv[2] ?? "./sequences";

if (!existsSync(dir)) {
  console.error(`No sequences directory found at: ${dir}`);
  console.error(`Compile a skill first: node compile.mjs <skill-dir> "<goal>" ${dir}/my-sequence.json`);
  process.exit(1);
}

const files = readdirSync(dir).filter(f => f.endsWith(".json"));

if (files.length === 0) {
  console.error(`No sequence files in ${dir}`);
  process.exit(0);
}

const sequences = [];

for (const file of files) {
  try {
    const seq = JSON.parse(readFileSync(join(dir, file), "utf-8"));
    sequences.push({
      file,
      name: seq.name ?? "(unnamed)",
      skill: seq.sourceSkill ?? "?",
      goal: seq.goal ?? "",
      steps: seq.steps?.length ?? 0,
      variables: Object.keys(seq.variables ?? {}),
      compiledAt: seq.compiledAt ?? "?",
    });
  } catch {
    sequences.push({ file, name: "(parse error)", skill: "?", goal: "", steps: 0, variables: [], compiledAt: "?" });
  }
}

// Pretty table output
console.log(`\n  Sequences in ${dir}\n`);
console.log("  " + "─".repeat(72));

for (const s of sequences) {
  const vars = s.variables.length > 0 ? ` [vars: ${s.variables.join(", ")}]` : "";
  console.log(`  📋 ${s.name}`);
  console.log(`     File:  ${s.file}`);
  console.log(`     Skill: ${s.skill} | Steps: ${s.steps}${vars}`);
  console.log(`     Goal:  ${s.goal.substring(0, 60)}${s.goal.length > 60 ? "..." : ""}`);
  console.log(`     Built: ${s.compiledAt}`);
  console.log("  " + "─".repeat(72));
}

console.log();

// JSON to stdout
console.log(JSON.stringify(sequences, null, 2));
