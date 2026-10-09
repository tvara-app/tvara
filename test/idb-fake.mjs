#!/usr/bin/env node
/* Layer-5 perf/edge-case tests for bg.js's IndexedDB layer, run in bare Node
   against fake-indexeddb rather than a real browser — fast, deterministic,
   good for edge cases (quota-exceeded, abort-mid-write, schema mismatch).
   Complements test/perf-idb-scale.mjs, which measures the same operations at
   real 50k-chat scale through an actual browser — different failure modes,
   both worth having.

   Feasibility spike (per the plan, done here rather than assumed): bg.js is
   5,298 lines registering live chrome.* listeners at load time, unlike the
   small standalone lib/*.js files test-license.mjs/test-worker.mjs already
   prove out in bare Node. Loading it needs: fake-indexeddb as the global
   indexedDB, a chrome.* stub broad enough to cover every API bg.js touches at
   load time (alarms/notifications/commands .addListener calls run
   top-level), and an importScripts() that actually loads lib/*.js into the
   same vm context bg.js runs in. All three are built below — this file IS
   the spike, formalized once it worked. */
import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { reporter } from "./security-fixtures.mjs";

const ROOT = join(import.meta.dirname, "..");
const { t, done } = reporter();

/* ---------- minimal chrome.* stub ---------- */

function memoryArea() {
  const data = {};
  return {
    async get(keys) {
      if (keys == null) return { ...data };
      const list = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys);
      const out = {};
      for (const k of list) if (k in data) out[k] = data[k];
      return out;
    },
    async set(obj) { Object.assign(data, obj); },
    async remove(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k]; },
    async clear() { for (const k of Object.keys(data)) delete data[k]; },
    _raw: data
  };
}

const listenerSet = () => ({ addListener() {}, removeListener() {}, hasListener: () => false });

const chromeStub = {
  runtime: {
    id: "test-extension-id",
    onMessage: (() => {
      const listeners = [];
      return { addListener: (fn) => listeners.push(fn), _listeners: listeners };
    })(),
    onInstalled: listenerSet(),
    onStartup: listenerSet(),
    getURL: (p) => `chrome-extension://test-extension-id/${p}`,
    sendMessage: async () => undefined,
    lastError: undefined
  },
  storage: { local: memoryArea(), sync: memoryArea() },
  alarms: { onAlarm: listenerSet(), create: async () => {}, clear: async () => true, get: async () => null, getAll: async () => [] },
  notifications: { onClicked: listenerSet(), create: async () => {}, clear: async () => true },
  commands: { onCommand: listenerSet(), getAll: async () => [] },
  downloads: { download: async () => 1 },
  cookies: { getAll: async () => [] }
};

/* ---------- load bg.js (+ its importScripts deps) into one vm context ---------- */

function loadServiceWorker() {
  const sandbox = {
    self: undefined, chrome: chromeStub, indexedDB: globalThis.indexedDB,
    IDBKeyRange: globalThis.IDBKeyRange, crypto: globalThis.crypto,
    console, setTimeout, clearTimeout, TextEncoder, TextDecoder, btoa, atob,
    fetch: async () => { throw new Error("network disabled in idb-fake spike"); },
    URL, Date, Promise, Object, Array, JSON, Math, Error, Map, Set, Uint8Array,
    AbortSignal, structuredClone
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);

  sandbox.importScripts = (...files) => {
    for (const f of files) {
      const src = readFileSync(join(ROOT, f), "utf8");
      vm.runInContext(src, context, { filename: f });
    }
  };

  const bgSrc = readFileSync(join(ROOT, "bg.js"), "utf8");
  vm.runInContext(bgSrc, context, { filename: "bg.js" });
  return context;
}

let ctx;
try {
  ctx = loadServiceWorker();
  t("bg.js loads in bare Node with a stubbed chrome.* + fake-indexeddb", true);
} catch (e) {
  t("bg.js loads in bare Node with a stubbed chrome.* + fake-indexeddb", false, `${e.message}\n${e.stack}`);
  console.log("\nFeasibility spike failed — see error above. Not attempting the edge-case tests below.");
  process.exitCode = 1;
  process.exit();
}

/* ---------- edge cases ---------- */

async function freshChat(id, overrides = {}) {
  return {
    id, host: "chatgpt.com", path: `/c/${id}`, platform: "chatgpt", title: `Chat ${id}`,
    msgs: [{ i: "m1", r: "user", t: "hi" }, { i: "m2", r: "assistant", t: "hello" }],
    ...overrides
  };
}

