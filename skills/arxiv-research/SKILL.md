---
name: arxiv-research
description: Search arXiv papers, download LaTeX source, extract algorithms and equations, and implement them in code. Use when a task involves academic research, finding papers, understanding algorithms, or implementing methods from publications.
---

# arXiv Research

Search for academic papers on arXiv, retrieve full LaTeX source, extract pseudocode and algorithms, and implement them.

## Tools

All tools are in `{baseDir}/scripts/`.

### Search Papers

```bash
node {baseDir}/scripts/search.mjs "deep q-learning" --max 5
node {baseDir}/scripts/search.mjs "ti:attention is all you need"
node {baseDir}/scripts/search.mjs "au:mnih AND ti:playing atari"
```

**Query syntax** (field prefixes):
- `ti:` — title
- `au:` — author
- `abs:` — abstract
- `cat:` — category (e.g. `cs.AI`, `cs.LG`)
- `all:` — all fields
- Use `AND`, `OR`, `ANDNOT` for boolean operators
- Use quotes for exact phrases: `ti:"learning by cheating"`

Returns JSON with paper IDs, titles, authors, abstracts, categories, and dates.

### Get Paper Metadata

```bash
node {baseDir}/scripts/metadata.mjs 1312.5602
node {baseDir}/scripts/metadata.mjs 1312.5602 1912.12294 1706.03762
```

Returns full metadata for one or more papers by arXiv ID.

### Download LaTeX Source

```bash
node {baseDir}/scripts/download-source.mjs 1312.5602 /tmp/paper-src
```

Downloads and extracts the full LaTeX source (`.tex`, `.bib`, figures) for a paper. Second argument is the output directory.

### Extract Algorithms

```bash
node {baseDir}/scripts/extract-algorithms.mjs /tmp/paper-src
```

Scans all `.tex` files in a directory and extracts `\begin{algorithm}...\end{algorithm}` blocks. Returns the raw LaTeX pseudocode for each algorithm found.

### Full Pipeline

To go from a topic to an implementation:

1. Search: `node {baseDir}/scripts/search.mjs "topic" --max 5`
2. Pick a paper ID from the results
3. Download: `node {baseDir}/scripts/download-source.mjs <id> /tmp/paper-src`
4. Extract: `node {baseDir}/scripts/extract-algorithms.mjs /tmp/paper-src`
5. Read the extracted pseudocode and implement it

## Notes

- arXiv rate limits: wait 3 seconds between API requests
- Not all papers have LaTeX source available (some are PDF-only)
- Source files are returned as `.tar.gz`; the download script handles extraction
- The extract script finds `algorithm`, `algorithmic`, and `lstlisting` environments
