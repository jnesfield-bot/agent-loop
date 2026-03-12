#!/usr/bin/env node

/**
 * Render the agent's state onto the blackboard.
 *
 * Takes a State JSON (from the agent loop's observe phase) and produces
 * a structured, dense visual layout. This is the agent's primary
 * observation surface — read first, every heartbeat.
 *
 * Segmented: each section of the board is a named segment with visibility
 * tags. Agents carry a "lens" (a set of tags) that filters which segments
 * they can see. Same board, different views.
 *
 * Inspired by Glyph (arXiv:2510.17800): maximize information density
 * per token. The board packs task, memory, workspace, action history,
 * children, inputs, and skills into a fixed-structure layout.
 *
 * Usage:
 *   node render.mjs --state <state.json> [--format text|markdown|json]
 *                   [--lens tag1,tag2,...] [--diff <prev-board.md>]
 *                   [--segments]
 *
 * Lenses:
 *   --lens executive     Full board (default for executive agents)
 *   --lens worker        Task + last action + memory + workspace
 *   --lens monitor       Children + inputs + task progress
 *   --lens minimal       Task + last action only
 *   --lens tag1,tag2     Custom combination of segment tags
 *
 * List segments:
 *   --segments           Print segment names and their tags, then exit
 */

import { readFileSync, existsSync, openSync, readSync, closeSync } from "fs";

// ── Parse args ──────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}
const hasFlag = (name) => args.includes(`--${name}`);

const stateFile = getArg("state");
const format = getArg("format") ?? "text";
const lensArg = getArg("lens") ?? "executive";
const diffFile = getArg("diff");
const showSegments = hasFlag("segments");

// ── Segment definitions ─────────────────────────────────
//
// Each segment has:
//   name   — unique identifier
//   tags   — visibility tags (agent lens must include at least one to see it)
//   order  — rendering order (lower = higher on the board)
//
// Predefined lenses are shorthand for tag sets:
//   executive → all tags (sees everything)
//   worker    → task, action, memory, workspace, skills
//   monitor   → task, children, inputs, meta
//   minimal   → task, action

const SEGMENTS = [
  { name: "header",    tags: ["meta", "task", "action", "memory", "workspace", "children", "inputs", "skills"], order: 0 },
  { name: "task",      tags: ["task"],                order: 10 },
  { name: "action",    tags: ["action"],              order: 20 },
  { name: "memory",    tags: ["memory"],              order: 30 },
  { name: "workspace", tags: ["workspace"],           order: 40 },
  { name: "inputs",    tags: ["inputs"],              order: 50 },
  { name: "children",  tags: ["children"],            order: 60 },
  { name: "skills",    tags: ["skills"],              order: 70 },
  { name: "active_skill", tags: ["skills", "action"], order: 75 },
  { name: "footer",    tags: ["meta"],                order: 100 },
];

const LENS_PRESETS = {
  executive: new Set(["meta", "task", "action", "memory", "workspace", "children", "inputs", "skills"]),
  worker:    new Set(["task", "action", "memory", "workspace", "skills"]),
  monitor:   new Set(["meta", "task", "children", "inputs"]),
  minimal:   new Set(["task", "action"]),
};

function parseLens(raw) {
  if (LENS_PRESETS[raw]) return LENS_PRESETS[raw];
  return new Set(raw.split(",").map(t => t.trim()).filter(Boolean));
}

const lens = parseLens(lensArg);

function isVisible(segment) {
  return segment.tags.some(t => lens.has(t));
}

// ── List segments mode ──────────────────────────────────

if (showSegments) {
  console.log(JSON.stringify({
    segments: SEGMENTS.map(s => ({ name: s.name, tags: s.tags, order: s.order })),
    presets: Object.fromEntries(Object.entries(LENS_PRESETS).map(([k, v]) => [k, [...v]])),
    activeLens: [...lens],
    visibleSegments: SEGMENTS.filter(isVisible).map(s => s.name),
  }, null, 2));
  process.exit(0);
}

