#!/usr/bin/env node

/**
 * Compile a skill into a deterministic step sequence.
 *
 * Reads a skill's SKILL.md, parses its capabilities (scripts, examples),
 * and produces a goal-tailored JSON sequence the agent can execute.
 *
 * Usage:
 *   node compile.mjs <skill-dir> "<goal>" [output-path]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join, basename, dirname, extname } from "path";

const skillDir = process.argv[2];
const goal = process.argv[3];
const outputPath = process.argv[4];

if (!skillDir || !goal) {
  console.error("Usage: node compile.mjs <skill-dir> \"<goal>\" [output-path]");
  process.exit(1);
}

// ── Load the skill ──────────────────────────────────────

const skillMd = join(skillDir, "SKILL.md");
if (!existsSync(skillMd)) {
  console.error(`No SKILL.md found in ${skillDir}`);
  process.exit(1);
}

const raw = readFileSync(skillMd, "utf-8");

const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---/);
const fm = fmMatch ? fmMatch[1] : "";
const skillName = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? basename(skillDir);
const skillDescription = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "";

const body = raw.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "").replace(/\{baseDir\}/g, skillDir);

// ── Discover available scripts ──────────────────────────

const scriptsDir = join(skillDir, "scripts");
const scripts = [];

if (existsSync(scriptsDir)) {
  for (const f of readdirSync(scriptsDir)) {
    if (!f.endsWith(".mjs") && !f.endsWith(".js") && !f.endsWith(".sh")) continue;
    const scriptPath = join(scriptsDir, f);
    const scriptName = f.replace(/\.(mjs|js|sh)$/, "");

    // Read the script's header comment for a description
    const scriptSrc = readFileSync(scriptPath, "utf-8");
    const headerMatch = scriptSrc.match(/\/\*\*\s*\n([\s\S]*?)\*\//);
    const desc = headerMatch
      ? headerMatch[1].replace(/^\s*\*\s?/gm, "").trim().split("\n")[0]
      : scriptName;

    // Extract usage line
    const usageMatch = scriptSrc.match(/Usage:\s*\n\s*\*?\s*(.*)/i)
      ?? scriptSrc.match(/console\.error\(["`]Usage:\s*(.*)/);
    const usage = usageMatch?.[1]?.replace(/["`].*/g, "").trim() ?? `node ${scriptPath}`;

    scripts.push({ name: scriptName, path: scriptPath, description: desc, usage });
  }
}

// ── Goal-aware sequence planning ────────────────────────

// Detect what the goal needs by keyword matching against script capabilities
const goalLower = goal.toLowerCase();

// Extract any arXiv IDs, paper titles, or other identifiers from the goal
const arxivIdMatch = goal.match(/(\d{4}\.\d{4,5})/);
const arxivId = arxivIdMatch?.[1];
const quotedMatch = goal.match(/"([^"]+)"/);
const quotedTerm = quotedMatch?.[1];

// Find variables in the goal
const variables = {};
const varRegex = /\{\{(\w+)\}\}/g;
let varMatch;
while ((varMatch = varRegex.exec(goal)) !== null) {
  variables[varMatch[1]] = "";
}

// Build steps based on what the goal asks for and what scripts are available
const steps = [];
let stepIndex = 0;

function addStep(description, command, opts = {}) {
  steps.push({
    index: stepIndex++,
    description,
    action: {
      kind: "primitive",
      type: "bash",
      description,
      params: { command },
    },
    onFailure: opts.onFailure ?? "abort",
    captureAs: opts.captureAs ?? null,
    condition: opts.condition ?? null,
  });
}

// Determine the script for each capability
const searchScript = scripts.find(s => s.name === "search");
const metadataScript = scripts.find(s => s.name === "metadata");
const downloadScript = scripts.find(s => s.name === "download-source");
const extractScript = scripts.find(s => s.name === "extract-algorithms");

// Paper-related goals
if (searchScript || metadataScript || downloadScript || extractScript) {
  const needsSearch = goalLower.includes("find") || goalLower.includes("search") || !arxivId;
  const needsMetadata = goalLower.includes("metadata") || goalLower.includes("about") || true; // usually want this
  const needsDownload = goalLower.includes("download") || goalLower.includes("source") ||
    goalLower.includes("implement") || goalLower.includes("extract") || goalLower.includes("algorithm");
  const needsExtract = goalLower.includes("extract") || goalLower.includes("algorithm") ||
    goalLower.includes("implement") || goalLower.includes("pseudocode");
  const needsImplement = goalLower.includes("implement") || goalLower.includes("code") ||
    goalLower.includes("build") || goalLower.includes("write");

  const paperId = arxivId ?? "{{paper_id}}";
  if (!arxivId && !variables.paper_id) variables.paper_id = "";

  const searchTerm = quotedTerm ?? (arxivId ? arxivId : "{{search_term}}");
  if (!quotedTerm && !arxivId && !variables.search_term) variables.search_term = "";

  const srcDir = `/tmp/paper-src-${paperId.replace(/[^a-z0-9]/gi, "")}`;

  // Step 1: Search (if no direct ID or explicitly asked)
  if (needsSearch && searchScript) {
    addStep(
      `Search arXiv for "${searchTerm}"`,
      `node ${searchScript.path} "${searchTerm}" --max 5`,
      { captureAs: "search_results" }
    );
  }

  // Step 2: Get metadata
  if (needsMetadata && metadataScript) {
    addStep(
      `Get metadata for paper ${paperId}`,
      `node ${metadataScript.path} ${paperId}`,
      { captureAs: "paper_metadata" }
    );
  }

  // Step 3: Download source
  if (needsDownload && downloadScript) {
    addStep(
      `Download LaTeX source for ${paperId}`,
      `node ${downloadScript.path} ${paperId} ${srcDir}`,
      { captureAs: "download_result" }
    );
  }

  // Step 4: Extract algorithms
  if (needsExtract && extractScript) {
    addStep(
      `Extract algorithms and pseudocode from source`,
      `node ${extractScript.path} ${srcDir}`,
      { captureAs: "extracted_algorithms" }
    );
  }

  // Step 5: Implement (write a stub file with the extracted algorithm)
  if (needsImplement) {
    addStep(
      `Save extracted algorithm to workspace for implementation`,
      `node ${extractScript?.path ?? "echo no-extract-script"} ${srcDir} > /tmp/algorithm-extract.json`,
      { captureAs: "algorithm_json", onFailure: "continue" }
    );
  }
} else {
  // Generic: run each script in order with the goal as context
  for (const script of scripts) {
    addStep(
      `Run ${script.name}: ${script.description}`,
      `node ${script.path} ${goal.includes("{{") ? goal : `"${goal}"`}`,
    );
  }
}

// ── Assemble the sequence ───────────────────────────────

const sequenceName = goal
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "")
  .substring(0, 64);

const sequence = {
  name: sequenceName,
  description: goal,
  sourceSkill: skillName,
  goal,
  variables,
  steps,
  compiledAt: new Date().toISOString(),
  compiledFrom: skillMd,
  metadata: {
    skillDescription,
    availableScripts: scripts.map(s => ({ name: s.name, description: s.description })),
  },
};

// ── Output ──────────────────────────────────────────────

const json = JSON.stringify(sequence, null, 2);

if (outputPath) {
  const dir = dirname(outputPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(outputPath, json);
  console.error(`Compiled ${steps.length} steps → ${outputPath}`);
}

console.log(json);
