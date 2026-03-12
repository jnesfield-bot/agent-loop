#!/usr/bin/env node

/**
 * Replay transitions from the buffer — reconstruct what the agent saw and did.
 *
 * Supports episode replay, heartbeat ranges, diff mode (show what changed
 * between boards), and JSONL export for analysis pipelines.
 *
 * Usage:
 *   node replay.mjs --buffer <dir> [--episode <id>] [--from N] [--to N] [--diff] [--format text|jsonl|json]
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";

const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}
const hasFlag = (name) => args.includes(`--${name}`);

const bufferDir = getArg("buffer") ?? "./buffer";
const episodeId = getArg("episode");
const fromHb = parseInt(getArg("from") ?? "0");
const toHb = parseInt(getArg("to") ?? "999999");
const format = getArg("format") ?? "text";
const showDiff = hasFlag("diff");
const compact = hasFlag("compact");

// ── Load index ──────────────────────────────────────────

const indexPath = join(bufferDir, "index.json");
if (!existsSync(indexPath)) {
  console.error(`No replay buffer at ${bufferDir}`);
  process.exit(1);
}

const index = JSON.parse(readFileSync(indexPath, "utf-8"));

// ── Select transitions ──────────────────────────────────

let entries = index.transitions;

if (episodeId) {
  const episode = index.episodes.find(e => e.id === episodeId);
  if (!episode) {
    console.error(`Episode not found: ${episodeId}`);
    console.error(`Available: ${index.episodes.map(e => e.id).join(", ")}`);
    process.exit(1);
  }
  const end = episode.end ?? index.stats.totalTransitions;
  entries = entries.filter(t => t.id >= episode.start && t.id <= end);
}

entries = entries.filter(t => t.heartbeat >= fromHb && t.heartbeat <= toHb);

// ── Load full transitions ───────────────────────────────

function loadTransition(id) {
  const padded = String(id).padStart(6, "0");
  const path = join(bufferDir, "transitions", `${padded}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

// ── Simple line diff ────────────────────────────────────

function diffBoards(prev, curr) {
  if (!prev) return curr.split("\n").map(l => `+ ${l}`).join("\n");
  const prevLines = prev.split("\n");
  const currLines = curr.split("\n");
  const out = [];

  const maxLen = Math.max(prevLines.length, currLines.length);
  for (let i = 0; i < maxLen; i++) {
    const pl = prevLines[i] ?? "";
    const cl = currLines[i] ?? "";
    if (pl === cl) {
      if (!compact) out.push(`  ${cl}`);
    } else if (!pl) {
      out.push(`+ ${cl}`);
    } else if (!cl) {
      out.push(`- ${pl}`);
    } else {
      out.push(`- ${pl}`);
      out.push(`+ ${cl}`);
    }
  }

  return out.join("\n");
}

// ── Render: Text ────────────────────────────────────────

if (format === "text") {
  let prevBoard = null;

  console.error(`\n  Replay: ${entries.length} transitions`);
  if (episodeId) console.error(`  Episode: ${episodeId}`);
  console.error(`  ${"─".repeat(60)}\n`);

  for (const entry of entries) {
    const trans = loadTransition(entry.id);
    if (!trans) continue;

    const time = new Date(trans.timestamp).toISOString().substring(11, 19);
    const status = trans.result?.success ? "✓" : trans.result?.success === false ? "✗" : "?";
    const actionDesc = trans.selected?.kind === "skill"
      ? `skill:${trans.selected.skillName}`
      : trans.selected?.type ?? "?";

    console.error(`  ┌── Heartbeat #${trans.heartbeat} ──── ${time} ──── ${status} ──┐`);
    console.error(`  │  Action: ${actionDesc}`);
    if (trans.selected?.description) {
      console.error(`  │  Desc:   ${trans.selected.description.substring(0, 60)}`);
    }
    if (trans.candidates?.length > 0) {
      console.error(`  │  Candidates: ${trans.candidates.length} (top: ${trans.metrics?.selectedValue?.toFixed(2) ?? "?"})`);
    }
    if (trans.result) {
      console.error(`  │  Result: ${status} (${trans.result.durationMs ?? "?"}ms)`);
      if (trans.result.output) {
        const lines = trans.result.output.split("\n").slice(0, 3);
        for (const l of lines) console.error(`  │    ${l.substring(0, 65)}`);
        if (trans.result.output.split("\n").length > 3) console.error(`  │    ...`);
      }
      if (trans.result.error) console.error(`  │  Error: ${trans.result.error.substring(0, 60)}`);
    }
    if (trans.attachments?.length > 0) {
      console.error(`  │  Attachments: ${trans.attachments.map(a => a.name).join(", ")}`);
    }

    if (showDiff && trans.board) {
      console.error(`  │`);
      console.error(`  │  Board diff:`);
      const diff = diffBoards(prevBoard, trans.board);
      const diffLines = diff.split("\n").filter(l => l.startsWith("+") || l.startsWith("-"));
      for (const l of diffLines.slice(0, 10)) {
        console.error(`  │    ${l}`);
      }
      if (diffLines.length > 10) console.error(`  │    ... (${diffLines.length - 10} more changes)`);
      if (diffLines.length === 0) console.error(`  │    (no changes)`);
    }

    console.error(`  └${"─".repeat(58)}┘`);
    console.error();

    if (trans.board) prevBoard = trans.board;
  }

  // Summary
  const successes = entries.filter(e => e.success === true).length;
  const failures = entries.filter(e => e.success === false).length;
  console.error(`  Summary: ${entries.length} steps, ${successes} ✓, ${failures} ✗`);
  console.error();
}

// ── Render: JSONL ───────────────────────────────────────

else if (format === "jsonl") {
  for (const entry of entries) {
    const trans = loadTransition(entry.id);
    if (trans) {
      // Strip the full board text for JSONL (keep ref)
      const slim = { ...trans };
      delete slim.board;
      console.log(JSON.stringify(slim));
    }
  }
}

// ── Render: JSON ────────────────────────────────────────

else {
  const transitions = entries
    .map(e => loadTransition(e.id))
    .filter(Boolean);
  console.log(JSON.stringify({ episode: episodeId, transitions }, null, 2));
}
