#!/usr/bin/env node
/* Layer-4 combinatorial matrix — the row generator.
   Full-exhaustive Surface × State × Render × Host × A11y × Lifecycle, per the
   approved plan. A single complete enumeration of this 6-way factorial already
   contains every 2-through-5-way sub-combination as row projections — this IS
   "every combination from 2 to the max", non-redundantly. No separate
   smaller-order tables are generated.

   Four constraints prune cells that are structurally impossible (no code path
   can even receive the input), not merely low-value — verified against each
   surface's actual DOM-building code, not assumed:

   1. Host only means anything for the 6 surfaces actually injected into a
      provider's page DOM. The 4 isolated-page surfaces never touch provider
      CSS at all — there is no "host collision" cell for them, not a cheaper
      one. Collapses Host to 1 placeholder value.
   2. Render's two title-specific values (RTL/CJK/emoji, 2000-char-title)
      presuppose a chat-title-shaped field. tour/diag/timeline render no
      chat-derived text of that shape (verified: tour shows only static copy
      and the browser's own key bindings; diag shows platform names/percentages;
      timeline shows only a message index + a date). minimap/outline/
      chatcard/bridge/search were checked and kept — all demonstrably render
      real chat-derived text.
   3. State's two archive-scale values (empty/50k-chat-archive) presuppose a
      connection to the archive. diag/timeline/minimap/outline/tour have zero
      archive references. chatcard was checked and KEPT — it listens to
      storage.onChanged for synced chat metadata, a real connection via a
      different transport than the IndexedDB archive proper.
   4. Lifecycle's 50-chat-switch-soak presupposes staying mounted inside a
      provider page across its SPA navigation — inert for the same 4 isolated
      surfaces as constraint 1. The tour IS injected, and surviving an SPA
      route change is exactly what its 250ms reposition tick is for.

   Total: 22,550 rows (see `node test/matrix-rows.mjs --count` for the
   per-surface breakdown this number is generated from — never hand-maintain
   that table, regenerate it here). */

export const SURFACES = ["popup", "minimap", "search", "outline", "timeline", "chatcard", "bridge", "recall-page", "tour", "diag"];
export const STATE = ["free", "trial", "trial-expired", "pro", "deactivated", "offline", "empty-archive", "50k-chat-archive"];
export const RENDER = ["zoom", "320px-window", "rtl-cjk-emoji-titles", "2000-char-title", "dark-light-switch-mid-session", "prefers-reduced-motion", "forced-colors"];
// 6 real providers + 1 synthetic baseline (test/synthetic.html, per content/adapters.js's ADAPTERS array).
export const HOST = ["chatgpt", "claude", "gemini", "perplexity", "deepseek", "grok", "synthetic"];
export const A11Y = ["tab-order", "focus-trap", "esc", "conflicting-keybindings", "sr-labels"];
export const LIFECYCLE = ["50-chat-switch-soak", "extension-reload-mid-session"];

// Surfaces actually injected into a provider's page DOM (content_scripts
// group 1 in manifest.json) — these can collide with that provider's CSS.
const INJECTED_SURFACES = new Set(["minimap", "search", "outline", "timeline", "chatcard", "bridge", "tour"]);
// Surfaces that run in the extension's own isolated page/popup — never
// mounted inside a provider page, ever.
const ISOLATED_SURFACES = new Set(["popup", "recall-page", "diag"]);

const RENDER_TITLE_VALUES = new Set(["rtl-cjk-emoji-titles", "2000-char-title"]);
const RENDER_TITLE_INERT_SURFACES = new Set(["tour", "diag", "timeline"]);

const STATE_ARCHIVE_VALUES = new Set(["empty-archive", "50k-chat-archive"]);
const STATE_ARCHIVE_INERT_SURFACES = new Set(["diag", "timeline", "minimap", "outline", "tour"]);

const LIFECYCLE_SOAK_INERT_SURFACES = ISOLATED_SURFACES; // constraint 4 shares constraint 1's surface set

/** The per-surface factor lists, after applying the 4 constraints. */
export function factorsFor(surface) {
  const host = INJECTED_SURFACES.has(surface) ? HOST : ["n-a"];
  const render = RENDER_TITLE_INERT_SURFACES.has(surface)
    ? RENDER.filter((r) => !RENDER_TITLE_VALUES.has(r))
    : RENDER;
  const state = STATE_ARCHIVE_INERT_SURFACES.has(surface)
    ? STATE.filter((s) => !STATE_ARCHIVE_VALUES.has(s))
    : STATE;
  const lifecycle = LIFECYCLE_SOAK_INERT_SURFACES.has(surface)
    ? LIFECYCLE.filter((l) => l !== "50-chat-switch-soak")
    : LIFECYCLE;
  return { host, render, state, a11y: A11Y, lifecycle };
}

/** The full constrained row set: {surface, state, render, host, a11y, lifecycle} × 22,550. */
export function generateRows() {
  const rows = [];
  for (const surface of SURFACES) {
    const f = factorsFor(surface);
    for (const state of f.state) {
      for (const render of f.render) {
        for (const host of f.host) {
          for (const a11y of f.a11y) {
            for (const lifecycle of f.lifecycle) {
              rows.push({ surface, state, render, host, a11y, lifecycle });
            }
          }
        }
      }
    }
  }
  return rows;
}

export function breakdown(rows) {
  const bySurface = {};
  for (const r of rows) bySurface[r.surface] = (bySurface[r.surface] || 0) + 1;
  return bySurface;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows = generateRows();
  const counts = breakdown(rows);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(rows));
  } else {
    for (const surface of SURFACES) console.log(`${surface.padEnd(14)} ${String(counts[surface]).padStart(6)}`);
    console.log(`${"TOTAL".padEnd(14)} ${String(rows.length).padStart(6)}`);
  }
}
