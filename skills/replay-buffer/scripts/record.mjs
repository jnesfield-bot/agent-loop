#!/usr/bin/env node

/**
 * Record a transition into the replay buffer.
 *
 * Stores the full heartbeat transition: board snapshot, action candidates,
 * selected action, result, and any attachments. Updates the master index.
 *
 * Usage:
 *   node record.mjs --buffer <dir> --board <file> --action <file> --result <file> [--attach <file> ...] [--tag key=value ...] [--episode <id>]
 *   echo '{"board":"...","action":{...},"result":{...}}' | node record.mjs --buffer <dir>
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, statSync } from "fs";
import { join, basename, dirname } from "path";

// ── Parse args ──────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}
function getAllArgs(name) {
  const results = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}` && i + 1 < args.length) results.push(args[++i]);
  }
  return results;
}

const bufferDir = getArg("buffer") ?? "./buffer";
const boardFile = getArg("board");
const actionFile = getArg("action");
const resultFile = getArg("result");
const candidatesFile = getArg("candidates");
const stateFile = getArg("state");
const episodeId = getArg("episode");
const agentId = getArg("agent") ?? "agent-1";
const heartbeat = parseInt(getArg("heartbeat") ?? "0");
const attachFiles = getAllArgs("attach");
const tagArgs = getAllArgs("tag");

// Parse tags
const tags = {};
for (const t of tagArgs) {
  const eq = t.indexOf("=");
  if (eq > 0) tags[t.slice(0, eq)] = t.slice(eq + 1);
}

// ── Ensure directories ──────────────────────────────────

for (const sub of ["transitions", "boards", "media", "episodes"]) {
  mkdirSync(join(bufferDir, sub), { recursive: true });
}

// ── Load or create index ────────────────────────────────

const indexPath = join(bufferDir, "index.json");
let index;
if (existsSync(indexPath)) {
  index = JSON.parse(readFileSync(indexPath, "utf-8"));
} else {
  index = {
    bufferVersion: 1,
    agentId,
    created: new Date().toISOString(),
    transitions: [],
    episodes: [],
    stats: { totalTransitions: 0, totalEpisodes: 0, successRate: 0, avgDurationMs: 0 },
  };
}

// ── Load transition data ────────────────────────────────

let transitionInput = {};

// Check stdin first (non-blocking check)
if (!boardFile && !actionFile && !resultFile) {
  try {
    const { openSync, readSync, closeSync } = await import("fs");
    let input = "";
    const fd = openSync("/dev/stdin", "r");
    const buf = Buffer.alloc(1024 * 1024);
    const n = readSync(fd, buf, 0, buf.length, null);
    closeSync(fd);
    if (n > 0) transitionInput = JSON.parse(buf.slice(0, n).toString());
  } catch { /* no stdin */ }
}

// Load from files (override stdin)
const board = boardFile && existsSync(boardFile)
  ? readFileSync(boardFile, "utf-8")
  : transitionInput.board ?? "";

const action = actionFile && existsSync(actionFile)
  ? JSON.parse(readFileSync(actionFile, "utf-8"))
  : transitionInput.action ?? transitionInput.selected ?? null;

const result = resultFile && existsSync(resultFile)
  ? JSON.parse(readFileSync(resultFile, "utf-8"))
  : transitionInput.result ?? null;

const candidates = candidatesFile && existsSync(candidatesFile)
  ? JSON.parse(readFileSync(candidatesFile, "utf-8"))
  : transitionInput.candidates ?? [];

const stateData = stateFile && existsSync(stateFile)
  ? JSON.parse(readFileSync(stateFile, "utf-8"))
  : transitionInput.state ?? null;

// Merge tags from input
if (transitionInput.tags) Object.assign(tags, transitionInput.tags);

// ── Assign transition ID ────────────────────────────────

const id = index.stats.totalTransitions + 1;
const paddedId = String(id).padStart(6, "0");
const hb = transitionInput.heartbeat ?? (heartbeat || id);
const ts = transitionInput.timestamp ?? Date.now();
const ep = transitionInput.episodeId ?? episodeId ?? null;

// ── Store board snapshot ────────────────────────────────

const boardRef = `boards/${paddedId}.txt`;
writeFileSync(join(bufferDir, boardRef), board);

// ── Store attachments ───────────────────────────────────

const attachments = [];
const mediaDir = join(bufferDir, "media", paddedId);

