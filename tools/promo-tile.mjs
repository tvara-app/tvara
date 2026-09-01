#!/usr/bin/env node
/**
 * Tvara — the store promo tiles.
 *
 *   node tools/promo-tile.mjs              # small tile,   440×280
 *   node tools/promo-tile.mjs --marquee    # marquee tile, 1400×560
 *   node tools/promo-tile.mjs --all        # both
 *
 * Chrome requires the small tile for any featured placement, and the marquee
 * for the front-page one. Brand values are lifted from docs/index.html so the
 * tiles and the pricing page cannot drift apart.
 *
 * The two are separate art boards rather than one scaled twice: 440×280 is
 * 1.57:1 and the marquee is 2.5:1, so the same layout at two sizes leaves the
 * wide one mostly empty. Everything they share — palette, copy, the minimap
 * motif — is defined once below.
 */
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const EXT = args.find((a) => !a.startsWith("--")) || join(dirname(fileURLToPath(import.meta.url)), "..");
const icon = readFileSync(join(EXT, "icons", "icon256_rounded.png")).toString("base64");

/* The copy, in one place: the tiles say the same thing at two sizes. */
const HEAD_1 = "Long AI chats,";
const HEAD_2 = "without the lag.";
const SUB = "Speed engine, minimap, outline &amp; cross-platform search for ChatGPT, Claude &amp; Gemini.";
const PILLS = ["100% local", "No account", "Nothing deleted"];

/* Deterministic, not random: a tile must be byte-identical on every rebuild or
   it becomes a diff nobody can review. */
const stripScript = (bars) => `<script>
  const s = document.getElementById("s");
  let seed = 20260824;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < ${bars}; i++) {
    const el = document.createElement("i");
    const r = rnd();
    el.className = r > 0.74 ? "me" : r > 0.60 ? "code" : "";
    el.style.height = (r > 0.74 ? 4 : 3 + Math.round(rnd() * 9)) + "px";
    s.appendChild(el);
  }
</script>`;

const small = `<!doctype html><meta charset="utf-8"><style>
  :root { --bg:#0e1117; --panel:#161b26; --text:#e8eaf0; --muted:#9aa3b5;
          --accent:#7aa2ff; --line:rgba(255,255,255,0.08); }
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { width:440px; height:280px; }
  body { background:
      radial-gradient(120% 90% at 82% 8%, rgba(122,162,255,.20), transparent 60%),
      radial-gradient(90% 80% at 10% 100%, rgba(122,162,255,.10), transparent 55%),
      var(--bg);
    color:var(--text); font:16px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    display:flex; flex-direction:column; justify-content:center;
    padding:30px 32px; position:relative; overflow:hidden; }
  /* the minimap motif, the one visual that is unmistakably this product */
  .strip { position:absolute; right:30px; top:34px; bottom:34px; width:15px;
           border-radius:8px; background:var(--panel); border:1px solid var(--line);
           padding:7px 4px; display:flex; flex-direction:column; gap:3px; }
  .strip i { display:block; border-radius:2px; background:#2c3550; }
  .strip i.me  { background:var(--accent); opacity:.85; }
  .strip i.code{ background:#4d5c86; }
  .row { display:flex; align-items:center; gap:11px; }
  img { width:34px; height:34px; border-radius:9px; }
  .name { font-size:25px; font-weight:800; letter-spacing:-.4px; }
  h1 { font-size:29px; line-height:1.16; font-weight:800; letter-spacing:-.9px;
       margin:15px 0 0; max-width:322px; }
  h1 em { font-style:normal; color:var(--accent); }
  p { color:var(--muted); font-size:14.5px; margin-top:10px; max-width:318px; }
  .foot { display:flex; gap:7px; margin-top:16px; }
  .pill { font-size:11.5px; color:var(--muted); border:1px solid var(--line);
          border-radius:999px; padding:4px 11px; background:rgba(255,255,255,.02); }
</style>
<div class="strip" id="s"></div>
<div class="row"><img src="data:image/png;base64,${icon}"><span class="name">Tvara</span></div>
<h1>${HEAD_1}<br><em>${HEAD_2}</em></h1>
<p>${SUB}</p>
<div class="foot">
${PILLS.map((t) => `  <span class="pill">${t}</span>`).join("\n")}
</div>
${stripScript(26)}`;

