/**
 * Pi Extension — Agent Loop
 *
 * Integrates the heartbeat loop into pi's interactive TUI.
 * User input becomes a task brief. The loop runs Observe → Evaluate → Select → Act
 * using pi's own tools and LLM, with full visibility in the TUI.
 *
 * Commands:
 *   /loop <task>    — Run a task through the heartbeat loop
 *   /loop-status    — Show current loop state
 *   /loop-stop      — Stop a running loop
 *   /loop-memory    — Show/edit agent memory
 *   /loop-policy    — View, add, remove, enable/disable policy rules
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

// ── Policy Types ─────────────────────────────────────────

interface PolicyRule {
  id: string;
  description?: string;
  priority: number;
  precondition: {
    type: string;
    field?: string;
    pattern?: string;
    count?: number;
    threshold?: number;
    actionType?: string;
    withinMs?: number;
  };
  effect: string;
  message?: string;
  action?: any;
  skillName?: string;
  boostValue?: number;
}

interface Policy {
  version: number;
  name: string;
  rules: PolicyRule[];
  impasse?: any;
  defaults?: any;
}

interface LoopState {
  running: boolean;
  heartbeat: number;
  maxHeartbeats: number;
  task: string | null;
  memory: Record<string, string>;
  lastAction: { type: string; description: string; success: boolean } | null;
  history: Array<{ heartbeat: number; action: string; value: number; success: boolean; output: string }>;
  abortController: AbortController | null;
  policy: Policy | null;
  recentActions: Array<{ type: string; timestamp: number }>;
  consecutiveFailures: number;
}

const state: LoopState = {
  running: false,
  heartbeat: 0,
  maxHeartbeats: 15,
  task: null,
  memory: {},
  lastAction: null,
  history: [],
  abortController: null,
  policy: null,
  recentActions: [],
  consecutiveFailures: 0,
};

// ── Policy Engine ────────────────────────────────────────

/**
 * Load policy from standard locations.
 * Searches: CWD/policy.json, CWD/../policies/worker-default.json
 */
function loadPolicy(cwd: string): Policy | null {
  const paths = [
    join(cwd, "policy.json"),
    join(cwd, "policies", "worker-default.json"),
    join(cwd, "..", "policies", "worker-default.json"),
  ];

  for (const p of paths) {
    if (existsSync(p)) {
      try {
        const policy = JSON.parse(readFileSync(p, "utf-8"));
        if (policy?.rules && Array.isArray(policy.rules)) {
          return policy as Policy;
        }
      } catch { /* skip invalid */ }
    }
  }
  return null;
}

/**
 * Get a nested field from an object using dot notation.
 * e.g., getNestedField({ params: { command: "ls" } }, "params.command") => "ls"
 */
function getNestedField(obj: any, fieldPath: string): any {
  return fieldPath.split(".").reduce((o, k) => o?.[k], obj);
}

/**
 * Check if a policy rule's precondition matches against the current action and state.
 */
function matchPrecondition(
  rule: PolicyRule,
  action: { action_type: string; params?: Record<string, unknown>; description?: string } | null,
  taskDescription: string,
): boolean {
  const pre = rule.precondition;
  if (!pre) return false;

  switch (pre.type) {
    case "always":
      return true;

    case "action_match": {
      if (!action) return false;
      // Build a pseudo-action object that mirrors the structure SingleAgent uses
      // so field paths like "params.command" work correctly
      const actionObj = {
        kind: "primitive",
        type: action.action_type,
        params: action.params ?? {},
        description: action.description ?? "",
      };
      const val = String(getNestedField(actionObj, pre.field ?? "") ?? "");
      if (!val) return false;
      try {
        return new RegExp(pre.pattern ?? "", "i").test(val);
      } catch {
        return false;
      }
    }

    case "task_match": {
      try {
        return new RegExp(pre.pattern ?? "", "i").test(taskDescription);
      } catch {
        return false;
      }
    }

    case "consecutive_failures":
      return state.consecutiveFailures >= (pre.count ?? 3);

    case "value_below": {
      // Not directly applicable in extension mode — skip
      return false;
    }

    case "rapid_actions": {
      const now = Date.now();
      const windowMs = pre.withinMs ?? 5000;
      const recent = state.recentActions.filter(
        (a) => a.type === pre.actionType && (now - a.timestamp) < windowMs,
      );
      return recent.length >= (pre.count ?? 5);
    }

    default:
      return false;
  }
}

