#!/usr/bin/env node
/* Layer-4 combinatorial matrix — the runner, host="synthetic" rows only.
   Real-provider rows (82% of the full matrix) are deliberately NOT run here —
   see tools/live-check.mjs (extended in Phase 7) for those, kept off CI and
   human-attended, directly informed by Item 0.

   Stays on this repo's existing plain-script + raw `chromium` convention
   rather than introducing @playwright/test: this is the judgment call the
   plan flagged as overridable, made in favor of a runner that's immediately
   working and consistent with every other file in this suite, over
   @playwright/test's sharding/reporting ergonomics. Revisit if/when the full
   3,730-row CI-automatable slice needs production sharding.

   Per-surface assertions are real, not stubbed, for the surfaces implemented
   below (see SURFACE_CHECKS) — extending to the remaining surfaces is
   mechanical (same shape: mount the surface, assert it rendered under the
   row's Render/A11y conditions, assert no console error) but needs each
   surface's own trigger selector, which is why it isn't all done at once.

   Flags: --surface=<name> --host=synthetic --shard=N/M --limit=<n> --list */
import { join } from "node:path";
import { generateRows, SURFACES } from "./matrix-rows.mjs";
import { SCRATCH, reporter, mirrorExtension, launchExtension } from "./security-fixtures.mjs";
import { setEntitlement, seedArchive, wipeArchive, applyRenderCondition, ARCHIVE_SIZE_FOR_STATE } from "./matrix-fixtures.mjs";

const argv = process.argv.slice(2);
const flag = (name, def = null) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const only = { surface: flag("surface"), host: flag("host") };
const shardSpec = flag("shard"); // "N/M"
const limit = flag("limit") ? Number(flag("limit")) : Infinity;
const smoke = argv.includes("--smoke");

// This runner's scope: rows needing no real provider credentials — the
// synthetic host (injected surfaces) and "n-a" (isolated surfaces, where
// Host was never a real factor to begin with). Real-provider rows are
// tools/live-check.mjs's territory (Phase 7), not this runner's.
const NO_CREDENTIALS_NEEDED = new Set(["synthetic", "n-a"]);
let rows = generateRows().filter((r) => NO_CREDENTIALS_NEEDED.has(r.host));
if (only.surface) rows = rows.filter((r) => r.surface === only.surface);
if (only.host) rows = rows.filter((r) => r.host === only.host);

// PR-gate smoke slice: one row per (surface × lifecycle) at state in
// {free, pro}, one representative Render value, a11y=tab-order. ~50-100
// rows, seconds not minutes — the every-PR CI job uses this, never the full
// matrix. A surface/state combination that's been pruned by a matrix
// constraint (e.g. "pro" not applicable, or Lifecycle collapsed to 1 value)
// is simply absent from its slice rather than forced — the smoke slice
// respects the same constraints the full matrix does.
if (smoke) {
  const REPRESENTATIVE_RENDER = "zoom";
  const seen = new Set();
  rows = rows.filter((r) => {
    if (!["free", "pro"].includes(r.state)) return false;
    if (r.render !== REPRESENTATIVE_RENDER) return false;
    if (r.a11y !== "tab-order") return false;
    const key = `${r.surface}|${r.lifecycle}|${r.state}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
if (shardSpec) {
  const [n, m] = shardSpec.split("/").map(Number);
  rows = rows.filter((_, i) => i % m === n - 1);
}
if (argv.includes("--list")) {
  console.log(`${rows.length} matching rows.`);
  process.exit(0);
}
rows = rows.slice(0, limit);

/**
 * Real, surface-specific checks. Each receives the live `page` (already
 * navigated to test/synthetic.html with the row's Render condition applied)
 * and the `row` being exercised, and returns {ok, detail}. Extending this map
 * to the remaining 8 surfaces is the concrete, mechanical next step — each
 * needs its own mount/trigger selector, which is the only surface-specific
 * part; state/render/archive plumbing (matrix-fixtures.mjs) is already shared.
 */
const SURFACE_CHECKS = {
  async minimap(page) {
    const toggle = page.locator("#lct-mm-toggle");
    const present = await toggle.count() > 0;
    if (!present) return { ok: false, detail: "minimap toggle (#lct-mm-toggle) never mounted" };
    await toggle.click().catch(() => {});
    await page.waitForTimeout(200);
    const canvas = await page.locator("#lct-mm-canvas").count();
    return { ok: canvas > 0, detail: canvas > 0 ? "" : "minimap canvas did not appear after toggle click" };
  },
  async ["recall-page"](page, row, { ctx, id }) {
    const rp = await ctx.newPage();
    try {
      await rp.goto(`chrome-extension://${id}/recall.html`);
      const qPresent = await rp.locator("#q").count() > 0;
      if (!qPresent) return { ok: false, detail: "recall.html's #q search input never mounted" };
      // recall-search is Pro-gated (archive.search) — on a non-pro State the
      // box exists in the DOM but sits behind a paywall prompt and is
      // legitimately not fillable. Only exercise the fill+search path when
      // this row's State is actually entitled; otherwise the correct
      // assertion is presence, not interactivity.
      if (row.state !== "pro") {
        return { ok: true, detail: `#q present (not exercised — State "${row.state}" is not entitled, gated UI is expected)` };
      }
      await rp.fill("#q", "Seeded matrix chat");
      await rp.waitForTimeout(500);
      const resultsCount = await rp.locator("#results").count();
      return { ok: resultsCount > 0, detail: resultsCount > 0 ? "" : "#results container missing" };
    } finally { await rp.close(); }
  }
};

