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
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

interface LoopState {
  running: boolean;
  heartbeat: number;
  maxHeartbeats: number;
  task: string | null;
  memory: Record<string, string>;
  lastAction: { type: string; description: string; success: boolean } | null;
  history: Array<{ heartbeat: number; action: string; value: number; success: boolean; output: string }>;
  abortController: AbortController | null;
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
};

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
  });

  pi.on("session_shutdown", async () => {
    state.running = false;
    state.abortController?.abort();
  });
}
