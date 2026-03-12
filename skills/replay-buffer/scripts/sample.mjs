#!/usr/bin/env node

/**
 * Sample a minibatch from the replay buffer.
 *
 * Rainbow-inspired sampling strategies (arXiv:1710.02298):
 *
 *   uniform     — DQN-style random sampling
 *   prioritized — Priority = novelty × usefulness (Rainbow's key insight)
 *   recent      — Last N transitions
 *   failures    — Only failed transitions
 *   rainbow     — Full Rainbow-style: priority + multi-step chaining +
 *                 importance sampling weights for bias correction
 *
 * Priority scoring (inspired by prioritized replay + distributional RL):
 *   Novelty:    How different was this transition from expectations?
 *               High value-prediction error → high novelty (TD-error analog)
 *   Usefulness: How much learning potential remains?
 *               Failures, first-time actions, high-variance outcomes → useful
 *   Recency:    Recent transitions get a mild boost (but not dominant)
 *
 * Usage:
 *   node sample.mjs --buffer <dir> --size N [--strategy uniform|prioritized|recent|failures|rainbow]
 *   node sample.mjs --buffer <dir> --size 32 --strategy rainbow --omega 0.6 --beta 0.4
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
// Rainbow hyperparams
const omega = parseFloat(getArg("omega") ?? "0.6");  // Priority exponent (how much to prioritize)
const beta = parseFloat(getArg("beta") ?? "0.4");     // IS correction exponent (0=no correction, 1=full)

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

/**
 * Score a transition's priority: novelty × usefulness.
 *
 * Rainbow insight: sample proportional to |TD error|^ω.
 * Our analog: TD error ≈ how surprising/useful the outcome was.
 *
 * Novelty (surprise — how different from expectations):
 *   - First occurrence of this action type → high novelty
 *   - Failure when success was expected (or vice versa) → high novelty
 *   - Value prediction far from outcome → high novelty
 *
 * Usefulness (learning potential — how much we can learn):
 *   - Failures have more to teach than successes
 *   - Rare action types have more to teach than common ones
 *   - High candidate spread → agent was uncertain → more useful
 *
 * Recency: mild boost for recent transitions (not dominant).
 */
function scorePriority(entry, idx, pool, actionCounts) {
  const totalEntries = pool.length;

  // ── Novelty ────────────────────────────────────────
  const actionType = entry.actionType ?? "unknown";
  const actionFreq = (actionCounts[actionType] ?? 1) / totalEntries;
  const rarityScore = 1 - actionFreq;  // Rare actions → high novelty

  // If we have value info, use prediction error as novelty
  // (loaded transitions have metrics.selectedValue)
  let predictionSurprise = 0.5;  // default: moderate surprise
  if (entry.success === false) predictionSurprise = 0.8;  // failures are surprising
  if (entry.success === true && actionFreq > 0.3) predictionSurprise = 0.2;  // common success = boring

  const novelty = 0.6 * rarityScore + 0.4 * predictionSurprise;

  // ── Usefulness ─────────────────────────────────────
  let usefulness = 0.5;
  if (entry.success === false) usefulness += 0.3;  // Failures teach more
  if (actionFreq < 0.1) usefulness += 0.2;         // Rare actions teach more
  usefulness = Math.min(1.0, usefulness);

  // ── Recency ────────────────────────────────────────
  const recency = 0.3 + 0.7 * (idx / totalEntries);  // 0.3 to 1.0

  // ── Combined priority ──────────────────────────────
  // P(i) ∝ (novelty × usefulness × recency)^ω
  const rawPriority = novelty * usefulness * recency;
  return Math.pow(Math.max(rawPriority, 1e-6), omega);
}

function samplePrioritized(pool, n) {
  // Count action types for rarity scoring
  const actionCounts = {};
  for (const t of pool) {
    const at = t.actionType ?? "unknown";
    actionCounts[at] = (actionCounts[at] ?? 0) + 1;
  }

  // Score all transitions
  const weighted = pool.map((t, idx) => ({
    entry: t,
    priority: scorePriority(t, idx, pool, actionCounts),
  }));

  const totalPriority = weighted.reduce((s, w) => s + w.priority, 0);
  const selected = [];
  const used = new Set();

  // Proportional sampling: P(i) = priority_i / Σ priority
  for (let i = 0; i < Math.min(n, pool.length); i++) {
    let r = Math.random() * totalPriority;
    for (const w of weighted) {
      if (used.has(w.entry.id)) continue;
      r -= w.priority;
      if (r <= 0) {
        selected.push({ ...w.entry, _priority: w.priority, _samplingProb: w.priority / totalPriority });
        used.add(w.entry.id);
        break;
      }
    }
  }
  return selected;
}

/**
 * Rainbow-style sampling: prioritized + importance sampling weights + multi-step chaining.
 *
 * From Rainbow (arXiv:1710.02298):
 *   - Prioritized by KL divergence (we use novelty × usefulness)
 *   - Importance sampling weights correct for the non-uniform sampling bias
 *   - Multi-step: when we sample a transition, also include its temporal neighbors
 */
function sampleRainbow(pool, n) {
  // Step 1: Prioritized sample
  const prioritized = samplePrioritized(pool, Math.ceil(n * 0.7));  // 70% prioritized

  // Step 2: Multi-step chaining — for each sampled transition,
  // also grab its temporal neighbors (n-step returns analog)
  const chainLength = 3;  // Look at 3-step sequences
  const chained = new Map();

  for (const entry of prioritized) {
    chained.set(entry.id, entry);
    // Find neighbors in same episode within ±chainLength heartbeats
    const hb = entry.heartbeat ?? 0;
    const ep = entry.episode;
    for (const t of pool) {
      if (t.episode === ep && Math.abs((t.heartbeat ?? 0) - hb) <= chainLength && !chained.has(t.id)) {
        chained.set(t.id, { ...t, _priority: 0.5, _samplingProb: 0, _chained: true });
      }
    }
  }

  // Step 3: Fill remaining slots with uniform samples for diversity
  const remaining = n - chained.size;
  if (remaining > 0) {
    const usedIds = new Set(chained.keys());
    const unused = pool.filter(t => !usedIds.has(t.id));
    const uniform = sampleUniform(unused, remaining);
    for (const t of uniform) {
      chained.set(t.id, { ...t, _priority: 0.1, _samplingProb: 1 / pool.length });
    }
  }

  // Step 4: Compute importance sampling weights (bias correction)
  // w_i = (N * P(i))^(-β) / max(w)
  const N = pool.length;
  let maxWeight = 0;
  const result = [...chained.values()].map(entry => {
    const prob = entry._samplingProb || (1 / N);
    const rawWeight = Math.pow(N * prob, -beta);
    if (rawWeight > maxWeight) maxWeight = rawWeight;
    return { ...entry, _isWeight: rawWeight };
  });

  // Normalize weights
  for (const r of result) {
    r._isWeight = r._isWeight / (maxWeight || 1);
  }

  return result.slice(0, n);
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
  case "rainbow":
    sampled = sampleRainbow(pool, batchSize);
    break;
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
