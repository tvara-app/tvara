#!/usr/bin/env node
/**
 * Tvara — the small promo tile.
 *
 *   node tools/promo-tile.mjs
 *
 * 440×280. Chrome requires it for any featured placement and
   the listing has never had one. Brand values are lifted from docs/index.html
   so the tile and the pricing page cannot drift apart. */
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const EXT = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(EXT, "store", "screenshots", "promo-440x280.png");
const icon = readFileSync(join(EXT, "icons", "icon256_rounded.png")).toString("base64");

const html = `<!doctype html><meta charset="utf-8"><style>
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
<h1>Long AI chats,<br><em>without the lag.</em></h1>
<p>Speed engine, minimap, outline &amp; cross-platform search for ChatGPT, Claude &amp; Gemini.</p>
<div class="foot">
  <span class="pill">100% local</span>
  <span class="pill">No account</span>
  <span class="pill">Nothing deleted</span>
</div>
<script>
  /* Deterministic, not random: the tile must be byte-identical on every
     rebuild or it becomes a diff nobody can review. */
  const s = document.getElementById("s");
  let seed = 20260824;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 26; i++) {
    const el = document.createElement("i");
    const r = rnd();
    el.className = r > 0.74 ? "me" : r > 0.60 ? "code" : "";
    el.style.height = (r > 0.74 ? 4 : 3 + Math.round(rnd() * 9)) + "px";
    s.appendChild(el);
  }
</script>`;

mkdirSync(join(EXT, "store", "screenshots"), { recursive: true });
const browser = await chromium.launch({ channel: "chromium" });
const page = await browser.newPage({ viewport: { width: 440, height: 280 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: "load" });
await page.screenshot({ path: OUT });
await browser.close();
console.log("wrote", OUT);
