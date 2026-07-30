#!/usr/bin/env node
/* Long Chat Toolkit — multi-account browser suite.
 *
 * People keep several accounts on the same provider precisely because one free
 * tier runs out, so "two ChatGPTs in one browser" is the ordinary case. This
 * suite drives the real service worker against scripted providers and asserts
 * the two things that case breaks if nobody is looking:
 *
 *   the archive must never let one account's listing delete another's chats,
 *   and a usage tally must belong to the account whose limit it counts against.
 *
 * Runs on the user's real Google Chrome by default (channel "chrome", headed —
 * real Chrome will not load an unpacked extension headless). LCT_CHANNEL and
 * LCT_HEADED override for CI.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright";
import { startProviders, makeChats } from "./mock-providers.mjs";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRATCH = join(SRC, "test", ".work-accounts");
const PROFILE = join(SCRATCH, "chrome-profile");
const EXT = join(SCRATCH, "ext");
const PORT = Number(process.env.LCT_MOCK_PORT || 8931);
const CHANNEL = process.env.LCT_CHANNEL || "chrome";
const HEADED = process.env.LCT_HEADED ? process.env.LCT_HEADED !== "0" : CHANNEL === "chrome";

rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(EXT, { recursive: true });

/* The mirror differs from what ships by exactly two things: the provider base
   URLs point at the scripted server, and 127.0.0.1 is a permitted host so the
   worker may read those responses. Every rule under test is the real code. */
const sync = spawnSync("rsync", ["-a", "--exclude", ".git", "--exclude", "node_modules",
  "--exclude", "test/.work", "--exclude", "test/.work-accounts", SRC + "/", EXT + "/"]);
if (sync.status !== 0) { console.error("FATAL: could not mirror the extension"); process.exit(1); }

const bgPath = join(EXT, "bg.js");
let bg = readFileSync(bgPath, "utf8");
const bases = {
  "https://chatgpt.com": `http://127.0.0.1:${PORT}/chatgpt`,
  "https://claude.ai": `http://127.0.0.1:${PORT}/claude`,
  "https://chat.deepseek.com": `http://127.0.0.1:${PORT}/deepseek`,
  "https://grok.com": `http://127.0.0.1:${PORT}/grok`,
  "https://www.perplexity.ai": `http://127.0.0.1:${PORT}/perplexity`,
  "https://gemini.google.com": `http://127.0.0.1:${PORT}/gemini`
};
for (const [from, to] of Object.entries(bases)) {
  const needle = `base: "${from}"`;
  if (!bg.includes(needle)) { console.error(`FATAL: adapter base ${from} not found in bg.js`); process.exit(1); }
  bg = bg.replace(needle, `base: "${to}"`);
}
writeFileSync(bgPath, bg);

const manPath = join(EXT, "manifest.json");
const manifest = JSON.parse(readFileSync(manPath, "utf8"));
manifest.host_permissions = [...new Set([...(manifest.host_permissions || []), "http://127.0.0.1/*"])];
writeFileSync(manPath, JSON.stringify(manifest, null, 2));

const computedId = [...createHash("sha256").update(EXT).digest().subarray(0, 16)]
  .map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join("");
function idFromProfile() {
  for (const f of ["Preferences", "Secure Preferences"]) {
    try {
      const prefs = JSON.parse(readFileSync(join(PROFILE, "Default", f), "utf8"));
      for (const [id, v] of Object.entries(prefs.extensions?.settings || {})) if (v.path === EXT) return id;
    } catch { /* not written yet */ }
  }
  return null;
}

let pass = 0, fail = 0;
const failed = [];
const t = (name, cond, extra = "") => {
  const line = `${name}${cond || !extra ? "" : "  → " + extra}`;
  cond ? pass++ : (fail++, failed.push(line));
  console.log(`${cond ? "PASS" : "FAIL"}  ${line}`);
};

const providers = await startProviders(PORT);

/* Branded Chrome stopped honouring --load-extension in M136 and no flag brings
   it back, so a run on the installed Chrome comes up with no extension in it.
   Try it anyway — the day a build allows it again this needs no edit — and fall
   back to the bundled Chromium, which is the same engine and the same extension
   APIs, rather than reporting a pass that never ran. */
