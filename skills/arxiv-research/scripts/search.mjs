#!/usr/bin/env node

/**
 * Search arXiv papers.
 *
 * Usage:
 *   node search.mjs "attention is all you need" --max 5
 *   node search.mjs "ti:attention is all you need"
 *   node search.mjs "au:mnih AND ti:playing atari" --max 10
 *   node search.mjs "attention is all you need" --sort relevance
 *   node search.mjs "1706.03762"                  # direct ID lookup
 *
 * If the query has no field prefix (ti:, au:, abs:, cat:, all:),
 * it's auto-wrapped as an exact title search: ti:"query"
 * This prevents false matches from papers that happen to contain
 * common words in other fields.
 *
 * For broad keyword search, explicitly use: all:your query
 */

const query = process.argv[2];
if (!query) {
  console.error("Usage: node search.mjs <query> [--max N] [--sort relevance|date|updated]");
  console.error("");
  console.error("  Queries without a prefix auto-wrap as exact title search.");
  console.error("  Prefixes: ti: au: abs: cat: all:");
  console.error("");
  console.error("Examples:");
  console.error('  node search.mjs "attention is all you need"          # exact title');
  console.error('  node search.mjs "ti:attention is all you need"       # explicit title');
  console.error('  node search.mjs "all:deep reinforcement learning"    # broad keyword');
  console.error('  node search.mjs "au:vaswani AND ti:attention"        # combined');
  console.error('  node search.mjs "1706.03762"                         # direct ID');
  process.exit(1);
}

const maxIdx = process.argv.indexOf("--max");
const maxResults = maxIdx !== -1 ? parseInt(process.argv[maxIdx + 1], 10) : 5;

const sortIdx = process.argv.indexOf("--sort");
const sortBy = sortIdx !== -1 ? process.argv[sortIdx + 1] : "relevance";
const sortOrder = { relevance: "relevance", date: "submittedDate", updated: "lastUpdatedDate" }[sortBy] ?? "relevance";

// Detect if query looks like an arXiv ID (e.g. 1706.03762 or 2510.17800)
const isArxivId = /^\d{4}\.\d{4,5}(v\d+)?$/.test(query.trim());

let url;
if (isArxivId) {
  // Direct ID lookup
  url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(query.trim())}&max_results=1`;
} else {
  // Build search query
  let searchQuery = query;

  // If no field prefix and no boolean operators, auto-wrap as exact title search
  const hasPrefix = /^(ti|au|abs|cat|all):/.test(query);
  const hasBoolean = /\b(AND|OR|ANDNOT)\b/.test(query);

  if (!hasPrefix && !hasBoolean) {
    // Wrap as exact title phrase search
    // arXiv API supports quotes for phrase matching within a field
    searchQuery = `ti:"${query}"`;
  }

  const params = new URLSearchParams({
    search_query: searchQuery,
    start: "0",
    max_results: String(maxResults),
  });

  if (sortOrder !== "relevance") {
    params.set("sortBy", sortOrder);
    params.set("sortOrder", "descending");
  }

  url = `https://export.arxiv.org/api/query?${params.toString()}`;
}

const resp = await fetch(url);
if (!resp.ok) {
  console.error(`arXiv API error: ${resp.status} ${resp.statusText}`);
  process.exit(1);
}

const xml = await resp.text();

// Parse Atom XML entries
const entries = [];
const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
let match;

while ((match = entryRegex.exec(xml)) !== null) {
  const entry = match[1];

  const get = (tag) => {
    const m = entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
    return m ? m[1].trim() : null;
  };

  const id = get("id");
  const arxivId = id?.match(/abs\/(.+?)(?:v\d+)?$/)?.[1] || id;

  // Get all authors
  const authors = [];
  const authorRegex = /<author>\s*<name>([^<]+)<\/name>/g;
  let authorMatch;
  while ((authorMatch = authorRegex.exec(entry)) !== null) {
    authors.push(authorMatch[1].trim());
  }

  // Get categories
  const categories = [];
  const catRegex = /<category[^>]*term="([^"]+)"/g;
  let catMatch;
  while ((catMatch = catRegex.exec(entry)) !== null) {
    categories.push(catMatch[1]);
  }

  entries.push({
    id: arxivId,
    title: get("title")?.replace(/\s+/g, " "),
    authors,
    abstract: get("summary")?.replace(/\s+/g, " "),
    categories,
    published: get("published"),
    updated: get("updated"),
    pdf: `https://arxiv.org/pdf/${arxivId}`,
    source: `https://arxiv.org/e-print/${arxivId}`,
  });
}

if (entries.length === 0) {
  console.error(`No results for: ${query}`);
  console.error("Try: all:your query  for broad keyword search");
}

console.log(JSON.stringify(entries, null, 2));
