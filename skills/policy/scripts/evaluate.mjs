#!/usr/bin/env node

/**
 * Evaluate policy rules against state and candidate actions.
 *
 * The production-rule engine: loads a policy file, checks each rule's
 * preconditions against the current state/action, and returns the
 * effects that should be applied.
 *
 * This is Soar's propose-evaluate-select cycle for language agents.
 *
 * Usage:
 *   node evaluate.mjs --policy <policy.json> --state <state.json> --action <action.json>
 *   node evaluate.mjs --policy <policy.json> --state <state.json> --candidates <candidates.json>
 *
 * Can also be imported as a module:
 *   import { evaluatePolicy, applyPolicy } from "./evaluate.mjs";
 */

import { readFileSync, existsSync } from "fs";

// ── Parse args ──────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

const policyFile = getArg("policy");
const stateFile = getArg("state");
const actionFile = getArg("action");
const candidatesFile = getArg("candidates");

// ── Load inputs ─────────────────────────────────────────

function loadJson(path) {
  if (!path || !existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

const policy = loadJson(policyFile);
const state = loadJson(stateFile);
const action = loadJson(actionFile);
const candidates = loadJson(candidatesFile);

if (!policy) {
  console.error("Usage: node evaluate.mjs --policy <policy.json> --state <state.json> [--action|--candidates ...]");
  process.exit(1);
}

// ── Precondition matchers ───────────────────────────────

function getNestedField(obj, fieldPath) {
  return fieldPath.split(".").reduce((o, k) => o?.[k], obj);
}

function matchPrecondition(rule, state, action, context) {
  const pre = rule.precondition;
  if (!pre) return false;

  switch (pre.type) {
    case "always":
      return true;

    case "action_match": {
      if (!action) return false;
      const val = String(getNestedField(action, pre.field) ?? "");
      return new RegExp(pre.pattern, "i").test(val);
    }

    case "state_match": {
      if (!state) return false;
      const val = String(getNestedField(state, pre.field) ?? "");
      return new RegExp(pre.pattern, "i").test(val);
    }

    case "task_match": {
      const desc = state?.currentTask?.description ?? "";
      return new RegExp(pre.pattern, "i").test(desc);
    }

    case "memory_match": {
      const val = state?.memory?.[pre.key] ?? "";
      return new RegExp(pre.pattern, "i").test(String(val));
    }

    case "consecutive_failures": {
      const count = context?.consecutiveFailures ?? 0;
      return count >= (pre.count ?? 3);
    }

    case "all_criteria_met": {
      const criteria = state?.currentTask?.successCriteria ?? [];
      const memory = state?.memory ?? {};
      // Check if all criteria appear satisfied (simple: check memory for "done" flags)
      // In practice this would be more sophisticated
      return criteria.length > 0 && criteria.every(c => {
        const key = `criteria_${c.replace(/\W+/g, "_").toLowerCase()}`;
        return memory[key] === "done" || memory[key] === "true";
      });
    }

    case "rapid_actions": {
      const history = context?.recentActions ?? [];
      const now = Date.now();
      const windowMs = pre.withinMs ?? 5000;
      const recent = history.filter(a =>
        a.type === pre.actionType && (now - a.timestamp) < windowMs
      );
      return recent.length >= (pre.count ?? 5);
    }

    case "heartbeat_range": {
      const hb = context?.heartbeat ?? 0;
      return hb >= (pre.min ?? 0) && hb <= (pre.max ?? Infinity);
    }

    case "child_status": {
      const children = state?.children ?? [];
      const matching = children.filter(c => c.status === pre.status);
      return matching.length >= (pre.count ?? 1);
    }

    case "value_below": {
      const topValue = context?.topCandidateValue ?? 1.0;
      return topValue < (pre.threshold ?? 0.2);
    }

    case "custom": {
      // Simple expression evaluation against state
      // Supports: state.memory.key == "value", state.children.length > 0, etc.
      try {
        const fn = new Function("state", "action", "context", `return !!(${pre.expression})`);
        return fn(state, action, context);
      } catch { return false; }
    }

    default:
      return false;
  }
}

// ── Evaluate all rules ──────────────────────────────────

export function evaluatePolicy(policy, state, action, context = {}) {
  const rules = [...(policy.rules ?? [])].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  const matched = [];

  for (const rule of rules) {
    if (matchPrecondition(rule, state, action, context)) {
      matched.push({
        ruleId: rule.id,
        description: rule.description,
        priority: rule.priority,
        effect: rule.effect,
        action: rule.action,
        message: rule.message,
        boostValue: rule.boostValue,
        skillName: rule.skillName,
        rewrite: rule.rewrite,
      });
    }
  }

  return matched;
}

/**
 * Apply policy to a list of scored candidates. Returns the final selected action
 * after all rule effects (block, boost, override, filter, rewrite) are applied.
 */
export function applyPolicy(policy, state, scoredCandidates, context = {}) {
  let candidates = [...scoredCandidates].sort((a, b) => b.value - a.value);
  const log = [];

  const rules = [...(policy.rules ?? [])].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  // First pass: apply boost and filter rules across all candidates
  for (const rule of rules) {
    if (rule.effect === "boost") {
      if (matchPrecondition(rule, state, null, context)) {
        for (const c of candidates) {
          const isMatch = rule.skillName
            ? (c.action.kind === "skill" && c.action.skillName === rule.skillName)
            : (rule.actionType && c.action.type === rule.actionType);
          if (isMatch) {
            c.value += rule.boostValue ?? 0.1;
            log.push({ ruleId: rule.id, effect: "boost", target: c.action.type ?? c.action.skillName, delta: rule.boostValue });
          }
        }
      }
    }

    if (rule.effect === "filter") {
      if (matchPrecondition(rule, state, null, context)) {
        const before = candidates.length;
        candidates = candidates.filter(c => {
          if (rule.actionType && c.action.type === rule.actionType) return false;
          if (rule.pattern && new RegExp(rule.pattern, "i").test(JSON.stringify(c.action))) return false;
          return true;
        });
        if (candidates.length < before) {
          log.push({ ruleId: rule.id, effect: "filter", removed: before - candidates.length });
        }
      }
    }
  }

  // Re-sort after boosts
  candidates.sort((a, b) => b.value - a.value);

  // Second pass: check each candidate top-down for block/override/rewrite
  for (const candidate of candidates) {
    let blocked = false;
    let overridden = null;
    let rewritten = null;

    for (const rule of rules) {
      if (!matchPrecondition(rule, state, candidate.action, context)) continue;

      if (rule.effect === "block") {
        log.push({ ruleId: rule.id, effect: "block", action: candidate.action.type, message: rule.message });
        blocked = true;
        break;
      }

      if (rule.effect === "override") {
        log.push({ ruleId: rule.id, effect: "override", from: candidate.action.type, to: rule.action?.type });
        overridden = rule.action;
        break;
      }

      if (rule.effect === "rewrite") {
        log.push({ ruleId: rule.id, effect: "rewrite", action: candidate.action.type });
        rewritten = { ...candidate.action, ...rule.rewrite };
        break;
      }

      if (rule.effect === "escalate") {
        log.push({ ruleId: rule.id, effect: "escalate", message: rule.message });
        return {
          action: {
            kind: "primitive",
            type: "message",
            description: rule.message ?? "Policy escalation",
            params: {
              to: rule.escalateTarget ?? policy.impasse?.escalateTarget ?? "parent",
              content: rule.message ?? "Agent requesting guidance",
              channel: "escalation",
            },
          },
          ruleApplied: rule.id,
          log,
        };
      }

      if (rule.effect === "log") {
        log.push({ ruleId: rule.id, effect: "log", message: rule.message });
        // Don't break — log rules are non-blocking
      }
    }

    if (blocked) continue;

    if (overridden) {
      return { action: overridden, ruleApplied: log[log.length - 1]?.ruleId, log };
    }

    if (rewritten) {
      return { action: rewritten, ruleApplied: log[log.length - 1]?.ruleId, log };
    }

    // This candidate passed all rules
    return { action: candidate.action, ruleApplied: null, log };
  }

  // All candidates blocked — check impasse
  const impasse = policy.impasse;
  if (impasse) {
    log.push({ effect: "impasse", message: "All candidates blocked or no candidates" });
    return {
      action: {
        kind: "primitive",
        type: "message",
        description: impasse.escalateMessage ?? "Policy impasse — all actions blocked",
        params: {
          to: impasse.escalateTarget ?? "parent",
          content: impasse.escalateMessage ?? "All candidate actions were blocked by policy rules",
          channel: "escalation",
        },
      },
      ruleApplied: "impasse",
      log,
    };
  }

  // No impasse handler — wait
  log.push({ effect: "fallback_wait", message: "No candidates survived policy, no impasse handler" });
  return {
    action: { kind: "primitive", type: "wait", description: "Policy: no viable actions", params: {} },
    ruleApplied: "fallback",
    log,
  };
}

// ── Check impasse conditions ────────────────────────────

export function checkImpasse(policy, context) {
  const impasse = policy.impasse;
  if (!impasse) return null;

  if (context.noProgressHeartbeats >= (impasse.noProgressHeartbeats ?? 5)) {
    return { type: "no_progress", message: `No progress for ${context.noProgressHeartbeats} heartbeats` };
  }

  if (context.repeatedActionCount >= (impasse.repeatedActionThreshold ?? 3)) {
    return { type: "repeated_action", message: `Same action repeated ${context.repeatedActionCount} times` };
  }

  if (context.consecutiveFailures >= 3) {
    return { type: "consecutive_failures", message: `${context.consecutiveFailures} consecutive failures` };
  }

  return null;
}

// ── CLI mode ────────────────────────────────────────────

if (policy && (state || action || candidates)) {
  if (candidates) {
    // Apply policy to candidate list
    const result = applyPolicy(policy, state, candidates, {
      heartbeat: state?.heartbeat ?? 0,
      topCandidateValue: candidates.length > 0 ? Math.max(...candidates.map(c => c.value)) : 0,
    });
    console.log(JSON.stringify(result, null, 2));
  } else if (action) {
    // Evaluate rules against a single action
    const matched = evaluatePolicy(policy, state, action, {
      heartbeat: state?.heartbeat ?? 0,
    });
    console.log(JSON.stringify({
      rulesChecked: policy.rules?.length ?? 0,
      matched: matched.length,
      results: matched,
    }, null, 2));
  } else {
    // Just check impasse
    const impasse = checkImpasse(policy, {
      noProgressHeartbeats: 0,
      repeatedActionCount: 0,
      consecutiveFailures: 0,
    });
    console.log(JSON.stringify({ impasse }, null, 2));
  }
}