// ── Load state ──────────────────────────────────────────

let state;
if (stateFile) {
  if (!existsSync(stateFile)) {
    console.error(`State file not found: ${stateFile}`);
    process.exit(1);
  }
  state = JSON.parse(readFileSync(stateFile, "utf-8"));
} else {
  // Read from stdin
  let input = "";
  const fd = openSync("/dev/stdin", "r");
  const buf = Buffer.alloc(65536);
  let n;
  while ((n = readSync(fd, buf)) > 0) input += buf.slice(0, n).toString();
  closeSync(fd);
  state = JSON.parse(input);
}

// ── Load previous board for diff ────────────────────────

let prevBoard = null;
if (diffFile && existsSync(diffFile)) {
  prevBoard = readFileSync(diffFile, "utf-8");
}

// ── Helpers ─────────────────────────────────────────────

const W = 54;
const HR = "═".repeat(W);
const hr = "─".repeat(W - 2);

function pad(str, width = W - 2) {
  if (str.length > width) return str.substring(0, width - 1) + "…";
  return str + " ".repeat(width - str.length);
}

function box(title, lines) {
  const out = [];
  out.push(`╠${HR}╣`);
  out.push(`║  ${pad(title)}║`);
  out.push(`║  ┌${hr}┐║`);
  for (const line of lines) {
    out.push(`║  │${pad(" " + line, W - 4)}│║`);
  }
  out.push(`║  └${hr}┘║`);
  return out;
}

function progressBar(pct, width = 20) {
  const filled = Math.round(pct * width);
  return "█".repeat(filled) + "░".repeat(width - filled) + ` ${Math.round(pct * 100)}%`;
}

// ── Segment Renderers (text format) ─────────────────────

