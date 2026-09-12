#!/usr/bin/env node
/**
 * Tvara — publish tvara.pages.dev.
 *
 * The Pages project is DIRECT UPLOAD, not git-connected (`wrangler pages
 * project list` → Git Provider: No), so nothing in this repo reaches the site
 * by being committed. That is how both Search Console ownership artifacts came
 * to vanish: they only ever existed on a hand-made upload.
 *
 * The publish set is an ALLOWLIST, never a directory. `docs/` also holds
 * SESSIONS.md, architecture/ and operations/ — internal design notes — and
 * `icons/` holds a personal photograph. Uploading either folder wholesale
 * publishes those, and the only reason it has not happened is that nobody has
 * tried it yet.
 *
 *   node tools/site-deploy.mjs [--dry]
 */
import { mkdirSync, rmSync, copyFileSync, existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const OUT = join(ROOT, "dist", "site");
const PROJECT = "tvara";

/* published path → source path. Every entry is deliberate; add one only when
   the live site actually needs it. */
const FILES = {
  "index.html": "docs/index.html",
  "privacy.html": "docs/privacy.html",
  "terms.html": "docs/terms.html",
  "thanks.html": "docs/thanks.html",
  /* Without this Pages serves index.html with a 200 for every unmatched path,
     so /anything-at-all is a soft 404: Search Console reads a site full of
     duplicate home pages. The previous upload had one; it was never in git,
     which is the same way both ownership artifacts went missing. */
  "404.html": "docs/404.html",
  // The pages reference ../icons/icon128.png, which resolves to /icons/ at the
  // site root. It has been 404 in production, so the logo was broken on every
  // legal page.
  "icons/icon128.png": "icons/icon128.png",
  "favicon.ico": "icons/favicon.ico",
  "apple-touch-icon.png": "icons/apple-touch-icon.png"
};

/* Search Console ownership files, whatever they are called. Picked up from
   docs/ automatically so adding one is a copy, not an edit here. */
for (const f of readdirSync(join(ROOT, "docs"))) {
  if (/^google[a-z0-9]+\.html$/.test(f)) FILES[f] = "docs/" + f;
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const missing = [];
for (const [to, from] of Object.entries(FILES)) {
  const src = join(ROOT, from);
  if (!existsSync(src)) { missing.push(from); continue; }
  mkdirSync(dirname(join(OUT, to)), { recursive: true });
  copyFileSync(src, join(OUT, to));
  console.log("  + " + to);
}
if (missing.length) {
  console.error("\n✋ missing source file(s): " + missing.join(", "));
  process.exit(1);
}

if (process.argv.includes("--dry")) {
  console.log(`\nprepared ${OUT} (not deployed — drop --dry to publish)`);
  process.exit(0);
}

const run = spawnSync("wrangler", ["pages", "deploy", OUT, "--project-name", PROJECT, "--commit-dirty=true"],
  { stdio: "inherit", cwd: ROOT });
process.exit(run.status ?? 1);
