#!/usr/bin/env node
/**
 * Long Chat Toolkit — launch readiness check.
 *
 *   node tools/preflight.mjs [--offline]
 *
 * Answers one question with facts instead of memory: can this be submitted and
 * sold today, or not? Every check here corresponds to a way the launch has
 * already nearly gone wrong once — a zip a version behind the code, a listing
 * that justifies three of six permissions, a price with nowhere to pay it.
 *
 * BLOCKERs make the exit code non-zero. WARNs are judgement calls left to you.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const offline = process.argv.includes("--offline");
const read = (p) => { try { return readFileSync(join(root, p), "utf8"); } catch { return ""; } };

const rows = [];
const ok = (what, detail = "") => rows.push({ level: "ok", what, detail });
const warn = (what, detail = "") => rows.push({ level: "warn", what, detail });
const block = (what, detail = "") => rows.push({ level: "block", what, detail });

const mf = JSON.parse(read("manifest.json"));
const listing = read("store/listing.md");
const readme = read("README.md");
const docs = read("docs/index.html");

/* ---------- 1. the artefact matches the code ---------- */

const zips = existsSync(join(root, "dist"))
  ? readdirSync(join(root, "dist")).filter((f) => f.endsWith(".zip")) : [];
const shipZip = `long-chat-toolkit-v${mf.version}.zip`;
if (!zips.length) block("no zip built", "node tools/pack.mjs");
else if (!zips.includes(shipZip)) block(`dist/ holds ${zips.join(", ")}, but the manifest says v${mf.version}`, "node tools/pack.mjs");
else {
  // Read the manifest out of the ZIP, not off disk: the file that gets uploaded
  // is the only one whose contents matter, and it is not the one we edit.
  try {
    const packed = JSON.parse(execFileSync("unzip", ["-p", join(root, "dist", shipZip), "manifest.json"], { encoding: "utf8" }));
    const devHosts = JSON.stringify(packed).match(/localhost|127\.0\.0\.1/g);
    if (devHosts) block(`the packed manifest still contains ${devHosts.length} dev-only host reference(s)`);
    else ok("packed manifest carries no dev-only hosts");
    if (packed.version !== mf.version) block(`packed manifest says v${packed.version}, source says v${mf.version}`);
  } catch { warn("could not read the manifest inside the zip"); }

  const age = (Date.now() - statSync(join(root, "dist", shipZip)).mtimeMs) / 36e5;
  ok(`zip matches manifest (v${mf.version})`, `built ${age < 1 ? "just now" : age.toFixed(0) + "h ago"}`);
  // Older than the newest source file = a zip that predates a change.
  const newest = ["bg.js", "manifest.json", "content", "popup", "lib"]
    .flatMap((p) => {
      const full = join(root, p);
      return statSync(full).isDirectory()
        ? readdirSync(full).map((f) => statSync(join(full, f)).mtimeMs)
        : [statSync(full).mtimeMs];
    }).reduce((a, b) => Math.max(a, b), 0);
  if (newest > statSync(join(root, "dist", shipZip)).mtimeMs) {
    block("the zip is older than the source it was built from", "node tools/pack.mjs");
  }
}

/* ---------- 2. the listing tells the truth ---------- */

