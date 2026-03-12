/**
 * Phase 1 Demo — Single Agent Heartbeat Loop
 *
 * Runs a SingleAgent with a task, demonstrating the
 * Observe → Evaluate → Select → Act cycle.
 */

import { SingleAgent } from "./single-agent.js";
import type { LoopEvent } from "./types.js";

// ── Pretty Logging ─────────────────────────────────────────

const ICONS: Record<string, string> = {
  heartbeat_start: "💓",
  observe_complete: "👁️ ",
  evaluate_complete: "🧠",
  select_complete: "🎯",
  act_complete: "⚡",
  heartbeat_end: "✅",
  loop_paused: "⏸️ ",
  loop_error: "❌",
};

function logEvent(event: LoopEvent): void {
  const icon = ICONS[event.type] ?? "•";
  const time = new Date(event.timestamp).toISOString().substring(11, 23);

  switch (event.type) {
    case "heartbeat_start":
      console.log(`\n${"═".repeat(60)}`);
      console.log(`${icon} Heartbeat #${event.heartbeat} — ${time}`);
      console.log(`${"═".repeat(60)}`);
      break;

    case "observe_complete":
      console.log(`${icon} OBSERVE — Task: ${event.state.currentTask?.description ?? "(none)"}`);
      console.log(`   Memory keys: ${Object.keys(event.state.memory).join(", ") || "(empty)"}`);
      console.log(`   Inputs: ${event.state.inputs.length}`);
      if (event.state.lastActionResult) {
        console.log(
          `   Last result: ${event.state.lastActionResult.action.type} → ${event.state.lastActionResult.success ? "✓" : "✗"}`
        );
      }
      break;

    case "evaluate_complete":
      console.log(`${icon} EVALUATE — ${event.scoredActions.length} candidate actions:`);
      for (const sa of event.scoredActions) {
        const bar = "█".repeat(Math.round(sa.value * 10));
        console.log(
          `   [${sa.value.toFixed(2)}] ${bar} ${sa.action.type}: ${sa.action.description}`
        );
        if (sa.reasoning) {
          console.log(`          └─ ${sa.reasoning}`);
        }
      }
      break;

    case "select_complete":
      console.log(`${icon} SELECT — Chose: ${event.selected.type}: ${event.selected.description}`);
      break;

    case "act_complete":
      const r = event.result;
      console.log(
        `${icon} ACT — ${r.action.type} ${r.success ? "succeeded" : "FAILED"} (${r.durationMs}ms)`
      );
      if (r.output) {
        const truncated =
          r.output.length > 200 ? r.output.substring(0, 200) + "..." : r.output;
        console.log(`   Output: ${truncated}`);
      }
      if (r.error) {
        console.log(`   Error: ${r.error}`);
      }
      break;

    case "heartbeat_end":
      console.log(`${icon} Heartbeat #${event.heartbeat} complete`);
      break;

    case "loop_paused":
      console.log(`${icon} PAUSED: ${event.reason}`);
      break;

    case "loop_error":
      console.log(`${icon} ERROR on heartbeat #${event.heartbeat}: ${event.error}`);
      break;
  }
}

// ── Main ───────────────────────────────────────────────────

async function main() {
  console.log("🤖 Agent Loop — Phase 1 Demo");
  console.log("━".repeat(60));

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("Error: ANTHROPIC_API_KEY environment variable required");
    process.exit(1);
  }

  const workDir = process.argv[2] || "/tmp/agent-workspace";

  const agent = new SingleAgent({
    agentId: "agent-001",
    workDir,
    heartbeatIntervalMs: 1000,  // 1 second between beats
    maxHeartbeats: 10,          // Stop after 10 beats
    persistState: true,
    apiKey,
    task: {
      taskId: "task-001",
      description:
        "Explore the current environment. Find out what OS we're running, what tools are available (node, python, git, etc.), and create a summary file at workspace/env-report.md.",
      successCriteria: [
        "env-report.md exists with OS info",
        "env-report.md lists available dev tools",
        "env-report.md has a summary section",
      ],
      constraints: [
        "Only use non-destructive commands",
        "Do not install any packages",
        "Complete within 10 heartbeats",
      ],
      context: {},
      priority: 1,
      maxHeartbeats: 10,
    },
  });

  // Subscribe to all events for visibility
  agent.subscribe(logEvent);

  console.log(`\nWorkDir: ${workDir}`);
  console.log(`Task: Explore environment and create report`);
  console.log(`Max heartbeats: 10`);
  console.log(`\nStarting loop...\n`);

  const startTime = Date.now();
  await agent.run();
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\n${"━".repeat(60)}`);
  console.log(`🏁 Loop finished in ${elapsed}s, ${agent.currentHeartbeat} heartbeats`);
  console.log(`\nAction history:`);
  for (const result of agent.getHistory()) {
    console.log(
      `  ${result.success ? "✓" : "✗"} ${result.action.type}: ${result.action.description} (${result.durationMs}ms)`
    );
  }

  console.log(`\nFinal memory:`, agent.getMemory());
}

main().catch(console.error);
