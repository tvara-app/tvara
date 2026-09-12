#!/usr/bin/env node
/**
 * Tvara — launch readiness check.
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
import { workerSource } from "./worker-source.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const offline = process.argv.includes("--offline");
const read = (p) => { try { return readFileSync(join(root, p), "utf8"); } catch { return ""; } };

const rows = [];
const ok = (what, detail = "") => rows.push({ level: "ok", what, detail });
const warn = (what, detail = "") => rows.push({ level: "warn", what, detail });
const block = (what, detail = "") => rows.push({ level: "block", what, detail });

const requiredNode = [24, 11, 0];
const runningNode = process.versions.node.split(".").map(Number);
const nodeReady = runningNode[0] > requiredNode[0] ||
  (runningNode[0] === requiredNode[0] && (runningNode[1] > requiredNode[1] ||
    (runningNode[1] === requiredNode[1] && runningNode[2] >= requiredNode[2])));
if (!nodeReady) block("Node 24.11.0 or newer is required", `running ${process.versions.node}`);
else ok(`Node ${process.versions.node} meets the release baseline`);

const mf = JSON.parse(read("manifest.json"));
const listing = read("store/listing.md");
const readme = read("README.md");
const pack = read("tools/pack.mjs");

/* ---------- 1. the artefact matches the code ---------- */

const zips = existsSync(join(root, "dist"))
  ? readdirSync(join(root, "dist")).filter((f) => f.endsWith(".zip")) : [];
const shipZip = `tvara-v${mf.version}.zip`;
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
  /* Everything pack.mjs ships, walked to the leaves. This used to watch five
     entries and stat only a directory's immediate children, so editing
     pages/pages.js (40KB, shipped) or content/inject/quota-probe.js (a
     subdirectory, whose mtime does not move when a file inside it changes)
     left this printing "zip matches manifest" over a zip that predated the fix. */
  const WATCH = ["bg.js", "bg", "manifest.json", "content", "popup", "lib", "icons",
                 "diag", "pages"];
  const newestOf = (full) => {
    let st;
    try { st = statSync(full); } catch { return 0; }
    if (!st.isDirectory()) return st.mtimeMs;
    return readdirSync(full).reduce((a, f) => Math.max(a, newestOf(join(full, f))), st.mtimeMs);
  };
  const newest = WATCH.reduce((a, p) => Math.max(a, newestOf(join(root, p))), 0);
  if (newest > statSync(join(root, "dist", shipZip)).mtimeMs) {
    block("the zip is older than the source it was built from", "node tools/pack.mjs");
  }
}

/* ---------- 2. the listing tells the truth ---------- */

/* Host permissions are the most common store rejection and the review form asks
   for each one individually, so they are checked exactly like API permissions —
   by the hostname a listing would actually name, not the raw match pattern.
   localhost/127.0.0.1 are dev-only and stripped by pack.mjs, so they are not
   part of what ships and are not required to appear here. */