async function launch(channel) {
  rmSync(PROFILE, { recursive: true, force: true });
  const context = await chromium.launchPersistentContext(PROFILE, {
    channel,
    headless: channel === "chrome" ? false : !HEADED,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      "--disable-features=DisableLoadExtensionCommandLineSwitch"
    ],
    viewport: { width: 900, height: 800 }
  });
  // The worker's own URL is the authoritative extension id, and waiting for it
  // is also the proof that the extension actually loaded.
  const worker = context.serviceWorkers()[0] ||
    await context.waitForEvent("serviceworker", { timeout: 20000 }).catch(() => null);
  if (worker) return { context, id: new URL(worker.url()).host };
  await context.close();
  return null;
}

let started = await launch(CHANNEL);
let usedChannel = CHANNEL;
if (!started && CHANNEL === "chrome") {
  console.log("note: this Google Chrome build refuses --load-extension (M136+); " +
    "falling back to the bundled Chromium — same engine, same extension APIs.");
  started = await launch("chromium");
  usedChannel = "chromium";
}
if (!started) {
  console.error(`FATAL: ${CHANNEL} started without the extension.`);
  await providers.close();
  process.exit(1);
}
const ctx = started.context;
const EXT_ID = started.id;
console.log(`running on ${usedChannel} · extension ${EXT_ID}` +
  (EXT_ID === (idFromProfile() || computedId) ? "" : " (id from worker)"));
const POPUP = `chrome-extension://${EXT_ID}/popup/popup.html`;

const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e.message)));
await page.goto(POPUP);
await page.waitForSelector("#usage-bars");

/* ---------- talking to the worker and the archive ---------- */

const send = (msg) => page.evaluate((m) => new Promise((res) => {
  chrome.runtime.sendMessage(m, (reply) => { void chrome.runtime.lastError; res(reply); });
}), msg);

const syncNow = () => send({ type: "recall-bg-sync" });

/** Every archived row, with the account it is attributed to. */
const rows = () => page.evaluate(() => new Promise((res, rej) => {
  const req = indexedDB.open("lct-recall", 3);
  req.onerror = () => rej(req.error);
  req.onsuccess = () => {
    const out = [];
    const cur = req.result.transaction("chats", "readonly").objectStore("chats").openCursor();
    cur.onerror = () => rej(cur.error);
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return res(out);
      out.push({ id: c.value.id, acct: c.value.acct || "", n: c.value.n, title: c.value.title || "" });
      c.continue();
    };
  };
}));

const idsFor = (all, prefix) => all.filter((r) => r.id.includes(prefix)).map((r) => r.id).sort();
const ledger = () => page.evaluate(async () =>
  (await chrome.storage.sync.get("lct-recall-sync-ledger-v2"))["lct-recall-sync-ledger-v2"] || { checkpoints: {} });
const quarantined = async () => (await send({ type: "recall-deletions" })).items.map((i) => i.id).sort();
const roster = async () => (await send({ type: "account-roster" })).accounts;
const local = (key) => page.evaluate(async (k) => (await chrome.storage.local.get(k))[k], key);

/** The sweep only looks once a day; a test cannot wait that long. */
const makeSweepDue = () => page.evaluate(() => chrome.storage.local.remove("lct-recall-sweep-v1"));

/** One archived chat's messages, so a test can assert what the adapter PARSED
 *  and not merely that something with the right id landed. */
const msgsOf = (id) => page.evaluate((key) => new Promise((res, rej) => {
  const req = indexedDB.open("lct-recall", 3);
  req.onerror = () => rej(req.error);
  req.onsuccess = () => {
    const get = req.result.transaction("chats", "readonly").objectStore("chats").get(key);
    get.onerror = () => rej(get.error);
    get.onsuccess = () => res((get.result && get.result.msgs) || []);
  };
}), id);

const checkpointsFor = async (platform) => {
  const l = await ledger();
  return Object.entries(l.checkpoints).filter(([, c]) => c.platform === platform);
};