const declared = [...(mf.permissions || []), ...(mf.host_permissions?.length ? [] : [])];
const unjustified = declared.filter((p) => !new RegExp(`\`${p}\``).test(listing));
if (!listing) block("store/listing.md missing");
else {
  if (unjustified.length) {
    block(`listing does not justify ${unjustified.length} permission(s): ${unjustified.join(", ")}`,
      "store forms ask per-permission; an unexplained one is a rejection");
  } else ok(`all ${declared.length} permissions justified in the listing`);

  const listedVersion = (listing.match(/^# Store Listing.*v(\d+\.\d+\.\d+)/m) || [])[1];
  if (listedVersion && listedVersion !== mf.version) {
    block(`listing is written for v${listedVersion}, manifest is v${mf.version}`);
  } else if (listedVersion) ok(`listing version matches (v${listedVersion})`);

  const short = (listing.match(/## Short description[^\n]*\n+([^\n]+)/) || [])[1] || "";
  if (short && short.length > 132) block(`short description is ${short.length} chars (Chrome allows 132)`);
  else if (short) ok(`short description fits (${short.length}/132)`);
  if (short && short.trim() !== (mf.description || "").trim()) {
    warn("listing's short description and the manifest description differ");
  }
}

/* ---------- 3. claims that drift ---------- */

const period = Number((read("bg.js").match(/BG_AUTO_PERIOD_MIN\s*=\s*(\d+)/) || [])[1] || 0);
const hours = period / 60;
let drift = 0;
for (const [name, text] of [["listing", listing], ["README", readme], ["docs", docs]]) {
  const claims = [...text.matchAll(/every (\d+)\s*hours/gi)].map((m) => Number(m[1]));
  const wrong = claims.filter((h) => h !== hours);
  if (wrong.length) { drift++; block(`${name} claims sync "every ${wrong[0]} hours"; the code says every ${hours}`); }
}
if (period && !drift) ok(`sync interval claims agree with the code (${hours}h)`);

/* ---------- 4. someone can actually pay ---------- */

const product = read("lib/product.js");
const buy = (product.match(/BUY:\s*SITE\s*\+\s*"([^"]+)"/) || [])[1];
if (!buy) block("lib/product.js has no BUY target");
else ok(`buy button points at ${buy} on the pricing page`);

// The pricing page is the one place a real checkout URL has to appear, and it
// is the last thing anyone remembers to fill in.
const buySection = /id="buy"/.test(docs);
const checkoutHref = /id="checkout"[^>]*\n?\s*href="([^"]+)"/i.exec(docs)
  || /href="([^"]+)"[^>]*id="checkout"/i.exec(docs);
if (!buySection) block("docs/index.html has no #buy anchor for the buy button to land on");
else if (!checkoutHref) block("docs/index.html has no #checkout button");
else if (/REPLACE_WITH/.test(checkoutHref[1])) {
  block("the payment link is still the placeholder — nobody can pay",
    "one edit: replace the #checkout href in docs/index.html with your Dodo payment link");
} else ok("pricing page carries a real checkout link", checkoutHref[1].slice(0, 52));

/* ---------- 4b. one price, everywhere ---------- */

// The extension renders its price from lib/product.js and the pricing page from
// its own constant, because they deploy separately. Every other mention is
// prose. A page quoting one number beside a checkout charging another is how a
// launch turns into refunds, so nothing here is left to memory.
const price = (product.match(/PRICE:\s*"([^"]+)"/) || [])[1];
const priceNum = (product.match(/PRICE_NUM:\s*(\d+(?:\.\d+)?)/) || [])[1];
if (!price) block("lib/product.js declares no PRICE");
else {
  const docsPrice = (docs.match(/var PRICE = "([^"]+)"/) || [])[1];
  if (!docsPrice) block("docs/index.html declares no PRICE constant");
  else if (docsPrice !== price) block(`the pricing page says ${docsPrice}, the extension says ${price}`);

  if (priceNum && `$${priceNum}` !== price) {
    block(`PRICE (${price}) and PRICE_NUM (${priceNum}) disagree in lib/product.js`);
  }

  // Prose can only be checked for CONTRADICTION: any dollar figure that is not
  // the price, in a file that talks about buying, is a stale number.
  const prose = [["README", readme], ["listing", listing],
                 ["user guide", read("docs/USER-GUIDE.md")], ["pricing page", docs]];
  const wrong = [];
  for (const [name, text] of prose) {
    for (const m of text.matchAll(/\$(\d+(?:\.\d{2})?)\b/g)) {
      // Two figures here are not our price and never will be: "$0 data" is a
      // privacy claim, and "$5" is the Chrome developer fee — money going out,
      // not coming in.
      if (m[0] === price || m[1] === "0" || m[1] === "5") continue;
      wrong.push(`${name}: ${m[0]}`);
    }
  }
  if (wrong.length) block(`a stale price is written in prose — ${[...new Set(wrong)].join(", ")}`);
  else ok(`one price everywhere (${price})`);
}

// The page someone lands on after paying. Without it a buyer's last impression
// is the payment provider's own receipt screen and no idea what to do next.
if (!read("docs/thanks.html")) block("docs/thanks.html is missing — no post-purchase page");
else if (!/Licence key|licence key/i.test(read("docs/thanks.html"))) {
  block("the post-purchase page never mentions the licence key");
} else ok("post-purchase page explains how to activate");

/* ---------- 5. the licence chain ---------- */

