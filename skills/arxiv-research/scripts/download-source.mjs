#!/usr/bin/env node

/**
 * Download and extract LaTeX source for an arXiv paper.
 *
 * Usage:
 *   node download-source.mjs 1312.5602 /tmp/paper-src
 */

import { execSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readdirSync } from "fs";
import { join } from "path";

const arxivId = process.argv[2];
const outputDir = process.argv[3];

if (!arxivId || !outputDir) {
  console.error("Usage: node download-source.mjs <arxiv-id> <output-dir>");
  process.exit(1);
}

const url = `https://arxiv.org/e-print/${arxivId}`;
const tarPath = join(outputDir, `${arxivId.replace("/", "-")}.tar.gz`);

// Create output directory
mkdirSync(outputDir, { recursive: true });

console.error(`Downloading source for ${arxivId}...`);

try {
  // Download
  execSync(`curl -sL "${url}" -o "${tarPath}"`, { timeout: 30000 });

  // Check what we got
  const fileType = execSync(`file "${tarPath}"`, { encoding: "utf-8" }).trim();

  if (fileType.includes("gzip")) {
    // Try tar.gz first
    try {
      execSync(`tar xzf "${tarPath}" -C "${outputDir}" 2>/dev/null`);
    } catch {
      // Might be a single gzipped file (not tar)
      try {
        execSync(`gunzip -c "${tarPath}" > "${join(outputDir, "paper.tex")}" 2>/dev/null`);
      } catch {
        console.error("Failed to extract source archive");
        process.exit(1);
      }
    }
  } else if (fileType.includes("tar")) {
    execSync(`tar xf "${tarPath}" -C "${outputDir}"`);
  } else if (fileType.includes("PDF")) {
    console.error("Paper source is PDF-only (no LaTeX available)");
    process.exit(1);
  } else {
    // Might be raw tex
    const newPath = join(outputDir, "paper.tex");
    execSync(`mv "${tarPath}" "${newPath}"`);
    console.error("Source appears to be a single file");
  }

  // Clean up tar
  try { unlinkSync(tarPath); } catch {}

  // List extracted files
  const files = [];
  const walk = (dir, prefix = "") => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(join(dir, entry.name), rel);
      } else {
        files.push(rel);
      }
    }
  };
  walk(outputDir);

  const texFiles = files.filter(f => f.endsWith(".tex"));
  const bibFiles = files.filter(f => f.endsWith(".bib") || f.endsWith(".bbl"));
  const otherFiles = files.filter(f => !f.endsWith(".tex") && !f.endsWith(".bib") && !f.endsWith(".bbl"));

  const result = {
    arxivId,
    outputDir,
    texFiles,
    bibFiles,
    otherFiles: otherFiles.slice(0, 20),  // Cap listing
    totalFiles: files.length,
  };

  console.log(JSON.stringify(result, null, 2));

} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
