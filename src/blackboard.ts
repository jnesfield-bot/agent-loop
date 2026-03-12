/**
 * Blackboard — A zoned canvas for agent observation.
 *
 * The blackboard is the agent's primary observation surface. It's a spatial
 * layout of named zones, each containing structured text. Think of it as a
 * TUI dashboard or a whiteboard with sticky notes — the agent "sees" the
 * whole board at once, and each zone is independently updatable.
 *
 * ## Why text, not images?
 *
 * Glyph (arXiv:2510.17800) renders text as images for VLM compression —
 * they get 3-4x token savings by packing text as Verdana 9pt in images.
 * But that's for 240K-token novels being compressed to fit a context window.
 *
 * Our board is ~1-2K tokens — no compression needed. And:
 * - LLMs process text natively with full reasoning (no OCR errors)
 * - Text is searchable, diffable, versionable, exact
 * - We CAN render to HTML/SVG for human dashboards (dual output)
 *
 * ## What we DO take from Glyph:
 *
 * Their genetic search proved spatial layout affects comprehension:
 * - Dense, zero-padding layouts outperform spacious ones
 * - Every character should carry information (data-ink ratio)
 * - Hierarchy through indentation beats redundant labels
 * - Consistent structure aids pattern recognition
 *
 * So: text primary (for LLM), dense layout (from Glyph), dual render (for humans).
 *
 * ## The canvas metaphor:
 *
 * Like Figma layers: named zones at priorities. The agent "draws" by
 * writing to zones. The full board renders as one text block for observe().
 * Zones have visibility tags — lenses filter what each agent role sees.
 */

import type {
  Action,
  ActionResult,
  ChildStatus,
  PrimitiveAction,
  SkillAction,
  SkillDescriptor,
  SkillExecution,
  State,
  TaskBrief,
} from "./types.js";

// ── Zone Types ───────────────────────────────────────────

export interface BoardZone {
  /** Unique name for this zone */
  name: string;
  /** Display title (shown in the rendered board) */
  title: string;
  /** Content lines */
  lines: string[];
  /** Visibility tags — which lenses can see this zone */
  visibility: LensTag[];
  /** Priority for rendering order (higher = rendered first) */
  priority: number;
  /** Whether this zone is currently stale (needs refresh) */
  stale: boolean;
  /** Last update timestamp */
  updatedAt: number;
}

export type LensTag = "executive" | "worker" | "monitor" | "minimal" | "all";

export type Lens = "executive" | "worker" | "monitor" | "minimal";

// ── The Board ────────────────────────────────────────────

export class Blackboard {
  private zones: Map<string, BoardZone> = new Map();
  private heartbeat = 0;
  private agentId = "";
  private lens: Lens = "worker";

  constructor(lens: Lens = "worker") {
    this.lens = lens;
  }

  // ── Zone API (the "drawing" tools) ─────────────────────

  /** Create or replace a zone */
  setZone(name: string, title: string, lines: string[], visibility: LensTag[] = ["all"], priority = 50): void {
    this.zones.set(name, {
      name, title, lines,
      visibility,
      priority,
      stale: false,
      updatedAt: Date.now(),
    });
  }

  /** Append lines to an existing zone */
  appendZone(name: string, lines: string[]): void {
    const zone = this.zones.get(name);
    if (zone) {
      zone.lines.push(...lines);
      zone.updatedAt = Date.now();
      zone.stale = false;
    }
  }

  /** Update specific lines in a zone by index */
  updateZoneLines(name: string, updates: Record<number, string>): void {
    const zone = this.zones.get(name);
    if (zone) {
      for (const [idx, line] of Object.entries(updates)) {
        zone.lines[parseInt(idx)] = line;
      }
      zone.updatedAt = Date.now();
    }
  }

  /** Mark a zone as stale (will show [stale] indicator) */
  markStale(name: string): void {
    const zone = this.zones.get(name);
    if (zone) zone.stale = true;
  }

  /** Remove a zone */
  removeZone(name: string): void {
    this.zones.delete(name);
  }

  /** Clear all zones */
  clear(): void {
    this.zones.clear();
  }

  // ── Populate from State ────────────────────────────────

