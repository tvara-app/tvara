#!/usr/bin/env node
/**
 * Build a store-ready zip: copies only shippable files, strips the
 * localhost/127.0.0.1 dev matches from the manifest, zips into dist/.
 *
 *   node tools/pack.mjs
 */
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const staging = join(root, "dist", "staging");
const SHIP = ["manifest.json", "lib", "content", "popup", "diag",
              "bg.js", "recall.html", "recall.css", "recall-page.js"];

rmSync(join(root, "dist"), { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
for (const item of SHIP) cpSync(join(root, item), join(staging, item), { recursive: true });

const mfPath = join(staging, "manifest.json");
const mf = JSON.parse(readFileSync(mfPath, "utf8"));

// strip dev-only matches
for (const cs of mf.content_scripts) {
  cs.matches = cs.matches.filter((m) => !m.includes("localhost") && !m.includes("127.0.0.1"));
}
writeFileSync(mfPath, JSON.stringify(mf, null, 2) + "\n");

/* Icons come from the manifest, not from the folder. icons/ also holds the
   source photo, the rounded variants and the web favicons — 1.5MB the browser
   never loads but every user downloads. Deriving the list means it cannot
   drift when an icon is added or renamed. */
const wanted = new Set([...Object.values(mf.icons || {}),
                        ...Object.values(mf.action?.default_icon || {})]);
mkdirSync(join(staging, "icons"), { recursive: true });
for (const rel of wanted) cpSync(join(root, rel), join(staging, rel));
console.log(`icons: shipping ${wanted.size} of ${
  execSync(`ls -1 "${join(root, "icons")}" | wc -l`).toString().trim()} files in icons/`);

const zipName = `long-chat-toolkit-v${mf.version}.zip`;
execSync(`cd "${staging}" && zip -r -X "../${zipName}" . -x "*.DS_Store"`, { stdio: "inherit" });
rmSync(staging, { recursive: true });
console.log(`\n✅ dist/${zipName} — store-ready (localhost matches removed)`);
