#!/usr/bin/env node

/**
 * Semantic code search across indexed repositories.
 *
 * Implements the RepoRift (arXiv:2408.11058) multi-stream approach:
 *   Stream 1: Query terms → match against function/class search text (TF-IDF-like)
 *   Stream 2: Query → code keywords → match against body text
 *   Stream 3: Query decomposition → match component parts separately
 *
 * Without an embedding model, we use weighted keyword matching with:
 *   - Exact name matches (highest weight)
 *   - Docstring overlap
 *   - Body identifier overlap
 *   - Signature parameter overlap
 *
 * Usage:
 *   node search.mjs "<natural language query>" --index <index.json> [--top N] [--context]
 *   node search.mjs "<query>" --index idx1.json --index idx2.json   # multi-repo
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";

const args = process.argv.slice(2);
const query = args.find(a => !a.startsWith("--"));

function getAllArgs(name) {
  const results = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}` && i + 1 < args.length) results.push(args[++i]);
  }
  return results;
}
function getArg(name) {
  const vals = getAllArgs(name);
  return vals.length > 0 ? vals[0] : null;
}
const hasFlag = (name) => args.includes(`--${name}`);

const indexFiles = getAllArgs("index");
const topN = parseInt(getArg("top") ?? "10");
const showContext = hasFlag("context");

if (!query || indexFiles.length === 0) {
  console.error('Usage: node search.mjs "<query>" --index <index.json> [--index ...] [--top N] [--context]');
  process.exit(1);
}

// ── Load indices ────────────────────────────────────────

const indices = [];
for (const f of indexFiles) {
  if (!existsSync(f)) {
    console.error(`Index not found: ${f}`);
    continue;
  }
  indices.push(JSON.parse(readFileSync(f, "utf-8")));
}

if (indices.length === 0) {
  console.error("No valid indices loaded");
  process.exit(1);
}

// ── Tokenize ────────────────────────────────────────────

function tokenize(text) {
  return text
    .toLowerCase()
    // Split camelCase and snake_case
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    // Remove punctuation
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(t => t.length > 1);
}

// Stopwords — common words that add noise
const STOPWORDS = new Set([
  "the", "is", "at", "of", "on", "in", "to", "for", "a", "an", "and", "or",
  "it", "its", "be", "as", "by", "this", "that", "with", "from", "are", "was",
  "has", "have", "had", "not", "all", "can", "if", "do", "does", "did", "but",
  "will", "would", "could", "should", "may", "might", "must", "shall",
  "self", "def", "return", "none", "true", "false", "class", "function",
  "import", "from", "const", "let", "var", "async", "await", "export",
]);

function filterTokens(tokens) {
  return tokens.filter(t => !STOPWORDS.has(t) && t.length > 1);
}

// ── Scoring ─────────────────────────────────────────────
//
// Multi-stream scoring inspired by RepoRift:
//
// Stream 1: Direct query → searchText match (TF-IDF-like)
//   Score based on how many query tokens appear in the entry's search text,
//   weighted by inverse document frequency.
//
// Stream 2: Query → code concepts
//   Extract likely code identifiers from the query (convert natural language
//   to snake_case/camelCase patterns), match against function names and body.
//
// Stream 3: Component matching
//   Split query into sub-phrases, score each independently, combine.

function computeIDF(entries) {
  const df = {};
  const N = entries.length;
  for (const entry of entries) {
    const tokens = new Set(tokenize(entry.searchText));
    for (const t of tokens) {
      df[t] = (df[t] ?? 0) + 1;
    }
  }
  const idf = {};
  for (const [term, count] of Object.entries(df)) {
    idf[term] = Math.log((N + 1) / (count + 1)) + 1;
  }
  return idf;
}

function scoreStream1(queryTokens, entry, idf) {
  // TF-IDF-like match of query tokens against search text
  const entryTokens = new Set(tokenize(entry.searchText));
  let score = 0;
  for (const qt of queryTokens) {
    if (entryTokens.has(qt)) {
      score += (idf[qt] ?? 1.0);
    }
  }
  // Normalize by query length
  return queryTokens.length > 0 ? score / queryTokens.length : 0;
}

function scoreStream2(queryTokens, entry) {
  // Name match — highest signal
  const name = entry.name.toLowerCase();
  const nameTokens = tokenize(name);
  let nameScore = 0;
  for (const qt of queryTokens) {
    if (name === qt) { nameScore += 5; }  // Exact name match
    else if (name.includes(qt)) { nameScore += 3; }  // Partial name match
    else if (nameTokens.includes(qt)) { nameScore += 2; }  // Name token match
  }

  // Docstring match — strong signal
  const docTokens = new Set(filterTokens(tokenize(entry.docstring ?? "")));
  let docScore = 0;
  for (const qt of queryTokens) {
    if (docTokens.has(qt)) docScore += 2;
  }

  // Signature/params match
  const sigTokens = new Set(tokenize(entry.signature ?? entry.params ?? ""));
  let sigScore = 0;
  for (const qt of queryTokens) {
    if (sigTokens.has(qt)) sigScore += 1;
  }

  return (nameScore * 3 + docScore * 2 + sigScore) / Math.max(queryTokens.length, 1);
}

function scoreStream3(query, entry) {
  // Component matching: split query into 2-3 word sub-phrases
  const words = query.toLowerCase().split(/\s+/);
  if (words.length <= 3) return 0;

  const searchText = entry.searchText;
  let componentScore = 0;
  const chunkSize = Math.min(3, Math.ceil(words.length / 3));

  for (let i = 0; i < words.length; i += chunkSize) {
    const chunk = words.slice(i, i + chunkSize).join(" ");
    if (searchText.includes(chunk)) {
      componentScore += 2;
    } else {
      // Check individual words of chunk
      const chunkWords = filterTokens(tokenize(chunk));
      for (const w of chunkWords) {
        if (searchText.includes(w)) componentScore += 0.5;
      }
    }
  }

  const numChunks = Math.ceil(words.length / chunkSize);
  return numChunks > 0 ? componentScore / numChunks : 0;
}

// ── Search ──────────────────────────────────────────────

const queryTokens = filterTokens(tokenize(query));

const results = [];

for (const index of indices) {
  const allEntries = [...index.functions, ...index.classes];
  const idf = computeIDF(allEntries);

  for (const entry of allEntries) {
    const s1 = scoreStream1(queryTokens, entry, idf);
    const s2 = scoreStream2(queryTokens, entry);
    const s3 = scoreStream3(query, entry);

    // Weighted combination (stream 2 = name/doc match is most important)
    const totalScore = s1 * 0.3 + s2 * 0.5 + s3 * 0.2;

    if (totalScore > 0.1) {
      results.push({
        score: +totalScore.toFixed(4),
        scores: { stream1: +s1.toFixed(3), stream2: +s2.toFixed(3), stream3: +s3.toFixed(3) },
        repo: index.repo,
        name: entry.name,
        type: entry.type ?? (entry.id.startsWith("c") ? "class" : "function"),
        signature: entry.signature,
        file: entry.file,
        line: entry.line,
        docstring: entry.docstring?.substring(0, 200) || null,
        body: showContext ? entry.body?.substring(0, 500) : undefined,
      });
    }
  }
}

// Sort by score descending
results.sort((a, b) => b.score - a.score);
const topResults = results.slice(0, topN);

// ── Output ──────────────────────────────────────────────

console.log(JSON.stringify({
  query,
  queryTokens,
  repos: indices.map(i => i.repo),
  resultCount: topResults.length,
  totalCandidates: results.length,
  results: topResults,
}, null, 2));
