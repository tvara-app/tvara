#!/usr/bin/env node
/**
 * Build store-ready zips.
 *
 *   node tools/pack.mjs            → dist/tvara-vX.Y.Z.zip          (Chrome/Edge)
 *   node tools/pack.mjs --firefox  → …and dist/tvara-vX.Y.Z-firefox.zip
 *
 * Copies only shippable files, strips the localhost dev matches, and then
 * REFUSES to produce a zip that references a file it does not contain.
 *
 * That last part is not theoretical: the previous packed build shipped a
 * content/recall-sync.js that had been deleted from the tree months earlier.
 * A zip is the one artefact nobody re-reads before uploading, so the check has
 * to live here.
 */
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname, posix } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const withFirefox = process.argv.includes("--firefox");

const SHIP = ["manifest.json", "lib", "content", "popup", "diag",
              "bg.js", "recall.html", "recall.css", "recall-page.js",
              "welcome.html", "welcome.css", "welcome.js"];

/* ---------- integrity ---------- */

const walk = (dir, base = "") => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(join(dir, e.name), posix.join(base, e.name)) : [posix.join(base, e.name)]);

/**
 * Every path the built extension points at, from the three places a path can
 * hide: the manifest, an HTML tag, and a runtime getURL().
 */
function referencedPaths(staging, mf) {
  const refs = new Map();   // path → what asked for it
  const add = (p, why) => {
    if (!p || /^(https?:|data:|chrome:|#|\/\/)/.test(p)) return;
    refs.set(posix.normalize(p.replace(/^\//, "").split(/[?#]/)[0]), why);
  };

  add(mf.background?.service_worker, "manifest.background");
  for (const s of mf.background?.scripts || []) add(s, "manifest.background.scripts");
  for (const v of Object.values(mf.icons || {})) add(v, "manifest.icons");
  for (const v of Object.values(mf.action?.default_icon || {})) add(v, "manifest.action.icons");
  add(mf.action?.default_popup, "manifest.action.default_popup");
  for (const cs of mf.content_scripts || []) {
    for (const j of cs.js || []) add(j, "manifest.content_scripts.js");
    for (const c of cs.css || []) add(c, "manifest.content_scripts.css");
  }
  for (const war of mf.web_accessible_resources || []) {
    for (const r of war.resources || []) if (!r.includes("*")) add(r, "manifest.web_accessible_resources");
  }

  for (const rel of walk(staging)) {
    const file = join(staging, rel);
    const dir = posix.dirname(rel);
    const resolve = (p) => p.startsWith("/") ? p.slice(1) : posix.normalize(posix.join(dir, p));

    if (rel.endsWith(".html")) {
      const html = readFileSync(file, "utf8");
      for (const m of html.matchAll(/<script[^>]+src="([^"]+)"/g)) add(resolve(m[1]), rel);
      for (const m of html.matchAll(/<link[^>]+href="([^"]+)"/g)) add(resolve(m[1]), rel);
      for (const m of html.matchAll(/<img[^>]+src="([^"]+)"/g)) add(resolve(m[1]), rel);
    } else if (rel.endsWith(".js")) {
      const js = readFileSync(file, "utf8");
      // getURL("welcome.html") — the runtime reference the manifest never sees.
      for (const m of js.matchAll(/getURL\(\s*["'`]([^"'`]+)["'`]/g)) add(m[1], rel);
    }
  }
  return refs;
}

function verify(staging, mf, label) {
  const present = new Set(walk(staging));
  const missing = [];
  for (const [path, why] of referencedPaths(staging, mf)) {
    if (!present.has(path)) missing.push(`${path}  ← referenced by ${why}`);
  }
  if (missing.length) {
    console.error(`\n✋ ${label}: the build points at ${missing.length} file(s) it does not contain:\n   ` +
      missing.join("\n   ") + "\n");
    process.exit(1);
  }
  // Loud, not silent: a dev-only match reaching a store listing is a rejection.
  const leaked = JSON.stringify(mf).match(/localhost|127\.0\.0\.1/g);
  if (leaked) { console.error(`✋ ${label}: dev-only matches survived into the manifest.`); process.exit(1); }
  console.log(`  ✓ ${label}: every referenced path is in the zip`);
}

/* ---------- build ---------- */

function build({ name, tweak, label }) {
  const staging = join(dist, "staging");
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  for (const item of SHIP) cpSync(join(root, item), join(staging, item), { recursive: true });

  const mfPath = join(staging, "manifest.json");
  const mf = JSON.parse(readFileSync(mfPath, "utf8"));

  const dev = (m) => m.includes("localhost") || m.includes("127.0.0.1");
  for (const cs of mf.content_scripts) cs.matches = cs.matches.filter((m) => !dev(m));
  // host_permissions carries the dev hosts too: without them the health page
  // cannot see the test tab, because a content_scripts match is not a host
  // permission. They must not ship — verify() below fails the build if they do.
  mf.host_permissions = (mf.host_permissions || []).filter((m) => !dev(m));
  tweak(mf);
  writeFileSync(mfPath, JSON.stringify(mf, null, 2) + "\n");

  /* Icons come from the manifest, not from the folder. icons/ also holds the
     source photo, the rounded variants and the web favicons — 1.5MB the browser
     never loads but every user downloads. Deriving the list means it cannot
     drift when an icon is added or renamed. */
  const wanted = new Set([...Object.values(mf.icons || {}),
                          ...Object.values(mf.action?.default_icon || {})]);
  // The welcome page shows the icon too, so ship whatever any page asks for.
  for (const html of ["welcome.html", "recall.html", "popup/popup.html"]) {
    const p = join(staging, html);
    if (!existsSync(p)) continue;
    for (const m of readFileSync(p, "utf8").matchAll(/(?:src|href)="((?:\.\.\/)?icons\/[^"]+)"/g)) {
      wanted.add(m[1].replace(/^\.\.\//, ""));
    }
  }
  mkdirSync(join(staging, "icons"), { recursive: true });
  for (const rel of wanted) cpSync(join(root, rel), join(staging, rel));

  verify(staging, mf, label);

  const zip = join(dist, name);
  rmSync(zip, { force: true });
  execSync(`cd "${staging}" && zip -qr -X "${zip}" . -x "*.DS_Store"`, { stdio: "inherit" });
  rmSync(staging, { recursive: true, force: true });
  const kb = (statSync(zip).size / 1024).toFixed(0);
  console.log(`  ✓ dist/${name}  (${kb} KB, ${wanted.size} icons)`);
  return zip;
}

const version = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")).version;
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

console.log(`\nTvara v${version}\n`);

build({
  name: `tvara-v${version}.zip`,
  label: "chrome/edge",
  // Firefox metadata has no business in a Chrome upload — it claims support we
  // have not verified, in a file reviewers read.
  tweak: (mf) => { delete mf.browser_specific_settings; }
});

if (withFirefox) {
  build({
    name: `tvara-v${version}-firefox.zip`,
    label: "firefox (UNVERIFIED)",
    tweak: (mf) => {
      // Firefox has no MV3 background service worker. It runs the same file as
      // an event page — which works only because bg.js's importScripts() calls
      // are already wrapped in try/catch, so listing the libs here loads them
      // and the failed importScripts is a no-op.
      mf.background = {
        scripts: ["lib/quota.js", "lib/license.js", "lib/dodo.js", "lib/entitlement.js", "bg.js"],
        type: "module"
      };
      /* Required for new Firefox extensions (addons-linter:
         MISSING_DATA_COLLECTION_PERMISSIONS). "none" is the literal truth here:
         there is no server to send anything to. */
      mf.browser_specific_settings = mf.browser_specific_settings || {};
      mf.browser_specific_settings.gecko = mf.browser_specific_settings.gecko || {};
      mf.browser_specific_settings.gecko.data_collection_permissions = { required: ["none"] };
      /* The data-collection key does not exist before Firefox 140, and declaring
         it against an older strict_min_version is itself a lint warning. 128 was
         the floor for MV3; 140 is the floor for saying, in the manifest, that we
         collect nothing. */
      mf.browser_specific_settings.gecko.strict_min_version = "140.0";
      // Firefox for Android reads its own floor, and inherits nothing.
      /* Android got the data-collection key later than desktop, at 142, so the
         two floors are genuinely different numbers rather than a copy of one. */
      mf.browser_specific_settings.gecko_android = { strict_min_version: "142.0" };
      delete mf.minimum_chrome_version;
    }
  });
  console.log("\n  ⚠️  The Firefox zip has never been run in Firefox. Load it with");
  console.log("     about:debugging before it goes anywhere near AMO.");
}

console.log("");
