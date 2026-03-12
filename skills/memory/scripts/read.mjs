#!/usr/bin/env node

/**
 * Read from the tri-store memory system.
 *
 * Usage:
 *   # Search semantic entities by query
 *   node read.mjs --store semantic --dir /tmp/memory --query "authentication"
 *
 *   # Get a specific entity
 *   node read.mjs --store semantic --dir /tmp/memory --entity "react"
 *
 *   # Get relationships for an entity
 *   node read.mjs --store semantic --dir /tmp/memory --relations "auth"
 *
 *   # Search procedural rules matching a context
 *   node read.mjs --store procedural --dir /tmp/memory --query "testing"
 *
 *   # Get all rules above a confidence threshold
 *   node read.mjs --store procedural --dir /tmp/memory --min-confidence 0.7
 *
 *   # Search episodic index
 *   node read.mjs --store episodic --dir /tmp/memory --query "failed bash"
 *
 *   # Get recent episodes
 *   node read.mjs --store episodic --dir /tmp/memory --recent 10
 *
 *   # Unified read across all stores
 *   node read.mjs --store all --dir /tmp/memory --query "authentication module"
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

const store = getArg("store") ?? "all";
const dir = getArg("dir") ?? "/tmp/memory";
const query = getArg("query");
const entityId = getArg("entity");
const relations = getArg("relations");
const minConfidence = parseFloat(getArg("min-confidence") ?? "0");
const recent = parseInt(getArg("recent") ?? "0", 10);

// ── Helpers ─────────────────────────────────────────────

function loadJson(storeName, filename) {
  const path = join(dir, storeName, filename);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

const STOPWORDS = new Set([
  "the","a","an","and","or","but","in","on","at","to","for","of","with","by",
  "from","up","about","into","over","after","is","are","was","were","be","been",
  "being","have","has","had","do","does","did","will","would","shall","should",
  "may","might","must","can","could","it","its","this","that","these","those",
  "not","no","nor","so","if","then","than","too","very","just","also","now",
]);

function tokenize(text) {
  return (text ?? "").toLowerCase().split(/\W+/).filter(t => t.length > 2 && !STOPWORDS.has(t));
}

function scoreMatch(tokens, text) {
  const textLower = (text ?? "").toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (textLower.includes(t)) score++;
  }
  return tokens.length > 0 ? score / tokens.length : 0;
}

// ── Semantic Read ───────────────────────────────────────

function readSemantic() {
  const results = { store: "semantic", entities: [], relationships: [] };

  if (entityId) {
    const entities = loadJson("semantic", "entities.json") ?? {};
    const e = entities[entityId];
    if (e) {
      results.entities.push({ id: entityId, ...e });
      // Also bump access count (side effect, but useful for decay)
    }
  }

  if (relations) {
    const rels = loadJson("semantic", "relationships.json") ?? [];
    results.relationships = rels.filter(r => r.from === relations || r.to === relations);
  }

  if (query && !entityId) {
    const entities = loadJson("semantic", "entities.json") ?? {};
    const tokens = tokenize(query);

    const scored = Object.entries(entities).map(([id, e]) => {
      const searchText = [id, e.type, ...(e.facts ?? []), e.description ?? ""].join(" ");
      return { id, ...e, relevance: scoreMatch(tokens, searchText) };
    }).filter(e => e.relevance > 0).sort((a, b) => b.relevance - a.relevance);

    results.entities = scored.slice(0, 10);

    // Also search relationships
    const rels = loadJson("semantic", "relationships.json") ?? [];
    results.relationships = rels.filter(r => {
      const text = `${r.from} ${r.to} ${r.type}`;
      return scoreMatch(tokens, text) > 0;
    });
  }

  return results;
}

// ── Procedural Read ─────────────────────────────────────

function readProcedural() {
  const results = { store: "procedural", rules: [], procedures: [] };
  const rules = loadJson("procedural", "rules.json") ?? {};
  const procs = loadJson("procedural", "procedures.json") ?? {};

  if (query) {
    const tokens = tokenize(query);

    const scoredRules = Object.entries(rules).map(([id, r]) => {
      const searchText = [id, r.description ?? "", r.source ?? ""].join(" ");
      return { id, ...r, relevance: scoreMatch(tokens, searchText) };
    }).filter(r => r.relevance > 0 && r.confidence >= minConfidence)
      .sort((a, b) => b.relevance * b.confidence - a.relevance * a.confidence);

    results.rules = scoredRules.slice(0, 10);

    const scoredProcs = Object.entries(procs).map(([id, p]) => {
      const searchText = [id, ...(p.steps ?? []), p.description ?? ""].join(" ");
      return { id, ...p, relevance: scoreMatch(tokens, searchText) };
    }).filter(p => p.relevance > 0).sort((a, b) => b.relevance - a.relevance);

    results.procedures = scoredProcs.slice(0, 5);
  } else {
    // Return all above confidence threshold
    results.rules = Object.entries(rules)
      .map(([id, r]) => ({ id, ...r }))
      .filter(r => r.confidence >= minConfidence)
      .sort((a, b) => b.confidence - a.confidence);

    results.procedures = Object.entries(procs).map(([id, p]) => ({ id, ...p }));
  }

  return results;
}

// ── Episodic Read ───────────────────────────────────────

function readEpisodic() {
  const results = { store: "episodic", entries: [] };
  const index = loadJson("episodic", "episode-index.json") ?? [];

  if (recent > 0) {
    results.entries = index.slice(-recent);
  } else if (query) {
    const tokens = tokenize(query);
    results.entries = index.filter(e => {
      const text = [e.actionType, e.episodeId, e.taskSnippet, e.success ? "success" : "failed"].join(" ");
      return scoreMatch(tokens, text) > 0;
    }).slice(-20);
  } else {
    results.entries = index.slice(-20);
  }

  results.totalEpisodes = index.length;
  return results;
}

// ── Unified Read ────────────────────────────────────────

function readAll() {
  return {
    semantic: readSemantic(),
    procedural: readProcedural(),
    episodic: readEpisodic(),
  };
}

// ── Main ────────────────────────────────────────────────

let result;
switch (store) {
  case "semantic": result = readSemantic(); break;
  case "procedural": result = readProcedural(); break;
  case "episodic": result = readEpisodic(); break;
  case "all": result = readAll(); break;
  default:
    console.error(`Unknown store: ${store}. Use: semantic, procedural, episodic, all`);
    process.exit(1);
}

console.log(JSON.stringify(result, null, 2));