// Attachments from CLI
for (const file of attachFiles) {
  if (!existsSync(file)) continue;
  mkdirSync(mediaDir, { recursive: true });
  const name = basename(file);
  const dest = join(mediaDir, name);
  copyFileSync(file, dest);
  const stat = statSync(file);
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const type = ["json"].includes(ext) ? "json"
    : ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext) ? "image"
    : ["py", "ts", "js", "mjs", "sh", "tex", "md", "txt"].includes(ext) ? "file"
    : "binary";
  attachments.push({ name, type, ref: `media/${paddedId}/${name}`, size: stat.size });
}

// Attachments from input
if (transitionInput.attachments) {
  for (const att of transitionInput.attachments) {
    if (att.content) {
      mkdirSync(mediaDir, { recursive: true });
      const dest = join(mediaDir, att.name);
      writeFileSync(dest, typeof att.content === "string" ? att.content : JSON.stringify(att.content, null, 2));
      attachments.push({
        name: att.name,
        type: att.type ?? "text",
        ref: `media/${paddedId}/${att.name}`,
        size: Buffer.byteLength(typeof att.content === "string" ? att.content : JSON.stringify(att.content)),
      });
    }
  }
}

// ── Compute metrics ─────────────────────────────────────

const resultDuration = result?.durationMs ?? 0;
const selectedValue = candidates.length > 0
  ? Math.max(...candidates.map(c => c.value ?? 0))
  : 0;

const metrics = {
  selectedValue,
  candidateCount: candidates.length,
  evaluateMs: transitionInput.evaluateMs ?? 0,
  actMs: resultDuration,
  totalMs: transitionInput.totalMs ?? resultDuration,
};

// Auto-tag
tags.actionType = action?.type ?? action?.kind ?? "unknown";
if (action?.kind === "skill") tags.skill = action.skillName ?? "unknown";

// ── Compact state summary ───────────────────────────────

const stateSummary = stateData ? {
  taskDescription: stateData.currentTask?.description ?? null,
  memoryKeys: Object.keys(stateData.memory ?? {}),
  fileCount: (stateData.observations?.workspace_files ?? "").split("\n").filter(Boolean).length,
  inputCount: (stateData.inputs ?? []).length,
  childCount: (stateData.children ?? []).length,
} : transitionInput.stateSummary ?? null;

// ── Build transition record ─────────────────────────────

const transition = {
  id,
  heartbeat: hb,
  timestamp: ts,
  agentId: transitionInput.agentId ?? agentId,
  episodeId: ep,
  board,
  boardRef,
  state: stateSummary,
  candidates,
  selected: action,
  result,
  attachments,
  tags,
  metrics,
};

// ── Write transition file ───────────────────────────────

const transPath = join(bufferDir, "transitions", `${paddedId}.json`);
writeFileSync(transPath, JSON.stringify(transition, null, 2));

// ── Update index ────────────────────────────────────────

index.transitions.push({
  id,
  heartbeat: hb,
  timestamp: ts,
  actionType: tags.actionType,
  success: result?.success ?? null,
  episode: ep,
  tags,
});

// Update episode tracking
if (ep) {
  let episode = index.episodes.find(e => e.id === ep);
  if (!episode) {
    episode = { id: ep, start: id, end: null, status: "running", task: stateSummary?.taskDescription ?? "" };
    index.episodes.push(episode);
    index.stats.totalEpisodes = index.episodes.length;
  }
  if (action?.type === "complete") {
    episode.end = id;
    episode.status = result?.success ? "completed" : "failed";
  }
}

// Update stats
index.stats.totalTransitions = index.transitions.length;
const successes = index.transitions.filter(t => t.success === true).length;
const total = index.transitions.filter(t => t.success !== null).length;
index.stats.successRate = total > 0 ? successes / total : 0;

const durations = index.transitions
  .map((_, i) => {
    try {
      const t = JSON.parse(readFileSync(join(bufferDir, "transitions", String(i + 1).padStart(6, "0") + ".json"), "utf-8"));
      return t.metrics?.actMs ?? 0;
    } catch { return 0; }
  });
index.stats.avgDurationMs = durations.length > 0
  ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
  : 0;

writeFileSync(indexPath, JSON.stringify(index, null, 2));

// ── Output ──────────────────────────────────────────────

const summary = {
  recorded: id,
  heartbeat: hb,
  actionType: tags.actionType,
  success: result?.success ?? null,
  attachments: attachments.length,
  episode: ep,
  bufferSize: index.stats.totalTransitions,
};

console.log(JSON.stringify(summary, null, 2));
