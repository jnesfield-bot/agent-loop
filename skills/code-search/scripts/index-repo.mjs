#!/usr/bin/env node

/**
 * Index a git repository for semantic code search.
 *
 * Clones (or uses local) repo, extracts all functions/classes/methods,
 * builds a searchable index with signatures, docstrings, and context.
 *
 * Inspired by RepoRift (arXiv:2408.11058): the index is the set Y (functions)
 * and Z (classes) that the multi-stream search compares against.
 *
 * Usage:
 *   node index-repo.mjs <repo-url-or-path> [--output <index.json>] [--lang py|ts|js|all] [--depth N]
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { join, basename, extname, relative } from "path";

const args = process.argv.slice(2);
const repoArg = args.find(a => !a.startsWith("--"));
function getArg(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

const outputPath = getArg("output");
const lang = getArg("lang") ?? "all";
const maxDepth = parseInt(getArg("depth") ?? "10");

if (!repoArg) {
  console.error("Usage: node index-repo.mjs <repo-url-or-path> [--output index.json] [--lang py|ts|js|all]");
  process.exit(1);
}

// ── Clone or use local ──────────────────────────────────

let repoDir;
const isUrl = repoArg.startsWith("http") || repoArg.startsWith("git@");

if (isUrl) {
  const repoName = basename(repoArg).replace(/\.git$/, "");
  repoDir = join("/tmp", `code-search-${repoName}-${Date.now().toString(36)}`);
  console.error(`Cloning ${repoArg} → ${repoDir}...`);
  try {
    execSync(`git clone --depth 1 ${repoArg} ${repoDir}`, {
      encoding: "utf-8", timeout: 120000, stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    console.error(`Clone failed: ${err.message}`);
    process.exit(1);
  }
} else {
  repoDir = repoArg;
  if (!existsSync(repoDir)) {
    console.error(`Directory not found: ${repoDir}`);
    process.exit(1);
  }
}

// ── File extensions by language ─────────────────────────

const EXT_MAP = {
  py: [".py"],
  ts: [".ts", ".tsx"],
  js: [".js", ".jsx", ".mjs"],
  all: [".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".java", ".go", ".rs", ".rb", ".sh"],
};

const extensions = new Set(EXT_MAP[lang] ?? EXT_MAP.all);

// ── Collect source files ────────────────────────────────

function walkDir(dir, depth = 0) {
  if (depth > maxDepth) return [];
  const results = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" ||
          entry.name === "__pycache__" || entry.name === "venv" ||
          entry.name === ".git" || entry.name === "dist" || entry.name === "build") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...walkDir(full, depth + 1));
      } else if (extensions.has(extname(entry.name))) {
        results.push(full);
      }
    }
  } catch { /* skip unreadable dirs */ }
  return results;
}

const files = walkDir(repoDir);
console.error(`Found ${files.length} source files`);

// ── Extract functions and classes ────────────────────────

const functions = [];  // Y in the paper
const classes = [];     // Z in the paper

// Python patterns
const pyFuncRe = /^([ \t]*)def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*[^:]+)?\s*:/gm;
const pyClassRe = /^([ \t]*)class\s+(\w+)\s*(?:\([^)]*\))?\s*:/gm;

