#!/usr/bin/env node

/**
 * Query the replay buffer.
 *
 * Filter transitions by heartbeat range, time, action type, success,
 * tags, episode, text search. Supports random sampling for training.
 *
 * Usage:
 *   node query.mjs --buffer <dir> [filters...] [--sample N] [--latest N] [--full]
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}
const hasFlag = (name) => args.includes(`--${name}`);

const bufferDir = getArg("buffer") ?? "./buffer";
const fromHb = parseInt(getArg("from") ?? "0");
const toHb = parseInt(getArg("to") ?? "999999");
const afterTime = getArg("after") ? new Date(getArg("after")).getTime() : 0;
const beforeTime = getArg("before") ? new Date(getArg("before")).getTime() : Infinity;
const actionType = getArg("action-type");
const successFilter = getArg("success");
const tagFilter = getArg("tag");
const episodeFilter = getArg("episode");
const searchTerm = getArg("search");
const sampleSize = parseInt(getArg("sample") ?? "0");
const latestN = parseInt(getArg("latest") ?? "0");
const full = hasFlag("full");
const statsOnly = hasFlag("stats");

// ── Load index ──────────────────────────────────────────

const indexPath = join(bufferDir, "index.json");
if (!existsSync(indexPath)) {
  console.error(`No replay buffer at ${bufferDir}`);
  process.exit(1);
}

const index = JSON.parse(readFileSync(indexPath, "utf-8"));

// ── Stats mode ──────────────────────────────────────────

if (statsOnly) {
  const actionTypes = {};
  for (const t of index.transitions) {
    actionTypes[t.actionType] = (actionTypes[t.actionType] ?? 0) + 1;
  }

  console.log(JSON.stringify({
    ...index.stats,
    actionTypes,
    episodes: index.episodes.map(e => ({
      id: e.id,
      status: e.status,
      task: e.task,
      transitions: (e.end ?? index.stats.totalTransitions) - e.start + 1,
    })),
    oldestTimestamp: index.transitions[0]?.timestamp,
    newestTimestamp: index.transitions[index.transitions.length - 1]?.timestamp,
  }, null, 2));
  process.exit(0);
}

// ── Filter ──────────────────────────────────────────────

let results = index.transitions.filter(t => {
  if (t.heartbeat < fromHb || t.heartbeat > toHb) return false;
  if (t.timestamp < afterTime || t.timestamp > beforeTime) return false;
  if (actionType && t.actionType !== actionType) return false;
  if (successFilter !== null && successFilter !== undefined) {
    const wantSuccess = successFilter === "true";
    if (t.success !== wantSuccess) return false;
  }
  if (episodeFilter && t.episode !== episodeFilter) return false;
  if (tagFilter) {
    const [tk, tv] = tagFilter.split("=");
    if (!t.tags || t.tags[tk] !== tv) return false;
  }
  return true;
});

// ── Text search (requires loading full transitions) ─────

if (searchTerm) {
  const term = searchTerm.toLowerCase();
  results = results.filter(t => {
    try {
      const transPath = join(bufferDir, "transitions", String(t.id).padStart(6, "0") + ".json");
      const trans = readFileSync(transPath, "utf-8").toLowerCase();
      return trans.includes(term);
    } catch { return false; }
  });
}

// ── Latest N ────────────────────────────────────────────

if (latestN > 0) {
  results = results.slice(-latestN);
}

// ── Random sample ───────────────────────────────────────

if (sampleSize > 0 && results.length > sampleSize) {
  // Fisher-Yates shuffle, take first N
  const shuffled = [...results];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  results = shuffled.slice(0, sampleSize);
}

// ── Load full transitions if requested ──────────────────

let output;
if (full) {
  output = results.map(t => {
    try {
      const transPath = join(bufferDir, "transitions", String(t.id).padStart(6, "0") + ".json");
      return JSON.parse(readFileSync(transPath, "utf-8"));
    } catch { return t; }
  });
} else {
  output = results;
}

// ── Output ──────────────────────────────────────────────

console.log(JSON.stringify({
  query: {
    from: fromHb, to: toHb, actionType, success: successFilter,
    episode: episodeFilter, tag: tagFilter, search: searchTerm,
    sample: sampleSize || null, latest: latestN || null,
  },
  count: output.length,
  totalInBuffer: index.stats.totalTransitions,
  results: output,
}, null, 2));