const renderers = {
  header(s) {
    const now = new Date(s.timestamp ?? Date.now());
    const time = now.toISOString().substring(11, 16);
    const hb = s.heartbeat ?? "?";
    const lensLabel = lensArg;
    return [
      `╔${HR}╗`,
      `║  ${pad(`BOARD #${hb}  [${lensLabel}]${" ".repeat(20)}${time}`)}║`,
    ];
  },

  task(s) {
    if (!s.currentTask) return box("TASK", ["(no active task)"]);
    const t = s.currentTask;
    const lines = [];
    lines.push(`Description: ${t.description ?? "none"}`);
    if (t.successCriteria?.length) {
      for (const c of t.successCriteria) lines.push(`  ☐ ${c}`);
    }
    if (t.constraints?.length) lines.push(`Constraints: ${t.constraints.join(", ")}`);
    if (t.priority != null) lines.push(`Priority: ${t.priority}`);
    return box("TASK", lines);
  },

  action(s) {
    if (!s.lastActionResult) return [];
    const r = s.lastActionResult;
    const lines = [];
    const kind = r.action?.kind ?? "primitive";
    const type = kind === "skill" ? `skill:${r.action.skillName}` : r.action?.type ?? "?";
    const status = r.success ? "✓" : "✗";
    lines.push(`${type} ${status}  (${r.durationMs ?? "?"}ms)`);
    if (r.action?.type === "bash") {
      lines.push(`$ ${(r.action.params?.command ?? "").toString().substring(0, 80)}`);
    } else if (r.action?.type === "read" || r.action?.type === "write") {
      lines.push(`Path: ${r.action.params?.path ?? "?"}`);
    }
    if (r.output) {
      const outLines = r.output.split("\n").slice(0, 5);
      for (const ol of outLines) lines.push(`  ${ol.substring(0, 70)}`);
      const total = r.output.split("\n").length;
      if (total > 5) lines.push(`  ... (${total - 5} more lines)`);
    }
    if (r.error) lines.push(`ERROR: ${r.error.substring(0, 80)}`);
    if (r.skillTrace) {
      lines.push(`Skill: ${r.skillTrace.steps.length} steps, ${r.skillTrace.complete ? "complete" : "failed"}`);
    }
    return box("LAST ACTION", lines);
  },

  memory(s) {
    const memKeys = Object.keys(s.memory ?? {});
    if (!memKeys.length) return box("MEMORY", ["(empty)"]);
    const lines = [];
    for (const k of memKeys.slice(0, 10)) {
      lines.push(`${k}: ${String(s.memory[k]).substring(0, 60)}`);
    }
    if (memKeys.length > 10) lines.push(`... (${memKeys.length - 10} more)`);
    return box(`MEMORY (${memKeys.length} keys)`, lines);
  },

  workspace(s) {
    const filesStr = s.observations?.workspace_files;
    if (!filesStr || typeof filesStr !== "string") return [];
    const files = filesStr.split("\n").filter(Boolean);
    const lines = files.slice(0, 15).map(f => f.substring(0, 70));
    if (files.length > 15) lines.push(`... (${files.length - 15} more)`);
    return box(`WORKSPACE (${files.length} files)`, lines);
  },

  inputs(s) {
    const inputs = s.inputs ?? [];
    if (!inputs.length) return [];
    const lines = inputs.slice(0, 5).map(i => `[${i.source}] ${i.content?.substring(0, 60)}`);
    if (inputs.length > 5) lines.push(`... (${inputs.length - 5} more)`);
    return box(`INPUTS (${inputs.length} pending)`, lines);
  },

  children(s) {
    const children = s.children ?? [];
    if (!children.length) return [];
    const lines = children.map(c => {
      const bar = progressBar(c.progress, 10);
      return `${c.agentId} [${c.status}] ${bar} task:${c.taskId}`;
    });
    return box(`CHILDREN (${children.length})`, lines);
  },

  skills(s) {
    const skills = s.availableSkills ?? [];
    if (!skills.length) return [];
    const names = skills.map(sk => sk.name).join("  ");
    return box(`SKILLS (${skills.length} available)`, [names]);
  },

  active_skill(s) {
    if (!s.activeSkill) return [];
    const as = s.activeSkill;
    return box("ACTIVE SKILL", [
      `Skill: ${as.skill?.name}`,
      `Goal: ${as.goal?.substring(0, 60)}`,
      `Step: ${as.currentStep + 1}/${as.steps?.length}`,
      `Status: ${as.complete ? "complete" : as.failed ? "FAILED" : "running"}`,
    ]);
  },

  footer() {
    return [`╚${HR}╝`];
  },
};

// ── Segment Renderers (JSON format) ─────────────────────

const jsonRenderers = {
  header(s) { return { heartbeat: s.heartbeat ?? "?", timestamp: s.timestamp, lens: lensArg }; },
  task(s) {
    if (!s.currentTask) return null;
    return { description: s.currentTask.description, criteria: s.currentTask.successCriteria, priority: s.currentTask.priority, constraints: s.currentTask.constraints };
  },
  action(s) {
    if (!s.lastActionResult) return null;
    const r = s.lastActionResult;
    return { type: r.action?.type, success: r.success, output: r.output?.substring(0, 500), error: r.error, skillTrace: r.skillTrace ? { steps: r.skillTrace.steps.length, complete: r.skillTrace.complete } : undefined };
  },
  memory(s) { return s.memory ?? {}; },
  workspace(s) { return s.observations?.workspace_files ?? null; },
  inputs(s) { return (s.inputs ?? []).map(i => ({ source: i.source, content: i.content })); },
  children(s) { return (s.children ?? []).map(c => ({ id: c.agentId, status: c.status, progress: c.progress, task: c.taskId })); },
  skills(s) { return (s.availableSkills ?? []).map(sk => ({ name: sk.name, description: sk.description })); },
  active_skill(s) { return s.activeSkill ? { name: s.activeSkill.skill?.name, step: s.activeSkill.currentStep, total: s.activeSkill.steps?.length } : null; },
  footer() { return undefined; },
};

