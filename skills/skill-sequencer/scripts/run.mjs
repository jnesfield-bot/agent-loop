#!/usr/bin/env node

/**
 * Execute a compiled skill sequence.
 *
 * Runs each step in order, substitutes variables, handles failure policies,
 * and captures outputs into named variables for later steps.
 *
 * Usage:
 *   node run.mjs <sequence-file> [--var key=value ...] [--dry-run] [--from N] [--to N]
 */

import { readFileSync } from "fs";
import { execSync } from "child_process";

const args = process.argv.slice(2);
const sequenceFile = args.find(a => !a.startsWith("--"));
const dryRun = args.includes("--dry-run");
const fromStep = parseInt(args.find(a => a.startsWith("--from="))?.split("=")[1] ?? "0");
const toStep = parseInt(args.find(a => a.startsWith("--to="))?.split("=")[1] ?? "9999");

if (!sequenceFile) {
  console.error("Usage: node run.mjs <sequence-file> [--var key=value ...] [--dry-run] [--from=N] [--to=N]");
  process.exit(1);
}

// Parse --var flags
const vars = {};
for (const arg of args) {
  if (arg.startsWith("--var")) {
    // Handle both --var key=value and --var=key=value
    const rest = arg.startsWith("--var=") ? arg.slice(6) : args[args.indexOf(arg) + 1];
    if (rest) {
      const eq = rest.indexOf("=");
      if (eq > 0) vars[rest.slice(0, eq)] = rest.slice(eq + 1);
    }
  }
}

// Load sequence
const sequence = JSON.parse(readFileSync(sequenceFile, "utf-8"));
const context = { ...sequence.variables, ...vars };

console.error(`╔══════════════════════════════════════════════════════════╗`);
console.error(`║  Sequence: ${(sequence.name || "unnamed").substring(0, 44).padEnd(44)} ║`);
console.error(`║  Skill:    ${(sequence.sourceSkill || "unknown").substring(0, 44).padEnd(44)} ║`);
console.error(`║  Goal:     ${(sequence.goal || "").substring(0, 44).padEnd(44)} ║`);
console.error(`║  Steps:    ${String(sequence.steps.length).padEnd(44)} ║`);
if (dryRun) {
  console.error(`║  Mode:     ${"DRY RUN".padEnd(44)} ║`);
}
console.error(`╚══════════════════════════════════════════════════════════╝`);
console.error();

/**
 * Substitute {{variables}} in a string using the current context.
 */
function substitute(str) {
  if (typeof str !== "string") return str;
  return str.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (key in context) return context[key];
    console.error(`  ⚠ Unresolved variable: {{${key}}}`);
    return `{{${key}}}`;
  });
}

/**
 * Deep-substitute all string values in an object.
 */
function substituteDeep(obj) {
  if (typeof obj === "string") return substitute(obj);
  if (Array.isArray(obj)) return obj.map(substituteDeep);
  if (obj && typeof obj === "object") {
    const result = {};
    for (const [k, v] of Object.entries(obj)) result[k] = substituteDeep(v);
    return result;
  }
  return obj;
}

// ── Execute ─────────────────────────────────────────────

const results = [];
let failed = false;

