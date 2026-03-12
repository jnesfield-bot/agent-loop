#!/usr/bin/env node

/**
 * Write to the tri-store memory system.
 *
 * Stores:
 *   episodic  — auto-captured transitions (delegates to replay-buffer)
 *   semantic  — entities, facts, relationships
 *   procedural — learned rules, procedures, patterns
 *
 * Usage:
 *   # Write a semantic entity
 *   node write.mjs --store semantic --dir /tmp/memory \
 *     --entity '{"id":"react","type":"framework","facts":["component-based","uses JSX"]}'
 *
 *   # Write a semantic relationship
 *   node write.mjs --store semantic --dir /tmp/memory \
 *     --relationship '{"from":"login","to":"auth","type":"requires"}'
 *
 *   # Write a procedural rule (learned from experience)
 *   node write.mjs --store procedural --dir /tmp/memory \
 *     --rule '{"id":"read-docs-first","description":"Read docs before implementing","confidence":0.85,"source":"ep-abc123"}'
 *
 *   # Write a procedural pattern (multi-step)
 *   node write.mjs --store procedural --dir /tmp/memory \
 *     --procedure '{"id":"setup-react","steps":["npx create-react-app","npm install"],"successRate":0.9}'
 *
 *   # Pipe episodic transition (same as replay-buffer record)
 *   echo '{"heartbeat":1,...}' | node write.mjs --store episodic --dir /tmp/memory
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

const store = getArg("store") ?? "semantic";
const dir = getArg("dir") ?? "/tmp/memory";

// Ensure store directories exist
const storeDir = join(dir, store);
mkdirSync(storeDir, { recursive: true });

// ── Helpers ─────────────────────────────────────────────

function loadStore(filename) {
  const path = join(storeDir, filename);
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf-8"));
}

function saveStore(filename, data) {
  writeFileSync(join(storeDir, filename), JSON.stringify(data, null, 2));
}

function loadArray(filename) {
  const path = join(storeDir, filename);
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf-8"));
}

function saveArray(filename, data) {
  writeFileSync(join(storeDir, filename), JSON.stringify(data, null, 2));
}

// ── Semantic Store ──────────────────────────────────────

function writeEntity(entityJson) {
  const entity = typeof entityJson === "string" ? JSON.parse(entityJson) : entityJson;
  if (!entity.id) { console.error("Entity needs an 'id' field"); process.exit(1); }

  const entities = loadStore("entities.json");
  const existing = entities[entity.id];

  if (existing) {
    // Merge: combine facts, update type if provided
    const mergedFacts = [...new Set([...(existing.facts ?? []), ...(entity.facts ?? [])])];
    entities[entity.id] = {
      ...existing,
      ...entity,
      facts: mergedFacts,
      updatedAt: new Date().toISOString(),
      accessCount: (existing.accessCount ?? 0),
    };
  } else {
    entities[entity.id] = {
      ...entity,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      accessCount: 0,
      confidence: entity.confidence ?? 1.0,
    };
  }

  saveStore("entities.json", entities);
  console.log(JSON.stringify({ written: "entity", id: entity.id, merged: !!existing }));
}

function writeRelationship(relJson) {
  const rel = typeof relJson === "string" ? JSON.parse(relJson) : relJson;
  if (!rel.from || !rel.to || !rel.type) {
    console.error("Relationship needs 'from', 'to', 'type' fields");
    process.exit(1);
  }

  const rels = loadArray("relationships.json");
  const exists = rels.some(r => r.from === rel.from && r.to === rel.to && r.type === rel.type);

  if (!exists) {
    rels.push({
      ...rel,
      createdAt: new Date().toISOString(),
      confidence: rel.confidence ?? 1.0,
    });
    saveArray("relationships.json", rels);
  }

  console.log(JSON.stringify({ written: "relationship", from: rel.from, to: rel.to, type: rel.type, duplicate: exists }));
}

// ── Procedural Store ────────────────────────────────────

function writeRule(ruleJson) {
  const rule = typeof ruleJson === "string" ? JSON.parse(ruleJson) : ruleJson;
  if (!rule.id) { console.error("Rule needs an 'id' field"); process.exit(1); }

  const rules = loadStore("rules.json");
  const existing = rules[rule.id];

  if (existing) {
    // Bayesian update: adjust confidence based on new evidence
    const totalTrials = (existing.successes ?? 0) + (existing.failures ?? 0) + 1;
    const success = rule.success !== false;
    const successes = (existing.successes ?? 0) + (success ? 1 : 0);
    const failures = (existing.failures ?? 0) + (success ? 0 : 1);
    const confidence = (successes + 1) / (totalTrials + 2); // Laplace smoothing

    rules[rule.id] = {
      ...existing,
      ...rule,
      confidence,
      successes,
      failures,
      updatedAt: new Date().toISOString(),
      usageCount: (existing.usageCount ?? 0) + 1,
    };
  } else {
    rules[rule.id] = {
      ...rule,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      confidence: rule.confidence ?? 0.5,
      successes: rule.success !== false ? 1 : 0,
      failures: rule.success === false ? 1 : 0,
      usageCount: 0,
    };
  }

  saveStore("rules.json", rules);
  console.log(JSON.stringify({ written: "rule", id: rule.id, confidence: rules[rule.id].confidence }));
}

function writeProcedure(procJson) {
  const proc = typeof procJson === "string" ? JSON.parse(procJson) : procJson;
  if (!proc.id) { console.error("Procedure needs an 'id' field"); process.exit(1); }

  const procs = loadStore("procedures.json");
  procs[proc.id] = {
    ...proc,
    updatedAt: new Date().toISOString(),
    createdAt: procs[proc.id]?.createdAt ?? new Date().toISOString(),
  };

  saveStore("procedures.json", procs);
  console.log(JSON.stringify({ written: "procedure", id: proc.id }));
}

// ── Episodic Store (delegates to replay-buffer) ─────────

function writeEpisodic(transition) {
  // Episodic writes go to the replay buffer
  // We add a lightweight index entry for cross-referencing
  const index = loadArray("episode-index.json");
  index.push({
    heartbeat: transition.heartbeat,
    episodeId: transition.episodeId,
    actionType: transition.action?.type,
    success: transition.result?.success,
    timestamp: new Date().toISOString(),
    taskSnippet: (transition.taskSnippet ?? transition.board ?? "").slice(0, 100),
  });

  // Keep index bounded
  if (index.length > 1000) {
    index.splice(0, index.length - 1000);
  }

  saveArray("episode-index.json", index);
  console.log(JSON.stringify({ written: "episodic-index", heartbeat: transition.heartbeat }));
}

// ── Main dispatch ───────────────────────────────────────

const entityArg = getArg("entity");
const relArg = getArg("relationship");
const ruleArg = getArg("rule");
const procedureArg = getArg("procedure");

if (store === "semantic" && entityArg) {
  writeEntity(entityArg);
} else if (store === "semantic" && relArg) {
  writeRelationship(relArg);
} else if (store === "procedural" && ruleArg) {
  writeRule(ruleArg);
} else if (store === "procedural" && procedureArg) {
  writeProcedure(procedureArg);
} else if (store === "episodic") {
  // Read from stdin
  let input = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", chunk => input += chunk);
  process.stdin.on("end", () => {
    if (input.trim()) writeEpisodic(JSON.parse(input));
    else console.error("Pipe a transition JSON to stdin for episodic write");
  });
  if (process.stdin.isTTY) {
    console.error("Usage: echo '{...}' | node write.mjs --store episodic --dir /tmp/memory");
    process.exit(1);
  }
} else {
  console.error("Usage:");
  console.error("  node write.mjs --store semantic --dir DIR --entity '{...}'");
  console.error("  node write.mjs --store semantic --dir DIR --relationship '{...}'");
  console.error("  node write.mjs --store procedural --dir DIR --rule '{...}'");
  console.error("  node write.mjs --store procedural --dir DIR --procedure '{...}'");
  console.error("  echo '{...}' | node write.mjs --store episodic --dir DIR");
  process.exit(1);
}
