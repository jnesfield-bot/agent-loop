#!/usr/bin/env node

/**
 * Validate a policy file — check structure, rule conflicts, coverage.
 *
 * Usage:
 *   node validate.mjs --policy <policy.json>
 */

import { readFileSync, existsSync } from "fs";

const args = process.argv.slice(2);
const policyFile = args.find(a => !a.startsWith("--")) ?? (() => {
  const i = args.indexOf("--policy");
  return i >= 0 ? args[i + 1] : null;
})();

if (!policyFile || !existsSync(policyFile)) {
  console.error("Usage: node validate.mjs <policy.json>");
  process.exit(1);
}

const policy = JSON.parse(readFileSync(policyFile, "utf-8"));
const errors = [];
const warnings = [];
const info = [];

// ── Structure checks ────────────────────────────────────

if (!policy.version) warnings.push("No version field");
if (!policy.name) warnings.push("No name field");
if (!policy.rules || !Array.isArray(policy.rules)) {
  errors.push("Missing or invalid 'rules' array");
} else {
  const ids = new Set();
  const priorities = new Map();

  for (let i = 0; i < policy.rules.length; i++) {
    const rule = policy.rules[i];
    const prefix = `Rule [${i}] "${rule.id ?? "(no id)"}"`;

    // Required fields
    if (!rule.id) errors.push(`${prefix}: missing 'id'`);
    if (!rule.precondition) errors.push(`${prefix}: missing 'precondition'`);
    if (!rule.effect) errors.push(`${prefix}: missing 'effect'`);

    // Duplicate IDs
    if (rule.id && ids.has(rule.id)) errors.push(`${prefix}: duplicate id`);
    ids.add(rule.id);

    // Priority conflicts
    if (rule.priority != null) {
      if (priorities.has(rule.priority)) {
        warnings.push(`${prefix}: same priority (${rule.priority}) as "${priorities.get(rule.priority)}"`);
      }
      priorities.set(rule.priority, rule.id);
    } else {
      warnings.push(`${prefix}: no priority set (defaults to 0)`);
    }

    // Valid effect types
    const validEffects = ["block", "override", "boost", "filter", "rewrite", "escalate", "log"];
    if (rule.effect && !validEffects.includes(rule.effect)) {
      errors.push(`${prefix}: invalid effect "${rule.effect}". Valid: ${validEffects.join(", ")}`);
    }

    // Effect-specific checks
    if (rule.effect === "override" && !rule.action) {
      errors.push(`${prefix}: override effect needs an 'action' field`);
    }
    if (rule.effect === "boost" && rule.boostValue == null) {
      warnings.push(`${prefix}: boost effect without 'boostValue' (defaults to 0)`);
    }
    if (rule.effect === "escalate" && !rule.message) {
      warnings.push(`${prefix}: escalate effect without 'message'`);
    }

    // Valid precondition types
    const validPreconditions = [
      "always", "action_match", "state_match", "task_match", "memory_match",
      "consecutive_failures", "all_criteria_met", "rapid_actions",
      "heartbeat_range", "child_status", "value_below", "custom",
    ];
    if (rule.precondition?.type && !validPreconditions.includes(rule.precondition.type)) {
      errors.push(`${prefix}: invalid precondition type "${rule.precondition.type}"`);
    }

    // Regex pattern validity
    if (rule.precondition?.pattern) {
      try { new RegExp(rule.precondition.pattern); }
      catch { errors.push(`${prefix}: invalid regex pattern "${rule.precondition.pattern}"`); }
    }
  }

  // Coverage analysis
  const hasBlockRules = policy.rules.some(r => r.effect === "block");
  const hasEscalateRules = policy.rules.some(r => r.effect === "escalate");
  const hasSafetyRules = policy.rules.some(r => (r.priority ?? 0) >= 1000);

  if (!hasSafetyRules) warnings.push("No safety-tier rules (priority >= 1000)");
  if (!hasBlockRules) info.push("No block rules — all LLM actions will be allowed");
  if (!hasEscalateRules && !policy.impasse) {
    warnings.push("No escalate rules and no impasse handler — agent cannot ask for help");
  }
}

// ── Impasse checks ──────────────────────────────────────

if (policy.impasse) {
  if (!policy.impasse.escalateTarget) warnings.push("Impasse: no escalateTarget");
  if (!policy.impasse.escalateMessage) warnings.push("Impasse: no escalateMessage");
} else {
  info.push("No impasse configuration — agent will wait if stuck");
}

// ── Output ──────────────────────────────────────────────

const valid = errors.length === 0;

console.log(JSON.stringify({
  valid,
  policyName: policy.name ?? "(unnamed)",
  ruleCount: policy.rules?.length ?? 0,
  errors,
  warnings,
  info,
  priorityTiers: {
    safety: (policy.rules ?? []).filter(r => (r.priority ?? 0) >= 1000).length,
    lifecycle: (policy.rules ?? []).filter(r => (r.priority ?? 0) >= 500 && (r.priority ?? 0) < 1000).length,
    behavioral: (policy.rules ?? []).filter(r => (r.priority ?? 0) >= 100 && (r.priority ?? 0) < 500).length,
    preference: (policy.rules ?? []).filter(r => (r.priority ?? 0) > 0 && (r.priority ?? 0) < 100).length,
  },
}, null, 2));

process.exit(valid ? 0 : 1);
