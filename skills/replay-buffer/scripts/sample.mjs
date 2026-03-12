#!/usr/bin/env node

/**
 * Sample a minibatch from the replay buffer.
 *
 * Implements uniform random sampling (DQN-style) and prioritized
 * sampling (weight by recency, value spread, or failure).
 *
 * Usage:
 *   node sample.mjs --buffer <dir> --size N [--strategy uniform|prioritized|recent|failures]
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

const bufferDir = getArg("buffer") ?? "./buffer";
const batchSize = parseInt(getArg("size") ?? "32");
const strategy = getArg("strategy") ?? "uniform";
const episodeFilter = getArg("episode");

// ── Load index ──────────────────────────────────────────

const indexPath = join(bufferDir, "index.json");
if (!existsSync(indexPath)) {
  console.error(`No replay buffer at ${bufferDir}`);
  process.exit(1);
}

const index = JSON.parse(readFileSync(indexPath, "utf-8"));
let pool = [...index.transitions];

if (episodeFilter) {
  pool = pool.filter(t => t.episode === episodeFilter);
}

if (pool.length === 0) {
  console.log(JSON.stringify({ strategy, requested: batchSize, sampled: 0, transitions: [] }));
  process.exit(0);
}

// ── Sampling strategies ─────────────────────────────────

function loadTransition(id) {
  const path = join(bufferDir, "transitions", String(id).padStart(6, "0") + ".json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

function sampleUniform(pool, n) {
  // Fisher-Yates
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, n);
}

function samplePrioritized(pool, n) {
  // Weight by: recency (linear), failure (2x), and candidate spread
  // Priority P(i) = (rank_recency + failure_bonus) / sum
  const weighted = pool.map((t, idx) => {
    let weight = (idx + 1) / pool.length; // recency: newer = higher weight
    if (t.success === false) weight *= 2.0; // failures are more informative
    return { entry: t, weight };
  });

  const totalWeight = weighted.reduce((s, w) => s + w.weight, 0);
  const selected = [];
  const used = new Set();

  for (let i = 0; i < Math.min(n, pool.length); i++) {
    let r = Math.random() * totalWeight;
    for (const w of weighted) {
      if (used.has(w.entry.id)) continue;
      r -= w.weight;
      if (r <= 0) {
        selected.push(w.entry);
        used.add(w.entry.id);
        break;
      }
    }
  }
  return selected;
}

function sampleRecent(pool, n) {
  return pool.slice(-n);
}

function sampleFailures(pool, n) {
  const failures = pool.filter(t => t.success === false);
  if (failures.length <= n) return failures;
  return sampleUniform(failures, n);
}

// ── Execute strategy ────────────────────────────────────

let sampled;
switch (strategy) {
  case "prioritized":
    sampled = samplePrioritized(pool, batchSize);
    break;
  case "recent":
    sampled = sampleRecent(pool, batchSize);
    break;
  case "failures":
    sampled = sampleFailures(pool, batchSize);
    break;
  case "uniform":
  default:
    sampled = sampleUniform(pool, batchSize);
    break;
}

// ── Load full transitions ───────────────────────────────

const transitions = sampled
  .map(entry => loadTransition(entry.id))
  .filter(Boolean)
  .map(t => {
    // Slim down for output: keep board ref not full text
    const { board, ...rest } = t;
    return rest;
  });

// ── Output ──────────────────────────────────────────────

console.log(JSON.stringify({
  strategy,
  requested: batchSize,
  sampled: transitions.length,
  poolSize: pool.length,
  transitions,
}, null, 2));