/* Wide board. The text column is held to roughly half the width so the tile
   reads as a headline beside a product motif, not as a banner of loose words:
   at 1400px a full-bleed line of copy is unreadable at the size Chrome
   actually renders it in the store. */
const marquee = `<!doctype html><meta charset="utf-8"><style>
  :root { --bg:#0e1117; --panel:#161b26; --text:#e8eaf0; --muted:#9aa3b5;
          --accent:#7aa2ff; --line:rgba(255,255,255,0.08); }
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { width:1400px; height:560px; }
  body { background:
      radial-gradient(80% 120% at 76% 0%, rgba(122,162,255,.22), transparent 62%),
      radial-gradient(70% 110% at 6% 100%, rgba(122,162,255,.10), transparent 58%),
      var(--bg);
    color:var(--text); font:16px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
    display:flex; align-items:center; gap:72px;
    padding:0 96px; position:relative; overflow:hidden; }
  .col { flex:0 1 720px; }
  .row { display:flex; align-items:center; gap:18px; }
  img { width:64px; height:64px; border-radius:16px; }
  .name { font-size:44px; font-weight:800; letter-spacing:-.8px; }
  h1 { font-size:64px; line-height:1.1; font-weight:800; letter-spacing:-2px;
       margin:30px 0 0; }
  h1 em { font-style:normal; color:var(--accent); }
  p { color:var(--muted); font-size:24px; margin-top:20px; max-width:660px; }
  .foot { display:flex; gap:12px; margin-top:30px; }
  .pill { font-size:18px; color:var(--muted); border:1px solid var(--line);
          border-radius:999px; padding:8px 20px; background:rgba(255,255,255,.02); }
  /* The motif, given room: at this size it can read as the minimap it is
     rather than as a decorative bar. */
  .board { flex:1 1 auto; align-self:stretch; margin:64px 0; position:relative;
           border-radius:22px; background:var(--panel); border:1px solid var(--line);
           display:flex; gap:20px; padding:26px 26px 26px 30px; overflow:hidden; }
  .lines { flex:1 1 auto; display:flex; flex-direction:column; gap:13px; padding-top:6px; }
  .lines b { display:block; height:12px; border-radius:6px; background:#222a3d; }
  .lines b.w1 { width:88%; } .lines b.w2 { width:64%; } .lines b.w3 { width:76%; }
  .lines b.hot { background:#2f3a5c; }
  .strip { flex:0 0 26px; border-radius:12px; background:#10141d;
           border:1px solid var(--line); padding:11px 6px;
           display:flex; flex-direction:column; gap:5px; }
  .strip i { display:block; border-radius:3px; background:#2c3550; }
  .strip i.me  { background:var(--accent); opacity:.85; }
  .strip i.code{ background:#4d5c86; }
</style>
<div class="col">
  <div class="row"><img src="data:image/png;base64,${icon}"><span class="name">Tvara</span></div>
  <h1>${HEAD_1}<br><em>${HEAD_2}</em></h1>
  <p>${SUB}</p>
  <div class="foot">
${PILLS.map((t) => `    <span class="pill">${t}</span>`).join("\n")}
  </div>
</div>
<div class="board">
  <div class="lines">
    <b class="w1"></b><b class="w2 hot"></b><b class="w3"></b><b class="w2"></b>
    <b class="w1 hot"></b><b class="w3"></b><b class="w2"></b><b class="w1"></b>
    <b class="w3 hot"></b><b class="w2"></b><b class="w1"></b><b class="w3"></b>
  </div>
  <div class="strip" id="s"></div>
</div>
${stripScript(38)}`;

const boards = [];
if (flags.has("--marquee") || flags.has("--all")) {
  boards.push({ html: marquee, w: 1400, h: 560, out: "marquee-1400x560.png" });
}
if (!flags.has("--marquee") || flags.has("--all")) {
  boards.push({ html: small, w: 440, h: 280, out: "promo-440x280.png" });
}

mkdirSync(join(EXT, "store", "screenshots"), { recursive: true });
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || "chromium" });
for (const b of boards) {
  const path = join(EXT, "store", "screenshots", b.out);
  const page = await browser.newPage({ viewport: { width: b.w, height: b.h }, deviceScaleFactor: 1 });
  await page.setContent(b.html, { waitUntil: "load" });
  await page.screenshot({ path });
  await page.close();
  console.log("wrote", path);
}
await browser.close();