// 1. Basic upsert + read-back round-trips.
{
  const chat = await freshChat("idb-basic-1");
  const res = await ctx.upsert(chat);
  t("upsert() on a well-formed chat succeeds", !!res && res.ok === true, JSON.stringify(res));
}

// 2. Abort mid-write: close the underlying connection while a put() is in flight,
//    then confirm a fresh upsert still works (the DB layer recovers, doesn't wedge).
{
  try {
    const p1 = ctx.upsert(await freshChat("idb-abort-1"));
    // No explicit abort API exposed by bg.js's db() — instead prove resilience
    // by firing two upserts concurrently and confirming both settle cleanly,
    // which is the observable half of "a write in flight doesn't corrupt state".
    const p2 = ctx.upsert(await freshChat("idb-abort-2"));
    const [r1, r2] = await Promise.all([p1, p2]);
    t("two concurrent upserts both settle successfully (no wedge/corruption under overlap)",
      r1.ok === true && r2.ok === true, JSON.stringify([r1, r2]));
  } catch (e) {
    t("two concurrent upserts both settle successfully (no wedge/corruption under overlap)", false, e.message);
  }
}

// 3. importBatch with a mix of valid and structurally-invalid records — must
//    not let one bad record abort the whole batch.
{
  const batch = [
    await freshChat("idb-batch-1"),
    { id: "idb-batch-bad", msgs: "not-an-array" }, // malformed
    await freshChat("idb-batch-2"),
    { host: "chatgpt.com" }, // missing id and msgs entirely
  ];
  try {
    const res = await ctx.importBatch(batch);
    t("importBatch() with malformed records mixed in doesn't throw", true);
    t("importBatch() stores the well-formed records despite malformed siblings",
      (res.ok || 0) >= 2, JSON.stringify(res));
  } catch (e) {
    t("importBatch() with malformed records mixed in doesn't throw", false, e.message);
  }
}

// 3b. A same-length re-read that DATES messages the stored copy never dated is
//     a repair (Gemini, 2026-10-08: archived for months with every ts 0, and
//     every re-read refused as a tie). A same-length copy that adds nothing is
//     still refused.
{
  const id = "gemini.google.com/app/c_times";
  const base = { id, host: "gemini.google.com", path: "/app/c_times", platform: "Gemini", title: "t",
    createdAt: 0, updatedAt: 5, sourceUpdatedAt: 0 };
  const undated = [{ r: "user", t: "first question here", ts: 0 }, { r: "assistant", t: "first answer here", ts: 0 }];
  const dated = [{ r: "user", t: "first question here", ts: 1790701404 }, { r: "assistant", t: "first answer here", ts: 1790701404 }];
  try {
    await ctx.importBatch([{ ...base, msgs: undated }]);
    await ctx.importBatch([{ ...base, msgs: dated }]);
    let after = null;
    await ctx.scanChats((v) => { if (v.id === id) after = v; });
    t("importBatch() accepts a same-length copy that dates undated messages",
      !!after && after.msgs.every((m) => m.ts === 1790701404), JSON.stringify(after && after.msgs));
    await ctx.importBatch([{ ...base, msgs: undated }]);
    let again = null;
    await ctx.scanChats((v) => { if (v.id === id) again = v; });
    t("…and an undated same-length copy cannot wipe the times back out",
      !!again && again.msgs.every((m) => m.ts === 1790701404), JSON.stringify(again && again.msgs));
  } catch (e) {
    t("importBatch() accepts a same-length copy that dates undated messages", false, e.message);
  }
}

// 4. Schema-version mismatch: fake-indexeddb starts a fresh, unversioned
//    database per process — this exercises bg.js's own onupgradeneeded path
//    (DB_VERSION bump from nothing to whatever bg.js declares), which is the
//    real-world "user upgrades the extension" case, not a contrived stub.
{
  try {
    const stats = await ctx.stats();
    t("stats() succeeds against a DB created fresh by bg.js's own onupgradeneeded path",
      !!stats && typeof stats.chats === "number", JSON.stringify(stats));
  } catch (e) {
    t("stats() succeeds against a DB created fresh by bg.js's own onupgradeneeded path", false, e.message);
  }
}