/**
 * Check the selected action against all policy rules.
 * Returns null if allowed, or a { rule, message } if blocked/overridden.
 */
function checkPolicy(
  action: { action_type: string; params?: Record<string, unknown>; description?: string },
): { effect: string; rule: PolicyRule; message: string } | null {
  if (!state.policy?.rules) return null;

  const rules = [...state.policy.rules].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  const taskDescription = state.task ?? "";

  for (const rule of rules) {
    if ((rule as any)._disabled) continue;
    if (!matchPrecondition(rule, action, taskDescription)) continue;

    if (rule.effect === "block") {
      return {
        effect: "block",
        rule,
        message: rule.message ?? `Blocked by policy rule: ${rule.id}`,
      };
    }

    if (rule.effect === "escalate") {
      return {
        effect: "escalate",
        rule,
        message: rule.message ?? `Escalation triggered by rule: ${rule.id}`,
      };
    }

    if (rule.effect === "override" && rule.action) {
      return {
        effect: "override",
        rule,
        message: rule.message ?? `Action overridden by rule: ${rule.id}`,
      };
    }

    // "log" effect — don't block, just continue
    // "boost" / "filter" — not applicable to single-action check
  }

  return null;
}

/**
 * Format a human-readable policy summary for inclusion in the loop prompt.
 * Groups rules by tier so the LLM understands what's enforced.
 */
