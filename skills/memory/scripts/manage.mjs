#!/usr/bin/env node

/**
 * Memory management operations: merge, reflect, forget.
 *
 * This is the "missing piece" identified in arXiv:2404.13501 —
 * most agent systems write and read memory but don't manage it.
 *
 * Usage:
 *   # Run all management operations
 *   node manage.mjs --dir /tmp/memory --operation all
 *
 *   # Forget: decay old entries, prune low-confidence
 *   node manage.mjs --dir /tmp/memory --operation forget --decay-constant 100
 *
 *   # Merge: deduplicate semantic entities
 *   node manage.mjs --dir /tmp/memory --operation merge
 *
 *   # Reflect: promote episodic patterns to semantic/procedural
 *   node manage.mjs --dir /tmp/memory --operation reflect
 *
 *   # Compact: enforce budgets across all stores
 *   node manage.mjs --dir /tmp/memory --operation compact
 *
 *   # Stats: show memory usage
 *   node manage.mjs --dir /tmp/memory --operation stats
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

const dir = getArg("dir") ?? "/tmp/memory";
const operation = getArg("operation") ?? "stats";
const decayConstant = parseFloat(getArg("decay-constant") ?? "100"); // τ in heartbeats

// Budgets
const EPISODIC_BUDGET = parseInt(getArg("episodic-budget") ?? "1000", 10);
const SEMANTIC_BUDGET = parseInt(getArg("semantic-budget") ?? "500", 10);
const PROCEDURAL_BUDGET = parseInt(getArg("procedural-budget") ?? "200", 10);

// ── Helpers ─────────────────────────────────────────────

function loadJson(storeName, filename) {
  const path = join(dir, storeName, filename);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

function saveJson(storeName, filename, data) {
  const storeDir = join(dir, storeName);
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(join(storeDir, filename), JSON.stringify(data, null, 2));
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

// ── Forget: Ebbinghaus-inspired decay ───────────────────

function forget() {
  const log = { forgotten: { semantic: 0, procedural: 0, episodic: 0 } };
  const now = Date.now();

  // Semantic: decay confidence based on time since last access
  const entities = loadJson("semantic", "entities.json");
  if (entities) {
    const toDelete = [];
    for (const [id, e] of Object.entries(entities)) {
      const updatedAt = new Date(e.updatedAt ?? e.createdAt).getTime();
      const ageMs = now - updatedAt;
      const ageHeartbeats = ageMs / 60000; // rough: 1 heartbeat ≈ 1 min
      const importance = (e.accessCount ?? 0) * 0.1 + (e.confidence ?? 0.5);
      const retention = Math.exp(-ageHeartbeats / decayConstant) * importance;

      if (retention < 0.05 && (e.accessCount ?? 0) === 0) {
        toDelete.push(id);
      } else {
        // Update confidence with decay
        entities[id].confidence = Math.max(0.01, (e.confidence ?? 1.0) * Math.exp(-ageHeartbeats / (decayConstant * 10)));
      }
    }
    for (const id of toDelete) {
      delete entities[id];
      log.forgotten.semantic++;
    }
    saveJson("semantic", "entities.json", entities);
  }

  // Procedural: decay unused rules
  const rules = loadJson("procedural", "rules.json");
  if (rules) {
    const toDelete = [];
    for (const [id, r] of Object.entries(rules)) {
      // Don't decay static rules (source: "policy")
      if (r.source === "policy" || r.source === "static") continue;

      const updatedAt = new Date(r.updatedAt ?? r.createdAt).getTime();
      const ageMs = now - updatedAt;
      const ageHeartbeats = ageMs / 60000;

      if (r.confidence < 0.1 && (r.usageCount ?? 0) < 2) {
        toDelete.push(id);
      } else {
        rules[id].confidence = Math.max(0.01, r.confidence * Math.exp(-ageHeartbeats / (decayConstant * 5)));
      }
    }
    for (const id of toDelete) {
      delete rules[id];
      log.forgotten.procedural++;
    }
    saveJson("procedural", "rules.json", rules);
  }

  // Episodic: trim old entries from index
  const index = loadJson("episodic", "episode-index.json");
  if (index && index.length > EPISODIC_BUDGET) {
    const trimmed = index.length - EPISODIC_BUDGET;
    index.splice(0, trimmed);
    saveJson("episodic", "episode-index.json", index);
    log.forgotten.episodic = trimmed;
  }

  return log;
}

// ── Merge: deduplicate entities ─────────────────────────

function merge() {
  const log = { merged: { entities: 0, relationships: 0 } };

  const entities = loadJson("semantic", "entities.json");
  if (entities) {
    // Simple dedup: normalize IDs (lowercase, trim), merge matching
    const normalized = {};
    for (const [id, e] of Object.entries(entities)) {
      const normId = id.toLowerCase().replace(/[^a-z0-9-_]/g, "");
      if (normalized[normId] && normId !== id) {
        // Merge facts
        const existing = normalized[normId];
        existing.facts = [...new Set([...(existing.facts ?? []), ...(e.facts ?? [])])];
        existing.accessCount = (existing.accessCount ?? 0) + (e.accessCount ?? 0);
        existing.confidence = Math.max(existing.confidence ?? 0, e.confidence ?? 0);
        log.merged.entities++;
      } else {
        normalized[normId] = { ...e };
      }
    }
    saveJson("semantic", "entities.json", normalized);
  }

  // Dedup relationships
  const rels = loadJson("semantic", "relationships.json");
  if (rels) {
    const seen = new Set();
    const deduped = rels.filter(r => {
      const key = `${r.from}|${r.to}|${r.type}`;
      if (seen.has(key)) { log.merged.relationships++; return false; }
      seen.add(key);
      return true;
    });
    saveJson("semantic", "relationships.json", deduped);
  }

  return log;
}

// ── Reflect: promote episodic patterns ──────────────────

function reflect() {
  const log = { reflected: { rules: 0, entities: 0 } };

  const index = loadJson("episodic", "episode-index.json") ?? [];
  if (index.length < 3) return log; // Need enough episodes to reflect

  // Pattern detection: find repeated action types with consistent outcomes
  const actionStats = {};
  for (const e of index) {
    const key = e.actionType ?? "unknown";
    if (!actionStats[key]) actionStats[key] = { success: 0, fail: 0, total: 0 };
    actionStats[key].total++;
    if (e.success) actionStats[key].success++;
    else actionStats[key].fail++;
  }

  // Generate procedural rules from patterns
  const rules = loadJson("procedural", "rules.json") ?? {};
  for (const [action, stats] of Object.entries(actionStats)) {
    if (stats.total < 3) continue; // Need enough data

    const successRate = stats.success / stats.total;

    if (successRate < 0.3 && stats.fail >= 3) {
      // High failure rate → generate caution rule
      const ruleId = `caution-${action}`;
      if (!rules[ruleId]) {
        rules[ruleId] = {
          description: `Caution: ${action} has a ${Math.round(successRate * 100)}% success rate (${stats.fail} failures)`,
          confidence: 1 - successRate,
          source: "reflection",
          successes: stats.success,
          failures: stats.fail,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          usageCount: 0,
        };
        log.reflected.rules++;
      }
    }

    if (successRate > 0.8 && stats.success >= 5) {
      // High success rate → reinforce pattern
      const ruleId = `reliable-${action}`;
      if (!rules[ruleId]) {
        rules[ruleId] = {
          description: `Reliable: ${action} succeeds ${Math.round(successRate * 100)}% of the time (${stats.success} successes)`,
          confidence: successRate,
          source: "reflection",
          successes: stats.success,
          failures: stats.fail,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          usageCount: 0,
        };
        log.reflected.rules++;
      }
    }
  }

  if (log.reflected.rules > 0) {
    saveJson("procedural", "rules.json", rules);
  }

  // Extract frequently mentioned terms as semantic entities
  const allText = index.map(e => e.taskSnippet ?? "").join(" ");
  const tokens = tokenize(allText);
  const freq = {};
  for (const t of tokens) {
    freq[t] = (freq[t] ?? 0) + 1;
  }

  const entities = loadJson("semantic", "entities.json") ?? {};
  const topTerms = Object.entries(freq)
    .filter(([, count]) => count >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  for (const [term, count] of topTerms) {
    if (!entities[term] && term.length > 2) {
      entities[term] = {
        type: "concept",
        facts: [`Mentioned ${count} times in episodic memory`],
        confidence: Math.min(1, count / 10),
        source: "reflection",
        accessCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      log.reflected.entities++;
    }
  }

  if (log.reflected.entities > 0) {
    saveJson("semantic", "entities.json", entities);
  }

  return log;
}

// ── Compact: enforce budgets ────────────────────────────

function compact() {
  const log = { compacted: { semantic: 0, procedural: 0, episodic: 0 } };

  // Semantic: keep top entities by (confidence * accessCount)
  const entities = loadJson("semantic", "entities.json");
  if (entities && Object.keys(entities).length > SEMANTIC_BUDGET) {
    const sorted = Object.entries(entities)
      .map(([id, e]) => [id, e, (e.confidence ?? 0.5) * (1 + (e.accessCount ?? 0))])
      .sort((a, b) => b[2] - a[2]);

    const kept = {};
    for (let i = 0; i < SEMANTIC_BUDGET && i < sorted.length; i++) {
      kept[sorted[i][0]] = sorted[i][1];
    }
    log.compacted.semantic = Object.keys(entities).length - Object.keys(kept).length;
    saveJson("semantic", "entities.json", kept);
  }

  // Procedural: keep top rules by confidence, always keep static
  const rules = loadJson("procedural", "rules.json");
  if (rules && Object.keys(rules).length > PROCEDURAL_BUDGET) {
    const staticRules = {};
    const learnedRules = [];

    for (const [id, r] of Object.entries(rules)) {
      if (r.source === "policy" || r.source === "static") {
        staticRules[id] = r;
      } else {
        learnedRules.push([id, r]);
      }
    }

    learnedRules.sort((a, b) => (b[1].confidence ?? 0) - (a[1].confidence ?? 0));
    const remaining = PROCEDURAL_BUDGET - Object.keys(staticRules).length;
    const kept = { ...staticRules };
    for (let i = 0; i < remaining && i < learnedRules.length; i++) {
      kept[learnedRules[i][0]] = learnedRules[i][1];
    }
    log.compacted.procedural = Object.keys(rules).length - Object.keys(kept).length;
    saveJson("procedural", "rules.json", kept);
  }

  // Episodic: already handled by forget
  const index = loadJson("episodic", "episode-index.json");
  if (index && index.length > EPISODIC_BUDGET) {
    log.compacted.episodic = index.length - EPISODIC_BUDGET;
    index.splice(0, index.length - EPISODIC_BUDGET);
    saveJson("episodic", "episode-index.json", index);
  }

  return log;
}

// ── Stats ───────────────────────────────────────────────

function stats() {
  const entities = loadJson("semantic", "entities.json") ?? {};
  const rels = loadJson("semantic", "relationships.json") ?? [];
  const rules = loadJson("procedural", "rules.json") ?? {};
  const procs = loadJson("procedural", "procedures.json") ?? {};
  const index = loadJson("episodic", "episode-index.json") ?? [];

  const staticRules = Object.values(rules).filter(r => r.source === "policy" || r.source === "static").length;
  const learnedRules = Object.keys(rules).length - staticRules;

  return {
    semantic: {
      entities: Object.keys(entities).length,
      relationships: rels.length,
      budget: SEMANTIC_BUDGET,
      usage: `${Math.round(Object.keys(entities).length / SEMANTIC_BUDGET * 100)}%`,
    },
    procedural: {
      rules: Object.keys(rules).length,
      staticRules,
      learnedRules,
      procedures: Object.keys(procs).length,
      budget: PROCEDURAL_BUDGET,
      usage: `${Math.round(Object.keys(rules).length / PROCEDURAL_BUDGET * 100)}%`,
    },
    episodic: {
      entries: index.length,
      budget: EPISODIC_BUDGET,
      usage: `${Math.round(index.length / EPISODIC_BUDGET * 100)}%`,
      oldestEntry: index[0]?.timestamp ?? null,
      newestEntry: index[index.length - 1]?.timestamp ?? null,
    },
  };
}

// ── Main ────────────────────────────────────────────────

let result;
switch (operation) {
  case "forget": result = forget(); break;
  case "merge": result = merge(); break;
  case "reflect": result = reflect(); break;
  case "compact": result = compact(); break;
  case "stats": result = stats(); break;
  case "all":
    result = {
      merge: merge(),
      reflect: reflect(),
      forget: forget(),
      compact: compact(),
      stats: stats(),
    };
    break;
  default:
    console.error(`Unknown operation: ${operation}. Use: forget, merge, reflect, compact, stats, all`);
    process.exit(1);
}

console.log(JSON.stringify(result, null, 2));