/* 5. The paged scan. search(), stats(), the stub scan and archiveIndex's
      fallback all walk the archive through scanChats(), which reads a page of
      whole records per request instead of one record per request. Every one of
      those walks is "how much is in here" or "what matches" — so a page
      boundary that drops a record does not fail loudly, it just answers with
      less than the truth. The counts below are chosen around SCAN_PAGE (150):
      one under, exactly one page, one over, and two pages. */
{
  const seen = [];
  const scanCount = async (n) => {
    await ctx.wipe();
    const batch = [];
    for (let i = 0; i < n; i++) {
      // Zero-padded so insertion order and key order agree, which is what
      // makes "every record exactly once" a meaningful assertion.
      batch.push(await freshChat("scan-" + String(i).padStart(5, "0")));
    }
    if (batch.length) await ctx.importBatch(batch);
    const got = [];
    await ctx.scanChats((v) => { got.push(v.id); });
    return got;
  };

  for (const n of [0, 1, 149, 150, 151, 300, 301]) {
    const got = await scanCount(n);
    const unique = new Set(got);
    seen.push(`${n}:${got.length}/${unique.size}`);
    t(`scanChats() returns all ${n} records, once each, in key order`,
      got.length === n && unique.size === n &&
      got.every((id, i) => id === got.slice().sort()[i]),
      got.length + " ids, " + unique.size + " unique");
  }

  // Stopping early must stop early — the walk is used to answer questions that
  // do not need the whole archive.
  {
    await ctx.wipe();
    const batch = [];
    for (let i = 0; i < 400; i++) batch.push(await freshChat("stop-" + String(i).padStart(5, "0")));
    await ctx.importBatch(batch);
    let n = 0;
    await ctx.scanChats(() => { n++; if (n === 7) return false; });
    t("scanChats() stops the moment the visitor says so", n === 7, String(n));
  }

  // A bounded walk sees its range and nothing outside it: archiveIndex() asks
  // for one platform's records, and reading another platform's would put a
  // chat under the wrong host.
  {
    await ctx.wipe();
    const batch = [];
    for (let i = 0; i < 200; i++) batch.push(await freshChat("aaa.com/c/" + String(i).padStart(4, "0")));
    for (let i = 0; i < 200; i++) batch.push(await freshChat("bbb.com/c/" + String(i).padStart(4, "0")));
    await ctx.importBatch(batch);
    const got = [];
    await ctx.scanChats((v) => { got.push(v.id); }, { lower: "bbb.com/c/", upper: "bbb.com/c/\uffff" });
    t("scanChats() bounded to one platform reads that platform whole and nothing else",
      got.length === 200 && got.every((id) => id.startsWith("bbb.com/c/")), String(got.length));
  }
  /* A visitor that throws must REJECT, not hang. The throw happens inside an
     IndexedDB event handler, where an unhandled error settles nothing at all —
     and every caller of this walk awaits it. */
  {
    await ctx.wipe();
    const batch = [];
    for (let i = 0; i < 20; i++) batch.push(await freshChat("boom-" + String(i).padStart(4, "0")));
    await ctx.importBatch(batch);
    let outcome = "hung";
    await Promise.race([
      ctx.scanChats(() => { throw new Error("visitor exploded"); })
        .then(() => { outcome = "resolved"; }, (e) => { outcome = e.message; }),
      new Promise((r) => setTimeout(r, 2000))
    ]);
    t("scanChats() rejects when the visitor throws, rather than never settling",
      outcome === "visitor exploded", outcome);
  }
}