// ── Segment Renderers (Markdown format) ─────────────────

const mdRenderers = {
  header(s) {
    const hb = s.heartbeat ?? "?";
    const time = new Date(s.timestamp ?? Date.now()).toISOString();
    return `# Board — Heartbeat #${hb} [${lensArg}]\n\n_${time}_\n`;
  },
  task(s) {
    if (!s.currentTask) return "## Task\n\n_(no active task)_\n";
    let out = `## Task\n\n**${s.currentTask.description}**\n\n`;
    if (s.currentTask.successCriteria?.length) {
      out += "Criteria:\n";
      for (const c of s.currentTask.successCriteria) out += `- [ ] ${c}\n`;
    }
    return out;
  },
  action(s) {
    if (!s.lastActionResult) return "";
    const r = s.lastActionResult;
    let out = `## Last Action\n\n`;
    out += `| Field | Value |\n|-------|-------|\n`;
    out += `| Type | \`${r.action?.type}\` |\n`;
    out += `| Status | ${r.success ? "✓" : "✗"} |\n`;
    if (r.output) out += `| Output | ${r.output.substring(0, 200).replace(/\n/g, " ")} |\n`;
    if (r.error) out += `| Error | ${r.error} |\n`;
    return out + "\n";
  },
  memory(s) {
    const keys = Object.keys(s.memory ?? {});
    if (!keys.length) return "";
    let out = `## Memory (${keys.length} keys)\n\n| Key | Value |\n|-----|-------|\n`;
    for (const k of keys) out += `| ${k} | ${String(s.memory[k]).substring(0, 80)} |\n`;
    return out + "\n";
  },
  workspace(s) {
    const f = s.observations?.workspace_files;
    if (!f) return "";
    return `## Workspace\n\n\`\`\`\n${f}\n\`\`\`\n\n`;
  },
  inputs(s) {
    if (!(s.inputs ?? []).length) return "";
    let out = `## Inputs\n\n`;
    for (const i of s.inputs) out += `- **[${i.source}]** ${i.content}\n`;
    return out + "\n";
  },
  children(s) {
    if (!(s.children ?? []).length) return "";
    let out = `## Children\n\n| Agent | Status | Progress | Task |\n|-------|--------|----------|------|\n`;
    for (const c of s.children) out += `| ${c.agentId} | ${c.status} | ${Math.round(c.progress * 100)}% | ${c.taskId} |\n`;
    return out + "\n";
  },
  skills(s) {
    if (!(s.availableSkills ?? []).length) return "";
    let out = `## Skills\n\n`;
    for (const sk of s.availableSkills) out += `- **${sk.name}**: ${sk.description?.substring(0, 80)}\n`;
    return out + "\n";
  },
  active_skill(s) {
    if (!s.activeSkill) return "";
    const as = s.activeSkill;
    return `## Active Skill\n\n**${as.skill?.name}** — step ${as.currentStep + 1}/${as.steps?.length}\n\nGoal: ${as.goal}\n\n`;
  },
  footer() { return "---\n"; },
};

// ── Render dispatch ─────────────────────────────────────

const visible = SEGMENTS.filter(isVisible).sort((a, b) => a.order - b.order);

let output;

if (format === "json") {
  const obj = {};
  for (const seg of visible) {
    if (jsonRenderers[seg.name]) {
      const val = jsonRenderers[seg.name](state);
      if (val !== undefined) obj[seg.name] = val;
    }
  }
  output = JSON.stringify(obj, null, 2);

} else if (format === "markdown" || format === "md") {
  const parts = [];
  for (const seg of visible) {
    if (mdRenderers[seg.name]) {
      const val = mdRenderers[seg.name](state);
      if (val) parts.push(val);
    }
  }
  output = parts.join("");

} else {
  // text format
  const lines = [];
  for (const seg of visible) {
    if (renderers[seg.name]) {
      lines.push(...renderers[seg.name](state));
    }
  }
  output = lines.join("\n");
}

console.log(output);
