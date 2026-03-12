#!/usr/bin/env node

/**
 * Inspect memory state across all three stores.
 * Useful for debugging and understanding what the agent "knows".
 *
 * Usage:
 *   node inspect.mjs --dir /tmp/memory
 *   node inspect.mjs --dir /tmp/memory --store semantic
 *   node inspect.mjs --dir /tmp/memory --format compact
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

const dir = getArg("dir") ?? "/tmp/memory";
const store = getArg("store") ?? "all";
const format = getArg("format") ?? "full";

function loadJson(storeName, filename) {
  const path = join(dir, storeName, filename);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

function renderSemantic() {
  const entities = loadJson("semantic", "entities.json") ?? {};
  const rels = loadJson("semantic", "relationships.json") ?? [];

  const lines = ["═══ SEMANTIC MEMORY ═══", ""];

  if (Object.keys(entities).length === 0) {
    lines.push("  (empty)");
  } else {
    lines.push(`  ${Object.keys(entities).length} entities:`);
    for (const [id, e] of Object.entries(entities)) {
      if (format === "compact") {
        lines.push(`  • ${id} [${e.type ?? "?"}] conf=${(e.confidence ?? 0).toFixed(2)}`);
      } else {
        lines.push(`  ┌ ${id}`);
        lines.push(`  │ type: ${e.type ?? "unknown"}`);
        lines.push(`  │ confidence: ${(e.confidence ?? 0).toFixed(2)}`);
        lines.push(`  │ accessed: ${e.accessCount ?? 0} times`);
        if (e.facts?.length) lines.push(`  │ facts: ${e.facts.join("; ")}`);
        if (e.source) lines.push(`  │ source: ${e.source}`);
        lines.push(`  └ updated: ${e.updatedAt ?? "?"}`);
      }
    }
  }

  if (rels.length > 0) {
    lines.push("");
    lines.push(`  ${rels.length} relationships:`);
    for (const r of rels) {
      lines.push(`  • ${r.from} ──${r.type}──> ${r.to}`);
    }
  }

  return lines.join("\n");
}

function renderProcedural() {
  const rules = loadJson("procedural", "rules.json") ?? {};
  const procs = loadJson("procedural", "procedures.json") ?? {};

  const lines = ["═══ PROCEDURAL MEMORY ═══", ""];

  if (Object.keys(rules).length === 0 && Object.keys(procs).length === 0) {
    lines.push("  (empty)");
  }

  if (Object.keys(rules).length > 0) {
    lines.push(`  ${Object.keys(rules).length} rules:`);
    const sorted = Object.entries(rules).sort((a, b) => (b[1].confidence ?? 0) - (a[1].confidence ?? 0));
    for (const [id, r] of sorted) {
      if (format === "compact") {
        lines.push(`  • ${id} conf=${(r.confidence ?? 0).toFixed(2)} [${r.source ?? "?"}]`);
      } else {
        lines.push(`  ┌ ${id}`);
        lines.push(`  │ ${r.description ?? "(no description)"}`);
        lines.push(`  │ confidence: ${(r.confidence ?? 0).toFixed(2)} (${r.successes ?? 0}✓ ${r.failures ?? 0}✗)`);
        lines.push(`  │ source: ${r.source ?? "unknown"}, used: ${r.usageCount ?? 0} times`);
        lines.push(`  └ updated: ${r.updatedAt ?? "?"}`);
      }
    }
  }

  if (Object.keys(procs).length > 0) {
    lines.push("");
    lines.push(`  ${Object.keys(procs).length} procedures:`);
    for (const [id, p] of Object.entries(procs)) {
      lines.push(`  ┌ ${id}`);
      if (p.steps) lines.push(`  │ steps: ${p.steps.length} → ${p.steps.join(" → ")}`);
      if (p.successRate != null) lines.push(`  │ success rate: ${Math.round(p.successRate * 100)}%`);
      lines.push(`  └ updated: ${p.updatedAt ?? "?"}`);
    }
  }

  return lines.join("\n");
}

function renderEpisodic() {
  const index = loadJson("episodic", "episode-index.json") ?? [];

  const lines = ["═══ EPISODIC MEMORY ═══", ""];
  lines.push(`  ${index.length} entries`);

  if (index.length === 0) {
    lines.push("  (empty)");
  } else {
    const recent = index.slice(-10);
    if (index.length > 10) lines.push(`  (showing last 10 of ${index.length})`);
    lines.push("");

    for (const e of recent) {
      const icon = e.success ? "✓" : "✗";
      if (format === "compact") {
        lines.push(`  ${icon} hb${e.heartbeat ?? "?"} ${e.actionType ?? "?"} [${e.episodeId ?? "?"}]`);
      } else {
        lines.push(`  ${icon} heartbeat ${e.heartbeat ?? "?"} | ${e.actionType ?? "?"} | ep: ${e.episodeId ?? "?"}`);
        if (e.taskSnippet) lines.push(`    task: ${e.taskSnippet.slice(0, 80)}`);
        lines.push(`    at: ${e.timestamp ?? "?"}`);
      }
    }
  }

  return lines.join("\n");
}

// ── Main ────────────────────────────────────────────────

const sections = [];
if (store === "all" || store === "semantic") sections.push(renderSemantic());
if (store === "all" || store === "procedural") sections.push(renderProcedural());
if (store === "all" || store === "episodic") sections.push(renderEpisodic());

console.log(sections.join("\n\n"));