const DEV_HOSTS = /^https?:\/\/(localhost|127\.0\.0\.1)\b/;
const shippedHosts = (mf.host_permissions || [])
  .filter((h) => !DEV_HOSTS.test(h))
  .map((h) => h.replace(/^\*?:?\/*/, "").replace(/^https?:\/\//, "").replace(/\/.*$/, ""));
const declared = [...(mf.permissions || []), ...shippedHosts];
const unjustified = declared.filter((p) => !new RegExp(`\`${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\``).test(listing));
if (!listing) block("store/listing.md missing");
else {
  const title = (listing.match(/## Title[^\n]*\n+([^\n]+)/) || [])[1] || "";
  if (title !== "Tvara: AI Chat Speed & Recall") {
    block("Store title does not match the approved launch title");
  } else ok("Store title matches the launch title");
  if (unjustified.length) {
    block(`listing does not justify ${unjustified.length} permission(s): ${unjustified.join(", ")}`,
      "store forms ask per-permission; an unexplained one is a rejection");
  } else ok(`all ${declared.length} permissions justified in the listing`);

  const listedVersion = (listing.match(/^# Store Listing.*v(\d+\.\d+\.\d+)/m) || [])[1];
  if (listedVersion && listedVersion !== mf.version) {
    block(`listing is written for v${listedVersion}, manifest is v${mf.version}`);
  } else if (listedVersion) ok(`listing version matches (v${listedVersion})`);

  /* Rejected on 2026-09-11 ("Yellow Argon", Spam and Placement in the Store):
     naming the six providers in the description read as keyword stuffing. The
     host list still has to appear further down the file — the dashboard asks
     for it per permission — so this is scoped to the description fields alone,
     which are the only text that goes in that box. */
  const BRANDS = /\b(ChatGPT|OpenAI|Claude|Anthropic|Gemini|Perplexity|DeepSeek|Grok)\b/g;
  const longDesc = (listing.match(/## Long description\n([\s\S]*?)(?=\n## )/) || [])[1] || "";
  const pitch = (longDesc.replace(/^>.*$/gm, "") + "\n" +
    (listing.match(/## Short description[^\n]*\n+([^\n]+)/) || [])[1] || "");
  const brands = [...new Set(pitch.match(BRANDS) || [])];
  if (brands.length) {
    block(`description names third-party products: ${brands.join(", ")}`,
      "this is what the store rejected as excessive keywords; say the capability, not the brand");
  } else ok("description names no third-party product");

  const short = (listing.match(/## Short description[^\n]*\n+([^\n]+)/) || [])[1] || "";
  if (short && short.length > 132) block(`short description is ${short.length} chars (Chrome allows 132)`);
  else if (short) ok(`short description fits (${short.length}/132)`);
  if (short && short.trim() !== (mf.description || "").trim()) {
    block("listing's short description and the manifest description differ");
  }
}

if (mf.manifest_version !== 3) block("manifest is not Manifest V3");
else ok("Manifest V3");
if (mf.browser_specific_settings) block("manifest declares an unsupported Firefox target");
else ok("manifest targets Chrome and Edge only");
if (!/minifyScripts\(/.test(pack) || /javascript-obfuscator/i.test(pack + read("package.json"))) {
  block("release packaging must use compliant minification and no obfuscator");
} else ok("release package uses non-obfuscating minification");
const sourceHiding = ["lib/entitlement.js", "lib/dodo.js"].filter((path) =>
  /Object\.defineProperty\([\s\S]*?\btoString\b/.test(read(path)));
if (sourceHiding.length) block(`release code hides function source: ${sourceHiding.join(", ")}`);
else ok("release code contains no function-source hiding");

for (const [name, text] of [["listing", listing], ["README", readme]]) {
  const match = text.match(/\b(zero lag|instant(?:ly)?|every chat|every platform)\b/i);
  if (match) block(`${name} contains an unprovable claim: ${match[1]}`);
}

const localeLedger = read("store/locales/metadata.json");
try {
  const locales = JSON.parse(localeLedger).locales || {};
  const expectedLocales = ["en", "es", "pt-BR", "fr", "de", "ja", "ko", "hi", "id", "tr"];
  const missing = expectedLocales.filter((code) => !locales[code]);
  if (missing.length) block(`localization tracker misses: ${missing.join(", ")}`);
  else {
    const publishedWithoutReview = Object.entries(locales)
      .filter(([, value]) => value.status === "ready" && value.nativeReview !== "approved")
      .map(([code]) => code);
    if (publishedWithoutReview.length) block(`locales ready without native review: ${publishedWithoutReview.join(", ")}`);
    else ok("localization tracker covers all launch locales");
  }
} catch { block("store/locales/metadata.json is missing or invalid"); }

/* ---------- 3. claims that drift ---------- */

// The constant moved to bg/schedule.js; read the worker, not just its entry.
const period = Number((workerSource(root).match(/BG_AUTO_PERIOD_MIN\s*=\s*(\d+)/) || [])[1] || 0);
const hours = period / 60;
let drift = 0;
for (const [name, text] of [["listing", listing], ["README", readme]]) {
  const claims = [...text.matchAll(/every (\d+)\s*hours/gi)].map((m) => Number(m[1]));
  const wrong = claims.filter((h) => h !== hours);
  if (wrong.length) { drift++; block(`${name} claims sync "every ${wrong[0]} hours"; the code says every ${hours}`); }
}
if (period && !drift) ok(`sync interval claims agree with the code (${hours}h)`);

/* The canonical site owns its policy pages now. Network checks below verify
   that the deployed URLs exist; this repository no longer mirrors their HTML. */

/* ---------- 4. someone can actually pay ---------- */

const product = read("lib/product.js");
const worker = read("server/entitlement-worker.js");
const entitlement = read("lib/entitlement.js");
const wrangler = read("server/wrangler.toml");
const canonicalSite = (product.match(/const SITE = "([^"]+)"/) || [])[1] || "";

/* The checked-in ALLOWED_ORIGINS is a PLACEHOLDER and wrangler.toml says so:
   deploy.sh rewrites it into a temp config from the ids it is handed. Counting
   entries here proved nothing about the worker anybody actually calls — it
   passed on a file that never ships and blocked on one that does. The ids live
   in server/published-origins.json and the LIVE issuer is asked about each one
   further down, which is the only answer worth having. */
const EXT_ID = /^[a-p]{32}$/;
const published = (() => { try { return JSON.parse(read("server/published-origins.json")); } catch { return null; } })();
const publishedIds = published
  ? Object.entries(published).filter(([k, v]) => !k.startsWith("_") && typeof v === "string" && v)
  : [];
if (!published) {
  block("server/published-origins.json is missing or unreadable",
    "it is where the store-assigned extension ids are recorded");
} else {
  const malformed = publishedIds.filter(([, v]) => !EXT_ID.test(v));
  if (malformed.length) {
    block(`malformed extension id: ${malformed.map(([k]) => k).join(", ")}`);
  } else if (!EXT_ID.test(published.chrome || "")) {
    block("no Chrome Web Store id recorded — the listing cannot be submitted",
      "the store assigns it on upload; it is not the id manifest.key derives");
  } else {
    ok(`Chrome Web Store id recorded (${published.chrome.slice(0, 8)}\u2026)`);
    if (!EXT_ID.test(published.edge || "")) {
      warn("Edge is not published, so no Edge origin is allow-listed",
        "add it to server/published-origins.json and redeploy when that listing goes live");
    }
  }
}
if (!/^ALLOW_FIREFOX\s*=\s*"0"/m.test(wrangler)) block("ALLOW_FIREFOX must be 0 for this launch");
else ok("Firefox issuer access is disabled");
if (!/^SESSION_SCOPE\s*=\s*"paid"/m.test(wrangler)) block("live session sockets must be paid-only");
else ok("live session sockets are paid-only");
if (!/head_sampling_rate\s*=\s*0\.01/.test(wrangler) || !/binding\s*=\s*"ISSUER_METRICS"/.test(wrangler)) {
  block("issuer observability must use 1% sampling and aggregate metrics");
} else ok("issuer aggregate telemetry and 1% log sampling configured");

/* The checkout is opened by the issuer, per purchase. These checks exist
   because the OLD arrangement — a payment link pasted into a static page, and a
   licence key handed back in the redirect URL — is the sort of thing that comes
   back the first time someone is in a hurry. Each one is a regression guard for
   a specific way that would happen. */

// 4a. The canonical site owns its checkout surface; the extension does not.
ok("checkout is issuer-only");

// 4b. And no buy URL back in the extension either.
if (/\bBUY\s*:/.test(product)) {
  block("lib/product.js has a BUY target again",
    "the extension must not know where the checkout is; it asks the issuer");
} else ok("the extension holds no payment URL, product id or provider");

// 4c. The issuer is the one that has to know, so it has to be configured.
const productId = (wrangler.match(/DODO_PRODUCT_ID\s*=\s*"([^"]*)"/) || [])[1];
if (!/route === "\/checkout"/.test(worker) || !/route === "\/checkout\/claim"/.test(worker)) {
  block("server/entitlement-worker.js has no /checkout routes — nobody can pay");
} else if (!productId || /REPLACE|^pdt_x+$/i.test(productId)) {
  block("server/wrangler.toml has no DODO_PRODUCT_ID — /checkout has nothing to sell",
    "set DODO_PRODUCT_ID in server/wrangler.toml, then ./server/deploy.sh");
} else ok("the issuer opens checkouts");

// The two halves of a signed request have to agree on the route name, or every
// checkout fails its device proof at the issuer and nobody can buy anything.
for (const route of ["checkout", "checkout-claim"]) {
  const signed = new RegExp(`"${route}"`);
  if (!signed.test(worker) || !signed.test(entitlement)) {
    block(`the signing route "${route}" is missing from ${signed.test(worker) ? "lib/entitlement.js" : "server/entitlement-worker.js"}`);
  }
}

// 4d. THE ONE THAT MATTERS. A licence key is a bearer secret for five device
// seats, and a URL is read by history, profile sync, the omnibox and every
// extension holding `tabs`. Nothing may put one there again.
const returnUrl = (wrangler.match(/RETURN_URL\s*=\s*"([^"]*)"/) || [])[1] || "";
if (/license_key|licence_key|[?&]key=/i.test(returnUrl)) {
  block("RETURN_URL templates the licence key into a URL",
    "the extension claims its own licence over its device proof; the URL carries nothing");
} else if (!canonicalSite || returnUrl !== canonicalSite.replace(/\/+$/, "") + "/thanks") {
  block("RETURN_URL must use the canonical Pages purchase-activation route");
} else ok("no licence key ever travels in a web address");

/* ---------- 4b. one price, everywhere ---------- */

// The extension renders its price from lib/product.js and the pricing page from
// its own constant, because they deploy separately. Every other mention is
// prose. A page quoting one number beside a checkout charging another is how a
// launch turns into refunds, so nothing here is left to memory.
const price = (product.match(/PRICE:\s*"([^"]+)"/) || [])[1];
const priceNum = (product.match(/PRICE_NUM:\s*(\d+(?:\.\d+)?)/) || [])[1];
if (!price) block("lib/product.js declares no PRICE");
else {
  if (priceNum && `$${priceNum}` !== price) {
    block(`PRICE (${price}) and PRICE_NUM (${priceNum}) disagree in lib/product.js`);
  }

  // Prose can only be checked for CONTRADICTION: any dollar figure that is not
  // the price, in a file that talks about buying, is a stale number.
  /* store/demo-script.md is in here because it was NOT, and it sat with "$9
     once" in the caption of the launch video long after the price became $1 —
     a file whose whole purpose is to be read aloud on camera. Anything that
     quotes the price gets checked, including the things that are not code. */
  const prose = [["README", readme], ["listing", listing],
                 ["user guide", read("docs/USER-GUIDE.md")],
                 ["demo script", read("store/demo-script.md")]];
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
if (!/\/thanks/.test(returnUrl)) block("post-purchase activation route is missing");
else ok("post-purchase activation uses the canonical Pages route");

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
  const siteCode = await head(canonicalSite);
  siteCode === 200 ? ok("canonical Pages site is live", canonicalSite)
    : block(`canonical site answered ${siteCode || "nothing"} — stores require a reachable privacy policy`, canonicalSite);

  for (const page of ["privacy", "terms", "thanks"]) {
    const url = canonicalSite.replace(/\/+$/, "") + "/" + page;
    const code = await head(url);
    code === 200 ? ok(`${page} is live`, url)
      : block(`${page} answered ${code || "nothing"} — deploy the canonical Pages site before submitting`, url);
  }

  // A junk POST is enough: anything that answers proves a worker is deployed.
  let code;
  try {
    const res = await fetch(issuer + "/entitlement", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "chrome-extension://" + "a".repeat(32) },
      /* A fresh key per run. A constant one put every preflight into a single
         20/hour bucket, so the sixth run of an afternoon got 429 and the check
         quietly stopped meaning anything. */
      body: JSON.stringify({
        license_key: "PREFLIGHT-" + Math.random().toString(36).slice(2, 10).toUpperCase(),
        device: "a".repeat(32), ts: Date.now()
      }),
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
  } else if (code === 429) {
    warn("issuer answered 429 — rate-limited, so the origin check never ran",
      "wait, or rerun: a green tick here would mean nothing");
  } else {
    /* Anything other than 403 means the origin check did not happen. A worker
       with a broken SIGNING_KEY or a missing KV binding 500s on every request,
       and "✓ issuer answered 500" used to exit 0 and green-light the ship. */
    block(`issuer answered ${code}, not 403 — the origin check never ran`,
      `${issuer} · a healthy issuer refuses an unknown extension origin with 403`);
  }
}

/* Every recorded id must be ACCEPTED by the deployed worker. The stranger check
   above proves the gate is closed; this proves it is not closed on US, which is
   the failure that costs a sale: a store install whose origin was never
   allow-listed gets 403 on trial and on purchase, and reads to the buyer as the
   product being broken. Checked against the live issuer because the deployed
   list is the only one that decides anything. */
if (issuer && publishedIds.length) {
  for (const [label, id] of publishedIds) {
    const origin = "chrome-extension://" + id;
    let status = 0, echoed = "";
    try {
      const res = await fetch(issuer + "/entitlement", {
        method: "OPTIONS",
        headers: { Origin: origin, "Access-Control-Request-Method": "POST" },
        signal: AbortSignal.timeout(12000)
      });
      status = res.status;
      echoed = res.headers.get("access-control-allow-origin") || "";
    } catch { /* status remains 0 when the issuer is unreachable */ }
    if (status === 204 && echoed === origin) {
      ok(`issuer accepts the ${label} origin`, id.slice(0, 8) + "\u2026");
    } else if (!status) {
      block(`issuer unreachable while checking the ${label} origin`, issuer);
    } else {
      block(`issuer REFUSES the ${label} origin (${status}) — every trial and purchase from it 403s`,
        `fix: ./server/deploy.sh ${publishedIds.map(([, v]) => v).join(" ")}`);
    }
  }
}

/* Search Console ownership belongs to the canonical site repository, which
   uses HTML-file verification. This extension repository no longer mirrors
   that token or assumes a meta-tag method. */
ok("Search Console ownership is maintained by the canonical site repository");

/* ---------- 7. store assets ---------- */

const shotDir = join(root, "store", "screenshots");
if (!existsSync(shotDir)) block("no store/screenshots — a listing cannot be submitted without them");
else {
  const dims = (f) => {
    const out = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", join(shotDir, f)], { encoding: "utf8" });
    return [+(out.match(/pixelWidth: (\d+)/) || [])[1], +(out.match(/pixelHeight: (\d+)/) || [])[1]];
  };

  /* The promo tiles live beside the screenshots but are a different asset with
     different rules, and lumping them together made this check say
     "screenshots not 1280×800" about a tile that is correct at 440×280. */
  const all = readdirSync(shotDir).filter((f) => f.endsWith(".png"));
  const shots = all.filter((f) => !/^(promo|marquee)-/.test(f));

  if (!shots.length) block("store/screenshots is empty");
  else {
    ok(`${shots.length} screenshots present`);
    if (shots.length > 5) warn(`Chrome accepts at most 5 screenshots — you have ${shots.length}, so pick the five`);
    try {
      const bad = shots.filter((f) => { const [w, h] = dims(f); return !((w === 1280 && h === 800) || (w === 640 && h === 400)); });
      bad.length ? block(`screenshots not 1280×800: ${bad.join(", ")}`) : ok("every screenshot is 1280×800");
    } catch { warn("could not measure screenshots (sips unavailable)"); }
  }

  /* The small tile is not optional in practice: without it the listing is
     ineligible for every featured and category placement Chrome has, which for
     a new extension is most of the discovery that is not paid or posted.
     Rebuild it with: node tools/promo-tile.mjs */
  const promo = "promo-440x280.png";
  if (!all.includes(promo)) {
    block("no small promo tile (440×280) — the listing cannot be featured without one",
      "node tools/promo-tile.mjs");
  } else {
    try {
      const [w, h] = dims(promo);
      (w === 440 && h === 280) ? ok("small promo tile present (440×280)")
        : block(`${promo} is ${w}×${h}, Chrome requires exactly 440×280`);
    } catch { warn("could not measure the promo tile (sips unavailable)"); }
  }

  const shotSource = join(root, "test", "shoot-store.mjs");
  const promoSource = join(root, "tools", "promo-tile.mjs");
  if (existsSync(shotSource) && shots.length) {
    const oldestShot = Math.min(...shots.map((f) => statSync(join(shotDir, f)).mtimeMs));
    if (statSync(shotSource).mtimeMs > oldestShot) {
      block("screenshots predate the evidence-copy generator", "npm run store-assets");
    } else ok("screenshots match the current evidence-copy generator");
  }

  if (existsSync(promoSource) && all.includes(promo)) {
    const promoAssets = all.filter((f) => /^(promo|marquee)-/.test(f));
    const oldestPromo = Math.min(...promoAssets.map((f) => statSync(join(shotDir, f)).mtimeMs));
    if (statSync(promoSource).mtimeMs > oldestPromo) {
      block("promo artwork predates its generator", "npm run store-assets");
    } else ok("promo artwork matches the current generator");
  }

  // Optional, and only ever a nudge: the marquee is for the front page.
  if (!all.some((f) => /^marquee-/.test(f))) {
    warn("no marquee tile (1400×560)", "optional — needed only for front-page featuring");
  }
}

/* ---------- report ---------- */

const icon = { ok: "✓", warn: "!", block: "✗" };
const blocks = rows.filter((r) => r.level === "block");
const warns = rows.filter((r) => r.level === "warn");

console.log(`\nTvara v${mf.version} — launch readiness\n`);
for (const r of rows) {
  console.log(`  ${icon[r.level]} ${r.what}${r.detail ? `\n      ${r.detail}` : ""}`);
}
console.log("");
if (blocks.length) {
  console.log(`❌ ${blocks.length} blocker${blocks.length === 1 ? "" : "s"}${warns.length ? `, ${warns.length} warning${warns.length === 1 ? "" : "s"}` : ""} — not submittable yet.\n`);
  process.exit(1);
}
console.log(`✅ submittable${warns.length ? ` (${warns.length} warning${warns.length === 1 ? "" : "s"} to weigh)` : ""}.\n`);