// JS/TS patterns
const jsFuncRe = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/gm;
const jsArrowRe = /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\([^)]*\)\s*(?::\s*\w+)?\s*=>/gm;
const jsClassRe = /^(?:export\s+)?class\s+(\w+)(?:\s+extends\s+\w+)?/gm;
const jsMethodRe = /^([ \t]+)(?:async\s+)?(\w+)\s*\(([^)]*)\)(?:\s*:\s*[^{]+)?\s*\{/gm;

function extractDocstring(lines, lineIdx) {
  // Python: look for triple-quote docstring right after def/class
  if (lineIdx + 1 < lines.length) {
    const next = lines[lineIdx + 1].trim();
    if (next.startsWith('"""') || next.startsWith("'''")) {
      const quote = next.substring(0, 3);
      if (next.endsWith(quote) && next.length > 6) {
        return next.slice(3, -3).trim();
      }
      // Multi-line docstring
      const docLines = [next.slice(3)];
      for (let i = lineIdx + 2; i < Math.min(lineIdx + 20, lines.length); i++) {
        if (lines[i].includes(quote)) {
          docLines.push(lines[i].split(quote)[0]);
          return docLines.join(" ").trim();
        }
        docLines.push(lines[i].trim());
      }
    }
  }
  // JS/TS: look for JSDoc comment above
  if (lineIdx > 0) {
    let i = lineIdx - 1;
    while (i >= 0 && lines[i].trim() === "") i--;
    if (i >= 0 && lines[i].trim().endsWith("*/")) {
      const docLines = [];
      while (i >= 0) {
        docLines.unshift(lines[i].trim().replace(/^\/?\*+\/?/g, "").trim());
        if (lines[i].trim().startsWith("/**") || lines[i].trim().startsWith("/*")) break;
        i--;
      }
      return docLines.filter(Boolean).join(" ").trim();
    }
  }
  return "";
}

function getBody(lines, startLine, indent) {
  const bodyLines = [];
  for (let i = startLine + 1; i < Math.min(startLine + 50, lines.length); i++) {
    const line = lines[i];
    if (line.trim() === "") { bodyLines.push(""); continue; }
    const lineIndent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
    if (lineIndent <= indent && line.trim() !== "") break;
    bodyLines.push(line);
  }
  return bodyLines.join("\n");
}

for (const file of files) {
  let content;
  try { content = readFileSync(file, "utf-8"); } catch { continue; }

  const relPath = relative(repoDir, file);
  const lines = content.split("\n");
  const ext = extname(file);

  if (ext === ".py") {
    // Python functions
    let m;
    pyFuncRe.lastIndex = 0;
    while ((m = pyFuncRe.exec(content)) !== null) {
      const indent = m[1].length;
      const name = m[2];
      const params = m[3].trim();
      const lineNum = content.substring(0, m.index).split("\n").length - 1;
      const docstring = extractDocstring(lines, lineNum);
      const body = getBody(lines, lineNum, indent);
      const signature = `def ${name}(${params})`;

      const entry = {
        name, signature, params, docstring,
        body: body.substring(0, 1000),
        file: relPath, line: lineNum + 1,
        type: indent > 0 ? "method" : "function",
      };

      functions.push(entry);
    }

    // Python classes
    pyClassRe.lastIndex = 0;
    while ((m = pyClassRe.exec(content)) !== null) {
      const indent = m[1].length;
      const name = m[2];
      const lineNum = content.substring(0, m.index).split("\n").length - 1;
      const docstring = extractDocstring(lines, lineNum);
      const body = getBody(lines, lineNum, indent);

      classes.push({
        name, docstring,
        body: body.substring(0, 2000),
        file: relPath, line: lineNum + 1,
      });
    }
  }

  if ([".ts", ".tsx", ".js", ".jsx", ".mjs"].includes(ext)) {
    let m;
    // Named functions
    jsFuncRe.lastIndex = 0;
    while ((m = jsFuncRe.exec(content)) !== null) {
      const name = m[1];
      const params = m[2].trim();
      const lineNum = content.substring(0, m.index).split("\n").length - 1;
      const docstring = extractDocstring(lines, lineNum);
      const body = getBody(lines, lineNum, 0);
      functions.push({
        name, signature: `function ${name}(${params})`, params, docstring,
        body: body.substring(0, 1000),
        file: relPath, line: lineNum + 1, type: "function",
      });
    }

    // Arrow functions
    jsArrowRe.lastIndex = 0;
    while ((m = jsArrowRe.exec(content)) !== null) {
      const name = m[1];
      const lineNum = content.substring(0, m.index).split("\n").length - 1;
      const docstring = extractDocstring(lines, lineNum);
      const body = getBody(lines, lineNum, 0);
      functions.push({
        name, signature: `const ${name} = (...)`, params: "", docstring,
        body: body.substring(0, 1000),
        file: relPath, line: lineNum + 1, type: "function",
      });
    }

    // Classes
    jsClassRe.lastIndex = 0;
    while ((m = jsClassRe.exec(content)) !== null) {
      const name = m[1];
      const lineNum = content.substring(0, m.index).split("\n").length - 1;
      const docstring = extractDocstring(lines, lineNum);
      const body = getBody(lines, lineNum, 0);
      classes.push({
        name, docstring,
        body: body.substring(0, 2000),
        file: relPath, line: lineNum + 1,
      });
    }

    // Methods
    jsMethodRe.lastIndex = 0;
    while ((m = jsMethodRe.exec(content)) !== null) {
      const indent = m[1].length;
      const name = m[2];
      const params = m[3].trim();
      if (["if", "for", "while", "switch", "catch", "constructor"].includes(name)) continue;
      const lineNum = content.substring(0, m.index).split("\n").length - 1;
      const docstring = extractDocstring(lines, lineNum);
      const body = getBody(lines, lineNum, indent);
      functions.push({
        name, signature: `${name}(${params})`, params, docstring,
        body: body.substring(0, 1000),
        file: relPath, line: lineNum + 1, type: "method",
      });
    }
  }
}

console.error(`Indexed: ${functions.length} functions/methods, ${classes.length} classes`);

// ── Build search index ──────────────────────────────────

// For each entry, build a "search text" that combines name, docstring, signature, and body keywords
function buildSearchText(entry) {
  const parts = [
    entry.name,
    entry.signature ?? "",
    entry.docstring ?? "",
    // Extract identifiers from body (camelCase/snake_case split)
    ...(entry.body ?? "").match(/[a-zA-Z_]\w+/g)?.slice(0, 100) ?? [],
  ];
  return parts.join(" ").toLowerCase();
}

const index = {
  version: 1,
  repo: isUrl ? repoArg : basename(repoDir),
  repoDir,
  indexedAt: new Date().toISOString(),
  languages: lang,
  files: files.length,
  functions: functions.map((f, i) => ({
    id: `f${i}`,
    ...f,
    searchText: buildSearchText(f),
  })),
  classes: classes.map((c, i) => ({
    id: `c${i}`,
    ...c,
    searchText: buildSearchText(c),
  })),
  stats: {
    totalFunctions: functions.length,
    totalClasses: classes.length,
    totalFiles: files.length,
  },
};

const json = JSON.stringify(index, null, 2);

if (outputPath) {
  const dir = outputPath.substring(0, outputPath.lastIndexOf("/"));
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(outputPath, json);
  console.error(`Index written to ${outputPath}`);
}

console.log(json);
