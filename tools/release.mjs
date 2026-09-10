#!/usr/bin/env node
/**
 * Tvara, cut a release.
 *
 *   node tools/release.mjs patch     0.8.0 -> 0.8.1   a fix
 *   node tools/release.mjs minor     0.8.0 -> 0.9.0   a feature
 *   node tools/release.mjs major     0.8.0 -> 1.0.0
 *   node tools/release.mjs 1.2.3                      an exact version
 *
 * The version lives in two files and preflight fails the build when they
 * disagree, which is correct and is also exactly the kind of thing you forget
 * at 1am while fixing something urgent. So it is one command:
 *
 *   bump both -> run every suite -> pack -> preflight
 *
 * It stops at the first failure and leaves the version bumped, so you can fix
 * and re-run rather than hunt for what it half-did.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(root, "manifest.json");
const LISTING = join(root, "store", "listing.md");

const arg = process.argv[2];
if (!arg) {
  console.error("Usage: node tools/release.mjs <patch|minor|major|X.Y.Z>");
  process.exit(1);
}

const mf = JSON.parse(readFileSync(MANIFEST, "utf8"));
const cur = mf.version;
const [ma, mi, pa] = cur.split(".").map(Number);
const next =
  arg === "patch" ? `${ma}.${mi}.${pa + 1}` :
  arg === "minor" ? `${ma}.${mi + 1}.0` :
  arg === "major" ? `${ma + 1}.0.0` :
  arg;

if (!/^\d+\.\d+\.\d+$/.test(next)) {
  console.error(`✋ "${next}" is not a version.`);
  process.exit(1);
}
/* Chrome refuses an upload whose version is not higher than the published one,
   and the error it gives is not obvious. Catch it here instead. */
const higher = (a, b) => {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] > y[i]; }
  return false;
};
if (!higher(next, cur)) {
  console.error(`✋ ${next} is not higher than the current ${cur}. Chrome will refuse it.`);
  process.exit(1);
}

console.log(`\n  ${cur}  ->  ${next}\n`);

mf.version = next;
writeFileSync(MANIFEST, JSON.stringify(mf, null, 2) + "\n");
console.log("  ✓ manifest.json");

const listing = readFileSync(LISTING, "utf8");
const bumped = listing.replace(/^(# Store Listing.*v)\d+\.\d+\.\d+/m, `$1${next}`);
if (bumped === listing) {
  console.error("✋ Could not find the version line in store/listing.md");
  process.exit(1);
}
writeFileSync(LISTING, bumped);
console.log("  ✓ store/listing.md");

const run = (label, cmd, args) => {
  console.log(`\n→ ${label}`);
  try {
    execFileSync(cmd, args, { cwd: root, stdio: "inherit" });
  } catch {
    console.error(`\n✋ ${label} failed. The version is bumped; fix and re-run the step.\n`);
    process.exit(1);
  }
};

run("every suite", "npm", ["test"]);
run("pack", "node", ["tools/pack.mjs"]);
run("preflight", "node", ["tools/preflight.mjs"]);

console.log(`
  Ready: dist/tvara-v${next}.zip

  Next:
    1. Upload that zip to the Chrome Web Store as a new version
    2. If public copy changed, verify the canonical Pages site separately:
         cd ../tvara-site && npm run build
    3. Commit and push this repo
`);