/* The install listener arms the tour, and it opens over whatever control a
   surface check is about — so a click waits for an actionable element that a
   coach mark is covering. Clearing the flag in the fixture is not enough: the
   worker's install listener can arm it AFTER that write lands, which is a race
   the fixture cannot win. Dismissing what is actually on screen can only be
   raced by the tour appearing later, and it is fast when there is none.

   One minimap row spent 17 minutes on a single click before this. */
async function dismissTour(page) {
  for (let i = 0; i < 40; i++) {
    const gone = await page.evaluate(() => {
      const card = document.getElementById("lct-tour-card");
      if (!card) return true;
      (card.querySelector(".lct-tour-close") || card.querySelector(".lct-tour-next"))?.click();
      return false;
    });
    if (gone) return;
    await page.waitForTimeout(50);
  }
}

async function runRow(row, group) {
  const { ctx } = group;
  const page = await ctx.newPage();
  try {
    const trackedErrors = [];
    page.on("pageerror", (e) => trackedErrors.push(e.message));

    await page.goto(`http://127.0.0.1:${group.port}/synthetic.html`, { waitUntil: "load" });
    await dismissTour(page);
    await applyRenderCondition(page, row.render);
    await page.waitForTimeout(150);

    const check = SURFACE_CHECKS[row.surface];
    if (!check) return { row, skipped: true, detail: `no SURFACE_CHECKS entry for "${row.surface}" yet` };

    const result = await check(page, row, group);
    if (trackedErrors.length) return { row, ok: false, detail: `page error(s): ${trackedErrors.join("; ")}` };
    return { row, ok: result.ok, detail: result.detail };
  } finally { await page.close(); }
}

async function main() {
  const { t, done } = reporter();
  if (!rows.length) { console.log("No rows match the given filters."); process.exit(0); }

  const bySurface = new Map();
  for (const surface of SURFACES) {
    if (!SURFACE_CHECKS[surface]) continue; // skip surfaces with no check yet, don't fail them silently
    const surfaceRows = rows.filter((r) => r.surface === surface);
    if (surfaceRows.length) bySurface.set(surface, surfaceRows);
  }

  let skippedNoCheck = rows.length - [...bySurface.values()].reduce((n, r) => n + r.length, 0);

  for (const [surface, surfaceRows] of bySurface) {
    const { EXT, priv } = mirrorExtension(`matrix-${surface}`);
    const { spawn } = await import("node:child_process");
    const port = 8930 + [...bySurface.keys()].indexOf(surface);
    const server = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1"],
      { cwd: join(EXT, "test"), stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 300));

    const { ctx, id } = await launchExtension(EXT, join(SCRATCH, `matrix-${surface}-profile`));
    const group = { ctx, id, priv, port };

    // Group rows by State so entitlement/archive setup happens once per
    // group, not once per row — the whole point of matrix-fixtures.mjs's
    // seed-once design.
    const byState = new Map();
    for (const row of surfaceRows) {
      if (!byState.has(row.state)) byState.set(row.state, []);
      byState.get(row.state).push(row);
    }

    try {
      for (const [state, stateRows] of byState) {
        await setEntitlement(ctx, id, state, { priv });
        const archiveSize = ARCHIVE_SIZE_FOR_STATE[state];
        if (archiveSize !== undefined) {
          await wipeArchive(ctx, id);
          // MATRIX_ARCHIVE_SIZE overrides for a fast local/demo run (seeding
          // 50k chats takes real time); a real nightly CI run leaves this
          // unset and seeds the true size the State value names.
          const n = process.env.MATRIX_ARCHIVE_SIZE ? Number(process.env.MATRIX_ARCHIVE_SIZE) : archiveSize;
          if (n > 0) await seedArchive(ctx, id, n);
        }
        for (const row of stateRows) {
          const result = await runRow(row, group);
          const label = `${row.surface} | ${row.state} | ${row.render} | ${row.host} | ${row.a11y} | ${row.lifecycle}`;
          if (result.skipped) continue;
          t(label, result.ok, result.detail);
        }
      }
    } finally {
      await ctx.close();
      server.kill();
    }
  }

  if (skippedNoCheck > 0) {
    console.log(`\n(${skippedNoCheck} rows skipped — surface not yet in SURFACE_CHECKS: ${SURFACES.filter((s) => !SURFACE_CHECKS[s]).join(", ")})`);
  }
  done();
}

main();
