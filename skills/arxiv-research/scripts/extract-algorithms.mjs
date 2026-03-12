#!/usr/bin/env node

/**
 * Extract algorithm blocks from LaTeX source files.
 *
 * Finds \begin{algorithm}...\end{algorithm}, \begin{algorithmic}...\end{algorithmic},
 * and \begin{lstlisting}...\end{lstlisting} environments.
 *
 * Usage:
 *   node extract-algorithms.mjs /tmp/paper-src
 *   node extract-algorithms.mjs /tmp/paper-src --include-equations
 */

import { readdirSync, readFileSync } from "fs";
import { join } from "path";

const sourceDir = process.argv[2];
const includeEquations = process.argv.includes("--include-equations");

if (!sourceDir) {
  console.error("Usage: node extract-algorithms.mjs <source-dir> [--include-equations]");
  process.exit(1);
}

// Find all .tex files recursively
const texFiles = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (entry.name.endsWith(".tex")) {
      texFiles.push(full);
    }
  }
};
walk(sourceDir);

if (texFiles.length === 0) {
  console.error("No .tex files found in " + sourceDir);
  process.exit(1);
}

const results = {
  algorithms: [],
  equations: [],
  sourceFiles: texFiles.map(f => f.replace(sourceDir + "/", "")),
};

// Environments to extract
const algoEnvs = ["algorithm", "algorithm2e", "algorithmic", "lstlisting", "verbatim"];
const eqEnvs = ["equation", "equation*", "align", "align*", "gather", "gather*", "multline"];

for (const texFile of texFiles) {
  const content = readFileSync(texFile, "utf-8");
  const relPath = texFile.replace(sourceDir + "/", "");

  // Extract algorithm environments
  for (const env of algoEnvs) {
    const regex = new RegExp(
      `\\\\begin\\{${env.replace("*", "\\*")}\\}([\\s\\S]*?)\\\\end\\{${env.replace("*", "\\*")}\\}`,
      "g"
    );
    let match;
    while ((match = regex.exec(content)) !== null) {
      // Look for a caption/label
      const block = match[0];
      const captionMatch = block.match(/\\caption\{([^}]+)\}/);
      const labelMatch = block.match(/\\label\{([^}]+)\}/);

      results.algorithms.push({
        environment: env,
        file: relPath,
        caption: captionMatch ? captionMatch[1] : null,
        label: labelMatch ? labelMatch[1] : null,
        content: match[0].trim(),
        pseudocode: extractPseudocode(match[1]),
      });
    }
  }

  // Optionally extract equations
  if (includeEquations) {
    for (const env of eqEnvs) {
      const regex = new RegExp(
        `\\\\begin\\{${env.replace("*", "\\*")}\\}([\\s\\S]*?)\\\\end\\{${env.replace("*", "\\*")}\\}`,
        "g"
      );
      let match;
      while ((match = regex.exec(content)) !== null) {
        const labelMatch = match[0].match(/\\label\{([^}]+)\}/);
        results.equations.push({
          environment: env,
          file: relPath,
          label: labelMatch ? labelMatch[1] : null,
          content: match[0].trim(),
        });
      }
    }
  }
}

console.log(JSON.stringify(results, null, 2));

/**
 * Clean up algorithmic pseudocode for readability.
 * Strips LaTeX commands, preserves logical structure.
 */