const keyDir = join(homedir(), ".lct-keys");
if (!existsSync(join(keyDir, "private.pem"))) block("~/.lct-keys/private.pem is missing — no key can be issued");
else {
  const pub = (read("lib/license.js").match(/PUBLIC_KEY_B64 = "([^"]+)"/) || [])[1];
  const ent = (read("lib/entitlement.js").match(/PUBLIC_KEY_B64 = "([^"]+)"/) || [])[1];
  if (pub !== ent) block("lib/license.js and lib/entitlement.js ship different public keys", "node tools/genkey.mjs init");
  else ok("signing key present, both verifiers share one public key");
}

const issuer = (read("lib/entitlement.js").match(/ISSUER = "([^"]+)"/) || [])[1];

/* ---------- 6. the things only the network knows ---------- */

const head = async (url) => {
  try {
    const res = await fetch(url, { method: "GET", redirect: "follow",
      signal: AbortSignal.timeout(12000) });
    return res.status;
  } catch { return 0; }
};

if (offline) warn("skipped network checks (--offline)");
else {
  const site = (product.match(/const SITE = "([^"]+)"/) || [])[1];
  const siteCode = await head(site);
  siteCode === 200 ? ok("pricing/privacy page is live", site)
    : block(`pricing page answered ${siteCode || "nothing"} — stores require a reachable privacy policy`, site);

  // A junk POST is enough: anything that answers proves a worker is deployed.
  let code = 0;
  try {
    const res = await fetch(issuer + "/entitlement", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "chrome-extension://" + "a".repeat(32) },
      body: JSON.stringify({ license_key: "PREFLIGHT", device: "a".repeat(32), ts: Date.now() }),
      signal: AbortSignal.timeout(12000)
    });
    code = res.status;
  } catch { code = 0; }
  if (!code) {
    block("the entitlement issuer is not deployed — a Dodo purchase cannot unlock Pro",
      `${issuer} · fix: ./server/deploy.sh <extension-id>`);
  } else if (code === 403) {
    ok("issuer is live and refusing unknown origins", `${issuer} → 403`);
  } else if (code === 404) {
    warn("issuer is live but accepted a stranger's origin", "set ALLOWED_ORIGINS to the published extension id");
  } else ok(`issuer answered ${code}`, issuer);
}

/* ---------- 7. store assets ---------- */

const shotDir = join(root, "store", "screenshots");
if (!existsSync(shotDir)) block("no store/screenshots — a listing cannot be submitted without them");
else {
  const shots = readdirSync(shotDir).filter((f) => f.endsWith(".png"));
  if (!shots.length) block("store/screenshots is empty");
  else {
    ok(`${shots.length} screenshots present`);
    if (shots.length > 5) warn(`Chrome accepts at most 5 screenshots — you have ${shots.length}, so pick the five`);
    try {
      const bad = shots.filter((f) => {
        const out = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", join(shotDir, f)], { encoding: "utf8" });
        const w = +(out.match(/pixelWidth: (\d+)/) || [])[1];
        const h = +(out.match(/pixelHeight: (\d+)/) || [])[1];
        return !((w === 1280 && h === 800) || (w === 640 && h === 400));
      });
      bad.length ? block(`screenshots not 1280×800: ${bad.join(", ")}`) : ok("every screenshot is 1280×800");
    } catch { warn("could not measure screenshots (sips unavailable)"); }
  }
}

/* ---------- report ---------- */

const icon = { ok: "✓", warn: "!", block: "✗" };
const blocks = rows.filter((r) => r.level === "block");
const warns = rows.filter((r) => r.level === "warn");

console.log(`\nLong Chat Toolkit v${mf.version} — launch readiness\n`);
for (const r of rows) {
  console.log(`  ${icon[r.level]} ${r.what}${r.detail ? `\n      ${r.detail}` : ""}`);
}
console.log("");
if (blocks.length) {
  console.log(`❌ ${blocks.length} blocker${blocks.length === 1 ? "" : "s"}${warns.length ? `, ${warns.length} warning${warns.length === 1 ? "" : "s"}` : ""} — not submittable yet.\n`);
  process.exit(1);
}
console.log(`✅ submittable${warns.length ? ` (${warns.length} warning${warns.length === 1 ? "" : "s"} to weigh)` : ""}.\n`);
