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
const SHIP = ["manifest.json", "icons", "lib", "content", "popup",
              "bg.js", "recall.html", "recall.css", "recall-page.js"];

rmSync(join(root, "dist"), { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
for (const item of SHIP) cpSync(join(root, item), join(staging, item), { recursive: true });

// strip dev-only matches
const mfPath = join(staging, "manifest.json");
const mf = JSON.parse(readFileSync(mfPath, "utf8"));
for (const cs of mf.content_scripts) {
  cs.matches = cs.matches.filter((m) => !m.includes("localhost") && !m.includes("127.0.0.1"));
}
writeFileSync(mfPath, JSON.stringify(mf, null, 2) + "\n");

const zipName = `long-chat-toolkit-v${mf.version}.zip`;
execSync(`cd "${staging}" && zip -r -X "../${zipName}" . -x "*.DS_Store"`, { stdio: "inherit" });
rmSync(staging, { recursive: true });
console.log(`\n✅ dist/${zipName} — store-ready (localhost matches removed)`);