function extractPseudocode(raw) {
  let lines = raw.split("\n");
  let cleaned = [];
  let indent = 0;

  for (let line of lines) {
    line = line.trim();
    if (!line) continue;

    // Skip pure comments
    if (line.startsWith("%")) continue;

    // Track indentation
    if (/\\End(For|While|If|Loop|Procedure|Function)/.test(line)) {
      indent = Math.max(0, indent - 1);
    }

    // Clean LaTeX commands to readable pseudocode
    let clean = line
      // State/steps
      .replace(/\\State\s*/g, "")
      .replace(/\\Statex\s*/g, "")
      // Control flow
      .replace(/\\For\{(.+?)\}/g, "FOR $1:")
      .replace(/\\ForAll\{(.+?)\}/g, "FOR ALL $1:")
      .replace(/\\While\{(.+?)\}/g, "WHILE $1:")
      .replace(/\\If\{(.+?)\}/g, "IF $1:")
      .replace(/\\ElsIf\{(.+?)\}/g, "ELSE IF $1:")
      .replace(/\\Else/g, "ELSE:")
      .replace(/\\EndFor/g, "END FOR")
      .replace(/\\EndWhile/g, "END WHILE")
      .replace(/\\EndIf/g, "END IF")
      .replace(/\\EndLoop/g, "END LOOP")
      .replace(/\\Repeat/g, "REPEAT:")
      .replace(/\\Until\{(.+?)\}/g, "UNTIL $1")
      .replace(/\\Return\s*/g, "RETURN ")
      // Procedures
      .replace(/\\Procedure\{(.+?)\}\{(.+?)\}/g, "PROCEDURE $1($2):")
      .replace(/\\Function\{(.+?)\}\{(.+?)\}/g, "FUNCTION $1($2):")
      .replace(/\\EndProcedure/g, "END PROCEDURE")
      .replace(/\\EndFunction/g, "END FUNCTION")
      // Require/Ensure
      .replace(/\\Require\s*/g, "REQUIRE: ")
      .replace(/\\Ensure\s*/g, "ENSURE: ")
      // Comments
      .replace(/\\Comment\{(.+?)\}/g, "// $1")
      // Math
      .replace(/\$([^$]+)\$/g, "$1")
      .replace(/\\mathcal\{(\w)\}/g, "$1")
      .replace(/\\text\{([^}]+)\}/g, "$1")
      .replace(/\\textbf\{([^}]+)\}/g, "$1")
      .replace(/\\textit\{([^}]+)\}/g, "$1")
      .replace(/\\emph\{([^}]+)\}/g, "$1")
      .replace(/\\left/g, "")
      .replace(/\\right/g, "")
      .replace(/\\quad/g, "  ")
      .replace(/\\\\/g, "")
      // Arrows and symbols
      .replace(/\\gets/g, "←")
      .replace(/\\leftarrow/g, "←")
      .replace(/\\rightarrow/g, "→")
      .replace(/\\leq/g, "≤")
      .replace(/\\geq/g, "≥")
      .replace(/\\neq/g, "≠")
      .replace(/\\infty/g, "∞")
      .replace(/\\epsilon/g, "ε")
      .replace(/\\gamma/g, "γ")
      .replace(/\\alpha/g, "α")
      .replace(/\\beta/g, "β")
      .replace(/\\theta/g, "θ")
      .replace(/\\pi/g, "π")
      .replace(/\\phi/g, "φ")
      .replace(/\\max/g, "max")
      .replace(/\\min/g, "min")
      .replace(/\\arg\\max/g, "argmax")
      .replace(/\\arg\\min/g, "argmin")
      .replace(/\\sum/g, "Σ")
      .replace(/\\prod/g, "Π")
      .replace(/\\nabla/g, "∇")
      .replace(/\\partial/g, "∂")
      .replace(/\\sim/g, "~")
      .replace(/\\in/g, "∈")
      .replace(/\\cup/g, "∪")
      .replace(/\\cap/g, "∩")
      .replace(/\\subset/g, "⊂")
      .replace(/\\times/g, "×")
      .replace(/\\cdot/g, "·")
      // Cleanup
      .replace(/\{/g, "")
      .replace(/\}/g, "")
      .replace(/\\,/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (!clean) continue;

    // Skip caption/label lines
    if (clean.startsWith("\\caption") || clean.startsWith("\\label")) continue;

    cleaned.push("  ".repeat(indent) + clean);

    // Increase indent after control flow
    if (/^(FOR|WHILE|IF|ELSE|REPEAT|PROCEDURE|FUNCTION)/.test(clean)) {
      indent++;
    }
  }

  return cleaned.join("\n");
}