for (const step of sequence.steps) {
  if (step.index < fromStep || step.index > toStep) continue;
  if (failed) break;

  // Check condition
  if (step.condition) {
    const resolved = substitute(step.condition);
    if (!resolved || resolved === "false" || resolved === "0" || resolved === "") {
      console.error(`⏭  Step ${step.index}: ${step.description} [SKIPPED — condition not met]`);
      results.push({ index: step.index, status: "skipped", output: "" });
      continue;
    }
  }

  const resolvedAction = substituteDeep(step.action);

  console.error(`▶  Step ${step.index}: ${substitute(step.description)}`);

  if (resolvedAction.type === "bash") {
    const cmd = resolvedAction.params?.command;
    console.error(`   $ ${cmd}`);

    if (dryRun) {
      console.error(`   [DRY RUN — skipped]`);
      results.push({ index: step.index, status: "dry-run", output: "" });
      continue;
    }

    const maxRetries = step.onFailure?.startsWith("retry:")
      ? parseInt(step.onFailure.split(":")[1])
      : 0;

    let attempt = 0;
    let success = false;
    let output = "";

    while (attempt <= maxRetries) {
      try {
        output = execSync(cmd, {
          encoding: "utf-8",
          timeout: 120000,
          maxBuffer: 5 * 1024 * 1024,
          stdio: ["pipe", "pipe", "pipe"],
        });
        success = true;
        break;
      } catch (err) {
        output = (err.stdout || "") + (err.stderr || "");
        attempt++;
        if (attempt <= maxRetries) {
          console.error(`   ⟳ Retry ${attempt}/${maxRetries}...`);
        }
      }
    }

    // Capture output as variable
    if (step.captureAs && output) {
      // Truncate captured output to keep context manageable
      context[step.captureAs] = output.trim().substring(0, 10000);
    }

    if (success) {
      console.error(`   ✓ OK${step.captureAs ? ` → {{${step.captureAs}}}` : ""}`);
      // Print output (truncated)
      if (output.trim()) {
        const lines = output.trim().split("\n");
        const preview = lines.slice(0, 10).join("\n");
        console.error(`   ${preview.replace(/\n/g, "\n   ")}`);
        if (lines.length > 10) console.error(`   ... (${lines.length - 10} more lines)`);
      }
      results.push({ index: step.index, status: "ok", output: output.trim() });
    } else {
      console.error(`   ✗ FAILED`);
      if (output.trim()) console.error(`   ${output.trim().substring(0, 500)}`);

      const policy = step.onFailure ?? "abort";
      if (policy === "continue") {
        console.error(`   → Continuing (onFailure: continue)`);
        results.push({ index: step.index, status: "failed-continued", output });
      } else {
        console.error(`   → Aborting (onFailure: ${policy})`);
        results.push({ index: step.index, status: "failed", output });
        failed = true;
      }
    }
  } else if (resolvedAction.type === "read") {
    const path = resolvedAction.params?.path;
    console.error(`   📄 ${path}`);
    if (!dryRun) {
      try {
        const content = readFileSync(path, "utf-8");
        if (step.captureAs) context[step.captureAs] = content.substring(0, 10000);
        console.error(`   ✓ Read ${content.length} bytes${step.captureAs ? ` → {{${step.captureAs}}}` : ""}`);
        results.push({ index: step.index, status: "ok", output: content.substring(0, 200) });
      } catch (err) {
        console.error(`   ✗ ${err.message}`);
        results.push({ index: step.index, status: "failed", output: err.message });
        if ((step.onFailure ?? "abort") === "abort") failed = true;
      }
    }
  } else if (resolvedAction.type === "write") {
    console.error(`   📝 ${resolvedAction.params?.path}`);
    if (!dryRun) {
      try {
        const { writeFileSync, mkdirSync } = await import("fs");
        const { dirname } = await import("path");
        const p = resolvedAction.params.path;
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, resolvedAction.params.content);
        console.error(`   ✓ Wrote`);
        results.push({ index: step.index, status: "ok", output: `Wrote ${p}` });
      } catch (err) {
        console.error(`   ✗ ${err.message}`);
        results.push({ index: step.index, status: "failed", output: err.message });
        if ((step.onFailure ?? "abort") === "abort") failed = true;
      }
    }
  } else {
    console.error(`   ⚠ Unknown action type: ${resolvedAction.type}`);
    results.push({ index: step.index, status: "skipped", output: "Unknown type" });
  }

  console.error();
}

// ── Summary ─────────────────────────────────────────────

const ok = results.filter(r => r.status === "ok").length;
const skip = results.filter(r => r.status === "skipped" || r.status === "dry-run").length;
const fail = results.filter(r => r.status.startsWith("failed")).length;

console.error(`─── Summary ───`);
console.error(`  ✓ ${ok} succeeded  ⏭ ${skip} skipped  ✗ ${fail} failed`);
console.error();

// Output full results as JSON to stdout
console.log(JSON.stringify({
  sequence: sequence.name,
  goal: sequence.goal,
  variables: context,
  results,
  success: !failed,
  timestamp: new Date().toISOString(),
}, null, 2));

process.exit(failed ? 1 : 0);