function formatPolicySummary(policy: Policy): string {
  const lines: string[] = [];
  lines.push(`Policy "${policy.name}" (${policy.rules.length} rules):`);

  const tiers: [string, number, number][] = [
    ["🚫 SAFETY (will block your action)", 1000, Infinity],
    ["⚠️ LIFECYCLE (escalation/completion)", 500, 999],
    ["📋 BEHAVIORAL (rate limits, rewrites)", 100, 499],
    ["💡 PREFERENCE (skill boosts)", 1, 99],
  ];

  for (const [label, min, max] of tiers) {
    const inTier = policy.rules.filter(
      (r) => !((r as any)._disabled) && (r.priority ?? 0) >= min && (r.priority ?? 0) <= max,
    );
    if (inTier.length === 0) continue;
    lines.push(`\n${label}:`);
    for (const r of inTier) {
      lines.push(`  - ${r.id}: ${r.description ?? r.message ?? r.effect}`);
    }
  }

  const disabled = policy.rules.filter((r) => (r as any)._disabled);
  if (disabled.length > 0) {
    lines.push(`\n⏸️ DISABLED: ${disabled.map((r) => r.id).join(", ")}`);
  }

  lines.push("\nNote: Blocked actions will be rejected. Choose alternatives when a rule applies.");
  lines.push("The user can adjust policy via /loop-policy or by asking in chat.");
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {

  // ── Status widget ──────────────────────────────────────

  function updateStatus(ctx: { ui: ExtensionContext["ui"] }) {
    if (state.running) {
      ctx.ui.setStatus("agent-loop", `🔄 Loop #${state.heartbeat}/${state.maxHeartbeats}`);
    } else {
      ctx.ui.setStatus("agent-loop", undefined);
    }
  }

  // ── The Heartbeat Loop Tool ────────────────────────────
  //
  // Registered as a tool the LLM calls. Each invocation is one heartbeat.
  // The LLM is told to call this tool repeatedly to drive the loop.
  // This keeps everything inside pi's normal turn flow — full TUI visibility.

  pi.registerTool({
    name: "heartbeat",
    label: "Agent Loop Heartbeat",
    description: [
      "Execute one heartbeat of the agent loop. Call this repeatedly to drive the Observe → Evaluate → Select → Act cycle.",
      "You MUST respond with a JSON object containing your evaluation and selected action.",
      "After executing the action, call heartbeat again with the result until the task is complete.",
    ].join(" "),
    promptSnippet: "Drive the agent loop: observe state, evaluate actions, select best, execute",
    promptGuidelines: [
      "When running a /loop task, call heartbeat repeatedly until complete or max heartbeats reached.",
      "Each heartbeat: observe the current state, propose scored actions, select the best one, and execute it.",
      "Always include your reasoning for action selection.",
      "A safety policy may be active. If your action is blocked, choose a different approach — don't retry the same blocked action.",
      "Users can ask about or change policy rules in natural language. Help them understand what's blocked and why.",
      "Use /loop-policy show to display current rules when a user asks about the policy.",
    ],
    parameters: Type.Object({
      observation: Type.String({ description: "What you observe about the current state" }),
      candidates: Type.Array(
        Type.Object({
          action_type: Type.String({ description: "bash, read, write, edit, update_memory, complete, wait" }),
          description: Type.String({ description: "What this action does" }),
          value: Type.Number({ description: "Score 0.0-1.0, higher = better" }),
          reasoning: Type.String({ description: "Why this score" }),
          params: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Action parameters" })),
        }),
        { description: "1-5 candidate actions with scores" }
      ),
      selected_index: Type.Number({ description: "Index of the candidate you selected (0-based)" }),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!state.running) {
        return {
          content: [{ type: "text", text: "Loop is not running. Use /loop <task> to start." }],
          details: { state: "stopped" },
        };
      }

      state.heartbeat++;
      updateStatus(ctx);

      // Log the evaluation
      const selected = params.candidates[params.selected_index] || params.candidates[0];
      if (!selected) {
        return {
          content: [{ type: "text", text: "No candidates provided. Propose at least one action." }],
          details: { state: "error" },
        };
      }

      // Record in history
      state.history.push({
        heartbeat: state.heartbeat,
        action: `${selected.action_type}: ${selected.description}`,
        value: selected.value,
        success: true, // will update below if needed
        output: "",
      });

      // Build status update
      const candidateSummary = params.candidates
        .map((c, i) => `  ${i === params.selected_index ? "→" : " "} [${c.value.toFixed(2)}] ${c.action_type}: ${c.description}`)
        .join("\n");

      onUpdate?.({
        content: [{ type: "text", text: `Heartbeat #${state.heartbeat}\n\nObservation: ${params.observation}\n\nCandidates:\n${candidateSummary}\n\nSelected: ${selected.action_type}` }],
        details: { heartbeat: state.heartbeat, selected: selected.action_type },
      });

      // Handle special actions
      if (selected.action_type === "complete") {
        state.running = false;
        state.lastAction = { type: "complete", description: selected.description, success: true };
        updateStatus(ctx);
        return {
          content: [{ type: "text", text: `✅ Task complete (${state.heartbeat} heartbeats).\n\nSummary: ${selected.description}\n\nAction history:\n${state.history.map(h => `  #${h.heartbeat} [${h.value.toFixed(2)}] ${h.action}`).join("\n")}` }],
          details: { state: "complete", history: state.history },
        };
      }

      if (selected.action_type === "wait") {
        state.lastAction = { type: "wait", description: "Waiting", success: true };
        const histEntry = state.history[state.history.length - 1];
        histEntry.output = "waited";
        return {
          content: [{ type: "text", text: `⏳ Heartbeat #${state.heartbeat}: Waiting.\n\nContinue calling heartbeat. ${state.maxHeartbeats - state.heartbeat} heartbeats remaining.` }],
          details: { state: "waiting", heartbeat: state.heartbeat },
        };
      }

      if (selected.action_type === "update_memory") {
        const key = selected.params?.key as string || "note";
        const value = selected.params?.value as string || selected.description;
        state.memory[key] = value;
        state.lastAction = { type: "update_memory", description: `Set ${key}`, success: true };
        const histEntry = state.history[state.history.length - 1];
        histEntry.output = `memory[${key}] = ${value}`;
        return {
          content: [{ type: "text", text: `📝 Memory updated: ${key} = ${value}\n\nCurrent memory:\n${Object.entries(state.memory).map(([k, v]) => `  ${k}: ${v}`).join("\n") || "  (empty)"}\n\nContinue calling heartbeat. ${state.maxHeartbeats - state.heartbeat} heartbeats remaining.` }],
          details: { state: "running", memory: state.memory },
        };
      }

      // ── Policy Check ───────────────────────────────────
      // Before allowing execution, run the selected action through the policy engine.
      // Safety rules (priority 1000+) can block dangerous commands like sudo, rm -rf /, etc.
      const policyResult = checkPolicy(selected);
      if (policyResult) {
        if (policyResult.effect === "block") {
          // Record the blocked action in history
          const histEntry = state.history[state.history.length - 1];
          histEntry.success = false;
          histEntry.output = `BLOCKED: ${policyResult.message}`;

          state.lastAction = { type: selected.action_type, description: selected.description, success: false };

          return {
            content: [{ type: "text", text: `🚫 Heartbeat #${state.heartbeat}: Action BLOCKED by policy\n\nRule: ${policyResult.rule.id} (priority ${policyResult.rule.priority})\nReason: ${policyResult.message}\n\nYour proposed action "${selected.action_type}: ${selected.description}" was rejected by the safety policy.\n\nPlease choose a different action. Call heartbeat again with an alternative.\n\n${state.maxHeartbeats - state.heartbeat} heartbeats remaining.` }],
            details: {
              state: "blocked",
              heartbeat: state.heartbeat,
              blockedBy: policyResult.rule.id,
              message: policyResult.message,
            },
          };
        }

        if (policyResult.effect === "escalate") {
          const histEntry = state.history[state.history.length - 1];
          histEntry.output = `ESCALATED: ${policyResult.message}`;

          state.lastAction = { type: "escalate", description: policyResult.message, success: true };

          return {
            content: [{ type: "text", text: `⚠️ Heartbeat #${state.heartbeat}: Policy escalation triggered\n\nRule: ${policyResult.rule.id}\nMessage: ${policyResult.message}\n\nPlease reconsider your approach or choose a safer alternative.\n\n${state.maxHeartbeats - state.heartbeat} heartbeats remaining.` }],
            details: {
              state: "escalated",
              heartbeat: state.heartbeat,
              rule: policyResult.rule.id,
              message: policyResult.message,
            },
          };
        }
      }

      // Track action for rate-limiting rules
      state.recentActions.push({ type: selected.action_type, timestamp: Date.now() });
      if (state.recentActions.length > 50) state.recentActions.shift();

      // For bash/read/write/edit — tell the LLM to use the actual pi tools
      // The heartbeat tool records the decision; execution happens via pi's native tools
      state.lastAction = { type: selected.action_type, description: selected.description, success: true };

      const remaining = state.maxHeartbeats - state.heartbeat;
      const memoryStr = Object.keys(state.memory).length > 0
        ? `\n\nMemory:\n${Object.entries(state.memory).map(([k, v]) => `  ${k}: ${v}`).join("\n")}`
        : "";

      return {
        content: [{ type: "text", text: `🎯 Heartbeat #${state.heartbeat}: Selected ${selected.action_type} (value: ${selected.value.toFixed(2)})\n\nAction: ${selected.description}\n\nNow execute this action using the appropriate tool (bash, read, write, or edit). Then call heartbeat again with the results.\n\n${remaining} heartbeats remaining.${memoryStr}` }],
        details: {
          state: "running",
          heartbeat: state.heartbeat,
          selected: {
            type: selected.action_type,
            description: selected.description,
            value: selected.value,
            params: selected.params,
          },
        },
      };
    },

    renderCall(args, theme) {
      // Import at top level via require for sync renderCall
      const { Text } = require("@mariozechner/pi-tui");
      const selected = args.candidates?.[args.selected_index] || args.candidates?.[0];
      let text = theme.fg("toolTitle", theme.bold("heartbeat "));
      text += theme.fg("accent", `#${state.heartbeat + 1}`);
      if (selected) {
        text += " → " + theme.fg("warning", selected.action_type);
        text += theme.fg("dim", ` (${selected.value?.toFixed(2) ?? "?"}) ${selected.description?.slice(0, 50) ?? ""}`);
      }
      if (args.candidates && args.candidates.length > 1) {
        text += "\n";
        for (let i = 0; i < Math.min(args.candidates.length, 5); i++) {
          const c = args.candidates[i];
          const marker = i === args.selected_index ? "→" : " ";
          const bar = "█".repeat(Math.round((c.value || 0) * 10));
          text += `\n  ${marker} [${(c.value || 0).toFixed(2)}] ${bar} ${theme.fg("muted", c.action_type)}: ${theme.fg("dim", (c.description || "").slice(0, 40))}`;
        }
      }
      return new Text(text, 0, 0);
    },
  });

  // ── Commands ───────────────────────────────────────────

  pi.registerCommand("loop", {
    description: "Run a task through the agent heartbeat loop (Observe → Evaluate → Select → Act)",
    handler: async (args, ctx) => {
      if (!args?.trim()) {
        ctx.ui.notify("Usage: /loop <task description>", "warning");
        return;
      }

      if (state.running) {
        ctx.ui.notify("Loop already running. Use /loop-stop first.", "warning");
        return;
      }

      // Reset state
      state.running = true;
      state.heartbeat = 0;
      state.task = args.trim();
      state.lastAction = null;
      state.history = [];
      state.abortController = new AbortController();
      state.recentActions = [];
      state.consecutiveFailures = 0;

      // Load policy from standard locations
      state.policy = loadPolicy(ctx.cwd ?? process.cwd());
      if (state.policy) {
        ctx.ui.notify(`Policy loaded: ${state.policy.name} (${state.policy.rules.length} rules)`, "info");
      }

      updateStatus(ctx);
      ctx.ui.notify(`Starting loop: ${state.task}`, "info");

      // Inject the task as a user message with loop instructions
      const prompt = `You are operating in AGENT LOOP mode. Your task:

${state.task}

## Instructions

Drive the task by calling the \`heartbeat\` tool repeatedly. Each call is one cycle of:
1. **Observe** — Describe what you see (files, state, prior results)
2. **Evaluate** — Propose 1-5 candidate actions with value scores (0.0-1.0)
3. **Select** — Pick the best candidate (set selected_index)
4. **Act** — The heartbeat tool will instruct you to execute using bash/read/write/edit

After executing the action with the appropriate tool, call heartbeat again.

Keep going until you call heartbeat with action_type "complete" or reach ${state.maxHeartbeats} heartbeats.

## Scoring Guide
- 1.0 = Critical, do now
- 0.7-0.9 = High value, directly advances task
- 0.4-0.6 = Moderate, useful but not urgent
- 0.1-0.3 = Low value, speculative
- 0.0 = No value

## Current Memory
${Object.keys(state.memory).length > 0 ? Object.entries(state.memory).map(([k, v]) => `${k}: ${v}`).join("\n") : "(empty)"}

## Active Policy
${state.policy ? formatPolicySummary(state.policy) : "No policy loaded — all actions are allowed."}

Start by calling heartbeat with your initial observation and candidate actions.`;

      pi.sendUserMessage(prompt);
    },
  });

  pi.registerCommand("loop-stop", {
    description: "Stop the running agent loop",
    handler: async (_args, ctx) => {
      if (!state.running) {
        ctx.ui.notify("No loop running.", "info");
        return;
      }
      state.running = false;
      state.abortController?.abort();
      updateStatus(ctx);
      ctx.ui.notify(`Loop stopped after ${state.heartbeat} heartbeats.`, "info");
    },
  });

  pi.registerCommand("loop-status", {
    description: "Show agent loop status",
    handler: async (_args, ctx) => {
      const lines = [
        `Running: ${state.running}`,
        `Heartbeat: ${state.heartbeat}/${state.maxHeartbeats}`,
        `Task: ${state.task || "(none)"}`,
        `Last action: ${state.lastAction ? `${state.lastAction.type}: ${state.lastAction.description}` : "(none)"}`,
        `Memory keys: ${Object.keys(state.memory).join(", ") || "(empty)"}`,
        `History: ${state.history.length} actions`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("loop-memory", {
    description: "Show agent loop memory",
    handler: async (_args, ctx) => {
      if (Object.keys(state.memory).length === 0) {
        ctx.ui.notify("Memory is empty.", "info");
        return;
      }
      const lines = Object.entries(state.memory).map(([k, v]) => `${k}: ${v}`);
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  // ── Policy Command ─────────────────────────────────────
  //
  // Users can view, add, remove, enable/disable rules via chat.
  // The LLM can also suggest policy changes through normal conversation.

  pi.registerCommand("loop-policy", {
    description: "Manage policy rules. Usage: /loop-policy [show|add|remove|enable|disable|save|load|help]",
    handler: async (args, ctx) => {
      const parts = (args ?? "").trim().split(/\s+/);
      const subcmd = parts[0] || "show";

      // Ensure policy is loaded
      if (!state.policy && subcmd !== "load" && subcmd !== "help") {
        state.policy = loadPolicy(ctx.cwd ?? process.cwd());
        if (!state.policy) {
          state.policy = { version: 1, name: "session-policy", rules: [], defaults: { maxCandidates: 5, minActionValue: 0.1, explorationRate: 0 } };
          ctx.ui.notify("No policy file found. Created empty in-memory policy.\nUse /loop-policy add to create rules, or /loop-policy load <path> to load one.", "info");
          return;
        }
      }

      switch (subcmd) {
        case "show": {
          if (!state.policy || state.policy.rules.length === 0) {
            ctx.ui.notify("Policy: (no rules loaded)\n\nUse /loop-policy add <json> or /loop-policy load <path>", "info");
            return;
          }
          const lines = [
            `Policy: ${state.policy.name} (v${state.policy.version})`,
            `Rules: ${state.policy.rules.length}`,
            "",
            ...state.policy.rules.map((r: any, i: number) => {
              const disabled = r._disabled ? " [DISABLED]" : "";
              const effect = r.effect.toUpperCase();
              return `  ${i + 1}. [${r.priority}] ${effect} "${r.id}"${disabled}\n     ${r.description ?? "(no description)"}`;
            }),
            "",
            "Commands: /loop-policy [show|add|remove|enable|disable|save|load|help]",
          ];
          ctx.ui.notify(lines.join("\n"), "info");
          break;
        }

        case "add": {
          // Usage: /loop-policy add {"id":"...","priority":...,"precondition":{...},"effect":"...","message":"..."}
          const jsonStr = parts.slice(1).join(" ");
          if (!jsonStr) {
            ctx.ui.notify(
              'Usage: /loop-policy add <rule-json>\n\n' +
              'Example:\n' +
              '  /loop-policy add {"id":"block-curl","priority":1000,"precondition":{"type":"action_match","field":"params.command","pattern":"curl"},"effect":"block","message":"No curl allowed"}\n\n' +
              'Or just describe the rule you want in chat — e.g.:\n' +
              '  "Add a policy rule that blocks any wget commands"',
              "info",
            );
            return;
          }
          try {
            const rule = JSON.parse(jsonStr);
            if (!rule.id || !rule.precondition || !rule.effect) {
              ctx.ui.notify("Rule must have: id, precondition, effect", "warning");
              return;
            }
            rule.priority = rule.priority ?? 500;
            state.policy!.rules.push(rule);
            ctx.ui.notify(`✅ Rule added: [${rule.priority}] ${rule.effect.toUpperCase()} "${rule.id}"\n${rule.description ?? rule.message ?? ""}`, "info");
          } catch (e) {
            ctx.ui.notify(`Invalid JSON: ${e}\n\nTip: describe the rule in natural language and ask me to format it for you.`, "warning");
          }
          break;
        }

        case "remove": {
          const ruleId = parts[1];
          if (!ruleId) {
            ctx.ui.notify("Usage: /loop-policy remove <rule-id>\nUse /loop-policy show to see rule IDs.", "info");
            return;
          }
          const before = state.policy!.rules.length;
          state.policy!.rules = state.policy!.rules.filter((r: any) => r.id !== ruleId);
          if (state.policy!.rules.length < before) {
            ctx.ui.notify(`✅ Removed rule: ${ruleId}`, "info");
          } else {
            ctx.ui.notify(`Rule not found: ${ruleId}`, "warning");
          }
          break;
        }

        case "enable": {
          const ruleId = parts[1];
          if (!ruleId) { ctx.ui.notify("Usage: /loop-policy enable <rule-id>", "info"); return; }
          const rule = state.policy!.rules.find((r: any) => r.id === ruleId);
          if (rule) { delete (rule as any)._disabled; ctx.ui.notify(`✅ Enabled: ${ruleId}`, "info"); }
          else { ctx.ui.notify(`Rule not found: ${ruleId}`, "warning"); }
          break;
        }

        case "disable": {
          const ruleId = parts[1];
          if (!ruleId) { ctx.ui.notify("Usage: /loop-policy disable <rule-id>", "info"); return; }
          const rule = state.policy!.rules.find((r: any) => r.id === ruleId);
          if (rule) { (rule as any)._disabled = true; ctx.ui.notify(`⏸️ Disabled: ${ruleId}`, "info"); }
          else { ctx.ui.notify(`Rule not found: ${ruleId}`, "warning"); }
          break;
        }

        case "save": {
          const savePath = parts[1] || join(ctx.cwd ?? process.cwd(), "policy.json");
          try {
            // Strip internal fields before saving
            const clean = {
              ...state.policy,
              rules: state.policy!.rules.map((r: any) => {
                const { _disabled, ...rest } = r;
                return rest;
              }),
            };
            writeFileSync(savePath, JSON.stringify(clean, null, 2));
            ctx.ui.notify(`✅ Policy saved to: ${savePath}`, "info");
          } catch (e) {
            ctx.ui.notify(`Failed to save: ${e}`, "error");
          }
          break;
        }

        case "load": {
          const loadPath = parts[1];
          if (!loadPath) { ctx.ui.notify("Usage: /loop-policy load <path>", "info"); return; }
          if (!existsSync(loadPath)) { ctx.ui.notify(`File not found: ${loadPath}`, "warning"); return; }
          try {
            state.policy = JSON.parse(readFileSync(loadPath, "utf-8"));
            ctx.ui.notify(`✅ Loaded: ${state.policy!.name} (${state.policy!.rules.length} rules)`, "info");
          } catch (e) {
            ctx.ui.notify(`Failed to load: ${e}`, "error");
          }
          break;
        }

        case "help":
        default: {
          ctx.ui.notify([
            "🛡️ Agent Loop Policy — Safety & behavior rules for the heartbeat loop",
            "",
            "Commands:",
            "  /loop-policy show              — List all rules with priority and status",
            "  /loop-policy add <rule-json>   — Add a new rule",
            "  /loop-policy remove <rule-id>  — Remove a rule by ID",
            "  /loop-policy enable <rule-id>  — Re-enable a disabled rule",
            "  /loop-policy disable <rule-id> — Temporarily disable a rule",
            "  /loop-policy save [path]       — Save current policy to file",
            "  /loop-policy load <path>       — Load policy from file",
            "",
            "You can also ask in natural language:",
            '  "Show me the current safety rules"',
            '  "Add a rule that blocks any curl commands"',
            '  "Disable the no-sudo rule for this session"',
            '  "What would happen if I tried to run rm -rf?"',
            "",
            "Rule effects: block, override, boost, filter, escalate, log",
            "Priority tiers: 1000+ safety, 500-999 lifecycle, 100-499 behavioral, 1-99 preference",
          ].join("\n"), "info");
          break;
        }
      }
    },
  });

  pi.registerCommand("loop-config", {
    description: "Set loop config. Usage: /loop-config max-heartbeats <n>",
    handler: async (args, ctx) => {
      if (!args?.trim()) {
        ctx.ui.notify(`Current config:\n  max-heartbeats: ${state.maxHeartbeats}`, "info");
        return;
      }
      const parts = args.trim().split(/\s+/);
      if (parts[0] === "max-heartbeats" && parts[1]) {
        const n = parseInt(parts[1], 10);
        if (isNaN(n) || n < 1 || n > 100) {
          ctx.ui.notify("max-heartbeats must be 1-100", "warning");
          return;
        }
        state.maxHeartbeats = n;
        ctx.ui.notify(`max-heartbeats set to ${n}`, "info");
      } else {
        ctx.ui.notify("Unknown config. Available: max-heartbeats <n>", "warning");
      }
    },
  });

  // ── Lifecycle ──────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    updateStatus(ctx);

    // Load policy at startup and show summary
    state.policy = loadPolicy(ctx.cwd ?? process.cwd());

    const lines = ["🔄 Agent Loop extension loaded"];
    if (state.policy) {
      const safetyRules = state.policy.rules.filter((r: any) => (r.priority ?? 0) >= 1000);
      const lifecycleRules = state.policy.rules.filter((r: any) => (r.priority ?? 0) >= 500 && (r.priority ?? 0) < 1000);
      const otherRules = state.policy.rules.filter((r: any) => (r.priority ?? 0) < 500);
      lines.push(`🛡️ Policy: ${state.policy.name} — ${state.policy.rules.length} rules (${safetyRules.length} safety, ${lifecycleRules.length} lifecycle, ${otherRules.length} preference)`);
      if (safetyRules.length > 0) {
        lines.push(`   Safety rules active: ${safetyRules.map((r: any) => r.id).join(", ")}`);
      }
    } else {
      lines.push("⚠️ No policy loaded — all actions allowed. Use /loop-policy load <path> or /loop-policy add to set rules.");
    }
    lines.push("   Use /loop-policy to view or modify rules, or just ask in chat.");
    ctx.ui.notify(lines.join("\n"), "info");
  });

  pi.on("session_shutdown", async () => {
    state.running = false;
    state.abortController?.abort();
  });
}
