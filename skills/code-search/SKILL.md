---
name: code-search
description: Semantic code search across git repositories. Clone, index, and search functions/classes by natural language query. Multi-stream scoring (name, docstring, body, component matching) inspired by RepoRift (arXiv:2408.11058). Supports multi-repo batch search in a single action.
---

# Code Search — Semantic Search Across Git Repos

Search for functions, methods, and classes using natural language queries.
Instead of `grep` for keywords, describe what the code does and find it.

Inspired by RepoRift (arXiv:2408.11058): multi-stream matching that scores
by name, docstring, body identifiers, and component decomposition.

## Quick Start — Single Strip Search

Search across one or more repos in a single command:

```bash
node {baseDir}/scripts/batch-search.mjs "find the function that handles authentication" \
  --repo https://github.com/user/repo1.git \
  --repo https://github.com/user/repo2.git \
  --top 5 --context
```

This clones, indexes, searches, and returns ranked results — one action.

## Step-by-Step Usage

### 1. Index a Repository

```bash
# From a git URL (clones automatically)
node {baseDir}/scripts/index-repo.mjs https://github.com/user/repo.git --output /tmp/repo-index.json

# From a local directory
node {baseDir}/scripts/index-repo.mjs ./my-project --output /tmp/project-index.json --lang ts

# Filter by language
node {baseDir}/scripts/index-repo.mjs ./repo --lang py --output /tmp/py-index.json
```

Supported languages: `py`, `ts`, `js`, `all` (default)

The index extracts:
- **Functions** (Y in the paper): name, signature, parameters, docstring, body
- **Classes** (Z in the paper): name, docstring, body
- **Search text**: combined tokens from name + signature + docstring + body identifiers

### 2. Search

```bash
# Single index
node {baseDir}/scripts/search.mjs "parse a URL and extract query parameters" --index /tmp/repo-index.json

# Multiple indices (cross-repo search)
node {baseDir}/scripts/search.mjs "handle websocket connections" \
  --index /tmp/server-index.json \
  --index /tmp/client-index.json \
  --top 10

# Include code context in results
node {baseDir}/scripts/search.mjs "compute hash of file contents" --index /tmp/index.json --context
```

### 3. Batch Search (clone + index + search in one shot)

```bash
node {baseDir}/scripts/batch-search.mjs "retry logic with exponential backoff" \
  --repo https://github.com/org/service-a.git \
  --repo https://github.com/org/service-b.git \
  --repo ./local-project \
  --top 5 --lang ts
```

## How It Works

### Multi-Stream Scoring (from RepoRift)

Each candidate is scored by three streams:

| Stream | Weight | What it matches |
|--------|--------|-----------------|
| Stream 1: TF-IDF | 0.3 | Query tokens against full search text with inverse document frequency weighting |
| Stream 2: Identity | 0.5 | Name match (5x), partial name (3x), name token (2x), docstring (2x), signature (1x) |
| Stream 3: Component | 0.2 | Sub-phrase matching — split query into chunks, check each independently |

Final score = weighted combination. Results ranked by score descending.

### Index Structure

```json
{
  "repo": "my-project",
  "functions": [
    {
      "id": "f0",
      "name": "parse_url",
      "signature": "def parse_url(url, strict=False)",
      "docstring": "Parse a URL string into components...",
      "body": "...",
      "file": "src/utils.py",
      "line": 42,
      "type": "function",
      "searchText": "parse url def parse url url strict ..."
    }
  ],
  "classes": [...],
  "stats": { "totalFunctions": 150, "totalClasses": 30, "totalFiles": 25 }
}
```

## Search Result Format

```json
{
  "query": "parse a URL and extract query parameters",
  "repos": ["my-project"],
  "resultCount": 5,
  "results": [
    {
      "score": 4.23,
      "scores": { "stream1": 2.1, "stream2": 6.5, "stream3": 1.8 },
      "repo": "my-project",
      "name": "parse_url",
      "type": "function",
      "signature": "def parse_url(url, strict=False)",
      "file": "src/utils.py",
      "line": 42,
      "docstring": "Parse a URL string into components..."
    }
  ]
}
```

## Design Notes

- **No embedding model required.** Uses weighted keyword matching with TF-IDF
  and multi-stream scoring. When embeddings are available, they slot into
  Stream 1 as a drop-in replacement.
- **Index once, search many.** The index is a JSON file — save it, version it,
  share it. Re-index only when the code changes.
- **Multi-repo is first-class.** Pass multiple `--index` or `--repo` flags.
  Results are ranked across all repos together.
- **Language-aware extraction.** Python (def/class), TypeScript/JavaScript
  (function/const/class/methods). Extensible to more languages.