  /**
   * Populate the board from a full agent state + memory stores.
   * This is the main entry point — called by observe() each heartbeat.
   */
  populate(state: State, extras?: {
    episodicSummary?: string[];
    semanticEntities?: string[];
    proceduralRules?: string[];
    policyRules?: string[];
    impasseWarning?: string;
    scratchpad?: string[];
  }): void {
    this.heartbeat = (state as any).heartbeat ?? 0;
    this.agentId = state.agentId;
    this.zones.clear();

    // ── HEADER (always visible) ──────────────────────────
    this.setZone("header", "HEADER", [
      `Agent: ${state.agentId}  Heartbeat: #${this.heartbeat}  Time: ${new Date(state.timestamp).toISOString().substring(11, 19)}`,
      `Lens: ${this.lens}${extras?.impasseWarning ? `  ⚠ ${extras.impasseWarning}` : ""}`,
    ], ["all"], 100);

    // ── TASK (always visible) ────────────────────────────
    if (state.currentTask) {
      const t = state.currentTask;
      const lines = [t.description];
      if (t.successCriteria?.length) {
        lines.push("Criteria:");
        for (const c of t.successCriteria) lines.push(`  ☐ ${c}`);
      }
      if (t.constraints?.length) {
        lines.push("Constraints:");
        for (const c of t.constraints) lines.push(`  ⚠ ${c}`);
      }
      if (t.priority != null) lines.push(`Priority: ${t.priority}`);
      this.setZone("task", "TASK", lines, ["all"], 95);
    }

    // ── LAST ACTION (visible to all except minimal) ──────
    if (state.lastActionResult) {
      const r = state.lastActionResult;
      const actionType = r.action.kind === "skill"
        ? `skill:${(r.action as SkillAction).skillName}`
        : (r.action as PrimitiveAction).type;
      const icon = r.success ? "✓" : "✗";
      const lines = [
        `${icon} ${actionType}: ${r.action.description.substring(0, 70)}`,
        `  ${r.success ? "OK" : "FAIL"} (${r.durationMs}ms)`,
      ];
      if (r.output) {
        const preview = r.output.split("\n").slice(0, 3).map(l => `  │ ${l.substring(0, 70)}`);
        lines.push(...preview);
        if (r.output.split("\n").length > 3) lines.push(`  │ ... (${r.output.split("\n").length} lines)`);
      }
      if (r.error) lines.push(`  ERROR: ${r.error.substring(0, 80)}`);
      if (r.skillTrace) lines.push(`  Steps: ${r.skillTrace.currentStep + 1}/${r.skillTrace.steps.length}`);
      this.setZone("last-action", "LAST ACTION", lines, ["executive", "worker", "monitor", "all"], 90);
    }

    // ── EPISODIC MEMORY (recent experience) ──────────────
    if (extras?.episodicSummary?.length) {
      this.setZone("episodic", "EPISODIC (recent)", extras.episodicSummary, ["executive", "worker", "all"], 80);
    }

    // ── SEMANTIC MEMORY (what I know) ────────────────────
    if (extras?.semanticEntities?.length) {
      this.setZone("semantic", "SEMANTIC (knowledge)", extras.semanticEntities, ["executive", "worker", "all"], 75);
    }

    // ── PROCEDURAL MEMORY (rules & patterns) ─────────────
    if (extras?.proceduralRules?.length) {
      this.setZone("procedural", "PROCEDURAL (rules)", extras.proceduralRules, ["executive", "worker", "all"], 70);
    }

    // ── ACTIVE POLICY RULES ──────────────────────────────
    if (extras?.policyRules?.length) {
      this.setZone("policy", "ACTIVE POLICY", extras.policyRules, ["executive", "monitor", "all"], 65);
    }

    // ── WORKING MEMORY (key-value) ───────────────────────
    const memKeys = Object.keys(state.memory).filter(k => !k.startsWith("_"));
    if (memKeys.length > 0) {
      const lines = memKeys.slice(0, 12).map(k => {
        const v = String(state.memory[k]);
        return `${k}: ${v.length > 60 ? v.substring(0, 57) + "..." : v}`;
      });
      if (memKeys.length > 12) lines.push(`... +${memKeys.length - 12} more`);
      this.setZone("memory", `WORKING MEMORY (${memKeys.length})`, lines, ["executive", "worker", "all"], 60);
    }

    // ── CHILDREN (for executive agents) ──────────────────
    if (state.children.length > 0) {
      const lines = state.children.map(c => {
        const icon = { idle: "○", running: "◉", done: "✓", failed: "✗", blocked: "⊘" }[c.status] ?? "?";
        return `${icon} ${c.agentId} [${c.status}] hb:${c.heartbeatCount} progress:${Math.round(c.progress * 100)}%`;
      });
      this.setZone("children", `CHILDREN (${state.children.length})`, lines, ["executive", "monitor", "all"], 55);
    }

    // ── INPUTS ───────────────────────────────────────────
    if (state.inputs.length > 0) {
      const lines = state.inputs.slice(0, 5).map(i =>
        `[${i.source}] ${i.content.substring(0, 70)}`
      );
      this.setZone("inputs", `INPUTS (${state.inputs.length})`, lines, ["executive", "all"], 50);
    }

    // ── SKILLS ───────────────────────────────────────────
    if (state.availableSkills.length > 0) {
      const lines = state.availableSkills.map(s => `• ${s.name}: ${s.description.substring(0, 60)}`);
      this.setZone("skills", `SKILLS (${state.availableSkills.length})`, lines, ["executive", "worker", "all"], 40);
    }

    // ── ACTIVE SKILL ─────────────────────────────────────
    if (state.activeSkill) {
      const s = state.activeSkill;
      const lines = [
        `Running: ${s.skill.name} — "${s.goal}"`,
        `Step ${s.currentStep + 1}/${s.steps.length}${s.failed ? " ✗ FAILED" : ""}`,
      ];
      for (let i = 0; i < Math.min(s.steps.length, 5); i++) {
        const step = s.steps[i];
        const icon = i < s.currentStep ? "✓" : i === s.currentStep ? "▸" : "○";
        lines.push(`  ${icon} ${step.description.substring(0, 60)}`);
      }
      this.setZone("active-skill", "ACTIVE SKILL", lines, ["executive", "worker", "monitor", "all"], 85);
    }

    // ── WORKSPACE ────────────────────────────────────────
    const files = state.observations?.["workspace_files"];
    if (files && typeof files === "string") {
      const fileList = files.split("\n").filter(Boolean);
      const lines = fileList.slice(0, 15).map(f => f.replace(/^.*\//, "  "));
      if (fileList.length > 15) lines.push(`  ... +${fileList.length - 15} more files`);
      this.setZone("workspace", `WORKSPACE (${fileList.length} files)`, lines, ["executive", "worker", "all"], 30);
    }

    // ── SCRATCHPAD (agent's own notes) ───────────────────
    if (extras?.scratchpad?.length) {
      this.setZone("scratchpad", "SCRATCHPAD", extras.scratchpad, ["executive", "worker", "all"], 20);
    }
  }

  // ── Render ─────────────────────────────────────────────

  /**
   * Render the full board as structured text.
   * This is what the LLM sees during the observe phase.
   */
  render(): string {
    const W = 72;
    const HR = "═".repeat(W);
    const hr = "─".repeat(W - 6);

    // Filter zones by current lens
    const visible = [...this.zones.values()]
      .filter(z => z.visibility.includes("all") || z.visibility.includes(this.lens))
      .sort((a, b) => b.priority - a.priority);

    if (visible.length === 0) return `╔${HR}╗\n║  (empty board)${" ".repeat(W - 16)}║\n╚${HR}╝`;

    const lines: string[] = [];
    lines.push(`╔${HR}╗`);

    for (let zi = 0; zi < visible.length; zi++) {
      const zone = visible[zi];
      const staleMarker = zone.stale ? " [stale]" : "";

      // Zone header
      if (zi > 0) lines.push(`╠${hr}══════╣`);
      const title = `  ${zone.title}${staleMarker}`;
      lines.push(`║${this.pad(title, W)}║`);

      // Zone content
      for (const line of zone.lines) {
        // Wrap long lines
        const chunks = this.wrapLine(line, W - 4);
        for (const chunk of chunks) {
          lines.push(`║  ${this.pad(chunk, W - 2)}║`);
        }
      }
    }

    lines.push(`╚${HR}╝`);
    return lines.join("\n");
  }

  /**
   * Render as compact single-line-per-zone format (for token-constrained contexts).
   */
  renderCompact(): string {
    const visible = [...this.zones.values()]
      .filter(z => z.visibility.includes("all") || z.visibility.includes(this.lens))
      .sort((a, b) => b.priority - a.priority);

    return visible.map(z => `[${z.title}] ${z.lines.join(" | ")}`).join("\n");
  }

  /**
   * Render as JSON (for programmatic consumption).
   */
  renderJson(): Record<string, { title: string; lines: string[]; stale: boolean }> {
    const visible = [...this.zones.values()]
      .filter(z => z.visibility.includes("all") || z.visibility.includes(this.lens))
      .sort((a, b) => b.priority - a.priority);

    const result: Record<string, { title: string; lines: string[]; stale: boolean }> = {};
    for (const z of visible) {
      result[z.name] = { title: z.title, lines: z.lines, stale: z.stale };
    }
    return result;
  }

  /**
   * Render as HTML for human dashboard viewing.
   *
   * This is the "dual render" — same data as render(), but as a visual
   * board a human can view in a browser. Inspired by Glyph's insight that
   * spatial layout aids comprehension, applied to human UX instead of VLM.
   *
   * CSS uses Glyph's density principles: tight line-height, minimal padding,
   * monospace font for alignment, dark-on-light for readability.
   */
  renderHtml(): string {
    const visible = [...this.zones.values()]
      .filter(z => z.visibility.includes("all") || z.visibility.includes(this.lens))
      .sort((a, b) => b.priority - a.priority);

    const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    const zones = visible.map(z => {
      const staleClass = z.stale ? ' class="stale"' : '';
      const content = z.lines.map(l => `<div class="line">${escHtml(l)}</div>`).join("\n");
      return `<div class="zone"${staleClass}>
  <div class="zone-title">${escHtml(z.title)}${z.stale ? ' <span class="stale-tag">[stale]</span>' : ''}</div>
  <div class="zone-content">${content}</div>
</div>`;
    }).join("\n");

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Blackboard — ${this.agentId} #${this.heartbeat}</title>
<style>
/* Glyph-inspired density: tight spacing, monospace, high data-ink ratio */
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'Verdana', 'DejaVu Sans Mono', monospace; font-size: 11px;
       line-height: 1.2; background: #1a1a2e; color: #e0e0e0; padding: 8px; }
.zone { border: 1px solid #3a3a5c; margin-bottom: 4px; background: #16213e; }
.zone-title { background: #0f3460; padding: 2px 6px; font-weight: bold;
              font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px;
              color: #53c0f0; border-bottom: 1px solid #3a3a5c; }
.zone-content { padding: 3px 6px; }
.line { white-space: pre-wrap; word-break: break-all; }
.stale { opacity: 0.6; }
.stale-tag { color: #e94560; font-size: 9px; }
</style></head>
<body>
<div class="board">
${zones}
</div>
<div style="margin-top:8px;font-size:9px;color:#666;">
  Agent: ${escHtml(this.agentId)} | Heartbeat: #${this.heartbeat} | Lens: ${this.lens} | ${new Date().toISOString().substring(11, 19)}
</div>
</body></html>`;
  }

  // ── Utilities ──────────────────────────────────────────

  setLens(lens: Lens): void { this.lens = lens; }
  getLens(): Lens { return this.lens; }
  getZone(name: string): BoardZone | undefined { return this.zones.get(name); }
  getZoneNames(): string[] { return [...this.zones.keys()]; }

  private pad(s: string, w: number): string {
    if (s.length >= w) return s.substring(0, w);
    return s + " ".repeat(w - s.length);
  }

  private wrapLine(line: string, maxWidth: number): string[] {
    if (line.length <= maxWidth) return [line];
    const chunks: string[] = [];
    let remaining = line;
    while (remaining.length > maxWidth) {
      // Try to break at a space
      let breakAt = remaining.lastIndexOf(" ", maxWidth);
      if (breakAt < maxWidth * 0.4) breakAt = maxWidth; // No good break point
      chunks.push(remaining.substring(0, breakAt));
      remaining = "  " + remaining.substring(breakAt).trimStart();
    }
    if (remaining.trim()) chunks.push(remaining);
    return chunks;
  }
}