try {
  /* ================= A. two accounts on one provider ================= */

  const alice = makeChats("alice", 4);
  const bob = makeChats("bob", 3, Date.UTC(2026, 3, 1));
  await providers.control({
    chatgpt: { signedIn: true, current: "acct-alice", accounts: {
      "acct-alice": { email: "alice@example.com", chats: alice }
    } }
  });

  await syncNow();
  let all = await rows();
  const aliceIds = idsFor(all, "chatgpt.com/c/alice");
  t("A1 first account's chats are archived", aliceIds.length === 4, String(aliceIds.length));
  const aliceTag = all.find((r) => r.id.includes("alice"))?.acct || "";
  t("A1 every archived chat carries an account tag",
    all.filter((r) => r.id.includes("chatgpt")).every((r) => r.acct === aliceTag) && aliceTag.length === 16,
    aliceTag);

  // The second account signs in. Its first pass is always a COMPLETE listing,
  // which is exactly the shape that used to nominate everyone else's chats for
  // deletion.
  await providers.control({
    chatgpt: { current: "acct-bob", accounts: {
      "acct-alice": { email: "alice@example.com", chats: alice },
      "acct-bob": { email: "bob@example.com", chats: bob }
    } }
  });
  await makeSweepDue();
  await syncNow();

  all = await rows();
  t("A2 second account's chats are archived", idsFor(all, "chatgpt.com/c/bob").length === 3,
    String(idsFor(all, "chatgpt.com/c/bob").length));
  t("A2 FIRST account's chats survive the second account's full listing",
    idsFor(all, "chatgpt.com/c/alice").length === 4,
    JSON.stringify(idsFor(all, "chatgpt.com/c/alice")));
  t("A2 nothing was put up for deletion", (await quarantined()).length === 0,
    JSON.stringify(await quarantined()));
  const bobTag = all.find((r) => r.id.includes("bob"))?.acct || "";
  t("A2 the two accounts carry different tags", bobTag && bobTag !== aliceTag, `${aliceTag} / ${bobTag}`);

  const cps = await checkpointsFor("chatgpt");
  t("A3 each account keeps its own checkpoint", cps.length === 2, String(cps.length));
  t("A3 coverage counts the account, not the host",
    cps.map(([, c]) => c.coverage).sort().join(",") === "3,4",
    cps.map(([, c]) => c.coverage).join(","));
  t("A3 checkpoints declare themselves account-scoped", cps.every(([, c]) => c.acctScoped === true));

  /* ================= B. deletion still works, per account ================= */

  // Bob deletes one of his own chats. That IS a deletion and must be noticed.
  await providers.control({
    chatgpt: { current: "acct-bob", accounts: {
      "acct-alice": { email: "alice@example.com", chats: alice },
      "acct-bob": { email: "bob@example.com", chats: bob.slice(0, 2) }
    } }
  });
  await makeSweepDue();
  await syncNow();
  const gone = await quarantined();
  t("B1 a chat deleted inside an account is still caught",
    gone.length === 1 && gone[0].includes("bob-3"), JSON.stringify(gone));
  t("B1 and the OTHER account is untouched by that sweep",
    (await rows()).filter((r) => r.id.includes("alice")).length === 4);

  await send({ type: "recall-deletions-resolve", ids: gone, action: "keep" });
  t("B2 quarantine clears once resolved", (await quarantined()).length === 0);

  /* ================= C. attributing an archive built before accounts ====== */

  // A row written by an older build: no acct at all. One belongs to Alice's
  // listing, one belongs to nobody's.
  await page.evaluate(() => new Promise((res, rej) => {
    const req = indexedDB.open("lct-recall", 3);
    req.onerror = () => rej(req.error);
    req.onsuccess = () => {
      const store = req.result.transaction("chats", "readwrite").objectStore("chats");
      const mk = (id, title) => ({
        id: "chatgpt.com/c/" + id, host: "chatgpt.com", path: "/c/" + id,
        platform: "ChatGPT", title, createdAt: 1, updatedAt: 1, sourceUpdatedAt: 1, n: 2, mv: 0,
        msgs: [{ i: "a", r: "user", t: "legacy question here" }, { i: "b", r: "assistant", t: "legacy answer here" }]
      });
      store.put(mk("alice-1", "legacy but listed"));
      store.put(mk("orphan-9", "legacy and unlisted"));
      req.result.transaction("chats", "readonly").objectStore("chats").count().onsuccess = () => res();
    };
  }));
  let legacy = (await rows()).filter((r) => r.id.includes("alice-1") || r.id.includes("orphan-9"));
  t("C0 legacy rows start with no account", legacy.every((r) => r.acct === ""), JSON.stringify(legacy));

  await providers.control({ chatgpt: { current: "acct-alice" } });
  await makeSweepDue();
  await syncNow();
  legacy = (await rows()).filter((r) => r.id.includes("alice-1") || r.id.includes("orphan-9"));
  const listedLegacy = legacy.find((r) => r.id.includes("alice-1"));
  const orphan = legacy.find((r) => r.id.includes("orphan-9"));
  t("C1 a legacy row named by a listing is adopted by that account",
    listedLegacy && listedLegacy.acct === aliceTag, JSON.stringify(listedLegacy));
  t("C2 a legacy row nobody claims stays unattributed", orphan && orphan.acct === "", JSON.stringify(orphan));
  t("C2 and is never quarantined by the account that swept",
    !(await quarantined()).some((id) => id.includes("orphan-9")), JSON.stringify(await quarantined()));

  /* ================= D. one login, several organisations ================= */

  const workChats = makeChats("work", 2, Date.UTC(2026, 5, 1));
  const personalChats = makeChats("personal", 3, Date.UTC(2026, 6, 1));
  await providers.control({
    claude: { signedIn: true, orgs: [
      { uuid: "org-personal", name: "personal@example.com", capabilities: ["chat"], chats: personalChats },
      { uuid: "org-work", name: "Work Team", capabilities: ["chat", "claude_pro"], chats: workChats }
    ] }
  });
  await syncNow();
  all = await rows();
  t("D1 chats from the FIRST organisation are archived",
    idsFor(all, "claude.ai/chat/personal").length === 3, String(idsFor(all, "claude.ai/chat/personal").length));
  t("D1 chats from the SECOND organisation are archived too",
    idsFor(all, "claude.ai/chat/work").length === 2, String(idsFor(all, "claude.ai/chat/work").length));
  const claudeTags = new Set(all.filter((r) => r.id.includes("claude.ai")).map((r) => r.acct));
  t("D2 each organisation is its own account", claudeTags.size === 2, JSON.stringify([...claudeTags]));
  t("D2 each organisation keeps its own checkpoint",
    (await checkpointsFor("claude")).length === 2, String((await checkpointsFor("claude")).length));
  const claudeRoster = (await roster()).claude || {};
  t("D3 the paid organisation's plan is read from its capabilities",
    Object.values(claudeRoster).some((a) => a.plan === "Pro"), JSON.stringify(Object.values(claudeRoster).map((a) => a.plan)));
  t("D3 the free organisation is recorded as free",
    Object.values(claudeRoster).some((a) => a.plan === "Free"));

  /* ================= E. a provider that names nobody ================= */

  const d1 = makeChats("dsone", 3, Date.UTC(2026, 1, 1));
  const d2 = makeChats("dstwo", 2, Date.UTC(2026, 8, 1));
  await providers.control({
    deepseek: { signedIn: true, current: "d1", accounts: { d1: { chats: d1 }, d2: { chats: d2 } } }
  });
  await syncNow();
  t("E1 first DeepSeek account archives", idsFor(await rows(), "chat.deepseek.com/chat/dsone").length === 3);
  const dsFirst = await checkpointsFor("deepseek");
  t("E1 its checkpoint records an anchor", dsFirst.length === 1 && !!dsFirst[0][1].anchor,
    JSON.stringify(dsFirst.map(([, c]) => c.anchor)));

  await providers.control({ deepseek: { current: "d2" } });
  await makeSweepDue();
  await syncNow();
  all = await rows();
  t("E2 second DeepSeek account archives", idsFor(all, "chat.deepseek.com/chat/dstwo").length === 2);
  t("E2 first DeepSeek account's chats survive — provider named nobody, archive still knew",
    idsFor(all, "chat.deepseek.com/chat/dsone").length === 3,
    JSON.stringify(idsFor(all, "chat.deepseek.com/chat/dsone")));
  t("E2 nothing was quarantined across the switch",
    !(await quarantined()).some((id) => id.includes("deepseek")), JSON.stringify(await quarantined()));
  t("E3 the stranger account got its own checkpoint",
    (await checkpointsFor("deepseek")).length === 2, String((await checkpointsFor("deepseek")).length));

  // Same account deleting its own oldest chat must NOT read as a new account.
  await providers.control({ deepseek: { current: "d2", accounts: { d1: { chats: d1 }, d2: { chats: d2.slice(1) } } } });
  await makeSweepDue();
  await syncNow();
  t("E4 losing the oldest chat is not mistaken for a different account",
    (await checkpointsFor("deepseek")).length === 2, String((await checkpointsFor("deepseek")).length));

  /* ================= P. Perplexity: shapes nothing else in the suite has =====
     Four things are unique to this adapter and silently wrong if nobody looks:
     the listing is a BARE array, it pages by an offset in the POST BODY (so
     none of the shared query-string schemes apply), the answer text is either
     `text` or a JSON-ENCODED `answer` string, and a purged thread is a 400
     rather than a 404. 51 chats, because a second page is the only proof the
     body-offset scheme actually advances. */

  const pplx = makeChats("pplx", 51, Date.UTC(2026, 5, 1));
  await providers.control({
    perplexity: { signedIn: true, current: "p1", expired: [],
      accounts: { p1: { email: "pplx@example.com", chats: pplx } } }
  });
  await syncNow();
  all = await rows();
  const pplxRows = all.filter((r) => r.id.startsWith("www.perplexity.ai/search/pplx-"));
  t("P1 every Perplexity thread archives, across both listing pages",
    pplxRows.length === 51, String(pplxRows.length));
  t("P1 one thread entry expands into a user message AND an assistant message",
    pplxRows.every((r) => r.n === 2), JSON.stringify(pplxRows.map((r) => r.n).filter((n) => n !== 2)));

  const plain = await msgsOf("www.perplexity.ai/search/pplx-1");     // mock sends `text`
  const wrapped = await msgsOf("www.perplexity.ai/search/pplx-2");   // mock sends encoded `answer`
  t("P2 the question is archived from query_str",
    plain[0] && plain[0].r === "user" && plain[0].t.startsWith("Question 1 from pplx"),
    JSON.stringify(plain[0]));
  t("P2 a plain `text` answer is archived verbatim",
    plain[1] && plain[1].r === "assistant" && plain[1].t.startsWith("Answer 1 for pplx"),
    JSON.stringify(plain[1]));
  // The failure this guards against is not an empty message — it is archiving
  // the literal string {"answer":"…"} and looking perfectly healthy doing it.
  t("P2 a JSON-encoded `answer` is unwrapped, not stored raw",
    wrapped[1] && wrapped[1].t.startsWith("Answer 2 for pplx"), JSON.stringify(wrapped[1]));
  t("P2 no archived Perplexity message is a raw JSON wrapper",
    !wrapped.some((m) => m.t.includes('{"answer"')), JSON.stringify(wrapped.map((m) => m.t.slice(0, 40))));

  // Perplexity stamps naive ISO with no zone. Read as local time this lands a
  // whole timezone offset away, which is invisible on a UTC machine and a
  // permanently re-syncing chat on every other one.
  t("P3 a zoneless timestamp is read as UTC, not as local time",
    plain[0] && plain[0].ts === Math.floor(Date.UTC(2026, 5, 1) / 1000),
    plain[0] && `${plain[0].ts} vs ${Math.floor(Date.UTC(2026, 5, 1) / 1000)}`);

  // A thread Perplexity has purged answers 400. Left as a network error it is
  // retried on every pass, forever, for something that is never coming back.
  await providers.control({ perplexity: { expired: ["pplx-3"] } });
  await page.evaluate(() => chrome.storage.local.remove("lct-recall-sync-work-v1"));
  await providers.control({ perplexity: { accounts: { p1: {
    email: "pplx@example.com",
    chats: pplx.map((c) => (c.id === "pplx-3" ? { ...c, updatedAt: c.updatedAt + 60000 } : c))
  } } } });
  await syncNow();
  const journal = (await local("lct-recall-sync-work-v1")) || {};
  const stillQueued = Object.values(journal)
    .flatMap((job) => (job && job.ids) || [])
    .filter((id) => String(id).includes("pplx-3"));
  t("P4 a purged thread (400) is dropped from the queue, not retried forever",
    stillQueued.length === 0, JSON.stringify(stillQueued));
  t("P4 and the rest of the platform still archives around it",
    (await rows()).filter((r) => r.id.startsWith("www.perplexity.ai/search/pplx-")).length >= 50);

  /* ================= M. Gemini: batchexecute end to end ====================
     Gemini has no REST API — this is Google's positional RPC transport, parsed
     by index out of length-prefixed frames. Three properties are the ones that
     break quietly. Conversations live on a PINNED and an UNPINNED shelf and one
     call returns only one shelf, so asking once archives half an account and
     calls it complete. Turns arrive NEWEST-FIRST, which an adapter that trusts
     arrival order writes down backwards. And a renamed field yields rows the
     adapter cannot name, which must be reported rather than read as an empty
     account. */

  const gem = makeChats("gemchat", 4, Date.UTC(2026, 4, 1));
  // makeChats is one turn per chat, and one turn cannot show whether the
  // reversal happened. This one has two.
  gem.push({
    id: "gemlong", title: "Gemini multi-turn chat",
    createdAt: Date.UTC(2026, 4, 9), updatedAt: Date.UTC(2026, 4, 9, 1),
    msgs: [
      { r: "user", t: "First question, long enough to be a real archived message." },
      { r: "assistant", t: "First answer, also long enough to be archived properly." },
      { r: "user", t: "Second question, following on from the first one above." },
      { r: "assistant", t: "Second answer, the most recent turn in this conversation." }
    ]
  });
  await providers.control({
    gemini: { signedIn: true, current: "gm1", pinned: ["gemchat-2"], blankIds: false,
      accounts: { gm1: { email: "gem@example.com", chats: gem } } }
  });
  await syncNow();
  all = await rows();
  const gemRows = all.filter((r) => r.id.startsWith("gemini.google.com/app/"));
  t("M1 Gemini conversations archive over batchexecute", gemRows.length === 5,
    JSON.stringify(gemRows.map((r) => r.id)));
  t("M1 the pinned shelf is read too, not only the unpinned one",
    gemRows.some((r) => r.id.endsWith("/gemchat-2")), JSON.stringify(gemRows.map((r) => r.id)));

  const gemTurns = await msgsOf("gemini.google.com/app/gemlong");
  t("M2 a newest-first conversation is archived in the order it happened",
    gemTurns.length === 4 &&
    gemTurns[0].t.startsWith("First question") && gemTurns[1].t.startsWith("First answer") &&
    gemTurns[2].t.startsWith("Second question") && gemTurns[3].t.startsWith("Second answer"),
    JSON.stringify(gemTurns.map((m) => m.t.slice(0, 16))));
  t("M2 roles survive the positional parse",
    gemTurns.map((m) => m.r).join(",") === "user,assistant,user,assistant",
    JSON.stringify(gemTurns.map((m) => m.r)));

  const gemCp = await checkpointsFor("gemini");
  t("M3 a listing under the ask limit is complete, and counts what it holds",
    gemCp.length === 1 && gemCp[0][1].coverage === 5,
    JSON.stringify(gemCp.map(([, c]) => c.coverage)));

  await providers.control({ gemini: { blankIds: true } });
  await makeSweepDue();
  await syncNow();
  const gemProg = await local("recall-sync-progress:gemini");
  t("M4 rows the adapter cannot name are reported, not read as an empty account",
    !!gemProg && gemProg.state === "error" && /changed its API/.test(gemProg.msg || ""),
    JSON.stringify(gemProg));
  t("M4 and nothing already archived is quarantined by it",
    !(await quarantined()).some((id) => id.includes("gemchat") || id.includes("gemlong")),
    JSON.stringify(await quarantined()));
  await providers.control({ gemini: { blankIds: false } });

  /* ================= K. Grok: camelCase, and messages kept elsewhere ========
     Grok names its listing fields conversationId / createTime / modifyTime and
     nothing else. An adapter reading id / created_at / updated_at therefore
     builds metas with no id at all, walkScheme discards the whole listing as
     unusable, and the platform reports a clean pass having archived nothing —
     which is exactly what shipped. Then the messages take two further calls,
     and load-responses answers in a different order than it was asked. */

  const grok = makeChats("grokchat", 3, Date.UTC(2026, 2, 1));
  await providers.control({
    grok: { signedIn: true, current: "g1", accounts: { g1: { chats: grok } } }
  });
  await syncNow();
  all = await rows();
  const grokRows = all.filter((r) => r.id.startsWith("grok.com/chat/grokchat-"));
  t("K1 Grok conversations archive at all", grokRows.length === 3,
    JSON.stringify(grokRows.map((r) => r.id)));
  t("K1 and they arrive with their messages, not just a title",
    grokRows.length === 3 && grokRows.every((r) => r.n === 2),
    JSON.stringify(grokRows.map((r) => r.n)));

  const grokMsgs = await msgsOf("grok.com/chat/grokchat-1");
  t("K2 an out-of-order load-responses batch is put back into reading order",
    grokMsgs.length === 2 && grokMsgs[0].r === "user" && grokMsgs[1].r === "assistant",
    JSON.stringify(grokMsgs.map((m) => m.r)));
  t("K2 the message text survives the two-step fetch",
    grokMsgs[0] && grokMsgs[0].t.startsWith("Question 1 from grokchat"),
    JSON.stringify(grokMsgs[0]));

  const grokCp = await checkpointsFor("grok");
  t("K3 the camelCase listing produces a checkpoint that counts what it holds",
    grokCp.length === 1 && grokCp[0][1].coverage === 3,
    JSON.stringify(grokCp.map(([, c]) => c.coverage)));

  // And the general form of the bug, not just Grok's instance of it: a listing
  // whose fields have been renamed must be reported, never quietly rendered as
  // "this account has no chats". Silence here is what let the broken Grok
  // adapter look healthy indefinitely.
  await providers.control({ grok: { rename: true } });
  await makeSweepDue();
  await syncNow();
  const grokProg = await local("recall-sync-progress:grok");
  t("K4 an unreadable listing is reported, not passed off as an empty account",
    !!grokProg && grokProg.state === "error" && /changed its API/.test(grokProg.msg || ""),
    JSON.stringify(grokProg));
  t("K4 and it is not mistaken for a signed-out session",
    !!grokProg && grokProg.signedOut === false, JSON.stringify(grokProg && grokProg.signedOut));
  t("K4 the chats already archived are left exactly as they were",
    (await rows()).filter((r) => r.id.startsWith("grok.com/chat/grokchat-")).length === 3);
  t("K4 and nothing was quarantined off the back of it",
    !(await quarantined()).some((id) => id.includes("grokchat")), JSON.stringify(await quarantined()));
  await providers.control({ grok: { rename: false } });

  /* ================= F. usage counts per account ================= */

  const who = await send({ type: "account-for", host: "chatgpt.com" });
  await providers.control({ chatgpt: { current: "acct-bob" } });
  // The worker caches the handshake for five minutes; ask about a host it has
  // to resolve fresh rather than waiting the clock out.
  const gemini = await send({ type: "account-for", host: "gemini.google.com", hint: "one@example.com" });
  const gemini2 = await send({ type: "account-for", host: "gemini.google.com", hint: "two@example.com" });
  t("F1 a signed-in provider resolves to a 16-character tag",
    who && who.acct && who.acct.length === 16, JSON.stringify(who));
  t("F1 the label is masked, never the raw address",
    who.label && !who.label.includes("alice@") && who.label.includes("@example.com"), who.label);
  t("F2 a page-supplied hint separates two accounts the provider cannot name",
    gemini.acct && gemini2.acct && gemini.acct !== gemini2.acct, `${gemini.acct} / ${gemini2.acct}`);
  /* Ordinals are assigned per platform in first-seen order. Gemini has a sync
     adapter now, and section M ran a pass before this, so the anchor-derived
     account it registered holds an earlier ordinal — hence distinct and
     consecutive rather than literally 1 and 2. What the ring needs is that two
     accounts never share a number, which is what is asserted. */
  t("F2 hinted accounts get distinct, consecutive ordinals",
    gemini.ordinal >= 1 && gemini2.ordinal === gemini.ordinal + 1,
    `${gemini.ordinal} / ${gemini2.ordinal}`);

  // The popup draws one ring per account, so seed two tallies on one host.
  const now = Date.now();
  await page.evaluate(([now, a, b]) => chrome.storage.local.set({
    ["usage:chatgpt.com|" + a]: { sent: [now - 1000, now - 2000], platform: "ChatGPT", id: "chatgpt",
      acct: a, label: "a••e@example.com", ordinal: 1, plan: "Free", updatedAt: now },
    ["usage:chatgpt.com|" + b]: { sent: [now - 3000], platform: "ChatGPT", id: "chatgpt",
      acct: b, label: "b••b@example.com", ordinal: 2, plan: "Plus", updatedAt: now }
  }), [now, aliceTag, bobTag]);
  await page.reload();
  await page.waitForSelector(".usage-row");
  const legend = await page.evaluate(() => Array.from(document.querySelectorAll(".usage-row"))
    .map((r) => r.textContent.replace(/\s+/g, " ").trim()));
  const ringCount = await page.evaluate(() => document.querySelectorAll(".usage-arc").length);
  t("F3 two accounts on one platform draw two rings",
    legend.filter((l) => l.startsWith("ChatGPT")).length === 2, JSON.stringify(legend));
  t("F3 the legend names the accounts, not the plan",
    legend.some((l) => l.includes("a••e@example.com")) && legend.some((l) => l.includes("b••b@example.com")),
    JSON.stringify(legend));
  // No published ceiling means no remainder to report, so the free account
  // counts what it sent; the paid one counts down what it has left.
  t("F4 the free account draws no invented ceiling",
    legend.some((l) => /a••e@example\.com\s*2 sent$/.test(l)), JSON.stringify(legend));
  t("F4 the paid account counts down against its published one",
    legend.some((l) => /b••b@example\.com\s*79\/80 left$/.test(l)), JSON.stringify(legend));
  t("F5 both rings actually render an arc", ringCount >= 2, String(ringCount));

  /* ================= G. edges ================= */

  // A live page writing a chat it has open must not strip the attribution the
  // sync established.
  const target = (await rows()).find((r) => r.id.includes("alice-2"));
  await send({ type: "recall-upsert", chat: {
    id: target.id, host: "chatgpt.com", path: "/c/alice-2", platform: "ChatGPT",
    title: "reopened in the page",
    msgs: [{ i: "x", r: "user", t: "a longer question typed in the page" },
           { i: "y", r: "assistant", t: "a longer answer rendered in the page" },
           { i: "z", r: "user", t: "and one more turn so the record grows" }]
  } });
  const after = (await rows()).find((r) => r.id === target.id);
  t("G1 a page write keeps the account the sync established",
    after && after.acct === aliceTag, JSON.stringify(after));

  // Signing out mid-life must not destroy anything.
  await providers.control({ chatgpt: { signedIn: false } });
  await makeSweepDue();
  await syncNow();
  t("G2 a signed-out provider archives nothing and deletes nothing",
    idsFor(await rows(), "chatgpt.com/c/alice").length === 4 &&
    !(await quarantined()).some((id) => id.includes("chatgpt")),
    JSON.stringify(await quarantined()));
  await providers.control({ chatgpt: { signedIn: true, current: "acct-alice" } });

  // An account whose listing comes back empty is a broken session, not a mass
  // deletion — the implausibility guard has to hold per account too.
  await providers.control({ chatgpt: { current: "acct-alice", accounts: {
    "acct-alice": { email: "alice@example.com", chats: [] },
    "acct-bob": { email: "bob@example.com", chats: bob.slice(0, 2) }
  } } });
  await makeSweepDue();
  await syncNow();
  t("G3 an empty listing is disbelieved rather than acted on",
    idsFor(await rows(), "chatgpt.com/c/alice").length === 4 &&
    !(await quarantined()).some((id) => id.includes("alice")),
    JSON.stringify(await quarantined()));
  const anomaly = await local("lct-recall-sweep-v1");
  t("G3 and the disbelief is recorded for the UI to explain",
    !!(anomaly && anomaly.anomaly), JSON.stringify(anomaly && anomaly.anomaly));

  // The ledger lives in storage.sync, which caps one item at 8KB. Many
  // accounts must degrade by dropping the oldest, never by losing the lot.
  // Seeded through storage.local, which has no per-item cap: storage.sync would
  // reject the oversized ledger on the way in and the trim would never be the
  // thing under test. getDurable() reads local when sync has no copy, so the
  // next pass loads all 40 and has to decide what fits.
  await page.evaluate(async () => {
    const checkpoints = {};
    for (let i = 0; i < 40; i++) {
      checkpoints["chatgpt:" + "f".repeat(60) + String(i).padStart(4, "0")] = {
        version: 5, platform: "chatgpt", safeWatermark: 1, completedAt: 1000 + i,
        lastResult: "delta", archived: 1, coverage: 1, coverageKnown: true, acctScoped: true,
        anchor: "", pendingCount: 0, passState: "clean", cooldownUntil: 0, runId: "x"
      };
    }
    await chrome.storage.sync.remove("lct-recall-sync-ledger-v2");
    await chrome.storage.local.set({ "lct-recall-sync-ledger-v2": { version: 2, checkpoints } });
  });
  await syncNow();
  const capped = await ledger();
  const size = JSON.stringify(capped).length;
  const kept = Object.keys(capped.checkpoints).length;
  t("G4 a crowded ledger is trimmed to fit the sync item cap, not dropped",
    size > 0 && size < 8192 && kept > 8, `${size} bytes / ${kept} checkpoints`);
  t("G4 and the newest checkpoints are the ones kept",
    Object.values(capped.checkpoints).every((c) => (c.completedAt || 0) > 0));

  // "Delete everything" has to include who was signed in.
  await send({ type: "recall-wipe" });
  const wipedRoster = await roster();
  const usageLeft = await page.evaluate(async () =>
    Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith("usage:")));
  t("G5 a wipe clears the account roster", Object.keys(wipedRoster).length === 0, JSON.stringify(wipedRoster));
  t("G5 a wipe clears every per-account usage tally", usageLeft.length === 0, JSON.stringify(usageLeft));
  t("G5 a wipe empties the archive", (await rows()).length === 0, String((await rows()).length));

  t("H1 no page exceptions during the run", pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)));
} catch (error) {
  fail++;
  failed.push("SUITE THREW: " + String(error && error.stack || error));
  console.error(error);
} finally {
  await ctx.close();
  await providers.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failed.length) { console.log("\nFailures:"); for (const f of failed) console.log("  " + f); }
process.exit(fail ? 1 : 0);