/* 6. The rejection pass. Search is AND, so a chat missing any one word scores
      zero — mayMatch() answers that without allocating a lowercase copy of the
      chat. It is only ever allowed to be WRONG in the safe direction: saying
      "maybe" about something that does not match costs a little work, saying
      "no" about something that does silently loses a search result. */
{
  const cases = [
    ["plain hit", "the quick brown fox", ["quick"], true],
    ["case folded", "The QUICK Brown Fox", ["quick"], true],
    ["mid-word substring, exactly as indexOf finds it", "refactoring", ["actor"], true],
    ["one word missing kills it", "the quick brown fox", ["quick", "zebra"], false],
    ["regex metacharacters are literal", "a+b (c) [d] $e", ["a+b"], true],
    ["a dot is not any character", "abc", ["a.c"], false],
    ["found in the title alone", "", ["title-word"], true, "a title-word here"],
    ["empty message list", "", ["anything"], false]
  ];
  for (const [name, text, words, want, title] of cases) {
    const chat = { title: title || "", msgs: text ? [{ t: text }] : [] };
    const probes = ctx.probesFor(words);
    t("mayMatch: " + name, probes !== null && ctx.mayMatch(chat, probes) === want);
  }
  // Non-ASCII takes the old road rather than a fast path whose case folding is
  // not provably the same as toLowerCase().
  t("a non-ASCII query gets no fast path at all", ctx.probesFor(["café"]) === null);

  /* The property that matters, checked against the thing it replaced: over
     random text, mayMatch() must never say "no" where the lowercase indexOf
     the scorer uses would have found every word. */
  let disagreed = 0;
  const alphabet = "abcAB xyZ+.*?[]()quick";
  const pick = (n) => Array.from({ length: n }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  for (let i = 0; i < 4000; i++) {
    const text = pick(1 + Math.floor(Math.random() * 24));
    const word = pick(1 + Math.floor(Math.random() * 3));
    const probes = ctx.probesFor([word]);
    if (!probes) continue;
    const oldSays = text.toLowerCase().includes(word.toLowerCase());
    const newSays = ctx.mayMatch({ title: "", msgs: [{ t: text }] }, probes);
    if (oldSays && !newSays) disagreed++;
  }
  t("mayMatch never rejects what the lowercase scan would have matched (4,000 random cases)",
    disagreed === 0, disagreed + " disagreements");
}

/* 7. Searching as you type. A query that extends the last one is answered from
      the last one's RESULTS rather than from the archive — the win is large
      (80 ms to 2 ms on a real 14 MB archive) and the risk is precise: an answer
      that is a subset of the true one, arrived at silently. So what is asserted
      here is not the speed, it is that the narrowed answer is the SAME answer. */
{
  await ctx.wipe();
  const batch = [];
  // Three shapes: one that survives the whole word, one that dies partway
  // through it, and one that never matched at all.
  for (let i = 0; i < 12; i++) {
    batch.push(await freshChat("search-full-" + i, {
      title: "About attention", msgs: [{ i: "a", r: "user", t: "the attention layer again" }]
    }));
  }
  for (let i = 0; i < 9; i++) {
    batch.push(await freshChat("search-part-" + i, {
      title: "About attendance", msgs: [{ i: "a", r: "user", t: "attendance was low" }]
    }));
  }
  for (let i = 0; i < 30; i++) {
    batch.push(await freshChat("search-none-" + i, {
      title: "Something else", msgs: [{ i: "a", r: "user", t: "kerning and ligatures" }]
    }));
  }
  await ctx.importBatch(batch);

  const ids = (r) => r.results.map((x) => x.id).sort().join(",");
  const cold = async (q) => { await ctx.search("zzz-nothing-resets-the-cache"); return ctx.search(q); };

  // Typed forward, one character at a time, against the same query asked cold.
  let same = true, steps = [];
  for (const q of ["att", "atte", "atten", "attent", "attenti", "attentio", "attention"]) {
    const warm = await ctx.search(q);            // follows the previous query
    const fresh = await cold(q);                 // reads the archive
    steps.push(`${q}:${warm.results.length}/${fresh.results.length}`);
    if (ids(warm) !== ids(fresh)) same = false;
    await ctx.search(q.slice(0, -1));            // re-seed the chain for the next step
    await ctx.search(q);
  }
  t("a query typed out returns exactly what the same query returns cold",
    same, steps.join(" "));

  // "atten" matches both attention and attendance; "attention" must not still
  // be carrying the attendance chats along with it.
  await ctx.search("zzz-reset");
  const five = await ctx.search("atten");
  const nine = await ctx.search("attention");
  t("narrowing actually narrows — the chats that stopped matching are dropped",
    five.results.length === 21 && nine.results.length === 12,
    `${five.results.length} then ${nine.results.length}`);

  /* The count the reader is shown is about the ARCHIVE, not about the handful
     of records re-read to answer. "no matches in 12 chats" would be a false
     statement about an archive of fifty-one. */
  t("a narrowed answer still says how much archive it came from",
    nine.scanned === five.scanned && five.scanned === 51,
    `${five.scanned} then ${nine.scanned}`);

  // Backspacing widens, so it must go back to the archive rather than to a set
  // that has already had those chats removed from it.
  const back = await ctx.search("atten");
  t("backspacing gets the wider answer back", back.results.length === 21,
    String(back.results.length));

  /* A chat written between two keystrokes must show up in the next answer. The
     cached set is held against the archive's write counter for exactly this. */
  await ctx.search("attention");
  await ctx.importBatch([await freshChat("search-late-1", {
    title: "Late arrival", msgs: [{ i: "a", r: "user", t: "attention, arriving late" }]
  })]);
  const after = await ctx.search("attention");
  t("a chat archived mid-query appears in the next answer",
    after.results.length === 13, String(after.results.length));
}

// 8. quota-exceeded: fake-indexeddb doesn't enforce browser storage quotas by
//    default, so this can't be triggered faithfully in-process. Documented as
//    a known gap (not called via t() — a fake pass/fail here would be worse
//    than an honest gap) rather than faked with a misleading result.
console.log("\nSKIPPED  quota-exceeded scenario — fake-indexeddb doesn't enforce storage quotas in-process; needs a real browser (see test/perf-idb-scale.mjs) or a quota-shim layer, not attempted here.");

done();
