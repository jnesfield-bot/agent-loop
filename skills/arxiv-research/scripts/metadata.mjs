#!/usr/bin/env node

/**
 * Get metadata for one or more arXiv papers by ID.
 *
 * Usage:
 *   node metadata.mjs 1312.5602
 *   node metadata.mjs 1312.5602 1912.12294 1706.03762
 */

const ids = process.argv.slice(2);
if (ids.length === 0) {
  console.error("Usage: node metadata.mjs <arxiv-id> [<arxiv-id> ...]");
  process.exit(1);
}

const idList = ids.join(",");
const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(idList)}`;

const resp = await fetch(url);
if (!resp.ok) {
  console.error(`arXiv API error: ${resp.status} ${resp.statusText}`);
  process.exit(1);
}

const xml = await resp.text();

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

  const authors = [];
  const authorRegex = /<author>\s*<name>([^<]+)<\/name>/g;
  let authorMatch;
  while ((authorMatch = authorRegex.exec(entry)) !== null) {
    authors.push(authorMatch[1].trim());
  }

  const categories = [];
  const catRegex = /<category[^>]*term="([^"]+)"/g;
  let catMatch;
  while ((catMatch = catRegex.exec(entry)) !== null) {
    categories.push(catMatch[1]);
  }

  const doi = get("arxiv:doi");
  const journal = get("arxiv:journal_ref");
  const comment = get("arxiv:comment");

  entries.push({
    id: arxivId,
    title: get("title")?.replace(/\s+/g, " "),
    authors,
    abstract: get("summary")?.replace(/\s+/g, " "),
    categories,
    published: get("published"),
    updated: get("updated"),
    doi: doi || null,
    journal: journal || null,
    comment: comment || null,
    pdf: `https://arxiv.org/pdf/${arxivId}`,
    source: `https://arxiv.org/e-print/${arxivId}`,
  });
}

console.log(JSON.stringify(entries, null, 2));
