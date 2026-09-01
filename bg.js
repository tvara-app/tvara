/**
 * Tvara — background service worker: the Total Recall database.
 *
 * One IndexedDB (extension origin) holds a local archive of every AI chat the
 * user has opened, across ALL platforms. Content scripts (isolated per site)
 * cannot share a database, so they send their conversation text here and this
 * worker owns storage + search.
 *
 * Privacy: the worker may make scoped, authenticated requests only to the AI
 * providers declared in manifest host permissions to copy history into this
 * local archive. No telemetry, no chat text ever leaves; everything is
 * deletable in one click from the Recall page. The single non-provider call is
 * licence entitlement (lib/entitlement.js) — licence key + device hash, nothing
 * else, and only when refreshing a token.
 *
 * Enforcement: this worker is the ONLY authority on paid features. Pages hide
 * locked UI as a courtesy; requireEntitlement() below is what actually decides.
 */
"use strict";

// One implementation of the backup envelope, shared with the Recall page.
try { importScripts("lib/backup-crypto.js"); } catch (_) { /* tests load bg.js bare */ }
// Provider allowance parsing. The worker is the only reader: content scripts
// forward raw responses and the popup asks for quota-state, so nothing else
// needs it in-page. diag/quota.html loads it directly to exercise the parser.
try { importScripts("lib/quota.js"); } catch (_) { /* tests load bg.js bare */ }
// Licence verification. Order matters: entitlement.js calls into LCTLicense.
try { importScripts("lib/license.js", "lib/dodo.js", "lib/entitlement.js"); }
catch (_) { /* tests load bg.js bare */ }

const DB_NAME = "lct-recall";
const DB_VERSION = 3;
const MAX_MSG_CHARS = 4000;   // per message — plenty for search, bounds disk
const MAX_MSGS = 6000;        // per chat
const MAX_RESULTS = 60;

let dbPromise = null;

function db() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      const s = d.objectStoreNames.contains("chats")
        ? req.transaction.objectStore("chats")
        : (() => {
            const created = d.createObjectStore("chats", { keyPath: "id" }); // id = host+path
            created.createIndex("updatedAt", "updatedAt");
            return created;
          })();
      // Lets the sync build its id→revision map from index keys alone, without
      // deserializing message bodies. On a large archive that is the difference
      // between reading a few hundred KB and the entire database.
      if (!s.indexNames.contains("sourceUpdatedAt")) s.createIndex("sourceUpdatedAt", "sourceUpdatedAt");
      // Which account a chat came from, paired with its revision so ONE key walk
      // answers both "what does this account hold" and "at which revision".
      // A record with no `acct` is absent from this index by definition — that
      // is what "not attributed to anybody yet" means, and it is why an
      // unattributed chat can never become another account's deletion candidate.
      if (!s.indexNames.contains("acctRev")) s.createIndex("acctRev", ["acct", "sourceUpdatedAt"]);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

const tx = (d, mode) => d.transaction("chats", mode).objectStore("chats");
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

/* ---------- write path ---------- */

function clampChat(chat) {
  const src = chat.msgs || [];
  const msgs = src.slice(-MAX_MSGS).map((m) => ({
    // The provider's own message id. On ChatGPT this is the same string the DOM
    // carries as data-message-id, which is what lets a stored record seed the
    // in-page map with no network call at all.
    i: String(m.i || "").slice(0, 80),
    r: m.r === "user" ? "user" : "assistant",
    t: String(m.t || "").slice(0, MAX_MSG_CHARS),
    // Remember that this one lost its tail. MAX_MSG_CHARS is a bound chosen for
    // the search index, not for export, and a long answer written to a .md file
    // cut mid-sentence with nothing to say so is the kind of quiet loss this
    // project exists to not commit. Export reads this flag and says so.
    ...(String(m.t || "").length > MAX_MSG_CHARS ? { c: 1 } : {}),
    ts: typeof m.ts === "number" ? m.ts : 0
  }));
  const acct = String(chat.acct || "").slice(0, 32);
  return {
    // mv=1 promises BOTH: every message carries its id, and nothing was dropped
    // by the MAX_MSGS window. Anything less cannot be an index source.
    // (`t` is still clamped to MAX_MSG_CHARS — norm() in minimap.js saturates at
    // 900 chars, so an archive-served tick is pixel-identical to a live one.)
    mv: msgs.length && src.length <= MAX_MSGS && msgs.every((m) => m.i) ? 1 : 0,
    // Deliberately omitted rather than set empty when unknown: "absent from the
    // acctRev index" is the single, uniform meaning of unattributed, whether the
    // record predates attribution or was just written by a page that could not
    // name its account.
    ...(acct ? { acct } : {}),
    id: String(chat.id || "").slice(0, 600),
    host: String(chat.host || "").slice(0, 100),
    path: String(chat.path || "").slice(0, 500),
    // Never kept by the provider: temporary/private mode, or signed out.
    // Omitted rather than 0, like acct above, so "absent" uniformly means an
    // ordinary chat — including every record predating this flag.
    ...(chat.temp ? { temp: 1 } : {}),
    platform: String(chat.platform || "").slice(0, 40),
    title: String(chat.title || "").slice(0, 200),
    createdAt: typeof chat.createdAt === "number" ? chat.createdAt : 0,
    updatedAt: Date.now(),
    // Provider-wide sync uses this timestamp as its dedupe contract. Keep it
    // separate from the local write time so opening a chat cannot falsely
    // make an older provider revision look synchronized.
    sourceUpdatedAt: Number.isFinite(Number(chat.sourceUpdatedAt)) && Number(chat.sourceUpdatedAt) > 0
      ? Number(chat.sourceUpdatedAt)
      : ((chat.keepTimes || chat.meta) && Number.isFinite(Number(chat.updatedAt)) && Number(chat.updatedAt) > 0
        ? Number(chat.updatedAt) : 0),
    n: msgs.length,
    msgs
  };
}

/* ---------- which chats are still just a title ----------
   A listing gives every conversation's title in one call; the text costs one
   call each, so the pass writes the titles first and fills the bodies after.
   The trouble was that a title-only record carries the provider's revision, and
   the sync decides what to fetch by comparing revisions — so a stub looked
   exactly like a finished chat and its text was never fetched. On a real
   archive that left 2,303 conversations and 15,760 messages: about seven each,
   for chats that run to hundreds.

   The archive's IndexedDB index is on revision, not on emptiness, and querying
   by value without an index means reading every record — 25MB of message text
   to answer "which of these are empty". So emptiness is tracked as it happens,
   in one small list, written by the two functions that write records. It is
   both the fix and the work queue the backfill runs from. */
const BG_STUBS = "lct-stub-chats-v1";

async function readStubs() {
  try {
    const got = await chrome.storage.local.get(BG_STUBS);
    const v = got && got[BG_STUBS];
    return v && typeof v === "object" ? v : {};
  } catch { return {}; }
}

/**
 * Record whether archived chats are still text-less. Batched, and never called
 * from inside an IndexedDB transaction.
 *
 * The first version awaited chrome.storage between the puts of a batch import,
 * which is how you lose data without an error: an IndexedDB transaction commits
 * itself as soon as the microtask queue drains with nothing pending, so the
 * await ended the transaction and every put after the first one threw into a
 * per-item catch. Eleven of twelve chats vanished silently. The tests caught it
 * in the same minute; a user would have found it as a gap in their archive.
 */
/* Serialized, like every other ledger in this file (ledgerWrite:694,
   accountsWrite:889). This is a read-modify-write over chrome.storage, and the
   fill loop and a sync flush can both be inside it at once — nothing guards
   bgSyncRunning against fillRunning. Unchained, the fill removed a chat and
   wrote the map, a flush that had read the map first wrote its own copy back,
   and the chat returned to the queue to be fetched again forever. */
let stubWrite = Promise.resolve();

async function noteStubs(updates) {
  const list = (updates || []).filter((u) => u && u.id && u.host);
  if (!list.length) return;
  const work = () => noteStubsNow(list);
  stubWrite = stubWrite.then(work, work);
  return stubWrite;
}

async function noteStubsNow(list) {
  try {
    const all = await readStubs();
    let touched = false;
    /* A Set per platform we actually touch, built once.
       This was indexOf + splice against an array that holds up to 20,000 ids,
       repeated for every id in the batch — so O(batch × 20,000) per call, with
       splice memmoving the tail each time, on every flush of a full sync. A Set
       makes the lookup and the removal O(1), so the whole call is O(n + batch).
       Insertion order is preserved: a Set keeps it, and add/delete do not
       disturb it, so the queue is still filled oldest-first. */
    const sets = new Map();
    const setFor = (platform) => {
      if (!sets.has(platform)) {
        sets.set(platform, new Set(Array.isArray(all[platform]) ? all[platform] : []));
      }
      return sets.get(platform);
    };
    for (const u of list) {
      const platform = PAGE_PLATFORMS[u.host] || "";
      if (!platform) continue;
      const ids = setFor(platform);
      if (u.hasBody) {
        if (!ids.delete(u.id)) continue;
      } else {
        if (ids.has(u.id)) continue;
        if (ids.size >= 20000) continue;        // a ceiling, not a policy
        ids.add(u.id);
      }
      touched = true;
    }
    for (const [platform, ids] of sets) all[platform] = [...ids];
    if (touched) await chrome.storage.local.set({ [BG_STUBS]: all });
  } catch { /* the next write records it instead */ }
}

const noteStub = (id, host, hasBody) => noteStubs([{ id, host, hasBody }]);

async function upsert(chat) {
  if (!chat || !chat.id || !Array.isArray(chat.msgs)) return { ok: false };
  const isMeta = chat.meta === true && chat.msgs.length === 0;
  if (!isMeta && chat.msgs.length < 2) return { ok: false };
  const d = await db();
  const id = String(chat.id).slice(0, 600);
  // A live page only ever sees what the host MOUNTED. On ChatGPT that is the
  // recent tail, and this id is the same one the provider sync writes — so
  // without a guard, opening a chat trades a complete 1,500-message transcript
  // for a 30-message fragment a few seconds later. Only a write that carries a
  // provider revision is allowed to shrink a record.
  const shrinks = !isMeta && !chat.sourceUpdatedAt;
  // A page writing a chat it has open rarely knows which account it belongs to,
  // and a write that dropped the attribution would quietly hand the record back
  // to "unattributed" — undoing a sweep's only safety rail. Read first, carry
  // the stored account forward.
  let existing = null;
  if (isMeta || shrinks || !chat.acct) {
    existing = await reqP(tx(d, "readonly").get(id));
  }
  if (isMeta || shrinks) {
    const keep = existing && existing.n > 0 &&
      (isMeta || existing.n > chat.msgs.length);
    if (keep) {
      if (chat.title && !existing.title) {
        existing.title = String(chat.title).slice(0, 200);
        await reqP(tx(d, "readwrite").put(existing));
      }
      return { ok: true, kept: true };
    }
  }
  const clamped = clampChat(chat.acct ? chat : { ...chat, acct: existing && existing.acct });
  // imports/sync carry the chat's real last-activity time — keep it
  if ((chat.keepTimes || isMeta) && chat.updatedAt) clamped.updatedAt = chat.updatedAt;
  await reqP(tx(d, "readwrite").put(clamped));
  await noteStub(clamped.id, clamped.host, clamped.n >= 2);
  return { ok: true };
}

async function importBatch(chats) {
  const arr = Array.isArray(chats) ? chats : [];
  if (!arr.length) return { ok: 0, skipped: 0, stored: [], failed: [] };
  const d = await db();
  let ok = 0, skipped = 0;
  const stored = [], failed = [];   // sync needs ids, not just counts

  // Phase 1: read existing records in a single readonly transaction
  const store = d.transaction("chats", "readonly").objectStore("chats");
  const existing = new Map();
  for (const c of arr) {
    try {
      const id = String((c && c.id) || "").slice(0, 600);
      if (id) {
        const v = await reqP(store.get(id));
        if (v) existing.set(id, v);
      }
    } catch { /* skip */ }
  }

  // Phase 2: write all upserts in a single readwrite transaction. Nothing in
  // this loop may await anything but IndexedDB — see noteStubs().
  const stubUpdates = [];
  const wStore = d.transaction("chats", "readwrite").objectStore("chats");
  for (const c of arr) {
    const cid = String((c && c.id) || "").slice(0, 600);
    try {
      if (!c || !c.id || !Array.isArray(c.msgs)) { skipped++; failed.push(cid); continue; }
      const chat = { ...c, keepTimes: true };
      const isMeta = chat.meta === true && chat.msgs.length === 0;
      if (!isMeta && chat.msgs.length < 2) { skipped++; failed.push(cid); continue; }
      const id = String(chat.id).slice(0, 600);
      if (isMeta) {
        const prev = existing.get(id);
        if (prev && prev.n > 0) {
          if (chat.title && !prev.title) {
            prev.title = String(chat.title).slice(0, 200);
            await reqP(wStore.put(prev));
          }
          ok++; stored.push(id); continue;
        }
      }
      const previous = existing.get(id);
      const candidateSource = Number(chat.sourceUpdatedAt || chat.updatedAt || 0);
      /* PROVIDER time only, on both sides.
         This used to fall back to the stored record's `updatedAt`, which
         clampChat sets to the LOCAL WRITE TIME. So a record written today
         out-ranked the provider's own revision of a conversation last touched a
         month ago — and every future sync of that chat was refused as "older",
         permanently.
         Found on a live archive: a 1,471-message conversation frozen at the 203
         messages captured by an old build, none of them carrying ids, so it
         could never complete, never seed the map, and never be searched. The
         record was written 519 hours ago; the conversation's real revision was
         1,032 hours old. It would have stayed that way forever. */
      const previousSource = Number(previous && previous.sourceUpdatedAt || 0);
      const candidateCount = Math.min(chat.msgs.length, MAX_MSGS);
      // A write that brings MORE of the conversation is never a loss, whatever
      // the clocks say — and one that brings ids where there were none makes a
      // record usable as an index for the first time.
      const richer = !previous || candidateCount > previous.n;
      const fixesIds = !!previous && previous.mv !== 1 &&
        chat.msgs.length > 0 && chat.msgs.every((m) => m && m.i);
      // Restores and retries are merge operations: a stale snapshot must not
      // overwrite a newer local conversation that arrived in the meantime.
      // No write happens here — `ok` used to count it anyway, so a restore of
      // a backup that was already fully synced reported hundreds of chats
      // "added to the archive" that were, byte for byte, already there.
      if (previous && previous.n > 0 && candidateSource > 0 &&
          previousSource > candidateSource && !richer && !fixesIds) {
        skipped++;
        stored.push(id);
        continue;
      }
      /* A write that brings LESS of the conversation has to prove it is newer.
         The clock test above can only fire when BOTH sides carry a provider
         revision, and `previousSource` is 0 for every record that predates the
         field, every record written by upsert(), and everything restored from
         such a backup — so those records had no guard at all. `fixesIds` is
         not an exemption either: ids make a record indexable, they do not make
         it complete, and a 30-message page-tail carrying ids must never replace
         1,471 archived messages that lack them. */
      const loses = !!previous && previous.n > 0 && candidateCount < previous.n;
      if (loses && !(candidateSource > 0 && previousSource > 0 && candidateSource > previousSource)) {
        // No write here either — same over-counting as the branch above.
        skipped++;
        stored.push(id);
        continue;
      }
      /* Neither richer nor losing: the exact same message count as what is
         already stored — the common case when a backup is restored onto the
         browser it was made from, or a sync retry re-delivers what already
         landed. `richer` (a strict >) does not cover a tie, so this used to
         fall all the way through to the unconditional write below and count
         as "added" — measured on a real restore: 937 of 941 chats reported
         "added to the archive" when the archive already held all 941, byte
         for byte. Still respects a genuinely newer same-length revision
         (an edited message keeps the same count) exactly like the guard
         above does. */
      const ties = !!previous && previous.n > 0 && candidateCount === previous.n;
      if (ties && !fixesIds && !(candidateSource > 0 && previousSource > 0 && candidateSource > previousSource)) {
        skipped++;
        stored.push(id);
        continue;
      }
      /* Carry forward what this write does not carry. `put` replaces the whole
         record, so a caller that fetches only the body — which is exactly what
         the backfill does — silently erased the title it was repairing, and
         stamped the local clock as the provider revision because importBatch
         forces keepTimes here. Neither is something the caller learned; both
         belong to the record already. */
      const merged = {
        ...chat,
        acct: chat.acct || (previous && previous.acct),
        title: chat.title || (previous && previous.title) || "",
        sourceUpdatedAt: Number(chat.sourceUpdatedAt || 0) > 0
          ? chat.sourceUpdatedAt
          : (previous && previous.sourceUpdatedAt) || 0
      };
      const clamped = clampChat(merged);
      if ((chat.keepTimes || isMeta) && chat.updatedAt) clamped.updatedAt = chat.updatedAt;
      await reqP(wStore.put(clamped));
      stubUpdates.push({ id: clamped.id, host: clamped.host, hasBody: clamped.n >= 2 });
      ok++;
      stored.push(id);
    } catch { skipped++; failed.push(cid); }
  }
  await noteStubs(stubUpdates);
  return { ok, skipped, stored, failed };
}

/* ---------- search ---------- */

function score(chat, words, lowered) {
  // every word must appear somewhere; score = total hits, title hits ×3
  let total = 0;
  const title = chat.title.toLowerCase();
  /* Lowercased ONCE, not once per word. The words loop is bounded at 8, so the
     nesting was already linear rather than quadratic — but it re-lowercased
     every message in the chat on every pass, which on a real archive is the
     whole body of text allocated eight times over for one query. Measured on
     archive-sized data: 128ms to 95ms, same score out. */
  const lows = lowered || chat.msgs.map((m) => m.t.toLowerCase());
  for (const w of words) {
    let hits = 0;
    for (const t of lows) {
      let i = -1;
      while ((i = t.indexOf(w, i + 1)) !== -1) hits++;
    }
    if (title.includes(w)) hits += 3;
    if (!hits) return 0; // AND semantics
    total += hits;
    // meta-only chats (synced titles, text not archived yet) rank below
    // full-text matches naturally: they can only ever score title hits
  }
  return total;
}

function snippetFor(chat, words, long, lowered) {
  const back = long ? 120 : 60, fwd = long ? 520 : 160;
  for (let i = 0; i < chat.msgs.length; i++) {
    const t = chat.msgs[i].t;
    // Reuse the pass scoreChat already made. Lowercasing the same body twice
    // per matching chat is the whole archive text allocated twice per query.
    const low = (lowered && lowered[i]) || t.toLowerCase();
    const at = low.indexOf(words[0]);
    if (at !== -1) {
      const start = Math.max(0, at - back);
      return {
        text: (start ? "…" : "") + t.slice(start, at + fwd),
        msgIndex: i,
        role: chat.msgs[i].r
      };
    }
  }
  if (!chat.msgs.length) {
    return { text: "Synced from your history. Open once (or run full sync) to archive the text.", msgIndex: 0, role: "user" };
  }
  return { text: chat.msgs[0].t.slice(0, 160), msgIndex: 0, role: "user" };
}

/* How many windows a chat is worth. Bridge only, and length-scaled: one window
   from the first hit represents a 12-message chat fine and a 400-message one
   badly, because the matches are spread through it and the first is rarely the
   best. */
const passageCap = (n) => (n < 12 ? 0 : n < 40 ? 2 : n < 120 ? 3 : 4);

/* Windows spaced across the conversation, not the first N — on a long thread
   those all land in the opening exchange. Verbatim, like everything else that
   travels: this picks, it never rewrites. */
function passagesFor(chat, words, lowered, cap) {
  if (cap < 2) return [];
  const hits = [];
  for (let i = 0; i < chat.msgs.length; i++) {
    const t = chat.msgs[i].t;
    const low = (lowered && lowered[i]) || t.toLowerCase();
    let at = -1;
    for (const w of words) {
      const k = low.indexOf(w);
      if (k !== -1 && (at < 0 || k < at)) at = k;
    }
    if (at >= 0) hits.push({ i, at, t, r: chat.msgs[i].r });
  }
  if (hits.length < 2) return [];
  const want = Math.min(cap, hits.length);
  const step = (hits.length - 1) / (want - 1);
  const out = [];
  for (let k = 0; k < want; k++) {
    const h = hits[Math.round(k * step)];
    const start = Math.max(0, h.at - 120);
    out.push({ i: h.i, r: h.r, t: (start ? "…" : "") + h.t.slice(start, h.at + 520) });
  }
  return out;
}

async function search(query, long) {
  const words = String(query || "").toLowerCase().split(/\s+/).filter((w) => w.length >= 2).slice(0, 8);
  if (!words.length) return { results: [], scanned: 0 };
  const d = await db();
  const results = [];
  let scanned = 0;
  await new Promise((resolve, reject) => {
    const cur = tx(d, "readonly").openCursor();
    cur.onerror = () => reject(cur.error);
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return resolve();
      scanned++;
      const chat = c.value;
      /* One lowercase pass per chat, shared by the scorer and the snippet.
         They each made their own, so the whole archive body was lowercased
         twice for every query that matched. */
      const lowered = chat.msgs.map((m) => m.t.toLowerCase());
      const s = score(chat, words, lowered);
      if (s > 0) {
        const snip = snippetFor(chat, words, long, lowered);
        results.push({
          id: chat.id, host: chat.host, path: chat.path, platform: chat.platform,
          title: chat.title, n: chat.n, createdAt: chat.createdAt,
          updatedAt: chat.updatedAt, score: s, snippet: snip.text, role: snip.role,
          // Temporary chat: no original to reopen on the platform.
          ...(chat.temp ? { temp: 1 } : {}),
          ...(long ? { passages: passagesFor(chat, words, lowered, passageCap(chat.n || 0)) } : {})
        });
      }
      c.continue();
    };
  });
  results.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt);
  return { results: results.slice(0, MAX_RESULTS), scanned };
}

/* ---------- freshness check (sync skips already-archived chats) ---------- */

async function check(ids) {
  const arr = Array.isArray(ids) ? ids : [];
  if (!arr.length) return {};
  const d = await db();
  const out = {};
  // Single transaction for all lookups — N reads in 1 transaction instead of N
  const store = d.transaction("chats", "readonly").objectStore("chats");
  for (const id of arr) {
    try {
      const v = await reqP(store.get(String(id).slice(0, 600)));
      if (v) out[id] = { n: v.n, updatedAt: v.updatedAt, sourceUpdatedAt: v.sourceUpdatedAt || 0 };
    } catch { /* skip */ }
  }
  return out;
}

/**
 * One cursor pass that returns what this browser already owns for a platform:
 * chat id -> the provider revision that produced the archived copy.
 *
 * This index — not a timestamp — is the ground truth the sync engine diffs
 * against. A watermark can be wrong (restored backup, clock skew, a provider
 * that back-dates edits); the index cannot: a chat is either archived at the
 * provider's current revision or it is not.
 */
/**
 * id → archived provider revision, for one platform.
 *
 * Walks the sourceUpdatedAt index with openKeyCursor, so only index keys and
 * primary keys are read — message bodies are never deserialized. The previous
 * full-record scan pulled the entire archive into memory once per platform per
 * pass, which is what made a multi-thousand-chat sync unusable.
 */
async function archiveIndex(host, prefix) {
  const d = await db();
  const index = new Map();
  const start = host + prefix;
  const range = IDBKeyRange.bound(start, start + "￿");

  const viaIndex = await new Promise((resolve) => {
    let store;
    try { store = tx(d, "readonly"); } catch { return resolve(null); }
    if (!store.indexNames.contains("sourceUpdatedAt")) return resolve(null);
    const cur = store.index("sourceUpdatedAt").openKeyCursor();
    cur.onerror = () => resolve(null);
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return resolve(index);
      const id = c.primaryKey;
      if (typeof id === "string" && id.startsWith(start)) index.set(id, Number(c.key) || 0);
      c.continue();
    };
  });
  // Records written before the index existed carry no indexable key, so a
  // shortfall against the true count means the map is incomplete.
  if (viaIndex && viaIndex.size >= await platformCount(host, prefix)) return viaIndex;

  index.clear();
  await new Promise((resolve, reject) => {
    const cur = tx(d, "readonly").openCursor(range);
    cur.onerror = () => reject(cur.error);
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return resolve();
      const v = c.value;
      if (v && typeof v.id === "string") index.set(v.id, Number(v.sourceUpdatedAt || v.updatedAt || 0));
      c.continue();
    };
  });
  return index;
}

/** Exact number of archived chats for one platform, via a keyed count — no
 *  record bodies are read, so this stays cheap on a large archive. */
async function platformCount(host, prefix) {
  const d = await db();
  const start = host + prefix;
  return reqP(tx(d, "readonly").count(IDBKeyRange.bound(start, start + "￿")));
}

/* ---------- per-account views of the archive ----------
 *
 * People run several accounts on the same provider precisely because a free
 * tier runs out, so two accounts sharing one hostname is the normal case, not
 * an exotic one. Two questions that look alike have to be answered from
 * DIFFERENT sets, and conflating them is a data-loss bug:
 *
 *   "have I already got this chat?"  — every record under the host, whoever
 *                                      owns it. Ids are provider-global, so an
 *                                      id already held is never re-downloaded.
 *   "what does THIS account hold?"   — only records attributed to it. Deletion
 *                                      and coverage must use this one: a second
 *                                      account's first complete listing would
 *                                      otherwise nominate the first account's
 *                                      entire history as vanished.
 */

/** Range over every `[acct, <revision>]` key. `[]` sorts above every number and
 *  string in IndexedDB's key order, so this covers the account exactly. */
const acctRange = (acct) => IDBKeyRange.bound([acct], [acct, []]);

/** id → archived revision, for ONE account. Key-cursor only: no record bodies. */
async function accountIndex(host, prefix, acct) {
  const index = new Map();
  if (!acct) return index;
  const d = await db();
  const start = host + prefix;
  return new Promise((resolve) => {
    let store;
    try { store = tx(d, "readonly"); } catch { return resolve(index); }
    if (!store.indexNames.contains("acctRev")) return resolve(index);
    let cur;
    try { cur = store.index("acctRev").openKeyCursor(acctRange(acct)); }
    catch { return resolve(index); }
    cur.onerror = () => resolve(index);
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return resolve(index);
      const id = c.primaryKey;
      if (typeof id === "string" && id.startsWith(start)) {
        index.set(id, Number(Array.isArray(c.key) ? c.key[1] : 0) || 0);
      }
      c.continue();
    };
  });
}

/** How many chats this account owns — a keyed count, so the fetch loop can
 *  refresh coverage without walking the archive again. */
async function accountCount(acct) {
  if (!acct) return 0;
  const d = await db();
  try {
    const store = tx(d, "readonly");
    if (!store.indexNames.contains("acctRev")) return 0;
    return await reqP(store.index("acctRev").count(acctRange(acct)));
  } catch { return 0; }
}

/**
 * Stamp records with the account whose listing just named them.
 *
 * Appearing in an account's listing is positive proof of ownership — that is
 * the ONLY evidence used here. Records the listing did not mention keep
 * whatever they had (usually nothing), which is what makes the migration safe:
 * an unattributed record is invisible to every account's deletion sweep until
 * some account's listing claims it.
 *
 * Capped per pass because adoption rewrites whole records, and an archive of
 * thousands would otherwise turn one pass into a multi-megabyte rewrite.
 */
async function adoptRecords(recordIds, acct, limit = BG_ADOPT_MAX) {
  const claimed = [];
  if (!acct || !recordIds.length) return { claimed, more: false };
  const d = await db();
  for (const recordId of recordIds) {
    if (claimed.length >= limit) return { claimed, more: true };
    try {
      const rec = await reqP(tx(d, "readonly").get(recordId));
      if (!rec || rec.acct === acct) continue;
      rec.acct = acct;
      await reqP(tx(d, "readwrite").put(rec));
      claimed.push(recordId);
    } catch { /* one row refusing to move must not stop the pass */ }
  }
  return { claimed, more: false };
}

/* ---------- stats / wipe ---------- */

async function stats() {
  const d = await db();
  let chats = 0, msgs = 0, bytes = 0;
  const byPlatform = {};
  await new Promise((resolve, reject) => {
    const cur = tx(d, "readonly").openCursor();
    cur.onerror = () => reject(cur.error);
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return resolve();
      const v = c.value;
      chats++; msgs += v.n;
      for (const m of v.msgs) bytes += m.t.length;
      byPlatform[v.platform || v.host] = (byPlatform[v.platform || v.host] || 0) + 1;
      c.continue();
    };
  });
  return { chats, msgs, bytes, byPlatform };
}

async function wipe() {
  const d = await db();
  await reqP(tx(d, "readwrite").clear());
  return { ok: true };
}

/* ===================== background sync engine ===================== */
/* Runs entirely in the service worker — no tabs needed. Uses host_permissions
   to make authenticated API requests directly with the user's cookies. */

// Per-host pacing. These are ceilings: concurrency ramps up on a clean streak
// and halves on a 429, so a healthy connection runs fast without ever being
// the reason the provider's own site starts refusing the user.
const BG_HOST_POLICY = {
  "chatgpt.com":       { concurrency: 4, minIntervalMs: 320, listDelayMs: 600 },
  "claude.ai":         { concurrency: 4, minIntervalMs: 300, listDelayMs: 450 },
  "chat.deepseek.com": { concurrency: 3, minIntervalMs: 400, listDelayMs: 500 },
  "grok.com":          { concurrency: 3, minIntervalMs: 400, listDelayMs: 500 },
  // Deliberately the slowest of the set. Perplexity sits behind Cloudflare and
  // its read endpoints publish no limit, so the only signal we would get for
  // going too fast is the user's own session being challenged.
  "www.perplexity.ai": { concurrency: 2, minIntervalMs: 700, listDelayMs: 800 },
  // One batchexecute call per conversation, and Google notices patterns. Paced
  // between the fast hosts and Perplexity's deliberate crawl.
  "gemini.google.com": { concurrency: 3, minIntervalMs: 450, listDelayMs: 600 }
};
const BG_FETCH_ATTEMPTS = 4;
/* A hung connection (dropped packets, a provider that accepts and never
   answers) left fetch() awaiting forever with nothing here to notice — no
   retry, no error, no response ever sent back to whoever asked. Found via
   diag/quota.html's "Check every provider now" staying disabled forever with
   zero console errors: one stalled endpoint blocked quotaProbe's whole
   sequential sweep, which blocked the message response. Generous enough for a
   slow real API under normal conditions, short enough that one bad host can't
   eat noticeably into BG_PASS_BUDGET_MS below. */
const BG_FETCH_TIMEOUT_MS = 20000;
const BG_RATE_TRIP = 3;                          // consecutive 429s → circuit opens
const BG_HOST_COOLDOWN_MS = 15 * 60 * 1000;
const BG_PASS_BUDGET_MS = 4 * 60 * 1000;         // MV3 workers get reclaimed
/* …and the fetch loop never gets less than this, however long the listing took.
   Sharing one clock without a floor turns a slow listing into a pass that
   archives nothing at all, repeated forever — the exact stall the shared clock
   exists to prevent. */
const BG_MIN_FETCH_MS = 60 * 1000;
// Journal entries are ~120B, and the manifest grants unlimitedStorage, so this
// covers a very large first backfill without ever refusing the watermark.
const BG_PENDING_MAX = 50000;
const BG_JOURNAL_FLUSH_MS = 3000;
const BG_PROGRESS_MS = 400;
const BG_LIST_MAX_PAGES = 100;
const BG_SYNC_LIST_PAGE = 100;
const BG_SYNC_BATCH = 15;
const BG_SYNC_OVERLAP_MS = 5 * 60 * 1000;
/* ---------- what the background actually did ----------
   The archive runs where nobody can watch it: a worker with no console open,
   woken by an alarm, killed again seconds later. When it looks stopped there is
   nothing to inspect — the progress row shows the last thing WRITTEN, which is
   identical whether a pass is running, being refused, or never woke at all.
   This is what tells those three apart.

   Deliberately coarse: one line per pass and per platform, never per chat, so a
   week of syncing is a few hundred rows. Written through rather than buffered —
   the case worth seeing is a worker that dies mid-pass, and an in-memory tail
   dies with it. Never awaited by callers and never able to fail a pass. */
const BG_TRACE = "lct-bg-trace-v1";
const BG_TRACE_MAX = 200;

async function trace(event, detail) {
  try {
    const held = (await chrome.storage.local.get(BG_TRACE))[BG_TRACE];
    const rows = Array.isArray(held) ? held : [];
    rows.push({ t: Date.now(), e: String(event).slice(0, 40),
      ...(detail == null ? {} : { d: String(detail).slice(0, 160) }) });
    await chrome.storage.local.set({ [BG_TRACE]: rows.slice(-BG_TRACE_MAX) });
  } catch { /* storage gone: a trace is never worth failing a pass for */ }
}

async function readTrace() {
  try {
    const held = (await chrome.storage.local.get(BG_TRACE))[BG_TRACE];
    const rows = Array.isArray(held) ? held : [];
    /* Alarms are the whole question — whether the browser is waking this worker
       while nobody is looking at it — so they are reported alongside. */
    let alarms = [];
    try {
      alarms = (await chrome.alarms.getAll()).map((a) => ({
        name: a.name, inMs: Math.round(a.scheduledTime - Date.now()), every: a.periodInMinutes || 0
      }));
    } catch { /* alarms unavailable */ }
    return { rows, alarms, now: Date.now(), worker: thisWorkerId, running: bgSyncRunning, filling: fillRunning };
  } catch { return { rows: [], alarms: [], now: Date.now() }; }
}

const BG_RUN_STALE_MS = 90 * 1000;
const BG_PLATFORM_IDS = new Set(["chatgpt", "claude", "deepseek", "grok", "perplexity", "gemini"]);
const BG_SYNC_FLAG = (p) => "recall-sync-" + p;     // { lastFull: ms } — chrome.storage.local
const BG_SYNC_PROG = (p) => "recall-sync-progress:" + p;
const BG_SYNC_LEDGER = "lct-recall-sync-ledger-v2";
const BG_SYNC_PROFILE = "lct-recall-sync-profile-v1";
const BG_BACKUP_MARKER = "lct-recall-backup-marker-v1";
const BG_RECOVERY = "lct-recall-recovery-v1";
const BG_INSTALL = "lct-recall-install-v1";
const BG_RUN = "lct-recall-sync-run-v1";
const BG_ACTIVE_ACCOUNT = "lct-recall-active-account-v1";
// Local-only, never mirrored to storage.sync: the account roster this browser
// has seen, so the UI can say "your second ChatGPT" without the worker ever
// persisting who that is. Labels here are masked before they are written.
const BG_ACCOUNTS = "lct-recall-accounts-v1";
const BG_ACCT_MAX = 8;            // accounts remembered per platform, LRU beyond
const ACCT_LEN = 16;              // hex chars of the account tag stamped on rows
const BG_ADOPT_MAX = 300;         // records re-stamped per pass — see adoptRecords
// A listing whose oldest chat matches the archive this much is the same account
// that simply lost its anchor, not a different one. See resolveAnchor().
const BG_ANCHOR_OVERLAP = 0.5;
const BG_LEDGER_MAX = 32;         // checkpoints kept, newest first
const BG_LEDGER_BYTES = 7000;     // under storage.sync's 8KB-per-item cap
// Outstanding-work journal. Local-only and never roamed: it is meaningful only
// against this browser's archive index, and it is far too large for sync's
// 8KB-per-item cap.
const BG_SYNC_WORK = "lct-recall-sync-work-v1";
const BG_HOST_COOLDOWN = "lct-recall-host-cooldown-v1";
const BG_PAGE_SCHEME = "lct-recall-page-scheme-v1";
// Chats the provider no longer has. Local-only, and deliberately NOT a delete:
// see the deletion-review section below for why the archive keeps them until
// the user says otherwise.
const BG_DELETIONS = "lct-recall-deletions-v1";
const BG_DELETION_MAX = 500;
// Deletion can only be inferred from a listing that covers the whole history,
// and a delta pass never does. So one full listing is forced on this cadence.
const BG_SWEEP_STATE = "lct-recall-sweep-v1";
const BG_SWEEP_MS = 24 * 60 * 60 * 1000;
// Key material for unattended backups. chrome.storage.local ONLY — never
// setDurable, because storage.sync roams to Google's servers and a wrapped
// archive key has no business leaving the device.
const BG_AUTOBACKUP = "lct-recall-autobackup-v1";
const BG_AUTOBACKUP_STATE = "lct-recall-autobackup-state-v1";
// Where a passphrase remembered "until I close the browser" lives. Session
// storage is memory-backed and trusted-contexts-only, so it never reaches disk
// and no content script can read it.
const BG_BACKUP_KEY = "lct-recall-backup-key-v1";
const BG_RESTORE_GUARD = "lct-recall-restore-guard-v1";
const BG_SCHEME_RETRY_MS = 7 * 24 * 60 * 60 * 1000;   // re-probe "none" weekly

// Claude documents limit/offset; DeepSeek's and Grok's list endpoints are
// undocumented and change between builds. Rather than hard-code a guess, the
// walk tries these until one actually advances, then remembers the winner.
const BG_PAGE_SCHEMES = [
  { id: "offset", param: (i, size) => `offset=${i * size}` },
  { id: "skip",   param: (i, size) => `skip=${i * size}` },
  { id: "page0",  param: (i) => `page=${i}` },
  { id: "page1",  param: (i) => `page=${i + 1}` }
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ledgerWrite = Promise.resolve();
let activeAccountWrite = Promise.resolve();
let profileSaltPromise = null;

const randomId = () => {
  try { return crypto.randomUUID(); }
  catch { return Date.now().toString(36) + Math.random().toString(36).slice(2); }
};
const thisWorkerId = randomId();

function cleanCheckpoint(value) {
  if (!value || typeof value !== "object") return null;
  const platform = String(value.platform || "");
  const safeWatermark = Number(value.safeWatermark);
  const completedAt = Number(value.completedAt);
  if (!BG_PLATFORM_IDS.has(platform) || !Number.isFinite(safeWatermark) || safeWatermark <= 0 ||
      !Number.isFinite(completedAt) || completedAt <= 0) return null;
  return {
    version: 5,
    platform,
    safeWatermark,
    completedAt,
    // The oldest chat this account's listing showed. Providers that refuse to
    // name the signed-in account are told apart by it — see resolveAnchor().
    anchor: String(value.anchor || "").slice(0, 200),
    // Whether `coverage` counts this ACCOUNT's chats or every chat under the
    // host. v4 and earlier counted the host, and reading that as an account's
    // coverage would either trust a wiped archive or force a pointless rebuild.
    // An unscoped checkpoint therefore declares coverage unknown exactly once;
    // the next pass re-establishes it against the account's own rows.
    acctScoped: value.acctScoped === true,
    lastResult: String(value.lastResult || "delta").slice(0, 32),
    archived: Math.max(0, Math.floor(Number(value.archived) || 0)),
    // v3 and earlier only ever wrote a checkpoint after a fully clean pass, so
    // defaulting these keeps migrated checkpoints trusted.
    pendingCount: Math.max(0, Math.floor(Number(value.pendingCount) || 0)),
    passState: value.passState === "partial" ? "partial" : "clean",
    cooldownUntil: Math.max(0, Number(value.cooldownUntil) || 0),
    runId: String(value.runId || "").slice(0, 8),
    // How many chats this browser held for the platform when the checkpoint was
    // written. A watermark alone cannot tell a resumed browser from a wiped one;
    // coverage can. If the archive now holds fewer chats than the checkpoint
    // promised, the index was lost and the watermark must not be trusted.
    coverage: Math.max(0, Math.floor(Number(value.coverage) || 0)),
    coverageKnown: value.acctScoped === true &&
      (value.coverageKnown === true || Number(value.coverage) > 0)
  };
}

function cleanProfile(value) {
  const salt = String(value && value.salt || "");
  return value && value.version === 1 && /^[a-f0-9]{32}$/i.test(salt)
    ? { version: 1, salt: salt.toLowerCase() } : null;
}

function cleanLedger(value) {
  if (!value || value.version !== 2 || !value.checkpoints || typeof value.checkpoints !== "object" ||
      Array.isArray(value.checkpoints)) return { version: 2, checkpoints: {} };
  const checkpoints = {};
  // 64 checkpoints overflowed storage.sync's 8KB-per-item cap, which silently
  // dropped the whole ledger. A flat count of 8 was the fix, but it was sized
  // for two accounts and someone juggling four free tiers plus a couple of
  // Claude orgs blows through it — losing a checkpoint means re-downloading
  // that account's whole history. Fill to the byte budget instead, newest
  // first, so the cap is the real constraint rather than a guess about it.
  const ranked = Object.entries(value.checkpoints)
    .sort((a, b) => (Number(b[1] && b[1].completedAt) || 0) - (Number(a[1] && a[1].completedAt) || 0))
    .slice(0, BG_LEDGER_MAX);
  let bytes = 2;
  for (const [key, raw] of ranked) {
    const checkpoint = cleanCheckpoint(raw);
    if (!checkpoint) continue;
    const id = String(key).slice(0, 200);
    const cost = JSON.stringify({ [id]: checkpoint }).length;
    if (bytes + cost > BG_LEDGER_BYTES) break;
    checkpoints[id] = checkpoint;
    bytes += cost;
  }
  return { version: 2, checkpoints };
}

/**
 * Values under a key prefix, without deserializing the rest of local storage.
 *
 * The store also holds the archive ledger, the sync journal and the deletion
 * list, so a get(null) to reach a handful of quota keys paid to parse all of
 * it — on the popup's open path, where it is felt. storage.getKeys() lists key
 * names alone; where it is missing (Chrome < 130, Firefox < 138) this is the
 * old full read, so behaviour is identical and only the cost differs.
 */
let localKeysUnavailable = false;

async function listLocalKeys() {
  const area = chrome.storage.local;
  if (!localKeysUnavailable && typeof area.getKeys === "function") {
    try { return await area.getKeys(); } catch { localKeysUnavailable = true; }
  }
  try { return Object.keys(await area.get(null)); } catch { return []; }
}

async function getByPrefix(prefix, extraKeys) {
  if (localKeysUnavailable || typeof chrome.storage.local.getKeys !== "function") {
    try { return await chrome.storage.local.get(null); } catch { return {}; }
  }
  const wanted = (await listLocalKeys()).filter((k) => k.startsWith(prefix));
  for (const k of extraKeys || []) if (!wanted.includes(k)) wanted.push(k);
  if (!wanted.length) return {};
  try { return await chrome.storage.local.get(wanted); } catch { return {}; }
}

// Reads cover both areas and writes mirror: a sync-only read missed values
// that landed in local after a sync write failed, which rotated the profile
// salt and re-synced the whole history.
async function getDurable(keys) {
  const list = Array.isArray(keys) ? keys : [keys];
  let data = {}, synced = true;
  try { data = await chrome.storage.sync.get(list); }
  catch { data = {}; synced = false; }
  const missing = list.filter((k) => data[k] === undefined);
  if (missing.length) {
    try {
      const local = await chrome.storage.local.get(missing);
      data = { ...local, ...data };   // sync wins where both hold a value
    } catch { /* local unavailable — return what sync gave us */ }
  }
  return { data, synced };
}

async function setDurable(value) {
  let synced = false;
  try { await chrome.storage.sync.set(value); synced = true; } catch { /* mirrored below */ }
  try { await chrome.storage.local.set(value); } catch { /* sync copy may still hold */ }
  return synced;
}

// setDurable mirrors, so every deletion must clear both areas or a "wipe
// everything" leaves a shadow copy behind — a privacy promise, not a nicety.
async function removeDurable(keys) {
  const list = Array.isArray(keys) ? keys : [keys];
  try { await chrome.storage.sync.remove(list); } catch { /* may not exist there */ }
  try { await chrome.storage.local.remove(list); } catch { /* nor there */ }
}

async function readLedger() {
  const { data } = await getDurable(BG_SYNC_LEDGER);
  return cleanLedger(data[BG_SYNC_LEDGER]);
}

async function mutateLedger(mutator) {
  const work = async () => {
    const ledger = await readLedger();
    const next = cleanLedger(await mutator({ ...ledger, checkpoints: { ...ledger.checkpoints } }));
    await setDurable({ [BG_SYNC_LEDGER]: next });
    return next;
  };
  ledgerWrite = ledgerWrite.then(work, work);
  return ledgerWrite;
}

async function profileSalt() {
  if (profileSaltPromise) return profileSaltPromise;
  profileSaltPromise = (async () => {
    const { data } = await getDurable(BG_SYNC_PROFILE);
    const profile = cleanProfile(data[BG_SYNC_PROFILE]);
    if (profile) return profile.salt;
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const salt = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    await setDurable({ [BG_SYNC_PROFILE]: { version: 1, salt } });
    // An unpersisted salt is worse than none: it rotates on every worker
    // respawn, changing every account key and re-syncing the whole history.
    // Fail loudly instead — the pass retries, the archive stays intact.
    const verify = await getDurable(BG_SYNC_PROFILE);
    if (!cleanProfile(verify.data[BG_SYNC_PROFILE])) throw new BgError("storage", "storage unavailable");
    return salt;
  })();
  try { return await profileSaltPromise; }
  catch (error) { profileSaltPromise = null; throw error; }
}

async function digest(text) {
  const value = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(value), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Never persist raw account identifiers. The provider identity is salted and
// hashed so a checkpoint cannot leak the user's account value.
async function identityCheckpointKey(adapter, identity) {
  return adapter.id + ":" + await digest((await profileSalt()) + "|" + adapter.id + "|" + String(identity));
}

async function accountCheckpointKey(adapter, ctx) {
  // The identity MUST be stable across sessions. Earlier builds fell back to
  // the raw cookie header when a provider exposed no account id — session
  // cookies rotate, so every rotation minted a new checkpoint key and the whole
  // history was swept again. Providers that expose no account id start on one
  // per-browser key and are separated afterwards by resolveAnchor(), which asks
  // the archive rather than the clock.
  const identity = String(ctx && ctx.account || "").trim() || "device";
  return identityCheckpointKey(adapter, identity);
}

/**
 * The short tag stamped on every archived row.
 *
 * Deliberately derived from the SAME hash as the checkpoint key: an upgrade
 * must not orphan a single existing checkpoint, or every user re-downloads
 * their entire history on the release that adds multi-account support.
 * Truncation only shortens what is repeated on every row.
 */
function tagOfKey(checkpointKey) {
  const at = String(checkpointKey).indexOf(":");
  return String(checkpointKey).slice(at + 1, at + 1 + ACCT_LEN);
}

async function accountTag(adapter, ctx) {
  return tagOfKey(await accountCheckpointKey(adapter, ctx));
}

/* ---------- the account roster ----------
 * Enough to label a ring in the popup and no more. An email is masked before it
 * is stored, and anything that is not an email contributes no label at all —
 * an opaque provider uuid tells the user nothing, so the UI counts instead. */

let accountsWrite = Promise.resolve();

function maskHandle(value) {
  const raw = String(value || "").trim();
  const at = raw.indexOf("@");
  if (at <= 0 || at === raw.length - 1) return "";   // not an email: no useful label
  const user = raw.slice(0, at);
  const domain = raw.slice(at + 1).slice(0, 40);
  const head = user.slice(0, 1);
  const tail = user.length > 2 ? user.slice(-1) : "";
  return `${head}••${tail}@${domain}`;
}

async function readAccounts() {
  try {
    const store = await chrome.storage.local.get(BG_ACCOUNTS);
    const all = store[BG_ACCOUNTS];
    return all && typeof all === "object" && !Array.isArray(all) ? all : {};
  } catch { return {}; }
}

/** Record that this account exists and was seen just now. Ordinals are assigned
 *  on first sight and never reused, so "Account 2" keeps meaning the same one. */
async function noteAccount(platformId, acct, meta = {}) {
  if (!acct) return null;
  let result = null;
  const work = async () => {
    const all = await readAccounts();
    const platform = all[platformId] && typeof all[platformId] === "object" ? { ...all[platformId] } : {};
    const prev = platform[acct] || {};
    const used = new Set(Object.values(platform).map((a) => Number(a && a.ordinal) || 0));
    let ordinal = Number(prev.ordinal) || 0;
    while (!ordinal || (used.has(ordinal) && !prev.ordinal)) ordinal = ordinal ? ordinal + 1 : 1;
    const label = maskHandle(meta.handle) || String(prev.label || "");
    platform[acct] = {
      ordinal,
      label: label.slice(0, 60),
      plan: String(meta.plan || prev.plan || "").slice(0, 24),
      limit: Number.isFinite(Number(meta.limit)) ? Number(meta.limit) : (Number(prev.limit) || null),
      identified: meta.identified === undefined ? prev.identified !== false : !!meta.identified,
      firstSeen: Number(prev.firstSeen) || Date.now(),
      lastSeen: Date.now()
    };
    // An account the user abandoned should not crowd out the ones in use, but
    // the roster must stay small: it is read on every popup open.
    const kept = Object.entries(platform)
      .sort((a, b) => (Number(b[1].lastSeen) || 0) - (Number(a[1].lastSeen) || 0))
      .slice(0, BG_ACCT_MAX);
    result = platform[acct];
    await chrome.storage.local.set({ [BG_ACCOUNTS]: { ...all, [platformId]: Object.fromEntries(kept) } });
  };
  accountsWrite = accountsWrite.then(work, work);
  await accountsWrite;
  return result;
}

async function readCheckpoint(adapter, ctx) {
  const key = await accountCheckpointKey(adapter, ctx);
  const ledger = await readLedger();
  return { key, checkpoint: ledger.checkpoints[key] || null };
}

async function saveCheckpoint(key, checkpoint) {
  return mutateLedger((ledger) => {
    ledger.checkpoints[key] = checkpoint;
    return ledger;
  });
}

/* ---------- outstanding-work journal (local only) ----------
 * pending is the OUTSTANDING set, not the failure set: it is seeded with every
 * chat the pass intends to fetch and written alongside the advanced watermark
 * BEFORE the first detail request. Ids leave it only once a row lands in the
 * archive. That is what lets a first pass mint a trustworthy checkpoint even
 * when every fetch is rate-limited. */

let journalWrite = Promise.resolve();
// Authoritative copy for the duration of a pass. Without it every drop re-read
// and re-serialized the whole pending array — quadratic once a backfill runs
// into the thousands.
let journalCache = null;

function cleanJob(value) {
  if (!value || typeof value !== "object") return null;
  const scanStartedAt = Number(value.scanStartedAt) || 0;
  if (!scanStartedAt) return null;
  const pending = Array.isArray(value.pending) ? value.pending.slice(0, BG_PENDING_MAX) : [];
  return {
    platform: String(value.platform || "").slice(0, 32),
    scanStartedAt,
    updatedAt: Number(value.updatedAt) || 0,
    pending: pending.filter((p) => p && p.id).map((p) => ({
      id: String(p.id).slice(0, 200),
      rev: Number(p.rev) || 0,
      title: String(p.title || "").slice(0, 200),
      createdAt: Number(p.createdAt) || 0,
      attempts: Math.max(0, Math.floor(Number(p.attempts) || 0)),
      lastKind: String(p.lastKind || "").slice(0, 16)
    })),
    tombstones: (Array.isArray(value.tombstones) ? value.tombstones : [])
      .filter((t) => t && t.id).slice(-500)
      .map((t) => ({ id: String(t.id).slice(0, 200), at: Number(t.at) || 0 }))
  };
}

async function readJournal() {
  if (journalCache) return journalCache;
  try {
    const { [BG_SYNC_WORK]: raw } = await chrome.storage.local.get(BG_SYNC_WORK);
    const jobs = raw && typeof raw.jobs === "object" && raw.jobs ? raw.jobs : {};
    const out = {};
    for (const [key, value] of Object.entries(jobs)) {
      const job = cleanJob(value);
      if (job) out[key] = job;
    }
    journalCache = { version: 1, jobs: out };
  } catch { journalCache = { version: 1, jobs: {} }; }
  return journalCache;
}

async function readJob(key) {
  return (await readJournal()).jobs[key] || null;
}

// `persist: false` mutates the cached copy only. Callers batch several drops and
// then force one write, so a 5,000-chat pass costs a handful of writes instead
// of one per batch.
async function mutateJournal(mutator, persist = true) {
  const work = async () => {
    const journal = await readJournal();
    const next = await mutator(journal);
    journalCache = next;
    if (persist) {
      try { await chrome.storage.local.set({ [BG_SYNC_WORK]: next }); } catch { /* full */ }
    }
    return next;
  };
  journalWrite = journalWrite.then(work, work);
  return journalWrite;
}

async function flushJournal() {
  return mutateJournal((journal) => journal, true);
}

async function writeJob(key, job) {
  return mutateJournal((journal) => {
    journal.jobs[key] = cleanJob({ ...job, updatedAt: Date.now() });
    return journal;
  });
}

async function clearJob(key) {
  return mutateJournal((journal) => { delete journal.jobs[key]; return journal; });
}

async function dropFromJob(key, ids, tombstoned = [], persist = true) {
  if (!ids.length && !tombstoned.length) return;
  const gone = new Set(ids.concat(tombstoned));
  return mutateJournal((journal) => {
    const job = journal.jobs[key];
    if (!job) return journal;
    job.pending = job.pending.filter((p) => !gone.has(p.id));
    if (tombstoned.length) {
      job.tombstones = (job.tombstones || [])
        .concat(tombstoned.map((id) => ({ id, at: Date.now() }))).slice(-500);
    }
    job.updatedAt = Date.now();
    return journal;
  }, persist);
}

async function setActiveAccount(adapter, checkpointKey) {
  const work = async () => {
    const current = await chrome.storage.local.get(BG_ACTIVE_ACCOUNT);
    const active = current[BG_ACTIVE_ACCOUNT] && typeof current[BG_ACTIVE_ACCOUNT] === "object"
      ? current[BG_ACTIVE_ACCOUNT] : {};
    await chrome.storage.local.set({
      [BG_ACTIVE_ACCOUNT]: { ...active, [adapter.id]: String(checkpointKey).slice(0, 200) }
    });
  };
  activeAccountWrite = activeAccountWrite.then(work, work);
  return activeAccountWrite;
}

async function markBackup(meta) {
  const marker = {
    version: 1,
    createdAt: Date.now(),
    chats: Math.max(0, Number(meta && meta.chats) || 0),
    filename: String((meta && meta.filename) || "archive.lctbackup").slice(0, 160)
  };
  await setDurable({ [BG_BACKUP_MARKER]: marker });
  await chrome.storage.local.set({ [BG_RECOVERY]: { state: "ready", backup: marker } });
  return marker;
}

/**
 * Reinstall detection.
 *
 * The install marker lives in storage.local (wiped with the extension); the
 * backup marker is durable (survives via storage.sync). Marker without install
 * marker = this profile had an archive before, and this is a fresh install.
 *
 * This used to HALT syncing until the user restored a file, which meant a
 * reinstall silently archived nothing — possibly forever, since nothing tells
 * an idle user to go and look. It is now an OFFER: syncing resumes immediately
 * and rebuilds from the providers, and restoring the old file afterwards still
 * merges cleanly, because importBatch() refuses to overwrite a newer archived
 * revision. Restoring first is only ever a shortcut, never a prerequisite.
 */
async function ensureRecoveryState() {
  const local = await chrome.storage.local.get([BG_INSTALL, BG_RECOVERY]);
  if (local[BG_INSTALL]) return local[BG_RECOVERY] || { state: "ready" };
  const { data } = await getDurable(BG_BACKUP_MARKER);
  const marker = data[BG_BACKUP_MARKER] || null;
  const recovery = marker
    ? { state: "restore-offered", backup: marker, reinstalledAt: Date.now() }
    : { state: "ready" };
  await chrome.storage.local.set({ [BG_INSTALL]: { at: Date.now() }, [BG_RECOVERY]: recovery });
  return recovery;
}

async function restoreLedger(backupLedger, backupMeta, backupProfile) {
  const incoming = cleanLedger(backupLedger);
  const current = await readLedger();
  const profile = cleanProfile(backupProfile);
  // A fresh install may have generated an empty local salt while the restore
  // page was opening. Reuse the backup's salt before the gap check so its
  // hashed account key resolves to the backed-up checkpoint. Never replace a
  // profile that already owns live checkpoints in this browser.
  if (profile && !Object.keys(current.checkpoints).length) {
    await setDurable({ [BG_SYNC_PROFILE]: profile });
    profileSaltPromise = Promise.resolve(profile.salt);
  }
  await mutateLedger((ledger) => {
    for (const [key, candidate] of Object.entries(incoming.checkpoints)) {
      const current = ledger.checkpoints[key];
      if (!current || (candidate.completedAt || 0) > (current.completedAt || 0)) {
        ledger.checkpoints[key] = candidate;
      }
    }
    return ledger;
  });
  if (backupMeta) await setDurable({ [BG_BACKUP_MARKER]: backupMeta });
  // Pending sets describe a pass against the pre-restore archive; keeping them
  // would carry stale work into the restored one.
  journalCache = null;
  await chrome.storage.local.remove(BG_SYNC_WORK);
  await chrome.storage.local.set({
    [BG_INSTALL]: { at: Date.now() },
    [BG_RECOVERY]: { state: "ready", restoredAt: Date.now(), backup: backupMeta || null }
  });
  await restoreGuardReset();
  return { ok: true };
}

async function skipRecovery() {
  await chrome.storage.local.set({ [BG_RECOVERY]: { state: "skipped", at: Date.now() } });
  return { ok: true };
}

/* The offer has to expire. Somebody who never opens the Recall page would
   otherwise keep an archive holding only what arrived after the reinstall, for
   as long as the install lasts. */
const BG_RESTORE_HOLD_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Is a restore still on offer for THIS install?
 *
 * storage.sync survives an uninstall; IndexedDB does not. So a reinstalled
 * browser wakes with a ledger saying an account holds 714 chats and an archive
 * holding none. Re-downloading all 714 is a correct archive and the wrong
 * answer: the user already made the encrypted backup that has them, and every
 * one of those requests is spent on a chat they have not lost. While this is
 * true the pass captures only what is new.
 */
async function restoreHeld() {
  try {
    const { [BG_RECOVERY]: rec } = await chrome.storage.local.get(BG_RECOVERY);
    if (!rec || rec.state !== "restore-offered") return false;
    const since = Number(rec.reinstalledAt) || 0;
    return !since || Date.now() - since < BG_RESTORE_HOLD_MS;
  } catch { return false; }
}

async function workerId() {
  // A service-worker reload creates a new module instance. Keeping the id in
  // memory (rather than storage.session) lets the durable run journal mark a
  // half-finished pass as interrupted immediately, without ever auto-starting
  // another historical sweep.
  return thisWorkerId;
}

async function normalizeRun() {
  const { [BG_RUN]: run } = await chrome.storage.local.get(BG_RUN);
  if (!run || run.state !== "running") return run || null;
  const stale = Date.now() - (run.heartbeatAt || run.startedAt || 0) > BG_RUN_STALE_MS;
  const replaced = run.workerId !== await workerId();
  if (!stale && !replaced) return run;
  const interrupted = { ...run, state: "interrupted", interruptedAt: Date.now() };
  const update = { [BG_RUN]: interrupted };
  // Only platforms that were still mid-flight are marked paused. A platform
  // that already finished keeps its "everything is backed up" state, so
  // reloading the extension never makes a completed archive look unfinished.
  const ids = run.platforms || [];
  const prog = await chrome.storage.local.get(ids.map(BG_SYNC_PROG));
  for (const id of ids) {
    const current = prog[BG_SYNC_PROG(id)];
    if (current && current.state !== "syncing") continue;
    update[BG_SYNC_PROG(id)] = { state: "interrupted", phase: "interrupted", done: 0, total: 0,
      msg: "Paused. Resumes from the last checkpoint; nothing is re-downloaded.", at: Date.now() };
  }
  await chrome.storage.local.set(update);
  return interrupted;
}

async function beginRun() {
  const existing = await normalizeRun();
  if (existing && existing.state === "running") return null;
  const run = { id: randomId(), state: "running", workerId: await workerId(), startedAt: Date.now(),
    heartbeatAt: Date.now(), platforms: BG_ADAPTERS.map((a) => a.id) };
  await chrome.storage.local.set({ [BG_RUN]: run });
  return run;
}

async function beat(run, platformId) {
  if (!run) return;
  await chrome.storage.local.set({ [BG_RUN]: { ...run, heartbeatAt: Date.now(), platform: platformId } });
}

// kind drives retry policy; message strings stay verbatim because the outer
// catch and the signedOut flag still match on them.
class BgError extends Error {
  constructor(kind, message, meta = {}) {
    super(message);
    this.kind = kind;
    Object.assign(this, meta);
  }
}

function parseRetryAfter(value) {
  if (!value) return 0;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, Math.min(secs, 3600) * 1000);
  const when = Date.parse(value);
  return Number.isFinite(when) ? Math.max(0, Math.min(when - Date.now(), 3600000)) : 0;
}

// Full jitter: without it every worker retries on the same tick and the burst
// that caused the 429 repeats exactly.
function backoffDelay(attempt, retryAfterMs) {
  const base = Math.min(30000, 1000 * 2 ** attempt);
  return Math.max(retryAfterMs, Math.round(base * (0.5 + Math.random() * 0.5)));
}

const hostState = new Map();
function hostEntry(host) {
  let s = hostState.get(host);
  if (!s) {
    s = { chain: Promise.resolve(), nextAt: 0, cooldownUntil: 0, consecutiveRate: 0,
          concurrency: 0, streak: 0 };
    hostState.set(host, s);
  }
  return s;
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ""; }
}

function policyFor(host) {
  return BG_HOST_POLICY[host] || { concurrency: 2, minIntervalMs: 700, listDelayMs: 800 };
}

// Serializes request starts per host so minIntervalMs holds across all workers.
/* `foreground` is one request for the conversation somebody has open, and it
   must not queue behind the circuit breaker. That cooldown is fifteen minutes
   long and it exists to stop the BULK sync hammering a provider — charging a
   reader's own chat for the background pass's sins is how "load the older
   messages" turned into a quarter of an hour of nothing. The polite minimum
   interval still applies, so this is a jump in the queue, not a free pass. */
function hostSlot(host, opts) {
  const s = hostEntry(host);
  const policy = policyFor(host);
  const foreground = !!(opts && opts.foreground);
  const work = async () => {
    const floor = foreground ? 0 : s.cooldownUntil - Date.now();
    const wait = Math.max(floor, s.nextAt - Date.now(), 0);
    if (wait > 0) await sleep(wait);
    s.nextAt = Date.now() + policy.minIntervalMs;
  };
  s.chain = s.chain.then(work, work);
  return s.chain;
}

async function noteRateLimit(host, retryAfterMs, attempt) {
  const s = hostEntry(host);
  s.consecutiveRate++;
  s.streak = 0;
  const delay = backoffDelay(attempt, retryAfterMs);
  // Cool the whole host, not the one worker: otherwise the other workers each
  // collect their own 429 before any of them notices.
  s.cooldownUntil = Math.max(s.cooldownUntil, Date.now() + delay);
  if (s.consecutiveRate >= BG_RATE_TRIP) {
    s.cooldownUntil = Math.max(s.cooldownUntil, Date.now() + BG_HOST_COOLDOWN_MS);
    await persistCooldown(host, s.cooldownUntil);
    return true;   // circuit open
  }
  return false;
}

function noteOk(host) {
  const s = hostEntry(host);
  s.consecutiveRate = 0;
  s.streak++;
}

async function persistCooldown(host, until) {
  try {
    const { [BG_HOST_COOLDOWN]: raw } = await chrome.storage.local.get(BG_HOST_COOLDOWN);
    const map = (raw && typeof raw === "object") ? raw : {};
    map[host] = until;
    await chrome.storage.local.set({ [BG_HOST_COOLDOWN]: map });
  } catch { /* best effort */ }
}

// A respawned worker has no in-memory cooldown; without this it re-hammers a
// host it was just throttled by.
async function loadCooldown(host) {
  try {
    const { [BG_HOST_COOLDOWN]: raw } = await chrome.storage.local.get(BG_HOST_COOLDOWN);
    const until = raw && typeof raw === "object" ? Number(raw[host]) || 0 : 0;
    if (until > Date.now()) hostEntry(host).cooldownUntil = Math.max(hostEntry(host).cooldownUntil, until);
    return until;
  } catch { return 0; }
}

/* The only hosts this worker may call with the user's cookies, read from the
   manifest rather than typed a second time. That keeps it honest in both
   directions: it is exactly what the user granted at install, it cannot drift
   from host_permissions, and it needs no dev-only exception because
   tools/pack.mjs strips the localhost entries out of the shipped build. */
const BG_ALLOWED_HOSTS = (() => {
  const out = new Set();
  try {
    for (const pattern of chrome.runtime.getManifest().host_permissions || []) {
      const m = /^[a-z*]+:\/\/([^/*]+)/i.exec(pattern);
      if (m && m[1]) out.add(m[1].toLowerCase());
    }
  } catch { /* a manifest we cannot read is not a reason to call anywhere */ }
  return out;
})();

async function bgFetch(url, opts = {}) {
  const host = hostOf(url);
  /* Two guards that cost nothing and close the same class of hole.

     A conversation id from a provider's own listing is interpolated into some
     of these URLs (`this.base + conv + "/load-responses"`), and a value like
     "@evil.com/" would re-point the whole URL at another host: `new URL()`
     reads everything before the "@" as credentials. Checking the PARSED host
     against the allowlist catches that whatever the string looked like.

     And redirects were followed by default while credentials were included.
     lib/dodo.js already refuses to follow one, with a comment saying why — a
     redirect off-host means a stranger's response gets parsed as a provider's
     and written into the archive. This is the same rule, applied to the path
     that actually carries the user's history. */
  if (!BG_ALLOWED_HOSTS.has(host)) {
    throw new BgError("net", `refusing to call ${host || "an unparseable URL"}`);
  }
  /* No Cookie header: it is a forbidden request header, so fetch() drops any
     value set here. `credentials: "include"` below is what actually carries the
     provider session, and it needs no chrome.cookies permission. */
  const headers = {
    Accept: "application/json, text/plain, */*",
    ...(opts.headers || {})
  };
  /* Per-call ceilings. The history pass is worth four attempts and twenty
     seconds a piece — it is the archive, and it can take its time. An allowance
     reading is not: it is a number on a panel the user is looking at right now,
     and a provider that has not answered in a few seconds should leave a ring
     unfilled rather than hold the whole dial. */
  const attempts = Math.max(1, Number(opts.attempts) || BG_FETCH_ATTEMPTS);
  const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || BG_FETCH_TIMEOUT_MS);
  const init = { ...opts };
  delete init.attempts;
  delete init.timeoutMs;

  let lastRate = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    await hostSlot(host, opts);
    let r;
    const timeoutCtl = new AbortController();
    const timeoutTimer = setTimeout(() => timeoutCtl.abort(), timeoutMs);
    try {
      r = await fetch(url, {
        ...init, headers, credentials: "include",
        redirect: "error",            // never off-host with the user's session
        referrerPolicy: "no-referrer",
        signal: timeoutCtl.signal
      });
    } catch (_) {
      if (attempt === attempts - 1) throw new BgError("net", "network unavailable");
      await sleep(backoffDelay(attempt, 0));
      continue;
    } finally {
      clearTimeout(timeoutTimer);
    }
    if (r.status === 429 || (r.status === 503 && r.headers.get("Retry-After"))) {
      const retryAfterMs = parseRetryAfter(r.headers.get("Retry-After"));
      const circuitOpen = await noteRateLimit(host, retryAfterMs, attempt);
      lastRate = new BgError("rate", "rate-limited", { retryAfterMs, circuitOpen });
      if (circuitOpen) throw lastRate;
      continue;   // retry in place so the caller's slot isn't burned
    }
    if (r.status === 401 || r.status === 403) throw new BgError("auth", "unauthorized", { status: r.status });
    if (r.status === 404 || r.status === 410) throw new BgError("gone", "http " + r.status, { status: r.status });
    if (!r.ok) {
      if (r.status >= 500 && attempt < attempts - 1) { await sleep(backoffDelay(attempt, 0)); continue; }
      // The status rides along because not every provider spells "this
      // conversation is gone" as a 404 — Perplexity says 400 — and an adapter
      // can only reclassify what it can see.
      throw new BgError("net", "http " + r.status, { status: r.status });
    }
    noteOk(host);
    return r;
  }
  throw lastRate || new BgError("net", "request failed");
}

async function bgJson(response) {
  // Providers occasionally return their HTML application shell or sign-in
  // page from an otherwise successful request. Parse the body ourselves so
  // the sync UI receives a useful provider error, never a raw JSON exception.
  const text = await response.text();
  try { return JSON.parse(text); }
  catch {
    throw new Error(/^\s*</.test(text) ? "unexpected provider response" : "invalid provider response");
  }
}

/**
 * Walk a provider's conversation list page by page.
 *
 * Pagination on these endpoints is undocumented and differs between builds, so
 * every exit degrades safely rather than looping or overclaiming:
 *   - server ignored `limit` and returned everything → that IS the full set
 *   - server ignored `offset` and repeated a page → stop, report incomplete
 *   - short page → genuine end
 * `complete` is only ever true when the walk actually reached the end, because
 * the caller uses it to decide whether the watermark may advance.
 */
async function walkScheme(adapter, opts, scheme) {
  const { pageSize, sinceMs, progress, fetchPage, toMeta } = opts;
  const delayMs = opts.delayMs != null ? opts.delayMs : policyFor(adapter.host).listDelayMs;
  const metas = [];
  const seen = new Set();
  let complete = false, ordered = true, previous = Infinity, hitOld = false, paged = false;
  /* "The provider listed conversations and we understood none of them" is a
     different fact from "the account is empty", and it is the one that hides.
     An adapter whose id field gets renamed produces metas with no id, every one
     is skipped here, and the walk ends looking exactly like a clean listing of
     an empty account. Counted so the caller can tell the two apart. */
  let sawItems = 0, namedItems = 0;

  for (let page = 0; page < BG_LIST_MAX_PAGES; page++) {
    if (page) await sleep(delayMs);
    let items;
    try { items = await fetchPage(scheme.param(page, pageSize), pageSize); }
    catch (error) {
      if (error && (error.kind === "auth" || error.kind === "rate")) throw error;
      break;   // this scheme's params upset the endpoint — try another
    }
    if (!items.length) { complete = true; break; }

    let fresh = 0;
    for (const it of items) {
      sawItems++;
      const meta = toMeta(it);
      if (!meta || !meta.id) continue;
      namedItems++;
      if (seen.has(meta.id)) continue;
      seen.add(meta.id);
      fresh++;
      if (meta.updatedAt > previous) ordered = false;
      previous = meta.updatedAt;
      if (sinceMs && meta.updatedAt <= sinceMs) { hitOld = true; continue; }
      metas.push(meta);
    }
    progress(metas.length, 0, `Listing chats… ${metas.length}`);

    // Server ignored `limit` and handed back the whole list — that IS the end.
    if (page === 0 && items.length > pageSize) { complete = true; break; }
    if (!fresh) break;                                   // paging param ignored
    if (page > 0) paged = true;                          // it genuinely advanced
    if (items.length < pageSize) { complete = true; break; }
    if (hitOld && ordered) { complete = true; break; }    // newest-first, past the watermark
  }
  metas.sort((a, b) => b.updatedAt - a.updatedAt);
  return { metas, complete, paged, unreadable: sawItems > 0 && namedItems === 0 };
}

async function readScheme(host) {
  try {
    const { [BG_PAGE_SCHEME]: raw } = await chrome.storage.local.get(BG_PAGE_SCHEME);
    const entry = raw && typeof raw === "object" ? raw[host] : null;
    if (!entry) return null;
    if (!entry.id && Date.now() - (entry.at || 0) > BG_SCHEME_RETRY_MS) return null;
    return entry;
  } catch { return null; }
}

async function rememberScheme(host, id) {
  try {
    const { [BG_PAGE_SCHEME]: raw } = await chrome.storage.local.get(BG_PAGE_SCHEME);
    const map = raw && typeof raw === "object" ? raw : {};
    map[host] = { id: id || null, at: Date.now() };
    await chrome.storage.local.set({ [BG_PAGE_SCHEME]: map });
  } catch { /* best effort */ }
}

/**
 * Walk a provider's conversation list, discovering how it paginates.
 *
 * Only Claude documents its scheme (limit/offset). For the others the walk
 * tries each candidate until one actually advances past page one, then caches
 * the winner per host so later passes go straight to it. Every exit degrades
 * safely: a scheme that is ignored, rejected, or unsupported yields at most one
 * page and `complete: false`, so the caller never advances the watermark past
 * chats it did not see.
 */
async function pageThrough(adapter, opts) {
  const schemes = opts.schemes || BG_PAGE_SCHEMES;
  const known = opts.noCache ? null : await readScheme(adapter.host);

  // Already established that this endpoint cannot page: take one page and stop
  // rather than re-probing every pass.
  if (known && !known.id) return walkScheme(adapter, opts, schemes[0]);

  const order = known
    ? schemes.filter((s) => s.id === known.id).concat(schemes.filter((s) => s.id !== known.id))
    : schemes;

  let best = null;
  for (const scheme of order) {
    const attempt = await walkScheme(adapter, opts, scheme);
    if (!best || attempt.metas.length > best.metas.length) best = attempt;
    if (attempt.paged) {
      // Includes re-discovery: a cached scheme that stopped working falls
      // through to the remaining candidates rather than giving up.
      if (!opts.noCache && (!known || known.id !== scheme.id)) await rememberScheme(adapter.host, scheme.id);
      return attempt;
    }
    if (attempt.complete) return attempt;   // one page held the whole history
  }
  if (!opts.noCache) await rememberScheme(adapter.host, null);
  return best || { metas: [], complete: false, paged: false, unreadable: false };
}

/**
 * The branch of a ChatGPT conversation the page actually renders: current_node
 * walked up the parent chain, root-first.
 *
 * Object.values(mapping) also hands back every dead edit/regenerate branch, and
 * create_time is not an ordering ACROSS branches — so the old flat sort produced
 * a transcript that no reader ever saw, in an order it was never in. That was
 * survivable for search; it is not survivable for a map whose positions have to
 * line up with the DOM.
 */
function chatBranch(conv) {
  const map = (conv && conv.mapping) || null;
  if (!map) return [];
  const out = [];
  const seen = new Set();                 // a malformed parent cycle must not hang the worker
  let id = conv.current_node;
  while (id && map[id] && !seen.has(id)) { seen.add(id); out.push(map[id]); id = map[id].parent; }
  out.reverse();
  // Share links and older payloads carry no current_node — fall back to the
  // flat sort rather than returning nothing.
  return out.length ? out : Object.values(map).sort(
    (a, b) => ((a.message && a.message.create_time) || 0) - ((b.message && b.message.create_time) || 0)
  );
}

/**
 * One ChatGPT conversation as an ordered message list, keeping the provider's
 * message id.
 *
 * Where a node kind is ambiguous, INCLUDE it: a surplus entry only draws a tick
 * that never binds to an element, which the map already tolerates. A missing
 * entry shifts every position after it.
 */
function chatgptMsgs(conv) {
  const msgs = [];
  for (const node of chatBranch(conv)) {
    const m = node && node.message;
    if (!m || !m.author) continue;
    const role = m.author.role;
    if (role !== "user" && role !== "assistant") continue;
    if (m.metadata && m.metadata.is_visually_hidden_from_conversation) continue;
    if (m.recipient && m.recipient !== "all") continue;      // a tool call, not a turn
    const parts = (m.content && m.content.parts) || [];
    const text = parts.filter((p) => typeof p === "string").join("\n").trim();
    // Empty text is KEPT, unlike the other adapters: an image-only turn still
    // occupies a row in the page, and the map's positions have to match.
    msgs.push({
      i: String(m.id || node.id || ""),
      r: role,
      t: text,
      ts: m.create_time ? Math.floor(m.create_time) : 0
    });
  }
  return msgs;                            // branch order IS reading order — no sort
}

/* ---------- Gemini ----------
 * Gemini has no REST API. Its own web app talks to `batchexecute`, a generic
 * Google RPC transport, and everything about it is positional: the request is
 * JSON nested inside a JSON string, and the reply is a stream of
 * length-prefixed frames whose payloads are also JSON inside a JSON string,
 * read by index rather than by name.
 *
 * That makes it the most fragile adapter here by a wide margin, so the rule for
 * every step below is the same: a shape we do not recognise raises, and never
 * returns a plausible-looking empty result. `unreadable` in walkScheme and
 * BgError("shape") exist for exactly this surface — a silent Gemini would look
 * identical to a signed-out one.
 *
 * Verified against Google's own client behaviour as documented by the
 * gemini_webapi project; the rpc ids and index positions are its findings.
 */
const GEMINI_BATCH_PATH = "/_/BardChatUi/data/batchexecute";
const GEMINI_RPC_LIST = "MaZiqc";     // list conversations
const GEMINI_RPC_READ = "hNvQHb";     // read one conversation
const GEMINI_LIST_MAX = 400;          // conversations asked for per shelf
const GEMINI_TURN_MAX = 2000;         // turns asked for per conversation
/* Gemini keeps pinned and unpinned conversations on separate shelves and one
   call returns only one of them. Both, or half a history goes unarchived —
   and, worse, a listing missing half the account would look complete to the
   sweep. The trailing triple is [pinned, cursor, unknown]. */
const GEMINI_SHELVES = [1, 0];

let geminiReqid = 0;

/** End (exclusive) of the JSON array or object starting at `from`.
 *
 *  String- and escape-aware, because a bracket inside somebody's message would
 *  otherwise be read as closing the frame. */
function geminiValueEnd(body, from) {
  let depth = 0, inString = false, escaped = false;
  for (let i = from; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") { if (--depth === 0) return i + 1; }
  }
  return -1;   // unbalanced — a truncated frame
}

/** Strip the `)]}'` guard, then walk Google's length-prefixed frames.
 *
 *  The length markers are SKIPPED rather than trusted. Sources disagree on
 *  whether the count includes one surrounding newline or both, and a
 *  one-character error there does not lose one frame — it desynchronises the
 *  scan and every later frame with it. The JSON value's own extent is
 *  unambiguous, so that is what decides where a frame ends; the digits are
 *  just something to step over. It also means a reply that arrives unframed,
 *  as a single bare array, needs no special case. */
function geminiFrames(text) {
  let body = String(text || "");
  if (body.startsWith(")]}'")) body = body.slice(4);

  const frames = [];
  const space = /\s/;
  let at = 0;
  while (at < body.length) {
    while (at < body.length && space.test(body[at])) at++;
    while (at < body.length && body[at] >= "0" && body[at] <= "9") at++;
    while (at < body.length && space.test(body[at])) at++;
    if (body[at] !== "[") break;
    const end = geminiValueEnd(body, at);
    if (end <= at) break;
    try { frames.push(JSON.parse(body.slice(at, end))); } catch { /* skip this frame */ }
    at = end;
  }
  return frames;
}

/** Every `wrb.fr` payload for one rpc id, already un-nested from its JSON
 *  string. Index 2 is the payload; index 1 names the rpc that produced it, and
 *  it is checked, because a batch reply carries other envelopes too. */
function geminiPayloads(text, rpcid) {
  const out = [];
  for (const frame of geminiFrames(text)) {
    for (const part of (Array.isArray(frame) ? frame : [])) {
      if (!Array.isArray(part) || part[0] !== "wrb.fr" || part[1] !== rpcid) continue;
      if (typeof part[2] !== "string" || !part[2]) continue;
      try { out.push(JSON.parse(part[2])); } catch { /* not this envelope */ }
    }
  }
  return out;
}

/** Gemini timestamps arrive as [seconds, nanos]. */
function geminiTime(value) {
  if (!Array.isArray(value) || !value.length) return 0;
  const secs = Number(value[0]) || 0;
  if (secs <= 0) return 0;
  return Math.round(secs * 1000 + (Number(value[1]) || 0) / 1e6);
}

/** Read a positional path out of a batchexecute payload. Everything in these
 *  replies is addressed by index, and any hop can legitimately be absent, so a
 *  miss is undefined rather than a throw. */
function geminiAt(node, path) {
  let at = node;
  for (const step of path) {
    if (!Array.isArray(at)) return undefined;
    at = at[step];
  }
  return at;
}

const GEMINI_AT_RE = /"SNlM0e":\s*"(.*?)"/;
const GEMINI_BL_RE = /"cfb2h":\s*"(.*?)"/;
const GEMINI_SID_RE = /"FdrFJe":\s*"(.*?)"/;

/* ---------- Grok ---------- */
const GROK_RESPONSE_BATCH = 50;    // the batch size grok.com's own client uses

/**
 * A Grok timestamp. ISO 8601 with a zone is what it sends today.
 *
 * Numbers are tolerated deliberately: this is an undocumented endpoint, and a
 * build that switched to epoch millis — or seconds — would otherwise zero every
 * date silently, which reads downstream as "this chat was never updated" and
 * quietly freezes it out of every future delta.
 */
function xaiTime(value) {
  if (value == null || value === "") return 0;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return 0;
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : 0;
}

/* ---------- Perplexity ----------
   Every Perplexity request the app makes carries these, and it costs nothing
   to look like the app rather than like something else. */
const PPLX_Q = "?version=2.18&source=default";
const PPLX_HEADERS = { "x-app-apiclient": "default", "x-app-apiversion": "2.18" };

/**
 * Perplexity stamps naive ISO with no zone: "2026-02-17T08:02:14.816554".
 *
 * Date.parse reads that as LOCAL time, so the same thread would carry a
 * different updatedAt in every timezone — and it is compared against a
 * watermark that is a Date.now(), i.e. UTC. West of Greenwich that skew reads
 * as "updated in the future" and the chat is re-fetched every pass; east of it
 * the chat falls behind the watermark and is never fetched again. Pin it.
 */
function pplxTime(value) {
  const raw = String(value || "").trim();
  if (!raw) return 0;
  const ms = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/.test(raw) ? raw : raw + "Z");
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * The assistant's half of one Perplexity turn.
 *
 * Three spellings, and they are not interchangeable: `text` is the answer as a
 * plain string, `answer` is the SAME answer wrapped in a JSON-encoded string
 * (so reading it raw archives `{"answer":"…"}` as the message body), and a
 * schematized reply has neither and carries it in a block instead. Read them
 * in that order and never fall back to the raw wrapper.
 */
function pplxAnswer(entry) {
  const plain = String(entry.text || "").trim();
  if (plain) return plain;

  if (typeof entry.answer === "string" && entry.answer) {
    try {
      const parsed = JSON.parse(entry.answer);
      const text = String((parsed && parsed.answer) || "").trim();
      if (text) return text;
    } catch { /* not the wrapper shape — fall through to blocks */ }
  }

  for (const block of (Array.isArray(entry.blocks) ? entry.blocks : [])) {
    if (!block || block.intended_usage !== "ask_text") continue;
    const text = String((block.markdown_block && block.markdown_block.answer) || "").trim();
    if (text) return text;
  }
  return "";
}

/** Claude states the tier in the org's capabilities, so the plan costs no extra
 *  request — and a plan is what decides the usage ceiling the popup draws. */
function claudeOrgCtx(org) {
  const caps = Array.isArray(org && org.capabilities) ? org.capabilities.map(String) : [];
  const plan = caps.includes("claude_max") ? "Max"
    : caps.includes("claude_pro") ? "Pro"
    : caps.includes("raven") || caps.includes("claude_team") ? "Team" : "Free";
  return {
    org: org.uuid,
    account: org.uuid,
    identified: true,
    // Personal orgs are named after the account's email; masked before storage.
    handle: String((org && org.name) || ""),
    plan
  };
}

const BG_ADAPTERS = [
  {
    id: "chatgpt", label: "ChatGPT", base: "https://chatgpt.com",
    host: "chatgpt.com", prefix: "/c/",
    async prepare() {
      const r = await bgFetch(this.base + "/api/auth/session");
      const j = await bgJson(r);
      if (!j || !j.accessToken) throw new BgError("auth", "not signed in");
      const account = j.user?.id || j.user?.email || j.account?.id || "";
      return {
        tok: j.accessToken,
        account,
        // The session names the signed-in user, so two accounts are told apart
        // outright and never have to be inferred from what they hold.
        identified: !!account,
        handle: String(j.user?.email || ""),
        plan: String(j.user?.plan || j.account?.plan_type || "")
      };
    },
    async get(ctx, path, opts) {
      const r = await bgFetch(this.base + path, {
        headers: { Authorization: "Bearer " + ctx.tok },
        ...(opts || {})
      });
      return bgJson(r);
    },
    // One request: is anything newer than the watermark? Turns a routine
    // "nothing changed" pass into a single call instead of a full listing.
    async peek(ctx, sinceMs) {
      const j = await this.get(ctx, "/backend-api/conversations?offset=0&limit=1&order=updated");
      const it = (j.items || [])[0];
      if (!it) return { hasNew: false, newestMs: 0 };
      const upd = it.update_time ? new Date(it.update_time).getTime() : Date.now();
      return { hasNew: upd > sinceMs, newestMs: upd };
    },
    async list(ctx, sinceMs, progress) {
      const metas = [];
      let hitOld = false, complete = false, page = 0;
      for (; page < BG_LIST_MAX_PAGES && !hitOld; page++) {
        if (page) await sleep(policyFor(this.host).listDelayMs);
        const j = await this.get(ctx,
          `/backend-api/conversations?offset=${page * BG_SYNC_LIST_PAGE}&limit=${BG_SYNC_LIST_PAGE}&order=updated`);
        const items = j.items || [];
        for (const it of items) {
          const upd = it.update_time ? new Date(it.update_time).getTime() : Date.now();
          if (sinceMs && upd <= sinceMs) { hitOld = true; break; }
          metas.push({
            id: it.id, title: it.title || "",
            createdAt: it.create_time ? new Date(it.create_time).getTime() : 0,
            updatedAt: upd
          });
        }
        progress(metas.length, j.total || 0, `Listing chats… ${metas.length}`);
        if (items.length < BG_SYNC_LIST_PAGE) { complete = true; break; }
      }
      return { metas, complete: complete || hitOld };
    },
    // One request returns the whole conversation. detailFull keeps the title and
    // revision too, so a single-chat index fetch can archive what it read.
    async detailFull(ctx, id, opts) {
      const conv = await this.get(ctx, "/backend-api/conversation/" + id, opts);
      return {
        msgs: chatgptMsgs(conv),
        title: String(conv.title || ""),
        createdAt: conv.create_time ? Math.round(conv.create_time * 1000) : 0,
        updatedAt: conv.update_time ? Math.round(conv.update_time * 1000) : 0
      };
    },
    async detail(ctx, id) {
      return (await this.detailFull(ctx, id)).msgs;
    }
  },
  {
    id: "claude", label: "Claude", base: "https://claude.ai",
    host: "claude.ai", prefix: "/chat/",
    async prepare() {
      const r = await bgFetch(this.base + "/api/organizations");
      const orgs = await bgJson(r);
      const list = (Array.isArray(orgs) ? orgs : []).filter((o) => o && o.uuid);
      const org = list[0];
      if (!org) throw new BgError("auth", "not signed in");
      return { ...claudeOrgCtx(org), orgs: list };
    },
    // One Claude login can own several organisations, and chats live in exactly
    // one of them. Syncing only the first quietly archived nothing from the
    // others — from the user's side, indistinguishable from a backup that lost
    // their work. Each org is its own account here, with its own checkpoint.
    accounts(ctx) {
      const list = Array.isArray(ctx.orgs) && ctx.orgs.length ? ctx.orgs : [{ uuid: ctx.org }];
      return list.map((org) => ({ ...ctx, ...claudeOrgCtx(org) }));
    },
    async get(ctx, path) { return bgJson(await bgFetch(this.base + path)); },
    async list(ctx, sinceMs, progress) {
      return pageThrough(this, {
        pageSize: 100, sinceMs, progress,
        fetchPage: async (page, limit) => {
          const arr = await this.get(ctx,
            `/api/organizations/${ctx.org}/chat_conversations?limit=${limit}&${page}`);
          return Array.isArray(arr) ? arr : (arr && Array.isArray(arr.data) ? arr.data : []);
        },
        toMeta: (it) => ({
          id: it.uuid, title: it.name || "",
          createdAt: it.created_at ? new Date(it.created_at).getTime() : 0,
          updatedAt: it.updated_at ? new Date(it.updated_at).getTime() : Date.now()
        })
      });
    },
    async detail(ctx, id) {
      const conv = await this.get(ctx, `/api/organizations/${ctx.org}/chat_conversations/${id}`);
      const msgs = [];
      for (const m of (conv.chat_messages || [])) {
        const role = m.sender === "human" ? "user" : "assistant";
        let text = String(m.text || "").trim();
        if (!text && Array.isArray(m.content)) {
          text = m.content.filter((c) => c && c.type === "text").map((c) => c.text).join("\n").trim();
        }
        if (text) msgs.push({ r: role, t: text, ts: m.created_at ? Math.floor(new Date(m.created_at).getTime() / 1000) : 0 });
      }
      return msgs;
    }
  },
  {
    id: "deepseek", label: "DeepSeek", base: "https://chat.deepseek.com",
    host: "chat.deepseek.com", prefix: "/chat/",
    // No endpoint here names the signed-in account, so every account on this
    // host would share one device-level tag; the page's hint can do better.
    namesAccount: false,
    async prepare() {
      await bgFetch(this.base + "/api/v0/chat/list?count=1");
      // No endpoint here names the signed-in user, so accounts are separated
      // after the listing instead — see resolveAnchor().
      return { identified: false };
    },
    async get(ctx, path) { return bgJson(await bgFetch(this.base + path)); },
    async list(ctx, sinceMs, progress) {
      return pageThrough(this, {
        pageSize: 100, sinceMs, progress,
        fetchPage: async (page, limit) => {
          const data = await this.get(ctx, `/api/v0/chat/list?count=${limit}&${page}`);
          return data.data?.list || data.list || (Array.isArray(data) ? data : []);
        },
        toMeta: (it) => ({
          id: it.id || it.session_id, title: it.title || it.topic || "",
          createdAt: it.created_at ? new Date(it.created_at).getTime() : (it.create_time || 0),
          updatedAt: it.updated_at ? new Date(it.updated_at).getTime() : (it.update_time || Date.now())
        })
      });
    },
    async detail(ctx, id) {
      const data = await this.get(ctx, "/api/v0/chat/history/" + id);
      const msgs = [];
      for (const m of (data.data?.messages || data.messages || [])) {
        const role = /user|human/i.test(m.role) ? "user" : "assistant";
        const text = (m.content || m.text || "").trim();
        if (text) msgs.push({ r: role, t: text, ts: m.created_at ? Math.floor(new Date(m.created_at).getTime() / 1000) : 0 });
      }
      return msgs;
    }
  },
  {
    id: "grok", label: "Grok", base: "https://grok.com",
    host: "grok.com", prefix: "/chat/",
    // No endpoint here names the signed-in account, so every account on this
    // host would share one device-level tag; the page's hint can do better.
    namesAccount: false,
    async prepare() {
      await bgFetch(this.base + "/rest/app-chat/conversations?limit=1");
      return { identified: false };   // as DeepSeek — resolveAnchor() separates them
    },
    async get(ctx, path) { return bgJson(await bgFetch(this.base + path)); },
    async list(ctx, sinceMs, progress) {
      return pageThrough(this, {
        pageSize: 100, sinceMs, progress,
        fetchPage: async (page, limit) => {
          const data = await this.get(ctx, `/rest/app-chat/conversations?limit=${limit}&${page}`);
          return data.conversations || data.items || (Array.isArray(data) ? data : []);
        },
        toMeta: (it) => ({
          // Grok spells every one of these in camelCase, and nothing else in
          // this file does. An earlier build read it.id / created_at /
          // updated_at — all three absent — so every meta came back without an
          // id, walkScheme dropped the entire listing as unusable, and the
          // platform archived nothing while reporting no error at all. The
          // snake_case spellings are kept only as a fallback.
          id: String(it.conversationId || it.id || it.conversation_id || ""),
          title: String(it.title || it.name || ""),
          createdAt: xaiTime(it.createTime || it.created_at),
          updatedAt: xaiTime(it.modifyTime || it.updated_at) || Date.now()
        })
      });
    },
    /**
     * Grok never hands over a conversation's messages with the conversation.
     * Two steps: the ids of its response nodes, then their bodies in batches.
     * The single GET an earlier build made returns metadata with no messages
     * in it whatsoever, so `data.messages || data.turns` was always empty and
     * every Grok chat archived as a title with nothing under it.
     */
    async detail(ctx, id) {
      const conv = "/rest/app-chat/conversations/" + encodeURIComponent(id);
      const nodes = await this.get(ctx, conv + "/response-node?includeThreads=true");
      const ids = (nodes.responseNodes || nodes.response_nodes || [])
        .map((n) => n && String(n.responseId || n.response_id || ""))
        .filter(Boolean);

      const msgs = [];
      for (let at = 0; at < ids.length; at += GROK_RESPONSE_BATCH) {
        if (at) await sleep(policyFor(this.host).listDelayMs);
        const batch = ids.slice(at, at + GROK_RESPONSE_BATCH);
        const data = await bgJson(await bgFetch(this.base + conv + "/load-responses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ responseIds: batch })
        }));
        const responses = Array.isArray(data.responses) ? data.responses.slice() : [];

        // The node listing IS the reading order, so the requested order is the
        // one to keep — but only reorder when every item can actually be
        // placed. A partial match would interleave a conversation worse than
        // leaving it exactly as the server sent it.
        const rank = new Map(batch.map((rid, i) => [rid, i]));
        const placed = responses.map((m) => rank.get(String(
          (m && (m.responseId || m.response_id)) || "")));
        if (placed.every((p) => p !== undefined)) {
          responses.sort((a, b) =>
            rank.get(String(a.responseId || a.response_id)) -
            rank.get(String(b.responseId || b.response_id)));
        }

        for (const m of responses) {
          const text = String((m && (m.message || m.content || m.text)) || "").trim();
          if (!text) continue;
          msgs.push({
            r: /user|human/i.test(String((m.sender || m.role) || "")) ? "user" : "assistant",
            t: text,
            ts: Math.floor(xaiTime(m.createTime || m.created_at) / 1000)
          });
        }
      }
      return msgs;
    }
  },
  {
    id: "gemini", label: "Gemini", base: "https://gemini.google.com",
    // The record id is the /app/<cid> URL, which is also what the Google Takeout
    // importer on the recall page builds — so a synced chat and an imported one
    // are the same row rather than two copies of the same conversation.
    host: "gemini.google.com", prefix: "/app/",
    // No endpoint here names the signed-in account, so every account on this
    // host would share one device-level tag; the page's hint can do better.
    namesAccount: false,
    async prepare() {
      // batchexecute's tokens live only in the app shell's HTML — no JSON
      // endpoint carries them — so this one request is deliberately not JSON.
      const r = await bgFetch(this.base + "/app", {
        headers: { Accept: "text/html,application/xhtml+xml,*/*" }
      });
      const html = await r.text();
      const at = (GEMINI_AT_RE.exec(html) || [])[1] || "";
      // No token means the shell rendered signed-out. An auth failure, not a
      // shape change — the two want different remedies from the user.
      if (!at) throw new BgError("auth", "not signed in");
      return {
        at,
        bl: (GEMINI_BL_RE.exec(html) || [])[1] || "",
        sid: (GEMINI_SID_RE.exec(html) || [])[1] || "",
        // Nothing in the shell names the account dependably, so accounts here
        // are told apart afterwards by what they hold — as DeepSeek and Grok are.
        identified: false
      };
    },
    async rpc(ctx, rpcid, payload) {
      geminiReqid = (geminiReqid || Math.floor(Math.random() * 90000) + 10000) + 100000;
      const params = new URLSearchParams({
        rpcids: rpcid, "source-path": "/app", hl: "en",
        _reqid: String(geminiReqid), rt: "c"
      });
      if (ctx.bl) params.set("bl", ctx.bl);
      if (ctx.sid) params.set("f.sid", ctx.sid);
      const r = await bgFetch(this.base + GEMINI_BATCH_PATH + "?" + params.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "X-Same-Domain": "1"
        },
        // Three levels of nesting, the innermost one a JSON string: the batch,
        // the envelope list, then the envelope. "generic" is the ordering slot a
        // single-rpc batch uses.
        body: new URLSearchParams({
          "f.req": JSON.stringify([[[rpcid, JSON.stringify(payload), null, "generic"]]]),
          at: ctx.at
        }).toString()
      });
      return r.text();
    },
    async list(ctx, sinceMs, progress) {
      const metas = [];
      const seen = new Set();
      let sawRows = 0, named = 0, truncated = false, shelf = 0;

      for (const pinned of GEMINI_SHELVES) {
        if (shelf++) await sleep(policyFor(this.host).listDelayMs);
        const payloads = geminiPayloads(
          await this.rpc(ctx, GEMINI_RPC_LIST, [GEMINI_LIST_MAX, null, [pinned, null, 1]]),
          GEMINI_RPC_LIST);
        // No envelope for the rpc we asked for is not an empty account — it is a
        // transport or a shape this build no longer speaks.
        if (!payloads.length) throw new BgError("shape", "provider listing not understood");

        let rowsHere = 0;
        for (const payload of payloads) {
          const rows = Array.isArray(payload) && Array.isArray(payload[2]) ? payload[2] : [];
          for (const row of rows) {
            if (!Array.isArray(row)) continue;
            rowsHere++; sawRows++;
            const cid = String(row[0] || "");
            if (!cid) continue;
            named++;
            if (seen.has(cid)) continue;
            seen.add(cid);
            const updatedAt = geminiTime(row[5]) || Date.now();
            if (sinceMs && updatedAt <= sinceMs) continue;
            metas.push({ id: cid, title: String(row[1] || ""), createdAt: 0, updatedAt });
          }
        }
        // LIST_CHATS takes a COUNT, not a cursor. A shelf that returns exactly
        // as many rows as it was asked for may have more behind it, and a
        // listing that might be partial must never be called complete — the
        // sweep would read everything it omitted as deleted upstream.
        if (rowsHere >= GEMINI_LIST_MAX) truncated = true;
        progress(metas.length, 0, `Listing chats… ${metas.length}`);
      }

      metas.sort((a, b) => b.updatedAt - a.updatedAt);
      return { metas, complete: !truncated, unreadable: sawRows > 0 && named === 0 };
    },
    async detail(ctx, id) {
      const payloads = geminiPayloads(
        await this.rpc(ctx, GEMINI_RPC_READ, [id, GEMINI_TURN_MAX, null, 1, [1], [4], null, 1]),
        GEMINI_RPC_READ);
      if (!payloads.length) throw new BgError("shape", "provider conversation not understood");

      const turns = payloads.map((p) => geminiAt(p, [0])).find(Array.isArray);
      // A conversation holding no turns is legitimate — one opened and
      // abandoned. An envelope with no turns ARRAY at all is not, but it is
      // also indistinguishable here from the former, so treat it as empty and
      // let the listing's own checks be the ones that raise.
      if (!turns) return [];

      const msgs = [];
      // Gemini answers newest-turn-first. Walk it backwards so the archive
      // reads in the order the conversation actually happened.
      for (let i = turns.length - 1; i >= 0; i--) {
        const turn = turns[i];
        if (!Array.isArray(turn)) continue;
        const ask = String(geminiAt(turn, [2, 0, 0]) || "").trim();
        if (ask) msgs.push({ r: "user", t: ask, ts: 0 });
        // The first candidate is the one the page shows; the rest are alternate
        // drafts the reader never saw.
        const best = geminiAt(turn, [3, 0, 0]);
        // Index 22 is where a "card" answer keeps its text instead of index 1.
        const reply = String(geminiAt(best, [1, 0]) || geminiAt(best, [22, 0]) || "").trim();
        if (reply) msgs.push({ r: "assistant", t: reply, ts: 0 });
      }
      return msgs;
    }
  },
  {
    id: "perplexity", label: "Perplexity", base: "https://www.perplexity.ai",
    // The thread slug IS the /search/ URL segment, so a record id here is the
    // address of the page it came from — same rule as every other adapter.
    host: "www.perplexity.ai", prefix: "/search/",
    async prepare() {
      const j = await bgJson(await bgFetch(this.base + "/api/auth/session" + PPLX_Q,
        { headers: PPLX_HEADERS }));
      const user = (j && j.user) || null;
      if (!user || !user.id) throw new BgError("auth", "not signed in");
      // Unlike DeepSeek and Grok, Perplexity names the signed-in user, so two
      // accounts are told apart outright and never inferred from what they hold.
      return { account: String(user.id), identified: true, handle: String(user.email || "") };
    },
    /** One page of the thread list. POST, with a JSON body — the same endpoint
     *  answers 400 to a bare GET. */
    async listPage(offset, limit) {
      const j = await bgJson(await bgFetch(this.base + "/rest/thread/list_ask_threads" + PPLX_Q, {
        method: "POST",
        headers: { ...PPLX_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({ limit, offset, ascending: false, search_term: "" })
      }));
      return Array.isArray(j) ? j : (j && Array.isArray(j.entries) ? j.entries : []);
    },
    async peek(ctx, sinceMs) {
      const [newest] = await this.listPage(0, 1);
      if (!newest) return { hasNew: false, newestMs: 0 };
      const upd = pplxTime(newest.last_query_datetime) || Date.now();
      return { hasNew: upd > sinceMs, newestMs: upd };
    },
    async list(ctx, sinceMs, progress) {
      return pageThrough(this, {
        pageSize: 50, sinceMs, progress,
        // Perplexity pages by an offset in the POST BODY, not a query param, so
        // none of the shared query-string schemes can describe it. One scheme,
        // whose "param" is the offset itself — walkScheme still owns every exit
        // condition, so the watermark is as safe here as anywhere else.
        schemes: [{ id: "pplx-body-offset", param: (page, size) => String(page * size) }],
        fetchPage: (param, limit) => this.listPage(Number(param) || 0, limit),
        toMeta: (it) => ({
          id: String(it.slug || it.uuid || ""),
          title: String(it.title || ""),
          // The listing carries no creation time at all — only the last query.
          createdAt: 0,
          updatedAt: pplxTime(it.last_query_datetime) || Date.now()
        })
      });
    },
    async detail(ctx, id) {
      const msgs = [];
      let cursor = "";
      for (let page = 0; page < BG_LIST_MAX_PAGES; page++) {
        if (page) await sleep(policyFor(this.host).listDelayMs);
        let j;
        try {
          j = await bgJson(await bgFetch(
            this.base + "/rest/thread/" + encodeURIComponent(id) + PPLX_Q +
            (cursor ? "&cursor=" + encodeURIComponent(cursor) : ""),
            { headers: PPLX_HEADERS }));
        } catch (error) {
          // Perplexity purges threads after roughly three months, and says so
          // with a 400 (ENTRY_EXPIRED / ENTRY_DELETED) rather than a 404. Left
          // as a network error this would be retried every pass forever, on a
          // thread that is never coming back. It is gone; say so, and let the
          // sweep tombstone it like any other vanished chat.
          if (error && error.status === 400) throw new BgError("gone", "http 400", { status: 400 });
          throw error;
        }
        // One entry is a whole turn — the question AND the answer — so it
        // yields two messages, not one.
        for (const entry of (j.entries || [])) {
          const secs = Math.floor((pplxTime(entry.updated_datetime) || 0) / 1000);
          const query = String(entry.query_str || "").trim();
          if (query) msgs.push({ r: "user", t: query, ts: secs });
          const answer = pplxAnswer(entry);
          if (answer) msgs.push({ r: "assistant", t: answer, ts: secs });
        }
        // has_next_page here is the THREAD's, not the listing's — the two use
        // the same field name for different things.
        cursor = (j.has_next_page && j.next_cursor) ? String(j.next_cursor) : "";
        if (!cursor) break;
      }
      return msgs;
    }
  }
];

let bgSyncRunning = false;

/* ===================== one conversation's index =====================
 * The map used to be assembled by walking the host's own scroller to the top —
 * sixty round trips of the page yanking itself around while somebody was trying
 * to read it. The provider hands over the entire conversation in ONE request we
 * already know how to make, and every message in it carries the same id ChatGPT
 * stamps on the DOM. So the map can be complete before the first paint, and the
 * page never has to move at all. */

const IDX_SNIP = 80;                    // matches metaFor()'s slice in minimap.js
const IDX_CODE = /```|\n {4}\S/;        // a hint; the DOM's own <pre> wins on mount
const IDX_CTX_TTL = 5 * 60 * 1000;      // clicking through 20 chats = one prepare()
const IDX_FRESH_MS = 60 * 1000;         // an SPA route bounce must not refetch

const idxCtx = new Map();               // host -> { ctx, at }
const idxInflight = new Map();          // recordId -> Promise
const idxFetchedAt = new Map();         // recordId -> ms

/** The map only needs shape and a label — never the full transcript. */
function indexFromMsgs(msgs) {
  const out = [];
  for (const m of msgs || []) {
    if (!m || !m.i) continue;
    const t = m.t || "";
    out.push({ i: m.i, r: m.r === "user" ? "user" : "assistant", n: t.length, c: IDX_CODE.test(t) ? 1 : 0, s: t.slice(0, IDX_SNIP) });
  }
  return out;
}

/** Drop a cached context so the next prepare() really talks to the provider.
 *  A bearer token can expire inside IDX_CTX_TTL, and the only way to tell that
 *  from a signed-out user is to go and ask again. */
function idxForget(adapter) {
  idxCtx.delete(adapter.host);
}

async function idxPrepare(adapter) {
  const hit = idxCtx.get(adapter.host);
  if (hit && Date.now() - hit.at < IDX_CTX_TTL) return hit.ctx;
  const ctx = await adapter.prepare();
  idxCtx.set(adapter.host, { ctx, at: Date.now() });
  return ctx;
}

/**
 * One message's full text, straight out of the archive.
 *
 * The index deliberately carries only an 80-char snippet — shipping every
 * message's body would be megabytes on chat open for something the reader looks
 * at one of. This is the other half: an IndexedDB read, so the preview fills in
 * within a frame or two of the click.
 */
async function chatMessage(host, path, messageId) {
  const id = String(host || "") + String(path || "");
  try {
    const d = await db();
    const rec = await reqP(tx(d, "readonly").get(id.slice(0, 600)));
    if (!rec || !rec.msgs) return { status: "missing" };
    const m = rec.msgs.find((x) => x.i === messageId);
    if (!m) return { status: "missing" };
    return { status: "ok", role: m.r, text: m.t, ts: m.ts || 0 };
  } catch { return { status: "missing" }; }
}

/**
 * Search ONE conversation, in the archive rather than in the page.
 *
 * Measured on a live 1,471-message ChatGPT thread: the word "isaac" appears in
 * 217 messages, and in-chat search found 8 of them. Not a bug in the search —
 * it reads what the page has mounted, and the host had mounted 195 of 1,471.
 * From the reader's side that is a search that does not work, and no amount of
 * "it only searches the loaded conversation" in a tooltip fixes the feeling of
 * asking a 1,400-message chat a question and being told there are eight
 * answers.
 *
 * The archive already holds every word of that conversation on this machine.
 * So it answers here, with the provider's own message ids, and the minimap's
 * existing seek walks the reader to a hit the page has never rendered.
 *
 * Returns ids and short excerpts only — never the whole conversation back into
 * a page.
 */
const CHAT_SEARCH_MAX = 300;
const CHAT_SEARCH_PAD = 70;      // characters of context on each side of a hit

async function chatSearch(host, path, query) {
  const q = String(query || "").trim().toLowerCase();
  if (q.length < 2) return { status: "short" };
  const id = (String(host || "") + String(path || "")).slice(0, 600);
  let rec;
  try {
    const d = await db();
    rec = await reqP(tx(d, "readonly").get(id));
  } catch { return { status: "unavailable" }; }
  if (!rec || !Array.isArray(rec.msgs)) return { status: "missing" };

  /* Every hit is returned as a provider message id, because that id is what
     the minimap seeks on — so a record whose messages carry no ids cannot be
     answered from here at all. Only the ChatGPT adapter emits `i`; Claude,
     DeepSeek, Grok, Gemini and Perplexity push {r,t,ts}. Reporting "ok" with
     zero hits for those told the reader the archive held no matches, when what
     actually happened is that the deep search never ran. That is the one thing
     this project must not do, so it is a distinct status the page can see. */
  const searchable = rec.msgs.filter((m) => m && m.i && m.t).length;
  if (!searchable) return { status: "no-index", total: 0, scanned: 0, hits: [] };

  const hits = [];
  let scanned = 0;
  for (const m of rec.msgs) {
    if (!m || !m.i || !m.t) continue;
    scanned++;
    const text = String(m.t);
    const at = text.toLowerCase().indexOf(q);
    if (at < 0) continue;
    if (hits.length < CHAT_SEARCH_MAX) {
      const from = Math.max(0, at - CHAT_SEARCH_PAD);
      hits.push({
        i: m.i,
        r: m.r === "user" ? "user" : "assistant",
        // The excerpt is what the reader recognises the hit by; the ellipses
        // are honest about it being an excerpt.
        s: (from ? "…" : "") + text.slice(from, at + q.length + CHAT_SEARCH_PAD).trim() +
           (at + q.length + CHAT_SEARCH_PAD < text.length ? "…" : ""),
        at
      });
    } else hits.push(null);        // counted, not carried
  }
  return {
    status: "ok",
    total: hits.length,
    scanned,
    truncated: hits.length > CHAT_SEARCH_MAX,
    hits: hits.filter(Boolean)
  };
}

/**
 * One conversation, whole, for the export button.
 *
 * Exporting reads the page, and the page holds what the host mounted — 197 of
 * 1,471 messages on a live thread. "Backed up the 197 loaded messages" is an
 * honest sentence about a backup that is 13% of the conversation, which is not
 * what anyone pressing a backup button believes they are getting.
 *
 * The archive on this machine has the rest. Same conversation, same machine,
 * no network: this hands it back so the file on disk is the whole thing.
 */
async function chatArchive(host, path) {
  const id = (String(host || "") + String(path || "")).slice(0, 600);
  try {
    const d = await db();
    const rec = await reqP(tx(d, "readonly").get(id));
    if (!rec || !Array.isArray(rec.msgs) || !rec.msgs.length) return { status: "missing" };
    return {
      status: "ok",
      title: rec.title || "",
      n: rec.n || rec.msgs.length,
      msgs: rec.msgs.map((m) => ({
        i: m.i || "", r: m.r, t: m.t || "", ts: m.ts || 0,
        // Records written before the flag existed are recognised by length.
        ...(m.c || (m.t || "").length >= MAX_MSG_CHARS ? { c: 1 } : {})
      }))
    };
  } catch { return { status: "unavailable" }; }
}

/** Forget a conversation. The only path that removes archived text. */
async function dropChat(id) {
  try {
    const d = await db();
    await reqP(tx(d, "readwrite").delete(String(id).slice(0, 600)));
  } catch { /* archive unavailable — nothing to forget */ }
}

/* ===================== deletion review =====================
 *
 * A chat vanishing upstream used to delete the archived copy on sight. That
 * makes the backup strictly weaker than the provider: one wrong click on
 * chatgpt.com, or a provider retention sweep, and the local copy — the whole
 * reason this archive exists — is gone with it, silently.
 *
 * So deletion is now a QUESTION, not an event. A vanished chat is quarantined:
 * still archived, still searchable, flagged, and queued for the user. Only an
 * explicit answer (or an explicit standing policy) removes anything.
 *
 * settings.deletionPolicy:
 *   "ask"    — default. Quarantine and prompt.
 *   "keep"   — the archive outlives the provider. Never prompt, never delete.
 *   "mirror" — the archive tracks the provider exactly. Delete on sight.
 */

const DELETION_REASONS = new Set(["opened", "sync", "sweep"]);

async function deletionPolicy() {
  try {
    const { settings } = await chrome.storage.local.get("settings");
    const value = settings && settings.deletionPolicy;
    return value === "keep" || value === "mirror" ? value : "ask";
  } catch { return "ask"; }
}

async function readDeletions() {
  try {
    const { [BG_DELETIONS]: raw } = await chrome.storage.local.get(BG_DELETIONS);
    const items = raw && typeof raw.items === "object" && raw.items ? raw.items : {};
    const out = {};
    for (const [id, value] of Object.entries(items)) {
      if (!value || typeof value !== "object") continue;
      out[String(id).slice(0, 600)] = {
        id: String(id).slice(0, 600),
        platform: String(value.platform || "").slice(0, 32),
        host: String(value.host || "").slice(0, 120),
        path: String(value.path || "").slice(0, 400),
        title: String(value.title || "").slice(0, 200),
        messages: Math.max(0, Math.floor(Number(value.messages) || 0)),
        updatedAt: Number(value.updatedAt) || 0,
        detectedAt: Number(value.detectedAt) || 0,
        reason: DELETION_REASONS.has(value.reason) ? value.reason : "sync"
      };
    }
    return { version: 1, items: out };
  } catch { return { version: 1, items: {} }; }
}

let deletionWrite = Promise.resolve();

async function mutateDeletions(mutator) {
  const work = async () => {
    const current = await readDeletions();
    const next = (await mutator(current)) || current;
    const entries = Object.entries(next.items);
    if (entries.length > BG_DELETION_MAX) {
      // Oldest detections go first: the newest surprise is the one the user
      // still has context for.
      entries.sort((a, b) => (b[1].detectedAt || 0) - (a[1].detectedAt || 0));
      next.items = Object.fromEntries(entries.slice(0, BG_DELETION_MAX));
    }
    try { await chrome.storage.local.set({ [BG_DELETIONS]: next }); } catch { /* full */ }
    await paintDeletionBadge(Object.keys(next.items).length);
    return next;
  };
  deletionWrite = deletionWrite.then(work, work);
  return deletionWrite;
}

async function paintDeletionBadge(count) {
  try {
    if (!chrome.action || !chrome.action.setBadgeText) return;
    await chrome.action.setBadgeText({ text: count ? String(Math.min(count, 99)) : "" });
    if (count && chrome.action.setBadgeBackgroundColor) {
      await chrome.action.setBadgeBackgroundColor({ color: "#c2410c" });
    }
  } catch { /* action API unavailable */ }
}

/** Enough of the archived record to let the user recognise what they are about to lose. */
async function chatSummary(id) {
  try {
    const d = await db();
    const rec = await reqP(tx(d, "readonly").get(String(id).slice(0, 600)));
    if (!rec) return null;
    return { title: rec.title || "", messages: (rec.msgs || []).length,
      updatedAt: rec.updatedAt || 0, platform: rec.platform || "", host: rec.host || "", path: rec.path || "" };
  } catch { return null; }
}

let deletionNoticePending = null;

/**
 * The provider says this chat is gone. Decide what that means for the archive.
 * Returns whether the archived copy was actually removed.
 */
async function noteVanished(id, hint = {}, reason = "sync") {
  const recordId = String(id).slice(0, 600);
  const policy = await deletionPolicy();
  if (policy === "mirror") { await dropChat(recordId); return { removed: true, policy }; }
  if (policy === "keep") return { removed: false, policy };

  const existing = (await readDeletions()).items[recordId];
  if (existing) return { removed: false, policy, queued: true };
  const summary = await chatSummary(recordId);
  // Nothing archived under that id — there is no decision to put to anyone.
  if (!summary) return { removed: false, policy, unknown: true };

  await mutateDeletions((state) => {
    state.items[recordId] = {
      id: recordId,
      platform: summary.platform || hint.platform || "",
      host: summary.host || hint.host || "",
      path: summary.path || hint.path || "",
      title: summary.title,
      messages: summary.messages,
      updatedAt: summary.updatedAt,
      detectedAt: Date.now(),
      reason: DELETION_REASONS.has(reason) ? reason : "sync"
    };
    return state;
  });
  scheduleDeletionNotice();
  return { removed: false, policy, queued: true };
}

/* One notification per burst, not one per chat: a sweep can find forty at once
   and forty toasts is an attack on the user, not a prompt. */
function scheduleDeletionNotice() {
  if (deletionNoticePending) return;
  deletionNoticePending = setTimeout(() => {
    deletionNoticePending = null;
    showDeletionNotice();
  }, 2500);
}

async function showDeletionNotice() {
  const count = Object.keys((await readDeletions()).items).length;
  if (!count) return;
  try {
    if (!chrome.notifications || !chrome.notifications.create) return;
    await chrome.notifications.create("lct-deletions", {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: count === 1 ? "A chat was deleted where you use it" : `${count} chats were deleted where you use them`,
      message: count === 1
        ? "Your backup still has it. Keep the backup copy, or delete it here too?"
        : "Your backup still has them. Choose which copies to keep.",
      priority: 1,
      requireInteraction: false
    });
  } catch { /* notifications unavailable — the badge and the panel still carry it */ }
}

/** The user answered. `action` is "delete" (remove from the backup too) or "keep". */
async function resolveDeletions(ids, action) {
  const wanted = Array.isArray(ids) ? ids.map((id) => String(id).slice(0, 600)) : [];
  const state = await readDeletions();
  const targets = wanted.length ? wanted.filter((id) => state.items[id]) : Object.keys(state.items);
  if (action === "delete") {
    for (const id of targets) await dropChat(id);
  } else if (action !== "keep") {
    return { err: "unknown action" };
  }
  await mutateDeletions((current) => {
    for (const id of targets) delete current.items[id];
    return current;
  });
  try { if (chrome.notifications) await chrome.notifications.clear("lct-deletions"); } catch { /* fine */ }
  return { ok: true, action, count: targets.length };
}

async function deletionsList() {
  const state = await readDeletions();
  const items = Object.values(state.items).sort((a, b) => (b.detectedAt || 0) - (a.detectedAt || 0));
  return { items, policy: await deletionPolicy() };
}

/**
 * Reconcile a FULL provider listing against the archive. Only safe when the
 * listing genuinely covered everything — a delta pass lists a window, and every
 * chat outside it would look deleted.
 */
async function sweepVanished(adapter, index, listedIds, scanStartedAt, pendingIds) {
  const candidates = [];
  for (const [recordId, revision] of index) {
    if (listedIds.has(recordId)) continue;
    // Written during this very pass, or still outstanding in the journal —
    // either way the listing is not evidence it is gone.
    if (Number(revision) >= scanStartedAt) continue;
    if (pendingIds.has(recordId.slice((adapter.host + adapter.prefix).length))) continue;
    candidates.push(recordId);
  }
  if (!candidates.length) return { vanished: 0 };
  // Nothing at all came back, yet the account demonstrably holds chats. That is
  // a session that expired between the handshake and the listing, or a provider
  // having a bad minute — never a user who deleted their entire history in the
  // gap between two passes. The proportional guard below cannot catch this on a
  // small archive, where "everything" is fewer chats than its floor.
  if (!listedIds.size) {
    await noteSweepAnomaly(adapter.id, candidates.length, index.size);
    return { vanished: 0, skipped: candidates.length, reason: "empty-listing" };
  }
  // A signed-out session, a changed response shape or a half-finished walk can
  // all produce a short listing, and every chat outside it then looks deleted.
  // Anything past a quarter of the archive is treated as a broken listing
  // rather than a very busy afternoon of deleting. The small floor keeps this
  // workable on a four-chat archive, where a quarter is one chat.
  //
  // The trade is deliberate: a genuine mass deletion goes unnoticed (the copies
  // simply stay, which is this feature's default anyway) instead of a glitch
  // putting the whole archive up for deletion in one dialog.
  const ceiling = Math.max(5, Math.floor(index.size * 0.25));
  if (candidates.length > ceiling) {
    await noteSweepAnomaly(adapter.id, candidates.length, index.size);
    return { vanished: 0, skipped: candidates.length, reason: "implausible" };
  }
  let removed = 0, queued = 0;
  for (const recordId of candidates) {
    const result = await noteVanished(recordId, { platform: adapter.id, host: adapter.host }, "sweep");
    if (result.removed) removed++;
    else if (result.queued) queued++;
  }
  return { vanished: candidates.length, removed, queued };
}

/* ===================== telling accounts apart without being told ============
 *
 * DeepSeek and Grok expose no endpoint that names the signed-in user, so every
 * account on them started out sharing one checkpoint key. That was survivable
 * while the archive was one undifferentiated pile per host. It is not
 * survivable now: sign into a second account, and its complete listing would
 * present the first account's entire history as vanished.
 *
 * Session cookies rotate, so they cannot be the identity (an earlier build
 * tried; every rotation re-swept the whole history). What does not rotate is
 * what the account HOLDS. The oldest conversation in a complete listing is a
 * stable, provider-assigned anchor for that account — and it is an id the
 * archive already stores anyway, so it introduces no new class of data.
 *
 * Three outcomes, and the ambiguous one always resolves toward keeping data:
 *   anchor matches, or none recorded  → same account.
 *   anchor differs but the listing still overlaps what this account holds
 *                                     → same account that deleted its oldest
 *                                       chat. Move the anchor, keep the tag.
 *   anchor differs and the listing is
 *   a stranger to the archive         → a DIFFERENT account. Re-key onto its
 *                                       own checkpoint and suppress the sweep
 *                                       for this pass: a listing from an
 *                                       account we have never seen is no
 *                                       evidence about anybody else's chats.
 */

/** The oldest chat in a listing. Ties break on id so the anchor is stable. */
function listingAnchor(metas) {
  let best = null;
  for (const meta of metas || []) {
    if (!meta || !meta.id) continue;
    const at = Number(meta.createdAt) || Number(meta.updatedAt) || 0;
    const id = String(meta.id);
    if (!best || at < best.at || (at === best.at && id < best.id)) best = { id, at };
  }
  return best ? best.id : "";
}

async function resolveAnchor(adapter, provisionalKey, checkpoint, metas, complete) {
  const anchor = listingAnchor(metas);
  // A delta lists a window, so its oldest entry says nothing about the account.
  // An empty listing says even less.
  if (!complete || !anchor) {
    return { key: provisionalKey, anchor: (checkpoint && checkpoint.anchor) || "", switched: false };
  }

  // Every account this browser has already separated on this platform, plus the
  // key we opened with. Matching against ALL of them is what lets an account be
  // recognised again on a later pass: the provisional key is the same one for
  // everybody here, so asking only "is this the account the provisional key
  // describes?" can discover a second account but never re-find it.
  const ledger = await readLedger();
  const known = Object.entries(ledger.checkpoints)
    .filter(([, c]) => c && c.platform === adapter.id)
    .map(([key, c]) => ({ key, anchor: String(c.anchor || "") }));
  if (!known.some((k) => k.key === provisionalKey)) {
    known.push({ key: provisionalKey, anchor: (checkpoint && checkpoint.anchor) || "" });
  }

  // 1. An exact anchor match is the account, full stop.
  const exact = known.find((k) => k.anchor && k.anchor === anchor);
  if (exact) return { key: exact.key, anchor, switched: exact.key !== provisionalKey };

  // 2. Otherwise the account whose archived chats this listing actually
  //    overlaps. That survives the anchor moving — which is what happens the
  //    day somebody deletes their oldest conversation.
  const prefix = adapter.host + adapter.prefix;
  let best = null, attributed = 0;
  for (const candidate of known) {
    const index = await accountIndex(adapter.host, adapter.prefix, tagOfKey(candidate.key));
    attributed += index.size;
    if (!index.size) continue;
    let overlap = 0;
    for (const meta of metas) if (index.has(prefix + meta.id)) overlap++;
    const floor = Math.max(1, Math.min(metas.length, index.size) * BG_ANCHOR_OVERLAP);
    if (overlap >= floor && (!best || overlap > best.overlap)) best = { key: candidate.key, overlap };
  }
  if (best) return { key: best.key, anchor, switched: best.key !== provisionalKey };

  // 3. Nothing on this platform is attributed yet, so there is nobody to be
  //    mistaken for: keep the key we already had. This is the first pass after
  //    an upgrade, and re-keying here would abandon a good checkpoint and
  //    re-download a history that is already on disk.
  if (!attributed) return { key: provisionalKey, anchor, switched: false };

  // 4. A listing that no account here recognises. Its own checkpoint, and no
  //    opinion about anybody else's chats this pass.
  return { key: await identityCheckpointKey(adapter, "anchor:" + anchor), anchor, switched: true };
}

/* ===================== who is signed in, for a content script ===============
 *
 * Usage counting is per ACCOUNT because the limit is per account — that is the
 * whole reason people keep a second one. A page therefore has to know which
 * account it is looking at before it can count anything, and it must not pay a
 * provider round trip to find out on every message sent.
 *
 * So the worker answers, and caches: one handshake per host per TTL, shared by
 * every tab. A page on a provider we do not sync (no adapter — Gemini) supplies
 * its own hint from the URL or the page chrome, which is salted and hashed here
 * exactly like a provider id, so the same rule holds everywhere: raw account
 * identifiers are never stored.
 *
 * The two paths are alternatives, never a fallback for one another: they salt
 * different identities, so the same person would tag as two accounts depending
 * on which one answered. A host with an adapter is therefore identified by the
 * adapter or not at all — a failed handshake yields an empty tag and the page
 * counts per host, which is what it did before accounts existed.
 */

const ACCT_CACHE_TTL = 5 * 60 * 1000;
const acctCache = new Map();      // host -> { at, value }

async function accountForHost(host, hint = "") {
  const key = host + "|" + hint;
  const hit = acctCache.get(key);
  if (hit && Date.now() - hit.at < ACCT_CACHE_TTL) return hit.value;

  const adapter = BG_ADAPTERS.find((a) => a.host === host);
  let value = { acct: "", label: "", ordinal: 0, plan: "", identified: false };

  /* Prefer whichever source can actually name the account, not whichever is
     nearer. An adapter flagged `namesAccount: false` has no endpoint that says
     who is signed in, so every account on that host collapses to one
     device-level tag — while the page, looking at the account switcher or the
     /u/N seat, can tell two of them apart. Gemini is the case that makes this
     matter: two Google accounts really are open side by side in one profile,
     and a shared tag counts both against one limit. It also saves the prepare()
     round trip we would only discard. */
  const preferHint = !!hint && (!adapter || adapter.namesAccount === false);

  /* Nothing to check the hint against here — but a hint is still stable per
     account, which is all a usage tally needs. */
  const fromHint = async () => {
    const platformId = PAGE_PLATFORMS[host] || host;
    const acct = tagOfKey(await identityCheckpointKey({ id: platformId }, "hint:" + hint));
    const meta = await noteAccount(platformId, acct, { handle: hint, identified: false });
    return {
      acct, label: (meta && meta.label) || "", ordinal: (meta && meta.ordinal) || 1,
      plan: "", identified: false
    };
  };

  try {
    if (preferHint) {
      value = await fromHint();
    } else if (adapter) {
      try {
        const ctx = await adapter.prepare();
        const acct = await accountTag(adapter, ctx);
        const meta = await noteAccount(adapter.id, acct, {
          handle: ctx.handle, plan: ctx.plan, identified: ctx.identified !== false
        });
        value = {
          acct, label: (meta && meta.label) || "", ordinal: (meta && meta.ordinal) || 1,
          plan: (meta && meta.plan) || "", identified: ctx.identified !== false
        };
      } catch (error) {
        /* The adapter could not answer — the host permission was declined, the
           session lapsed, the provider changed shape. The two paths salt
           different identities, so this is a FALLBACK and never an alternative:
           preferring the hint while the adapter still works would tag the same
           person twice. Here the choice is the hint or nothing, and Gemini is
           the case that makes it matter — two Google accounts really are open
           side by side, and per-host counting cannot tell them apart. */
        if (!hint) throw error;
        value = await fromHint();
      }
    } else if (hint) {
      value = await fromHint();
    }
  } catch {
    // Signed out, offline, or the provider changed shape. An empty tag is a
    // valid answer: the page falls back to counting per host, which is what it
    // did before accounts existed.
    value = { acct: "", label: "", ordinal: 0, plan: "", identified: false };
  }
  acctCache.set(key, { at: Date.now(), value });
  return value;
}

// Hosts we count usage on but do not sync from. Keyed here so a usage tally and
// a sync checkpoint can never disagree about what a platform is called.
const PAGE_PLATFORMS = {
  "gemini.google.com": "gemini",
  "www.perplexity.ai": "perplexity",
  "chatgpt.com": "chatgpt",
  "chat.openai.com": "chatgpt",
  "claude.ai": "claude",
  "chat.deepseek.com": "deepseek",
  "grok.com": "grok"
};

const USAGE_PREFIX = "usage:";

/** Every per-account usage tally. Cleared with the archive.
 *
 *  `usage:` keys are the retired DOM-count tally. Nothing writes them any more
 *  (see the quota section below for what replaced them and why); this stays so
 *  that clearing the archive still removes them from installs that have them. */
async function clearUsage() {
  try {
    // key names only — the values are about to be deleted, so reading them back
    // out of the store first was the one cost this could avoid
    const keys = (await listLocalKeys()).filter(
      (k) => k.startsWith(USAGE_PREFIX) || k.startsWith(QUOTA_PREFIX)
    );
    if (keys.length) await chrome.storage.local.remove(keys);
  } catch { /* nothing to clear it from */ }
}

/* ============================ provider quota ==============================
 *
 * What is left of the user's allowance, according to the provider.
 *
 * This replaced a DOM-node counter, and the reason is worth keeping written
 * down, because the counter looked like it worked. It counted user-message
 * elements each tick and treated any increase as messages sent. On the four
 * hosts that mount only a conversation's tail (ChatGPT, Claude, Gemini, Grok)
 * scrolling up mounts old turns, so reading an old chat registered as sending
 * dozens of messages. And even with a perfect count it could not have been
 * right: these providers meter a rolling window weighted by TOKENS, not
 * messages, so no message count converts into an allowance. The old panel then
 * divided that count by a ceiling typed into a table by hand.
 *
 * So we ask the provider. Two mechanisms, one store:
 *
 *   OBSERVED — content/inject/quota-probe.js reads the quota headers and limit
 *   payloads the host app already receives. Free, and exact at the instant the
 *   allowance moves, because it is the app's own data.
 *
 *   POLLED — the endpoints below, called with the user's session the same way
 *   the history sync does. This is what catches messages sent on a phone or in
 *   another browser, which no in-page mechanism can ever see.
 *
 * The endpoint list is CANDIDATES, not knowledge. These are private, unversioned
 * endpoints; nobody outside the provider knows their shape and it changes. So
 * discovery is empirical: probe the candidates, keep the ones that actually
 * return something quota-shaped for this account, and poll only those. A
 * provider that answers nothing reports nothing, and the popup says so — the
 * one outcome we will not produce is a plausible number with no source.
 */

const QUOTA_PREFIX = "quota:";
const QUOTA_PROBE_KEY = "lct-quota-probe-v1";   // learned endpoints, per platform
const QUOTA_POLL_MIN_MS = 60 * 1000;            // never hit a provider oftener
const QUOTA_CTX_TTL = 5 * 60 * 1000;
const QUOTA_STALE_MS = 12 * 60 * 60 * 1000;
const QUOTA_PROBE_TTL = 24 * 60 * 60 * 1000;    // re-discover once a day

const quotaKey = (id, acct) => QUOTA_PREFIX + id + "|" + (acct || "");

/* An account can be tagged two ways — the page hint before an adapter can name
 * it, the provider's own id afterwards — and the record written under the old
 * tag used to survive as a second account in the panel forever. An identical
 * window fingerprint with an older reading is that ghost, never a real second
 * account: two live accounts keep diverging.
 */
const quotaFingerprint = (rec) =>
  (rec && Array.isArray(rec.windows) ? rec.windows : [])
    .map((w) => w.key + ":" + w.remaining + ":" + w.limit).join(",");

async function retireStaleQuotaTags(id, acct, fresh) {
  const fp = quotaFingerprint(fresh);
  if (!fp) return;
  const keep = quotaKey(id, acct);
  const all = await getByPrefix(QUOTA_PREFIX + id + "|", [QUOTA_PROBE_KEY]);
  const dead = [];
  for (const [key, rec] of Object.entries(all)) {
    if (key === keep || !rec || typeof rec !== "object") continue;
    if (quotaFingerprint(rec) !== fp) continue;
    if ((rec.observedAt || 0) >= (fresh.observedAt || 0)) continue;
    dead.push(key);
  }
  if (dead.length) await chrome.storage.local.remove(dead);
}

const quotaCtx = new Map();        // host -> { ctx, at }
const quotaPolledAt = new Map();   // id -> ms
const quotaInflight = new Map();   // id -> Promise
const QUOTA_POLLED_AT = "lct-quota-polled-at";

/* The same service-worker defect the session heartbeat had, except this Map is
   the only thing keeping us off somebody else's allowance endpoint. It dies with
   the worker every ~30s of idle, so QUOTA_POLL_MIN_MS was a minute on paper and
   a respawn in practice. storage.session survives the respawn and clears on
   browser restart, which is the one moment a fresh poll is wanted anyway. */
async function quotaLastPoll(id) {
  const mem = quotaPolledAt.get(id) || 0;
  const area = sessionArea();
  if (!area) return mem;
  try {
    const got = await area.get(QUOTA_POLLED_AT);
    const map = (got && got[QUOTA_POLLED_AT]) || {};
    return Math.max(mem, Number(map[id]) || 0);
  } catch { return mem; }
}

async function noteQuotaPoll(id, at) {
  quotaPolledAt.set(id, at);
  const area = sessionArea();
  if (!area) return;
  try {
    const got = await area.get(QUOTA_POLLED_AT);
    const map = (got && got[QUOTA_POLLED_AT]) || {};
    map[id] = at;
    await area.set({ [QUOTA_POLLED_AT]: map });
  } catch { /* the memory map stands in */ }
}

/**
 * Candidate allowance endpoints.
 *
 * `needsOrg` paths are templated with the organisation uuid the adapter's
 * prepare() already resolved. `auth: "bearer"` reuses the access token the
 * ChatGPT adapter fetches; everything else rides on cookies, which bgFetch
 * attaches.
 *
 * Gemini has no entry on purpose rather than by omission: its app talks over a
 * batched RPC with no readable allowance endpoint, and Google publishes no
 * message ceiling for it. Observation is the only route there, and if the app
 * never states a remaining share, Gemini honestly has none to show.
 */
const QUOTA_ENDPOINTS = {
  chatgpt: [
    /* The one that actually answers in 2026. conversation_limit is a 404 now,
       and this is where the app itself reads its limits — found by watching
       what chatgpt.com fetches rather than by guessing at endpoint names.
       It returns named counters ("deep_research: 25 left") rather than a
       percentage, which is why lib/quota.js had to learn to carry a count with
       no ceiling: a remaining with no limit is still a true and useful figure,
       and inventing a denominator for it would be the exact dishonesty this
       panel exists to avoid. */
    { path: "/backend-api/conversation/init", method: "POST", body: {}, auth: "bearer" },
    { path: "/backend-api/conversation_limit", auth: "bearer" },
    { path: "/backend-api/models?history_and_training_disabled=false", auth: "bearer" },
    { path: "/backend-api/subscriptions", auth: "bearer" },
    { path: "/backend-api/accounts/check/v4-2023-04-27", auth: "bearer" },
    { path: "/backend-api/me", auth: "bearer" },
    { path: "/public-api/conversation_limit", auth: "bearer" }
  ],
  claude: [
    { path: "/api/bootstrap" },
    { path: "/api/organizations/{org}/usage", needsOrg: true },
    { path: "/api/organizations/{org}/rate_limits", needsOrg: true },
    { path: "/api/organizations/{org}/usage_limits", needsOrg: true },
    { path: "/api/organizations/{org}", needsOrg: true },
    { path: "/api/account" }
  ],
  grok: [
    // Grok's own UI renders "queries remaining" from a POST, so the probe has
    // to be able to send a body to find it at all.
    { path: "/rest/rate-limits", method: "POST", body: { requestKind: "DEFAULT", modelName: "grok-4" } },
    { path: "/rest/rate-limits", method: "POST", body: { requestKind: "DEFAULT", modelName: "grok-3" } },
    { path: "/rest/subscriptions" },
    { path: "/rest/app-chat/rate-limits", method: "POST", body: { requestKind: "DEFAULT" } }
  ],
  perplexity: [
    /* Where its own app reads them. user/settings carries a quota per
       commercial data partner and no user allowance at all — which is how the
       panel came to report "100% left" from ahrefs, then apollo, then bmj. */
    { path: "/rest/rate-limit/status?version=2.18&source=default" },
    { path: "/rest/rate-limit/status" },
    { path: "/rest/user/settings" },
    { path: "/api/auth/session" },
    { path: "/rest/user/limits" }
  ],
  deepseek: [
    { path: "/api/v0/users/current" },
    { path: "/api/v0/chat/rate_limit" }
  ]
};

function quotaAdapter(idOrHost) {
  return BG_ADAPTERS.find((a) => a.id === idOrHost || a.host === idOrHost) || null;
}

async function quotaPrepare(adapter) {
  const hit = quotaCtx.get(adapter.host);
  if (hit && Date.now() - hit.at < QUOTA_CTX_TTL) return hit.ctx;
  const ctx = await adapter.prepare();
  quotaCtx.set(adapter.host, { ctx, at: Date.now() });
  return ctx;
}

/** One candidate, called once. Returns what it found and what it cost, because
 *  the probe report has to be able to say "this endpoint is gone" as clearly as
 *  it says "this one works". */
async function quotaTry(adapter, ctx, endpoint) {
  const org = ctx && (ctx.org || ctx.account) ? String(ctx.org || ctx.account) : "";
  if (endpoint.needsOrg && !org) return { path: endpoint.path, skipped: "no organisation" };

  const path = endpoint.path.replace("{org}", encodeURIComponent(org));
  const url = adapter.base + path;
  const headers = {};
  if (endpoint.auth === "bearer") {
    if (!ctx || !ctx.tok) return { path, skipped: "no token" };
    headers.Authorization = "Bearer " + ctx.tok;
  }
  // Two tries, eight seconds: an unfilled ring beats a dial that waits.
  const init = { method: endpoint.method || "GET", headers, attempts: 2, timeoutMs: 8000 };
  if (endpoint.body) {
    init.body = JSON.stringify(endpoint.body);
    headers["Content-Type"] = "application/json";
  }

  try {
    const response = await bgFetch(url, init);
    if (!response.ok) return { path, status: response.status, ok: false };
    const json = await bgJson(response);
    const windows = self.LCTQuota.fromJson(json, {});
    return {
      path, status: response.status, ok: true,
      method: init.method,
      body: endpoint.body || null,
      needsOrg: !!endpoint.needsOrg,
      auth: endpoint.auth || "cookie",
      windows,
      // The redacted shape is what makes a wrong reading diagnosable: it shows
      // which keys the provider sent without carrying any prose.
      sample: self.LCTQuota.redact(json, 0)
    };
  } catch (error) {
    return { path, ok: false, error: String((error && error.message) || error) };
  }
}

/* The signature says "are these the same candidates I learned against". Hashing
   only `path` missed every other way a candidate can change — method, body,
   auth, needsOrg — and Grok already ships two candidates on the identical path
   /rest/rate-limits differing only by body.modelName. Change that body to a new
   model and the stored `working` entry would keep being served for the whole
   24h QUOTA_PROBE_TTL, POSTing the old model, which is exactly the staleness
   the signature exists to prevent. */
function quotaSig(list) {
  return (list || []).map((e) => JSON.stringify([
    e.path, e.method || "", e.body || null, e.auth || "", !!e.needsOrg
  ])).join("|");
}

/**
 * Discover which candidates work for this account, and remember.
 *
 * Runs at most daily per platform. The stored report is also exactly what the
 * diagnostics panel shows the user, so "what did we learn" and "what can I
 * verify" are the same record rather than two that can disagree.
 */
async function quotaProbe(platformId, opts = {}) {
  const adapter = quotaAdapter(platformId);
  const candidates = QUOTA_ENDPOINTS[platformId] || [];
  const at = Date.now();
  // What this report is an answer ABOUT — see quotaLearned().
  const sig = quotaSig(candidates);
  if (!adapter || !candidates.length) {
    return { id: platformId, at, sig, endpoints: [], working: [],
      note: adapter ? "no candidate endpoints, observation only" : "unknown platform" };
  }

  let ctx;
  try {
    ctx = await quotaPrepare(adapter);
  } catch (error) {
    return { id: platformId, at, sig, endpoints: [], working: [],
      note: "not signed in or provider unreachable",
      error: String((error && error.message) || error) };
  }

  const endpoints = [];
  for (const endpoint of candidates) {
    endpoints.push(await quotaTry(adapter, ctx, endpoint));
    // Probing is a courtesy call on somebody else's server. bgFetch already
    // paces per host; this keeps a six-endpoint sweep from looking like a scan.
    await sleep(250);
  }

  const working = endpoints
    .filter((e) => e.ok && e.windows && e.windows.length)
    .map((e) => ({ path: e.path, method: e.method || "GET", body: e.body || null,
      needsOrg: !!e.needsOrg, auth: e.auth || "cookie" }));

  const report = {
    id: platformId, at, sig, plan: (ctx && ctx.plan) || "", endpoints, working,
    note: working.length ? "" : "provider published no allowance for this account"
  };

  if (!opts.dryRun) {
    try {
      const { [QUOTA_PROBE_KEY]: held } = await chrome.storage.local.get(QUOTA_PROBE_KEY);
      const all = held && typeof held === "object" ? held : {};
      all[platformId] = report;
      await chrome.storage.local.set({ [QUOTA_PROBE_KEY]: all });
    } catch { /* the reading still returns, it just is not remembered */ }
  }
  return report;
}

/** The endpoints we know work here, discovering them first if we never have. */
async function quotaLearned(platformId) {
  let report = null;
  try {
    const { [QUOTA_PROBE_KEY]: held } = await chrome.storage.local.get(QUOTA_PROBE_KEY);
    report = held && held[platformId] ? held[platformId] : null;
  } catch { /* fall through to a fresh probe */ }

  /* The learned list is also invalid when WE change the candidates. These
     endpoints move — ChatGPT's conversation_limit is a 404 now and the figures
     moved to conversation/init — so shipping a new candidate must take effect
     on the next poll, not a day later when the cache happens to expire. The
     signature is the candidate list itself; if it differs from what was learned
     against, what was learned is about a different question. */
  const sig = quotaSig(QUOTA_ENDPOINTS[platformId] || []);
  const fresh = report && report.sig === sig && Date.now() - (report.at || 0) < QUOTA_PROBE_TTL;
  if (fresh) return report.working || [];

  // Either we have never looked, or what we learned is a day old and these
  // endpoints move. Re-discover — it is a handful of calls, once.
  const next = await quotaProbe(platformId);
  return next.working || [];
}

/**
 * Read the provider's current allowance and store it.
 *
 * Deduplicated per platform: four tabs sending at once must produce one call,
 * not four, and the second caller wants the first call's answer anyway.
 */
async function quotaPoll(platformId, reason = "manual") {
  /* The switch, enforced where the network call is rather than only in the
     page. Every earlier caller was a content script, which checks the setting
     itself; the worker now polls on its own clock too, and "Allowance tracking
     off" has to mean no request leaves this browser for a provider's limits. */
  try {
    const { settings } = await chrome.storage.local.get("settings");
    if (settings && settings.quota === false) return { id: platformId, skipped: "tracking off" };
  } catch { /* no settings — the default is on */ }

  const inflight = quotaInflight.get(platformId);
  if (inflight) return inflight;

  const last = await quotaLastPoll(platformId);
  if (reason !== "manual" && Date.now() - last < QUOTA_POLL_MIN_MS) {
    return { id: platformId, skipped: "polled recently" };
  }

  const run = (async () => {
    const adapter = quotaAdapter(platformId);
    if (!adapter) return { id: platformId, skipped: "unknown platform" };

    const working = await quotaLearned(platformId);
    if (!working.length) return { id: platformId, skipped: "no working endpoint" };

    let ctx;
    try { ctx = await quotaPrepare(adapter); }
    catch { return { id: platformId, skipped: "not signed in" }; }

    const windows = [];
    for (const endpoint of working) {
      const result = await quotaTry(adapter, ctx, endpoint);
      if (result.ok && result.windows) windows.push(...result.windows);
    }
    await noteQuotaPoll(platformId, Date.now());
    if (!windows.length) return { id: platformId, skipped: "provider reported nothing" };

    const acct = await quotaAcctFor(adapter, ctx);
    await quotaStore(platformId, acct, {
      id: platformId, acct, plan: (ctx && ctx.plan) || "",
      windows, observedAt: Date.now(), source: "polled"
    });
    return { id: platformId, windows: windows.length };
  })();

  quotaInflight.set(platformId, run);
  try { return await run; }
  finally { quotaInflight.delete(platformId); }
}

/* ---------- asking every provider at once ----------
   Every caller of quotaPoll used to be a page, so a reading only ever existed
   for a platform whose site had been opened: a fresh install held no allowance, no
   plan for any account, and drew an empty panel until the user happened to
   visit a chat site. The worker holds the cookies and needs no tab, so it asks
   on its own. Sequential and paced — six providers at once on the user's own
   session is a pattern worth not looking like. */
const BG_QUOTA_SWEEP = "lct-quota-sweep-v1";
const BG_QUOTA_SWEEP_MIN_MS = 15 * 60 * 1000;
let sweepRunning = null;

async function quotaSweep(reason = "manual") {
  // One sweep at a time, and the second caller wants the first one's answer.
  if (sweepRunning) return sweepRunning;
  if (reason !== "manual" && reason !== "install") {
    let last = 0;
    try {
      const held = (await chrome.storage.local.get(BG_QUOTA_SWEEP))[BG_QUOTA_SWEEP];
      last = (held && held.at) || 0;
    } catch { /* no prior sweep */ }
    if (Date.now() - last < BG_QUOTA_SWEEP_MIN_MS) return { status: "throttled", last };
  }
  const run = (async () => {
    /* All six at once. Sequential-with-a-pause was borrowed from the history
       pass, where it stops eight concurrent requests landing on ONE host; these
       are six different hosts, one or two small requests each, and each host's
       own slot still paces it. Serialised, a single signed-out provider's
       timeout delayed every ring behind it — which is the whole first minute
       after install, the one minute the panel is being looked at. */
    const results = await Promise.all([...BG_PLATFORM_IDS].map((id) =>
      // A first sweep must not be silently dropped by the per-platform poll
      // floor, which a page visit seconds earlier would otherwise have armed.
      quotaPoll(id, reason === "install" ? "manual" : reason)));
    try { await chrome.storage.local.set({ [BG_QUOTA_SWEEP]: { at: Date.now(), reason } }); }
    catch { /* dead context */ }
    return { status: "done", results };
  })();
  sweepRunning = run;
  try { return await run; }
  finally { sweepRunning = null; }
}

/** The account tag a reading belongs to. Same tag the archive uses, so a
 *  quota row and a synced account are the same account. */
async function quotaAcctFor(adapter, ctx) {
  try { return await accountTag(adapter, ctx); }
  catch { return ""; }
}

/** Merge a reading into the stored record. The single writer — see
 *  content/quota.js for why this is not done in the content script. */
/* ---------- running out ----------
   The whole reason to read an allowance at all. Every account of this feature
   from the people who live with it says the same thing: there is no meter, no
   countdown and no warning — the first signal is "usage limit reached", by
   which point the session is over and the context you had built is gone.

   A panel showing "100% left" answers a question nobody asks. Being told at
   20% is the product. So this fires at most twice per window, per account, and
   only downward:

     · once under 20%, once under 10%
     · keyed to the window's own reset time, so a rollover re-arms it and a
       re-read of the same window does not fire twice
     · never when allowance tracking is off, and never when the user has said
       they do not want warnings

   No notification is worth a wrong one, so a reading with no percentage or no
   reset produces silence rather than a guess. */
const QUOTA_WARN_KEY = "lct-quota-warned-v1";
const QUOTA_WARN_STEPS = [20, 10];

let quotaWarnWrite = Promise.resolve();

async function quotaMaybeWarn(platformId, acct, record) {
  const work = () => quotaMaybeWarnNow(platformId, acct, record);
  quotaWarnWrite = quotaWarnWrite.then(work, work);
  return quotaWarnWrite;
}

// Read-modify-write over one storage key: two platforms polling at once lost
// one another's ledger entry and both warned again on the next read.
async function quotaMaybeWarnNow(platformId, acct, record) {
  let settings;
  try { settings = (await chrome.storage.local.get("settings")).settings; } catch { return; }
  if (settings && settings.quota === false) return;
  if (settings && settings.quotaWarn === false) return;

  const win = self.LCTQuota.primary(record);
  const pct = win && typeof win.pctLeft === "number" ? win.pctLeft : null;
  if (pct === null) return;

  /* The MOST SEVERE level crossed, not the first one listed. `find` returned 20
     for a reading of 7% — so falling from 15% to 7% looked like the same level
     already warned about, and the one warning that matters most never fired. */
  const crossed = QUOTA_WARN_STEPS.filter((s) => pct <= s);
  if (!crossed.length) return;
  const step = Math.min(...crossed);

  /* The window's own reset is the identity of "this window". Without one we
     cannot tell a fresh drop from the same drop re-read, so we stay quiet.

     Bucketed to five minutes rather than used to the millisecond: providers
     re-state the same deadline with a little drift — a rolling "in 3600
     seconds" resolves to a different absolute time on every read — and an
     identity that moves is an identity that re-arms the warning every time
     anyone looks. That is a notification every minute, which is how a useful
     warning becomes one people turn off. */
  const windowId = win.resetAt ? Math.round(win.resetAt / 3e5) : 0;
  if (!windowId) return;

  const id = `${platformId}|${acct || ""}`;
  let seen = {};
  try { seen = (await chrome.storage.local.get(QUOTA_WARN_KEY))[QUOTA_WARN_KEY] || {}; } catch { /* first time */ }
  const already = seen[id];
  // Same window, and we have already said something at this level or lower.
  if (already && already.windowId === windowId && already.step <= step) return;

  /* A different window winning primary() is not a new thing to say. primary()
     ranks by informativeness and then by the LOWEST pctLeft, and merge() pools
     windows from several endpoints — so on Perplexity the winner flips between
     meters with different reset times, each flip minting a new windowId and
     another notification, three of them inside a minute. The same happens
     across the acct tag: quotaObserved stores under "" before the handshake
     completes while quotaPoll stores under the real account, so one person got
     two ledger entries and two notifications for one allowance.
     Both are answered by the same rule: having just said something about this
     platform at this level or lower, say nothing more for a while. */
  const QUIET_MS = 30 * 60 * 1000;
  const spokeRecently = Object.entries(seen).some(([k, v]) =>
    v && v.at && k.split("|")[0] === platformId &&
    v.at + QUIET_MS > Date.now() && v.step <= step);
  if (spokeRecently) return;

  seen[id] = { windowId, step, at: Date.now() };
  /* Prune by WHEN WE WARNED, not by the window id — the id is a five-minute
     bucket, not a timestamp, and treating it as one made every record look
     ancient the instant it was written. Which meant the ledger was always
     empty, and every re-read of the same low number warned again. */
  for (const [k, v] of Object.entries(seen)) {
    if (!v || !v.at || v.at + 7 * 864e5 < Date.now()) delete seen[k];
  }
  try { await chrome.storage.local.set({ [QUOTA_WARN_KEY]: seen }); } catch { /* dead context */ }

  const label = (BG_ADAPTERS.find((a) => a.id === platformId) || {}).label || platformId;
  const when = win.resetAt ? new Date(win.resetAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
  try {
    if (!chrome.notifications || !chrome.notifications.create) return;
    await chrome.notifications.create(`lct-quota-${id}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: `${label}: ${Math.round(pct)}% of your allowance left`,
      message: when
        ? `Wrap up or switch models. It resets at ${when}.`
        : "Wrap up or switch models before it runs out.",
      priority: pct <= 10 ? 2 : 1
    });
  } catch { /* notifications unavailable — the popup still shows it */ }
}

async function quotaStore(platformId, acct, reading) {
  const key = quotaKey(platformId, acct);
  try {
    const held = await chrome.storage.local.get(key);
    const merged = self.LCTQuota.merge(held[key] || null, reading, { staleMs: QUOTA_STALE_MS });
    // An unchanged reading must not be written. chrome.storage fires onChanged
    // on every set, the popup repaints on quota keys, and the popup asks for a
    // refresh when it opens — writing a byte-identical record would make those
    // three into a repaint loop. A re-read that says the same thing is not news.
    if (held[key] && JSON.stringify(held[key]) === JSON.stringify(merged)) return merged;
    await chrome.storage.local.set({ [key]: merged });
    retireStaleQuotaTags(platformId, acct, merged).catch(() => { /* best effort */ });
    quotaMaybeWarn(platformId, acct, merged).catch(() => { /* never block a write */ });
    return merged;
  } catch {
    return null;
  }
}

/**
 * Fold in what a content script saw the host app receive.
 *
 * The account is resolved here from the host, which means an observation made
 * before the account handshake completes lands on the host-wide tag and a later
 * one lands on the account — the same fallback the archive uses. Both describe
 * the same person; only the label differs.
 */
async function quotaObserved(host, observations, hint = "") {
  const platformId = PAGE_PLATFORMS[host] || "";
  if (!platformId || !Array.isArray(observations) || !observations.length) return { ok: false };

  const windows = [];
  let at = 0;
  for (const item of observations.slice(0, 24)) {
    if (!item || typeof item !== "object") continue;
    at = Math.max(at, Number(item.at) || 0);
    try {
      if (item.kind === "headers" && item.headers) {
        windows.push(...self.LCTQuota.fromHeaders(item.headers, {}));
      } else if (item.kind === "body" && item.json) {
        windows.push(...self.LCTQuota.fromJson(item.json, {}));
      }
    } catch { /* one malformed observation must not drop the batch */ }
  }
  if (!windows.length) return { ok: true, windows: 0 };

  // The observation already happened; resolving the account must not be allowed
  // to lose it, so a failed handshake stores against the host-wide tag.
  let acct = "";
  let plan = "";
  try {
    const who = await accountForHost(host, hint);
    acct = who.acct || "";
    plan = who.plan || "";
  } catch { /* host-wide tag it is */ }

  await quotaStore(platformId, acct, {
    id: platformId, acct, plan,
    windows, observedAt: at || Date.now(), source: "observed"
  });
  return { ok: true, windows: windows.length };
}

/** Every stored reading, for the popup. Shaped for rendering, not for storage:
 *  the popup gets the one window it should draw plus the provenance it needs to
 *  be honest about where the figure came from. */
async function quotaState() {
  const out = [];
  let probes = {};
  try {
    const all = await getByPrefix(QUOTA_PREFIX, [QUOTA_PROBE_KEY]);
    probes = all[QUOTA_PROBE_KEY] || {};
    for (const [key, record] of Object.entries(all)) {
      if (!key.startsWith(QUOTA_PREFIX) || !record || typeof record !== "object") continue;
      const win = self.LCTQuota.primary(record, {});
      out.push({
        id: record.id || key.slice(QUOTA_PREFIX.length).split("|")[0],
        acct: record.acct || "",
        plan: record.plan || "",
        observedAt: record.observedAt || 0,
        source: record.source || "",
        window: win
          ? { key: win.key, label: win.label, pctLeft: win.pctLeft, resetAt: win.resetAt,
              basis: win.basis, unit: win.unit, remaining: win.remaining, limit: win.limit,
              observedAt: win.observedAt || 0, source: win.source || "" }
          : null,
        windows: (record.windows || []).length
      });
    }
  } catch { /* an empty state renders as "not reported", which is true */ }

  // Which platforms have been asked at all, so the popup can distinguish
  // "nothing published" from "never checked".
  const checked = {};
  for (const [id, report] of Object.entries(probes)) {
    checked[id] = { at: report.at || 0, working: (report.working || []).length,
      note: report.note || "" };
  }
  return { records: out, checked, observable: Object.keys(PAGE_PLATFORMS) };
}

/** The comparison report the diagnostics panel renders. Runs a live probe so
 *  the user is checking what the provider says right now against what we show
 *  right now — a stale probe would make a disagreement unattributable. */
async function quotaDiagnose(platformId) {
  /* Every supported platform, not only the ones with candidate endpoints. A
     provider we cannot poll still belongs on this page: Gemini reports nothing
     readable, and the user is entitled to see that stated rather than to find
     it missing and wonder whether it was forgotten. */
  const ids = platformId
    ? [platformId]
    : Array.from(new Set(Object.values(PAGE_PLATFORMS))).filter((id) => quotaAdapter(id));
  const out = [];
  for (const id of ids) {
    const probe = await quotaProbe(id);
    const acct = await (async () => {
      const adapter = quotaAdapter(id);
      if (!adapter) return "";
      try { return await quotaAcctFor(adapter, await quotaPrepare(adapter)); }
      catch { return ""; }
    })();
    let stored = null;
    try {
      const key = quotaKey(id, acct);
      stored = (await chrome.storage.local.get(key))[key] || null;
    } catch { /* nothing stored yet */ }
    out.push({ id, acct, probe, stored, shown: stored ? self.LCTQuota.primary(stored, {}) : null });
  }
  return { at: Date.now(), platforms: out };
}

async function sweepDue(platformId) {
  try {
    const { [BG_SWEEP_STATE]: state } = await chrome.storage.local.get(BG_SWEEP_STATE);
    const at = (state && state[platformId]) || 0;
    return Date.now() - at > BG_SWEEP_MS;
  } catch { return false; }
}

/* Kept so the UI can explain a silence: "we saw most of your history vanish
   from the listing and did not believe it" is information the user wants. */
async function noteSweepAnomaly(platformId, missing, archived) {
  try {
    const { [BG_SWEEP_STATE]: state } = await chrome.storage.local.get(BG_SWEEP_STATE);
    const next = state && typeof state === "object" ? state : {};
    next.anomaly = { platform: platformId, missing, archived, at: Date.now() };
    await chrome.storage.local.set({ [BG_SWEEP_STATE]: next });
  } catch { /* nothing to record it in */ }
}

async function markSwept(platformId) {
  try {
    const { [BG_SWEEP_STATE]: state } = await chrome.storage.local.get(BG_SWEEP_STATE);
    const next = state && typeof state === "object" ? state : {};
    next[platformId] = Date.now();
    await chrome.storage.local.set({ [BG_SWEEP_STATE]: next });
  } catch { /* next pass sweeps instead */ }
}

/**
 * The whole conversation as a per-message index, for ONE chat.
 *
 * Stale-while-revalidate: an archived copy that carries message ids is served
 * with zero network so the map is complete before the first paint; the caller
 * re-asks with force once it has painted, and only then do we pay the round
 * trip. Every failure is a status, never a throw — no index just means the map
 * falls back to what the host has mounted, which is where it started.
 */
async function chatIndex(host, path, opts = {}) {
  const adapter = BG_ADAPTERS.find((a) => a.host === host && String(path || "").startsWith(a.prefix));
  // Gemini and Perplexity have no history endpoint here at all — answer before
  // touching the network rather than failing somewhere deeper.
  if (!adapter || adapter.id !== "chatgpt" || !adapter.detailFull) return { status: "unsupported" };
  const convId = String(path).slice(adapter.prefix.length).split(/[?#/]/)[0];
  if (!convId) return { status: "unsupported" };
  const recordId = adapter.host + adapter.prefix + convId;

  if (!opts.force) {
    try {
      const d = await db();
      const rec = await reqP(tx(d, "readonly").get(recordId));
      if (rec && rec.mv === 1 && rec.n >= 2) {
        return { status: "ok", source: "archive", stale: true, entries: indexFromMsgs(rec.msgs), title: rec.title || "" };
      }
    } catch { /* fall through to the provider */ }
  }

  const inflight = idxInflight.get(recordId);
  if (inflight) return inflight;
  if (opts.force && Date.now() - (idxFetchedAt.get(recordId) || 0) < IDX_FRESH_MS) {
    return { status: "fresh" };
  }

  const run = (async () => {
    try {
      const ctx = await idxPrepare(adapter);
      const full = await adapter.detailFull(ctx, convId, opts.foreground ? { foreground: true } : undefined);
      idxFetchedAt.set(recordId, Date.now());
      if (full.msgs.length >= 2) {
        // importBatch, not upsert: it already refuses to overwrite a newer
        // archived revision, and reading a chat should never lose one.
        await importBatch([{
          id: recordId, host: adapter.host, path: adapter.prefix + convId,
          platform: adapter.label, title: full.title,
          createdAt: full.createdAt, updatedAt: full.updatedAt || Date.now(),
          sourceUpdatedAt: full.updatedAt, msgs: full.msgs
        }]);
      }
      return { status: "ok", source: "provider", stale: false, entries: indexFromMsgs(full.msgs), title: full.title };
    } catch (error) {
      const kind = (error && error.kind) || "net";
      // Deleted upstream. Quarantine it and ask — deleting on sight would make
      // the archive lose exactly what the user may have opened it to recover.
      if (kind === "gone") {
        idxCtx.delete(adapter.host);
        await noteVanished(recordId, { platform: adapter.id, host: adapter.host, path: adapter.prefix + convId }, "opened");
      }
      if (kind === "auth") idxCtx.delete(adapter.host);
      // Pass the provider's own Retry-After through. A caller that has to guess
      // how long a 429 lasts either gives up too early or hammers it.
      const retryAfterMs = Number(error && error.retryAfterMs) || 0;
      return retryAfterMs ? { status: kind, retryAfterMs } : { status: kind };
    } finally {
      idxInflight.delete(recordId);
    }
  })();
  idxInflight.set(recordId, run);
  return run;
}

/* ---------- progress (coalesced) ----------
 * One write per BG_PROGRESS_MS instead of two per chat: a 256-chat pass used to
 * fire ~512 storage writes and as many full UI repaints. */

let progressPending = null;
let progressTimer = null;
let progressAt = 0;

async function flushProgress() {
  if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; }
  const p = progressPending;
  if (!p) return;
  progressPending = null;
  progressAt = Date.now();
  try {
    await chrome.storage.local.set({
      [BG_SYNC_PROG(p.platform)]: p.record,
      ...(p.run ? { [BG_RUN]: { ...p.run, heartbeatAt: Date.now(), platform: p.platform } } : {})
    });
  } catch { /* dead context */ }
}

function writeProgress(adapter, run, fields, opts = {}) {
  const record = {
    state: "syncing", phase: "syncing", runId: run && run.id, platform: adapter.id,
    at: Date.now(), ...fields
  };
  // `done` stays an alias of `attempted` for the popup and Recall page.
  if (record.attempted != null && record.done == null) record.done = record.attempted;
  progressPending = { platform: adapter.id, record, run };
  const due = progressAt + BG_PROGRESS_MS - Date.now();
  if (opts.force || due <= 0) return flushProgress();
  if (!progressTimer) progressTimer = setTimeout(() => { flushProgress(); }, due);
  return Promise.resolve();
}

async function finishPlatform(adapter, checkpointKey, checkpoint, result, fields, message, coverage) {
  const completedAt = Date.now();
  await saveCheckpoint(checkpointKey, {
    ...checkpoint,
    version: 5,
    platform: adapter.id,
    completedAt,
    lastResult: result,
    coverage: Math.max(0, Number(coverage) || 0),
    coverageKnown: true
  });
  await clearJob(checkpointKey);
  progressPending = null;
  if (progressTimer) { clearTimeout(progressTimer); progressTimer = null; }
  await chrome.storage.local.set({
    [BG_SYNC_PROG(adapter.id)]: {
      state: "done", phase: "up-to-date", result, msg: message, at: completedAt,
      runId: checkpoint.runId, platform: adapter.id,
      done: fields.attempted || 0, ...fields
    },
    [BG_SYNC_FLAG(adapter.id)]: { lastFull: completedAt }
  });
}

/* Is one of this site's tabs open? Not "is the user looking at it" — that
   question is deliberately not asked any more. Whether the browser is the
   front application, and which of its windows holds focus, decide nothing:
   the archive has to build while the user is in another app, which is most of
   the time. The answer here only sets the request rate, never whether a pass
   runs at all.

   Needs no "tabs" permission — tab.url is populated for hosts we already hold
   permission for. */
async function tabPresence(host) {
  try {
    if (typeof chrome.tabs === "undefined") return { open: false };
    return presenceFrom(await chrome.tabs.query({}), host);
  } catch { return { open: false }; }
}

/* The decision itself, with the browser taken out of it. */
function presenceFrom(tabs, host) {
  for (const t of (Array.isArray(tabs) ? tabs : [])) {
    let h = "";
    try { h = new URL((t && t.url) || "").hostname; } catch { /* opaque tab */ }
    if (host && h === host) return { open: true };
  }
  return { open: false };
}

/**
 * Reconcile one provider against the local archive.
 *
 * Authority order:
 *
 *   1. The archive index (what this browser actually holds) decides what gets
 *      downloaded. A chat is fetched only when it is absent, or when the
 *      provider's revision is newer than the archived one.
 *   2. The outstanding-work journal holds everything this pass still intends to
 *      fetch. It is written WITH the advanced watermark before the first detail
 *      request, so an interrupted or fully rate-limited pass still leaves a
 *      trustworthy checkpoint behind and the next pass resumes instead of
 *      re-listing the whole history.
 *   3. The checkpoint watermark only decides how much metadata to LIST, and is
 *      trusted only while coverage holds AND the journal matches it. A
 *      reinstall, a wipe, or a lost journal widens the pass to a full listing —
 *      which still downloads nothing already archived, because rule 1 outranks
 *      it.
 */
/**
 * One platform, however many accounts are signed into it.
 *
 * The gates that belong to the HOST — rate-limit cooldown, and staying out of
 * the way while the user is on the site — are answered once here. Everything
 * downstream of a session belongs to an ACCOUNT, and each gets its own pass:
 * its own checkpoint, its own outstanding-work journal, its own view of the
 * archive. A Claude login with three organisations is three passes.
 */
async function bgSyncPlatform(adapter, run, opts = {}) {

  // 1. host cooling down from an earlier 429 — say so, don't grind
  const cooldownUntil = await loadCooldown(adapter.host);
  if (cooldownUntil > Date.now()) {
    await chrome.storage.local.set({
      [BG_SYNC_PROG(adapter.id)]: {
        state: "paused", phase: "paused", runId: run.id, platform: adapter.id,
        done: 0, total: 0, cooldownUntil,
        msg: `${adapter.label} is rate-limiting. It resumes automatically.`, at: Date.now()
      }
    });
    return { ok: true, result: "cooling-down" };
  }

  /* 2. how hard to push, not whether to go.
     This used to defer the whole pass while a tab of the site was frontmost.
     It read "frontmost in its own window" plus "Chrome's last focused window",
     and neither goes false when the user switches to another application — so
     a chat site left open held the pass off indefinitely and the archive only
     ever moved when the popup forced a manual run. An unattended pass now
     always runs; an open tab only drops it to one request at a time. */
  const tabs = await tabPresence(adapter.host);

  let contexts;
  try {
    await writeProgress(adapter, run, { phase: "checking", attempted: 0, total: 0, msg: "Connecting…" }, { force: true });
    const primary = await adapter.prepare();
    contexts = (adapter.accounts ? await adapter.accounts(primary) : [primary]).filter(Boolean);
    if (!contexts.length) contexts = [primary];
  } catch (error) {
    return reportPlatformError(adapter, run, error, { attempted: 0, total: 0, succeeded: 0, failed: 0 });
  }

  const results = [];
  for (let seat = 0; seat < contexts.length; seat++) {
    results.push(await bgSyncAccount(adapter, run, opts, contexts[seat], tabs,
      { seat, seats: contexts.length }));
    // Two accounts on one host back to back is still one host being asked
    // twice; pace them like any other pair of listing requests.
    if (seat + 1 < contexts.length) await sleep(policyFor(adapter.host).listDelayMs);
  }
  return mergeAccountResults(results);
}

/** One verdict for a platform from one verdict per account. The most
 *  "unfinished" outcome wins, because that is what schedules a resume. */
function mergeAccountResults(results) {
  if (results.length === 1) return results[0];
  const failure = results.find((r) => r && !r.ok);
  if (failure) {
    return { ok: false, error: failure.error, signedOut: !!failure.signedOut, accounts: results.length };
  }
  const rank = ["rate-limited", "partial", "reconcile", "sweep", "delta", "up-to-date"];
  return {
    ok: true,
    result: rank.find((name) => results.some((r) => r && r.result === name)) || "up-to-date",
    archived: results.reduce((sum, r) => sum + (Number(r && r.archived) || 0), 0),
    left: results.reduce((sum, r) => sum + (Number(r && r.left) || 0), 0),
    accounts: results.length
  };
}

async function bgSyncAccount(adapter, run, opts, ctx, tabs, seat = { seat: 0, seats: 1 }) {
  /* The budget clock starts HERE, not at the fetch loop below.
     Started at the fetch loop it did not count the listing, and on a large
     history the listing is the expensive half: pages of titles, one request at
     a time, minutes of it. A pass could then spend ten minutes listing and take
     a full four more to fetch — long past the point where the worker is
     reclaimed, so the same listing was redone next pass and the archive sat at
     the same percentage forever. Everything this pass does now shares one
     budget, and whatever it did not reach is journalled for the next one. */
  const passStart = Date.now();
  let attempted = 0, succeeded = 0, failed = 0, total = 0;
  try {
    const { key: provisionalKey, checkpoint: provisionalCheckpoint } = await readCheckpoint(adapter, ctx);
    let checkpointKey = provisionalKey;
    let checkpoint = provisionalCheckpoint;
    let job = await readJob(checkpointKey);
    let acct = tagOfKey(checkpointKey);
    await setActiveAccount(adapter, checkpointKey);
    await noteAccount(adapter.id, acct, {
      handle: ctx.handle, plan: ctx.plan, identified: ctx.identified !== false
    });

    await writeProgress(adapter, run, { phase: "checking", attempted: 0, total: 0,
      msg: seat.seats > 1
        ? `Reading your local archive… (account ${seat.seat + 1} of ${seat.seats})`
        : "Reading your local archive…" });
    // Two views, two jobs. `index` answers "already held?" across every account
    // on the host so nothing is downloaded twice; `acctIndex` answers "held by
    // THIS account?", and only it may drive deletion and coverage.
    const index = await archiveIndex(adapter.host, adapter.prefix);
    let acctIndex = await accountIndex(adapter.host, adapter.prefix, acct);
    const covered = checkpoint && checkpoint.coverageKnown ? Number(checkpoint.coverage) || 0 : -1;
    // The journal may run AHEAD of pendingCount (it flushes far more often than
    // the sync ledger), never behind. scanStartedAt proves both came from the
    // same pass; a missing journal with work outstanding forces a full listing.
    const pendingOk = !(checkpoint && checkpoint.pendingCount) ||
      !!(job && job.scanStartedAt === checkpoint.safeWatermark &&
         job.pending.length <= checkpoint.pendingCount);
    // Coverage is compared against what THIS account holds. Against the whole
    // host it was worse than useless once a second account existed: the second
    // account's rows padded the count, so the check that exists to notice a
    // wiped archive could no longer notice one.
    const coverageOk = covered >= 0 && acctIndex.size >= covered;
    // The archive is gone and a backup of it exists: a reinstall, not a bug.
    // See restoreHeld(). The coverage guard is right that something is wrong;
    // rebuilding the whole history from the providers is the wrong repair.
    let holding = !coverageOk && covered > 0 && acctIndex.size === 0 && await restoreHeld();
    const trustWatermark = !!(checkpoint && checkpoint.safeWatermark &&
      (holding || (coverageOk && pendingOk)));
    /* A held pass archives what is new and rewrites nothing else. The
       checkpoint is the only surviving evidence that this account once held
       `covered` chats and how much was still outstanding when the archive
       died. Zeroing either turns "wiped" into "complete", and the old history
       would never be rebuilt even after the user declines the restore. */
    let holdKeep = holding ? {
      coverage: covered, coverageKnown: true,
      safeWatermark: checkpoint.safeWatermark,
      pendingCount: checkpoint.pendingCount || 0,
      passState: checkpoint.passState || "clean"
    } : null;
    const holdCoverage = (n) => holding ? covered : n;
    let heldSince = holding ? Math.max(0, checkpoint.safeWatermark - BG_SYNC_OVERLAP_MS) : 0;
    const doneMsg = () => holding
      ? "New chats captured \u00b7 restore your backup for the rest"
      : "Everything is already backed up";
    // A delta listing cannot see a deletion: a chat the user removed simply is
    // not in the window, exactly like a chat that never changed. Once a day the
    // pass lists everything instead, purely so vanished chats can be noticed.
    // It costs listing requests only — rule 1 still downloads nothing already
    // archived.
    const sweeping = trustWatermark && acctIndex.size > 0 && await sweepDue(adapter.id) &&
      (await deletionPolicy()) !== "keep";
    // A provider that will not name the signed-in account is re-identified from
    // its listing every pass, so the listing has to be a complete one. Listing
    // is cheap — rule 1 still downloads nothing already archived — and the
    // alternative is writing one account's chats under another's name.
    const mustIdentify = ctx.identified === false;
    const sinceMs = trustWatermark && !sweeping && !mustIdentify
      ? Math.max(0, checkpoint.safeWatermark - BG_SYNC_OVERLAP_MS) : 0;
    const mode = sweeping ? "sweep" : trustWatermark ? "delta" : "reconcile";
    let carried = trustWatermark && job ? job.pending : [];
    // Captured BEFORE listing on purpose: a chat that shifts pages mid-listing
    // still has a revision >= this, so the next pass re-lists it.
    const scanStartedAt = Date.now();

    // 3. one request to answer "anything new?" on a routine pass. Skipped while
    //    sweeping — "nothing new" says nothing about what was removed.
    if (trustWatermark && !sweeping && !mustIdentify && !carried.length && adapter.peek) {
      const { hasNew } = await adapter.peek(ctx, sinceMs);
      if (!hasNew) {
        await finishPlatform(adapter, checkpointKey,
          { ...checkpoint, safeWatermark: scanStartedAt, pendingCount: 0, passState: "clean",
            runId: run.id, acctScoped: true, ...(holdKeep || {}) },
          "up-to-date", { attempted: 0, total: 0, succeeded: 0, failed: 0 },
          doneMsg(), holdCoverage(acctIndex.size));
        return { ok: true, result: "up-to-date", mode };
      }
    }

    const progress = (count, listedTotal, msg) =>
      writeProgress(adapter, run, { phase: "checking", attempted: count || 0, total: listedTotal || 0,
        msg: msg || "Checking for new chats…" });
    await writeProgress(adapter, run, { phase: "checking", attempted: 0, total: 0,
      msg: mode === "delta" ? "Checking for new chats…"
        : mode === "sweep" ? "Checking which chats still exist…"
        : index.size ? "Rebuilding the archive index…" : "Building the first archive index…" });

    const listed = await adapter.list(ctx, sinceMs, progress);
    // The provider named conversations and this adapter recognised none of
    // them — a field it reads has been renamed upstream. That is not an empty
    // account, and reporting it as a clean pass is how Grok came to archive
    // nothing at all while every check came back green. Fail loudly, before
    // anything is written and before the watermark can move past chats that
    // were never actually seen.
    if (listed.unreadable) throw new BgError("shape", "provider listing not understood");
    const metas = listed.metas || [];
    const complete = listed.complete !== false;
    const prefix = adapter.host + adapter.prefix;

    // 3a. Whose listing was that? Providers that name the account answered this
    //     before the first request; the rest are identified by what they hold.
    let anchor = (checkpoint && checkpoint.anchor) || "";
    let strangerAccount = false;
    if (mustIdentify) {
      const resolved = await resolveAnchor(adapter, checkpointKey, checkpoint, metas, complete);
      anchor = resolved.anchor;
      if (resolved.switched) {
        // A different account than the checkpoint we opened with. Everything
        // account-shaped has to be re-read under its own key before a single
        // byte is written, and its pending set is not ours to carry.
        checkpointKey = resolved.key;
        checkpoint = (await readLedger()).checkpoints[checkpointKey] || null;
        job = await readJob(checkpointKey);
        acct = tagOfKey(checkpointKey);
        acctIndex = await accountIndex(adapter.host, adapter.prefix, acct);
        carried = [];
        strangerAccount = true;
        // The hold was computed against the checkpoint this pass opened with.
        // This is a different account: its coverage, its watermark and its
        // restore decision are its own, and carrying the previous account's
        // over would write one account's history under another's name.
        holding = false; holdKeep = null; heldSince = 0;
        await setActiveAccount(adapter, checkpointKey);
        await noteAccount(adapter.id, acct, { identified: false });
      }
    }

    const listedIds = new Set(metas.map((m) => prefix + m.id));

    // 3b. Appearing in this account's listing is proof of ownership, and the
    //     only proof used. It is also what migrates an archive built before
    //     chats were attributed at all: whatever the listing names, the account
    //     claims. Anything it does not name keeps whatever it had — which for a
    //     legacy row is nothing, and an unattributed row is invisible to every
    //     account's sweep. That is the property that makes this safe to ship.
    if (metas.length) {
      const orphans = [];
      for (const id of listedIds) {
        if (index.has(id) && acctIndex.get(id) === undefined) orphans.push(id);
      }
      if (orphans.length) {
        const { claimed, more } = await adoptRecords(orphans, acct);
        for (const id of claimed) acctIndex.set(id, index.get(id) || 0);
        if (more) {
          await writeProgress(adapter, run, { phase: "checking", attempted: 0, total: 0,
            msg: "Matching archived chats to this account…" });
        }
      }
    }

    // 3c. The listing covered the whole history, so anything THIS ACCOUNT holds
    //     and the listing does not name is gone upstream. Never destructive by
    //     itself — noteVanished() honours the user's policy, and the default is
    //     to ask.
    //
    //     Scoped to the account for a blunt reason: on a complete listing the
    //     host-wide archive index put every other account's chats up for
    //     deletion, and a first sync of a second account is always a complete
    //     listing. A stranger account is skipped outright — a listing from an
    //     account we have never seen before is evidence about nobody.
    const sweepAllowed = (sweeping || !trustWatermark) && !strangerAccount;
    if (sinceMs === 0 && complete && sweepAllowed && metas.length <= BG_PENDING_MAX) {
      const pendingIds = new Set(carried.map((p) => p.id));
      await sweepVanished(adapter, acctIndex, listedIds, scanStartedAt, pendingIds);
      await markSwept(adapter.id);
    }

    // 4. work = carried-over pending ∪ freshly listed, fresh meta winning,
    //    minus anything the archive already holds at that revision or newer.
    const byId = new Map();
    for (const p of carried) byId.set(p.id, { id: p.id, rev: p.rev, title: p.title, createdAt: p.createdAt, attempts: p.attempts || 0 });
    for (const m of metas) byId.set(m.id, { id: m.id, rev: m.updatedAt, title: m.title, createdAt: m.createdAt, attempts: 0 });
    /* A stub is NOT an archived chat. Comparing revisions alone treated a
       title-only record as finished — same revision as the real conversation,
       because that is where the title came from — so its text was never
       fetched and never would be. */
    const stubIds = new Set((await readStubs())[adapter.id] || []);
    const work = Array.from(byId.values()).filter((w) => {
      const recordId = adapter.host + adapter.prefix + w.id;
      // Belt and braces for a provider that must be re-identified from a
      // COMPLETE listing: sinceMs cannot prune that one, so prune the work.
      // Without this, holding a restore still re-downloaded every chat there.
      if (heldSince && w.rev <= heldSince) return false;
      const archivedRevision = index.get(recordId);
      if (archivedRevision === undefined || archivedRevision < w.rev) return true;
      return stubIds.has(recordId);
    });

    if (!work.length) {
      await finishPlatform(adapter, checkpointKey,
        { ...checkpoint, safeWatermark: complete ? scanStartedAt : (checkpoint?.safeWatermark || 0),
          pendingCount: 0, passState: complete ? "clean" : "partial", runId: run.id,
          anchor, acctScoped: true, ...(holdKeep || {}) },
        "up-to-date", { attempted: metas.length, total: metas.length, succeeded: 0, failed: 0 },
        doneMsg(), holdCoverage(await accountCount(acct)));
      return { ok: true, result: "up-to-date", mode };
    }

    total = work.length;
    const overflow = work.length > BG_PENDING_MAX;

    // 5. Persist the watermark and the FULL outstanding set before fetching
    //    anything. This is what lets a first pass that is rate-limited on every
    //    single chat still leave a resumable checkpoint behind.
    await writeJob(checkpointKey, { platform: adapter.id, scanStartedAt, pending: work,
      tombstones: job ? job.tombstones : [] });
    const baseCoverage = await accountCount(acct);
    await saveCheckpoint(checkpointKey, {
      version: 5, platform: adapter.id, anchor, acctScoped: true,
      safeWatermark: complete && !overflow ? scanStartedAt : (checkpoint?.safeWatermark || 0),
      completedAt: Date.now(), lastResult: mode,
      archived: checkpoint?.archived || 0,
      coverage: baseCoverage, coverageKnown: true,
      pendingCount: work.length,
      passState: complete && !overflow ? "clean" : "partial",
      cooldownUntil: 0, runId: String(run.id).slice(0, 8),
      ...(holdKeep || {})
    });

    // 6. fetch loop
    const concurrency = Math.max(1, tabs.open
      ? 1                                     // a tab of the site is open
      : policyFor(adapter.host).concurrency);
    const fetchDeadline = Math.max(passStart + BG_PASS_BUDGET_MS, Date.now() + BG_MIN_FETCH_MS);
    let cursor = 0, archived = 0, fatal = null, circuitOpen = false, budgetHit = false;
    const importQueue = [];
    const settled = [], gone = [];
    let journalAt = Date.now();

    const flushQueue = async (force) => {
      if (importQueue.length) {
        const batch = importQueue.splice(0);
        const result = await importBatch(batch);
        archived += result.ok;
        succeeded += result.ok;
        failed += result.failed.length;
        for (const id of result.stored) settled.push(id.slice((adapter.host + adapter.prefix).length));
      }
      const due = force || Date.now() - journalAt > BG_JOURNAL_FLUSH_MS;
      if (settled.length || gone.length) {
        // Always update the in-memory set; only pay for a storage write when
        // the debounce is due.
        await dropFromJob(checkpointKey, settled.splice(0), gone.splice(0), due);
      } else if (due) {
        await flushJournal();
      }
      if (due) journalAt = Date.now();
    };

    const worker = async () => {
      while (!fatal && !circuitOpen && !budgetHit) {
        const slot = cursor++;
        if (slot >= total) return;
        if (Date.now() > fetchDeadline) {
          budgetHit = true;
          trace("budget", `${adapter.id} stopped at ${attempted}/${total}`);
          return;
        }
        const item = work[slot];
        try {
          const msgs = await adapter.detail(ctx, item.id);
          const record = {
            id: adapter.host + adapter.prefix + item.id,
            host: adapter.host, path: adapter.prefix + item.id,
            platform: adapter.label, title: item.title,
            createdAt: item.createdAt, updatedAt: item.rev,
            // Always the LISTED revision: stamping the fetch time would claim a
            // revision we never verified and mask the next real update.
            sourceUpdatedAt: item.rev,
            // The account whose listing produced this chat. Written at the same
            // moment as the chat itself, so a row is never in the archive
            // without knowing who it belongs to.
            acct, msgs
          };
          if (msgs.length < 2) {
            record.msgs = []; record.meta = true;
            /* Finished, not pending. importBatch records hasBody=false for a
               meta write, so without this the id stays in the stub list and
               every pass for the life of the install re-fetches a conversation
               that will never have a body — and "everything is already backed
               up" is unreachable. fillStart:4089 already gets this right. */
            await noteStub(record.id, adapter.host, true);
          }
          importQueue.push(record);
          if (importQueue.length >= BG_SYNC_BATCH) await flushQueue();
        } catch (error) {
          const kind = error && error.kind;
          const reason = String((error && error.message) || error);
          if (kind === "auth" || reason.includes("unauthorized")) { fatal = error; return; }
          // Deleted upstream: it leaves the journal either way (there is nothing
          // left to fetch), but whether the ARCHIVED copy goes is the user's
          // call, not the provider's.
          if (kind === "gone") {
            gone.push(item.id);
            await noteVanished(adapter.host + adapter.prefix + item.id,
              { platform: adapter.id, host: adapter.host, path: adapter.prefix + item.id }, "sync");
          }
          // Anything not archived stays in the journal, so an abandoned slot is
          // simply retried next pass — no cursor rewind needed.
          else if (error && error.circuitOpen) { circuitOpen = true; return; }
          else failed++;
        }
        attempted++;
        await writeProgress(adapter, run, {
          attempted, total, succeeded, failed,
          msg: `Capturing ${attempted} of ${total} new chat${total === 1 ? "" : "s"}…`
        });
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
    await flushQueue(true);
    if (fatal) throw fatal;

    const coverage = await accountCount(acct);
    const remaining = await readJob(checkpointKey);
    const left = remaining ? remaining.pending.length : 0;

    if (circuitOpen || budgetHit || left) {
      // Watermark and journal already persisted at step 5 — nothing is lost and
      // the next pass picks up exactly what is left.
      const until = hostEntry(adapter.host).cooldownUntil;
      await saveCheckpoint(checkpointKey, {
        ...(checkpoint || {}), version: 5, platform: adapter.id, anchor, acctScoped: true,
        safeWatermark: complete && !overflow ? scanStartedAt : (checkpoint?.safeWatermark || 0),
        completedAt: Date.now(),
        lastResult: circuitOpen ? "rate-limited" : budgetHit ? "budget" : "partial",
        archived, coverage, coverageKnown: true, pendingCount: left,
        passState: complete && !overflow ? "clean" : "partial",
        cooldownUntil: circuitOpen ? until : 0, runId: String(run.id).slice(0, 8),
        ...(holdKeep || {})
      });
      progressPending = null;
      await chrome.storage.local.set({
        [BG_SYNC_PROG(adapter.id)]: {
          state: circuitOpen ? "paused" : "syncing", phase: circuitOpen ? "paused" : "syncing",
          runId: run.id, platform: adapter.id, done: attempted, attempted, total, succeeded, failed,
          msg: circuitOpen
            ? `${archived} saved. ${adapter.label} is rate-limiting. ${opts.canResume === false ? "Check again shortly." : "It resumes automatically."}`
            : `${archived} saved, ${left} left.${opts.canResume === false ? " Check again to continue." : " It resumes automatically."}`,
          at: Date.now()
        }
      });
      return { ok: true, result: circuitOpen ? "rate-limited" : "partial", archived, left };
    }

    await finishPlatform(adapter, checkpointKey,
      { ...(checkpoint || {}), anchor, acctScoped: true,
        safeWatermark: complete && !overflow ? scanStartedAt : (checkpoint?.safeWatermark || 0),
        archived, pendingCount: 0,
        passState: complete && !overflow ? "clean" : "partial",
        cooldownUntil: 0, runId: String(run.id).slice(0, 8), ...(holdKeep || {}) },
      mode, { attempted, total, succeeded, failed },
      archived ? `${archived} new chat${archived === 1 ? "" : "s"} backed up`
               : doneMsg(),
      holdCoverage(coverage));
    return { ok: true, result: mode, archived };
  } catch (error) {
    return reportPlatformError(adapter, run, error, { attempted, total, succeeded, failed });
  }
}

/** One place that turns a thrown pass into something the UI can say out loud —
 *  shared by the session handshake and by each account's own pass. */
async function reportPlatformError(adapter, run, error, fields) {
  const { attempted = 0, total = 0, succeeded = 0, failed = 0 } = fields || {};
  const reason = String((error && error.message) || error);
  const signedOut = reason.includes("unauthorized") || reason.includes("not signed in") ||
    /unexpected provider response|invalid provider response/i.test(reason);
  const rateLimited = (error && error.kind) === "rate";
  // A reachable provider that answered in a shape we no longer parse. Saying
  // "couldn't reach" there sends the user to check their connection about
  // something only a new build can fix.
  const shapeChanged = (error && error.kind) === "shape";
  const message = reason.includes("unauthorized") || reason.includes("not signed in")
    ? `Not signed in`
    : /unexpected token\s*['"]?<?|valid json|json\.parse|unexpected provider response|invalid provider response/i.test(reason)
      ? `Needs an active session`
      : rateLimited
        ? `${adapter.label} is rate-limiting. It resumes automatically.`
        : shapeChanged
          ? `${adapter.label} changed its API. This needs a Tvara update`
          : `Couldn't reach ${adapter.label}`;
  progressPending = null;
  await chrome.storage.local.set({
    [BG_SYNC_PROG(adapter.id)]: {
      state: rateLimited ? "paused" : "error", phase: rateLimited ? "paused" : "error",
      runId: run.id, platform: adapter.id,
      done: attempted, attempted, total, succeeded, failed, msg: message, signedOut, at: Date.now()
    }
  });
  return { ok: false, error: reason, signedOut };
}

async function bgSyncAll(opts = {}) {
  // Records the reinstall so the page can offer the old backup. It no longer
  // gates the pass: a reinstalled browser starts re-archiving straight away and
  // a later restore merges into it.
  await ensureRecoveryState();
  if (bgSyncRunning) { trace("pass-skip", "worker busy"); return { status: "already-running" }; }
  const run = await beginRun();
  if (!run) { trace("pass-skip", "a run is already journalled"); return { status: "already-running" }; }
  trace("pass-start", opts.reason || "?");
  bgSyncRunning = true;
  // writeProgress is no longer the only heartbeat: a cooldown or paced listing
  // can outlast BG_RUN_STALE_MS and the run would declare itself interrupted.
  const pulse = setInterval(() => { beat(run, null); }, 20000);
  try {
    // With auto-sync off nothing will pick a partial pass back up, so the UI
    // must not promise that it will.
    const canResume = await autoSyncEnabled();
    opts = { ...opts, canResume };
    // Before the first request, so a reclaim anywhere below is covered.
    if (canResume) await scheduleResume();
    const results = [];
    // Sequential, not Promise.all: four platforms at once meant up to 32
    // concurrent authenticated requests on the user's own cookies.
    for (const adapter of BG_ADAPTERS) {
      const r = await bgSyncPlatform(adapter, run, opts);
      results.push(r);
      trace("platform", `${adapter.id} ${(r && r.result) || "?"} ` +
        `archived=${(r && r.archived) || 0} left=${(r && r.left) || 0}`);
      await sleep(2000);
    }
    await flushProgress();
    await chrome.storage.local.set({ [BG_RUN]: { ...run, state: "done", finishedAt: Date.now() } });
    // The booking above stands unless this pass finished the work.
    if (!canResume || !results.some((r) => r && (r.left || r.result === "partial"))) {
      await clearResume();
    }
    // New chats just landed; if the portable copy is due, write it now rather
    // than waiting out the clock.
    await maybeAutoBackup("sync");
    /* The listing brought back titles; those chats hold no text until the fill
       fetches it. Not awaited — a full queue is about an hour and the pass that
       found the work must not be held open for it. */
    fillAutoStart("sync").catch(() => {});
    trace("pass-end", `${Math.round((Date.now() - run.startedAt) / 1000)}s`);
    return { status: "done", results };
  } finally {
    clearInterval(pulse);
    bgSyncRunning = false;
  }
}

/* ---------- filling in the text ----------
   The background pass now knows a stub is unfinished, so it will fill them in
   over time. That is not the same as a person being able to ASK for it and
   watch it happen — and "search every conversation you have ever had" is the
   paid promise, so the moment it is bought is the moment it has to be true.

   Resumable by construction: the queue is the stub list, and every chat that
   lands removes itself from it. Stop it, close the browser, come back a week
   later — it carries on from where the archive actually is, not from a cursor
   it had to remember. */
const BG_FILL = "lct-fill-v1";
const BG_FILL_ALARM = "lct-fill-resume";
let fillCancel = false;
let fillRunning = false;

const FILL_PAUSE_MS = 350;          // between chats; the provider is not ours to hammer
const FILL_REPORT_EVERY = 3;

/* ---------- and the ones that were already there ----------
   Tracking emptiness as it happens fixes every record written from now on and
   nothing that came before — which on a real archive was 1,415 of 2,303 chats,
   i.e. the entire problem. So the list is reconciled against the archive once,
   the only time it is worth reading 25MB of message text to answer "which of
   these are empty".

   Once, and remembered: the flag carries the archive's size, so a scan is
   redone if the archive changed out from under it (a restore, an import) and
   skipped every other time. */
const BG_STUB_SCAN = "lct-stub-scan-v1";

async function ensureStubIndex() {
  let flag = null;
  try {
    const got = await chrome.storage.local.get(BG_STUB_SCAN);
    flag = got && got[BG_STUB_SCAN];
  } catch { /* scan */ }

  /* The flag was always meant to carry the archive's size so a restore or an
     import forces a rescan — the comment above said so, the code only stored
     the number and never read it. A restore that brings back thousands of
     title-only chats left this returning early with an empty backfill queue,
     which is the exact "61% of the archive is titles" failure the scan exists
     to fix. Counting records is one IDB count(), not a read of the text. */
  let count = 0;
  let live = -1;
  try {
    const d0 = await db();
    live = await reqP(tx(d0, "readonly").count());
  } catch { /* unreadable: fall through and scan */ }
  if (flag && flag.done && live >= 0 && Number(flag.count) === live) return;

  const map = {};
  try {
    const d = await db();
    await new Promise((resolve, reject) => {
      const cur = tx(d, "readonly").openCursor();
      cur.onerror = () => reject(cur.error);
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) return resolve();
        const v = c.value;
        const platform = PAGE_PLATFORMS[v.host] || "";
        // A record with fewer than two messages is a title and a promise.
        if (platform && !(Array.isArray(v.msgs) && v.msgs.length >= 2)) {
          (map[platform] = map[platform] || []).push(v.id);
        }
        count++;
        c.continue();
      };
    });
  } catch { return; }

  try {
    const all = await readStubs();
    // Union, not replace: anything noted since the scan started still counts.
    for (const [platform, ids] of Object.entries(map)) {
      const held = new Set(Array.isArray(all[platform]) ? all[platform] : []);
      for (const id of ids) held.add(id);
      all[platform] = [...held].slice(0, 20000);
    }
    await chrome.storage.local.set({ [BG_STUBS]: all, [BG_STUB_SCAN]: { done: true, at: Date.now(), count } });
  } catch { /* next call scans again */ }
}

async function fillState() {
  await ensureStubIndex();
  try {
    const got = await chrome.storage.local.get(BG_FILL);
    const st = got && got[BG_FILL];
    const stubs = await readStubs();
    const remaining = {};
    let total = 0;
    for (const [platform, list] of Object.entries(stubs)) {
      const n = Array.isArray(list) ? list.length : 0;
      if (n) { remaining[platform] = n; total += n; }
    }
    const extra = st && typeof st === "object" ? st : {};
    /* fillRunning lives only in this worker's memory, and MV3 reclaims workers
       mid-run: the queue is left non-empty with nothing on screen saying so.
       The watchdog alarm picks it back up; this is what to show until it does.
       Spread first — a stale persisted key must not overwrite what was just
       counted. */
    const resuming = !fillRunning && extra.state === "running" && total > 0;
    return { ...extra, running: fillRunning, resuming, remaining, total };
  } catch { return { running: fillRunning, resuming: false, remaining: {}, total: 0 }; }
}

async function writeFill(patch) {
  try {
    const got = await chrome.storage.local.get(BG_FILL);
    const prev = (got && got[BG_FILL]) || {};
    await chrome.storage.local.set({ [BG_FILL]: { ...prev, ...patch, at: Date.now() } });
  } catch { /* the UI falls back to the queue length */ }
}

async function fillStop() {
  fillCancel = true;
  // Stop means stop: without this the resume alarm restarts the run a minute
  // after the user asked it not to.
  try { await chrome.alarms.clear(BG_FILL_ALARM); } catch { /* no alarms */ }
  await writeFill({ state: "stopped" });
  return { ok: true };
}

/* Only a click ever started the text download. The sync pass wrote the stubs
   and then waited for someone to find the row in the popup, so a fresh install
   archived hundreds of titles, no words, and reported 0% — the archive is not
   a thing to be asked for. Called wherever new stubs land and on every worker
   start, so a reclaim, an extension reload or a browser restart all resume it;
   the queue is the resume point and fillStart() owns the overlap guard.

   It does not need a tab, a focused window, or the popup: the fetches run in
   the worker on the user's own cookies.

   A stop is honoured. fillStop() persists "stopped", and that is the user's
   own switch on the same row — nothing here may quietly flip it back on. */
async function fillAutoStart(reason) {
  // The two refusals come first. A run still draining after a stop would
  // otherwise answer "already-running", which reads as consent it does not have.
  if (!(await autoSyncEnabled())) return { status: "disabled" };
  try {
    const got = await chrome.storage.local.get(BG_FILL);
    const held = got && got[BG_FILL];
    if (held && held.state === "stopped") return { status: "stopped" };
  } catch { /* unreadable: treat as never run */ }
  if (fillRunning) return { status: "already-running" };
  // Cheap when there is nothing to do: one keyed count, no message bodies.
  if (!(await fillState()).total) return { status: "empty" };
  trace("fill-start", String(reason || "auto"));
  await writeFill({ auto: String(reason || "auto").slice(0, 16) });
  // Not awaited: a full queue is about an hour, and every caller here is either
  // a message port or a pass that must not be held open for it.
  fillStart();
  return { status: "started" };
}

async function fillStart() {
  /* Claimed BEFORE the first await. ensureStubIndex() can walk a 25MB archive,
     and two clicks inside that window both saw fillRunning false and both
     started a loop over the same stub list — double-fetching every chat at
     twice the rate the provider is owed. */
  if (fillRunning) return { status: "already-running" };
  fillRunning = true;
  fillCancel = false;
  await ensureStubIndex();
  const started = Date.now();
  let done = 0, failed = 0;
  let budgetHit = false;
  const stubs = await readStubs();
  const planned = Object.values(stubs).reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), 0);
  // note cleared: "ChatGPT: signed out" from a previous pass otherwise outlives
  // the sign-in that fixed it and paints this run as stalled from the start.
  await writeFill({ state: "running", startedAt: started, done: 0, failed: 0, planned, note: "" });
  /* Booked before the first fetch and repeating, so a reclaim that is not a
     budget stop still comes back. The stub list is the resume point, so the
     alarm only has to call fillStart() again. Cleared when the run ends. */
  try { await chrome.alarms.create(BG_FILL_ALARM, { delayInMinutes: 1, periodInMinutes: 1 }); }
  catch { /* no alarms: the popup button still restarts it */ }

  try {
    for (const adapter of BG_ADAPTERS) {
      if (fillCancel) break;
      const ids = ((await readStubs())[adapter.id] || []).slice();
      if (!ids.length) continue;
      // A chat's text can only be fetched by the account that owns it; a
      // signed-out platform is skipped rather than failed.
      try { await idxPrepare(adapter); }
      catch { await writeFill({ state: "running", note: `${adapter.label}: not signed in` }); continue; }

      for (const recordId of ids) {
        if (fillCancel) break;
        /* MV3 workers get reclaimed. A full queue is about an hour of work and
           nothing re-entered this function, so a reclaim ended the run silently
           after welcome.js had told the user "you can close this page; it keeps
           going". The pass now stops on the same budget the sync engine uses
           and books itself back in; the stub list IS the resume point, so
           picking up is just running again. */
        if (Date.now() - started > BG_PASS_BUDGET_MS) { budgetHit = true; break; }
        /* Re-asked every chat, not once per platform. idxPrepare() caches for
           IDX_CTX_TTL (5 minutes) and returns the cached value inside it, so
           this costs nothing — but a full queue is 2,303 chats at ~1.5s, about
           an hour, and the ChatGPT ctx is a bearer token from /api/auth/session.
           Held once for the whole run it went stale partway, every detail()
           threw auth, and the run stopped around 480 with "signed out" written
           to a user who was signed in the whole time. */
        let ctx;
        try { ctx = await idxPrepare(adapter); }
        catch { await writeFill({ state: "running", note: `${adapter.label}: signed out` }); break; }
        const convId = recordId.startsWith(adapter.host + adapter.prefix)
          ? recordId.slice((adapter.host + adapter.prefix).length) : "";
        if (!convId) { await noteStub(recordId, adapter.host, true); continue; }
        try {
          const msgs = await adapter.detail(ctx, convId);
          if (Array.isArray(msgs) && msgs.length >= 2) {
            await importBatch([{
              id: recordId, host: adapter.host, path: adapter.prefix + convId,
              platform: adapter.label, msgs, updatedAt: Date.now(), keepTimes: false
            }]);
            done++;
          } else {
            // Nothing to fetch: an empty conversation is finished, not pending.
            await noteStub(recordId, adapter.host, true);
          }
        } catch (error) {
          failed++;
          const kind = (error && error.kind) || "net";
          if (kind === "auth") {
            /* Believe it only on the second try. A token that expired mid-run
               is indistinguishable here from a user who signed out, and the
               first is far commoner on a run this long. Drop the cached ctx,
               prepare a fresh one, and stop only if that fails too. */
            let recovered = false;
            try { idxForget(adapter); await idxPrepare(adapter); recovered = true; } catch { /* really gone */ }
            if (recovered) { failed--; continue; }
            await writeFill({ note: `${adapter.label}: signed out` });
            break;
          }
          if (kind === "gone") await noteStub(recordId, adapter.host, true);
          if (kind === "rate") await sleep(5000);
        }
        if ((done + failed) % FILL_REPORT_EVERY === 0) {
          await writeFill({ state: "running", done, failed, platform: adapter.label });
        }
        await sleep(FILL_PAUSE_MS);
      }
    }
    if (budgetHit && !fillCancel) {
      await writeFill({ state: "running", done, failed, note: "" });
      try { await chrome.alarms.create(BG_FILL_ALARM, { delayInMinutes: 1 }); }
      catch { /* no alarms: the popup button still restarts it */ }
      return { status: "paused", done, failed, left: (await fillState()).total };
    }
    const left = (await fillState()).total;
    // Ended on its own terms: no watchdog until the next start.
    try { await chrome.alarms.clear(BG_FILL_ALARM); } catch { /* no alarms */ }
    await writeFill({ state: fillCancel ? "stopped" : (left ? "partial" : "done"),
      done, failed, finishedAt: Date.now() });
    return { status: "ok", done, failed, left };
  } finally {
    fillRunning = false;
  }
}

async function bgSyncStatus() {
  const recovery = await ensureRecoveryState();
  const run = await normalizeRun();
  const ledger = await readLedger();
  const keys = BG_ADAPTERS.map((a) => BG_SYNC_PROG(a.id))
    .concat(BG_ADAPTERS.map((a) => BG_SYNC_FLAG(a.id)), BG_ACTIVE_ACCOUNT);
  const store = await chrome.storage.local.get(keys);
  const activeAccounts = store[BG_ACTIVE_ACCOUNT] && typeof store[BG_ACTIVE_ACCOUNT] === "object"
    ? store[BG_ACTIVE_ACCOUNT] : {};
  const roster = await readAccounts();
  const platforms = {};
  for (const adapter of BG_ADAPTERS) {
    // Do not show another signed-in account's checkpoint as this account's
    // state. A platform becomes "ready to check" until this browser has
    // identified the currently active account during a background check.
    const activeKey = String(activeAccounts[adapter.id] || "");
    const checkpoint = activeKey ? ledger.checkpoints[activeKey] || null : null;
    const progress = store[BG_SYNC_PROG(adapter.id)] || null;
    const phase = progress?.phase || (checkpoint ? "up-to-date" : "needs-sync");
    // Every account this browser has synced on the platform, so a row can say
    // "two accounts" instead of silently describing whichever one went last.
    // Matched by tag because the roster stores the short form of the same hash.
    const seen = roster[adapter.id] && typeof roster[adapter.id] === "object" ? roster[adapter.id] : {};
    const byTag = new Map(Object.entries(ledger.checkpoints)
      .filter(([, c]) => c && c.platform === adapter.id)
      .map(([key, c]) => [tagOfKey(key), c]));
    const accounts = Object.entries(seen)
      .sort((a, b) => (Number(a[1].ordinal) || 0) - (Number(b[1].ordinal) || 0))
      .map(([acct, meta]) => ({
        acct,
        ordinal: Number(meta.ordinal) || 0,
        label: String(meta.label || ""),
        plan: String(meta.plan || ""),
        active: acct === tagOfKey(activeKey),
        archived: Number(byTag.get(acct)?.coverage) || 0,
        completedAt: Number(byTag.get(acct)?.completedAt) || 0,
        synced: byTag.has(acct)
      }));
    platforms[adapter.id] = {
      label: adapter.label,
      progress,
      flag: store[BG_SYNC_FLAG(adapter.id)] || null,
      checkpoint,
      phase,
      accounts,
      archivedAll: accounts.reduce((sum, a) => sum + a.archived, 0)
    };
  }
  const deletions = await deletionsList();
  return {
    platforms,
    running: !!(run && run.state === "running"),
    recovery,
    deletions: { count: deletions.items.length, policy: deletions.policy },
    autoBackup: await autoBackupState(),
    summary: summarize(platforms, !!(run && run.state === "running"), recovery, run && run.id),
    run: run ? { state: run.state, startedAt: run.startedAt, interruptedAt: run.interruptedAt || 0 } : null
  };
}

/**
 * One verdict for the whole archive, computed here so the popup and the Recall
 * page can never disagree.
 *
 * Signed-out providers are deliberately excluded. Most people use two or three
 * of the four; requiring all four to report "up to date" meant the reassuring
 * message a fully-synced archive has earned could never appear.
 */
function summarize(platforms, running, recovery, runId) {
  const entries = Object.values(platforms);
  if (running || entries.some((p) => p.progress && p.progress.state === "syncing")) {
    const live = entries.filter((p) => p.progress && p.progress.state === "syncing");
    // Only this run counts. finishPlatform leaves a "done" record behind
    // indefinitely, and summing those inflated the denominator so the
    // percentage never matched the message.
    const current = runId || entries.reduce((newest, p) => {
      const pr = p.progress;
      return pr && pr.runId && (!newest || (Number(pr.at) || 0) > newest.at)
        ? { id: pr.runId, at: Number(pr.at) || 0 } : newest;
    }, null)?.id;
    let done = 0, total = 0, succeeded = 0;
    for (const p of entries) {
      const pr = p.progress;
      if (!pr || !Number.isFinite(Number(pr.total)) || Number(pr.total) <= 0) continue;
      if (pr.state !== "syncing" && pr.state !== "done") continue;
      if (current && pr.runId && pr.runId !== current) continue;
      done += Math.min(Number(pr.done) || 0, Number(pr.total));
      total += Number(pr.total);
      succeeded += Number(pr.succeeded) || 0;
    }
    const message = live.length > 1
      ? `Checking ${live.length} platforms…`
      : (live[0] && live[0].progress.msg) || "Checking for new chats…";
    return { state: "syncing", message, done, total, succeeded, syncing: live.length, checkedAt: 0, connected: 0 };
  }

  // A rate limit is not user-actionable and must not paint the error state.
  const cooling = entries.filter((p) => p.progress && p.progress.state === "paused");
  if (cooling.length) {
    return { state: "paused", message: cooling[0].progress.msg || "Paused. Resumes automatically.",
      checkedAt: 0, connected: entries.filter((p) => !(p.progress && p.progress.signedOut)).length };
  }

  /* A platform this browser has never checked is UNKNOWN, not connected —
     there is no evidence yet that the user has an account there at all.
     Counting one as a provider still "left to check" is what turned adding a
     fifth adapter into every existing user being told, on update, that the
     finished archive they had was suddenly incomplete. The window is short by
     construction: one sync pass gives every platform a progress record either
     way — archived, or signed out — and it rejoins the count on its own
     evidence rather than on our having shipped it. */
  const known = entries.filter((p) => p.progress || p.checkpoint);
  const connected = known.filter((p) => !(p.progress && p.progress.signedOut));
  const failing = connected.filter((p) => p.progress && p.progress.state === "error");
  if (failing.length) {
    return {
      state: "error",
      message: `${failing[0].label}: ${failing[0].progress.msg}`,
      checkedAt: 0,
      connected: connected.length
    };
  }
  const paused = connected.filter((p) => p.progress && p.progress.state === "interrupted");
  if (paused.length) {
    return { state: "pending", message: "Paused · pick up where it stopped", checkedAt: 0, connected: connected.length };
  }

  const current = connected.filter((p) => p.phase === "up-to-date" && p.checkpoint);
  if (current.length && current.length === connected.length) {
    const oldest = current.reduce((min, p) => Math.min(min, p.checkpoint.completedAt || 0), Infinity);
    const archived = current.reduce((sum, p) => sum + (p.checkpoint.coverage || 0), 0);
    // While a restore is on offer the pass is deliberately capturing only what
    // is new, so "everything is already backed up" would be a lie told by the
    // one line most people read.
    const held = recovery && recovery.state === "restore-offered";
    return { state: "current",
      message: held ? "New chats are backed up \u00b7 restore your archive for the rest"
                    : "Everything is already backed up",
      checkedAt: oldest, archived, connected: connected.length };
  }
  if (current.length) {
    return { state: "pending", message: `${connected.length - current.length} provider${connected.length - current.length === 1 ? "" : "s"} left to check`, checkedAt: 0, connected: connected.length };
  }
  return { state: "never", message: "Check your history for the first time", checkedAt: 0, connected: connected.length };
}

async function backupState() {
  const ledger = await readLedger();
  const { data } = await getDurable([BG_BACKUP_MARKER, BG_SYNC_PROFILE]);
  return {
    ledger,
    marker: data[BG_BACKUP_MARKER] || null,
    profile: cleanProfile(data[BG_SYNC_PROFILE])
  };
}

async function wipeRecall() {
  await wipe();
  profileSaltPromise = null;
  journalCache = null;
  const localKeys = [BG_RUN, BG_RECOVERY, BG_ACTIVE_ACCOUNT]
    .concat(BG_ADAPTERS.map((adapter) => BG_SYNC_PROG(adapter.id)))
    .concat(BG_ADAPTERS.map((adapter) => BG_SYNC_FLAG(adapter.id)));
  // "Delete everything" has to mean the backup key material too, or a wiped
  // browser would keep writing readable archives of whatever comes next.
  await chrome.storage.local.remove(localKeys.concat([BG_SYNC_WORK, BG_HOST_COOLDOWN, BG_PAGE_SCHEME,
    // Not BG_BOOTSTRAP: a wipe must not read as an install and start a fresh
    // full sync of everything the user has just asked to be rid of. The quota
    // sweep flag does go, so readings can be taken again straight away.
    BG_DELETIONS, BG_SWEEP_STATE, BG_QUOTA_SWEEP, BG_AUTOBACKUP, BG_AUTOBACKUP_STATE, BG_RESTORE_GUARD,
    // The account roster and every per-account usage tally are part of
    // "delete everything" — they describe who was signed in, which is exactly
    // what a wipe is meant to remove.
    BG_ACCOUNTS]));
  await clearUsage();
  await removeDurable([BG_SYNC_LEDGER, BG_BACKUP_MARKER, BG_SYNC_PROFILE]);
  await paintDeletionBadge(0);
  try { await chrome.alarms.clear(BG_AUTOBACKUP_ALARM); } catch { /* alarms unavailable */ }
  return { ok: true };
}

/* ===================== automatic encrypted backup =====================
 *
 * The manual backup was the only portable copy, and it existed only if the user
 * remembered to make one before uninstalling — which is the one moment nobody
 * remembers. This writes the same encrypted envelope on a schedule.
 *
 * Set-up is the only time the passphrase exists: the page derives a key from
 * it, wraps a random file key under that, and hands the worker the wrapped blob
 * plus the raw file key. The worker can then seal a backup at any hour with no
 * passphrase anywhere. The FILE still opens only with the passphrase, which is
 * never stored, never synced, and not recoverable.
 */

const BG_AUTOBACKUP_ALARM = "lct-auto-backup";
const BG_AUTOBACKUP_MIN_HOURS = 1;
const BG_AUTOBACKUP_MAX_HOURS = 24 * 30;
// base64 inflates by a third and the whole envelope is held in memory as a data
// URL; past this the worker would be gambling with an OOM every night.
const BG_AUTOBACKUP_MAX_BYTES = 96 * 1024 * 1024;
const BG_AUTOBACKUP_FOLDER = "Tvara";

/* ---------- how long the password is remembered ----------
   Two answers, both the user's to give. "Always on this device" persists the
   wrapped key in local storage, which is what unattended backups have always
   needed. "Until I close the browser" keeps it in session storage instead:
   memory-backed, wiped by the browser itself on exit, so forgetting it does not
   depend on any code of ours running at the right moment — including after a
   crash. Neither ever stores the passphrase. Both leave the FILE openable only
   with it.

   The in-memory copy is a fallback for engines without chrome.storage.session.
   It dies with the service worker, which is a shorter life than promised, never
   a longer one — the failure mode is being asked to type it again. */
let sessionKeyring = null;

function sessionArea() {
  try { return (chrome.storage && chrome.storage.session) || null; } catch { return null; }
}

async function writeSessionKeyring(keyring) {
  sessionKeyring = keyring || null;
  const area = sessionArea();
  if (!area) return;
  try {
    if (keyring) await area.set({ [BG_BACKUP_KEY]: { version: 1, keyring, at: Date.now() } });
    else await area.remove(BG_BACKUP_KEY);
  } catch { /* the memory copy stands in for this session */ }
}

async function readSessionKeyring() {
  const area = sessionArea();
  if (area) {
    try {
      const got = await area.get(BG_BACKUP_KEY);
      const raw = got && got[BG_BACKUP_KEY];
      if (raw && raw.keyring) { sessionKeyring = raw.keyring; return raw.keyring; }
    } catch { /* fall through to the memory copy */ }
  }
  return sessionKeyring;
}

/** The schedule as configured, with no key attached and no judgement on it. */
async function readAutoBackupRecord() {
  try {
    const { [BG_AUTOBACKUP]: raw } = await chrome.storage.local.get(BG_AUTOBACKUP);
    return raw && raw.enabled === true ? raw : null;
  } catch { return null; }
}

/** The schedule AND a usable key, or nothing. A session-scoped key that the
    browser has since wiped lands here as null, which is the point. */
async function readAutoBackup() {
  try {
    const raw = await readAutoBackupRecord();
    if (!raw) return null;
    const scope = raw.scope === "session" ? "session" : "device";
    const keyring = scope === "session" ? await readSessionKeyring() : raw.keyring;
    if (!self.LCTBackupCrypto || !self.LCTBackupCrypto.validKeyring(keyring)) return null;
    return {
      enabled: true,
      scope,
      keyring,
      everyHours: Math.min(BG_AUTOBACKUP_MAX_HOURS, Math.max(BG_AUTOBACKUP_MIN_HOURS,
        Math.floor(Number(raw.everyHours) || 24))),
      filename: String(raw.filename || "tvara-auto.lctbackup").slice(0, 120)
    };
  } catch { return null; }
}

async function readAutoBackupRun() {
  try {
    const { [BG_AUTOBACKUP_STATE]: raw } = await chrome.storage.local.get(BG_AUTOBACKUP_STATE);
    return raw && typeof raw === "object" ? raw : {};
  } catch { return {}; }
}

/** Everything the UI is allowed to know. The keyring never crosses this line. */
async function autoBackupState() {
  const record = await readAutoBackupRecord();
  const config = await readAutoBackup();
  const run = await readAutoBackupRun();
  const scope = record ? (record.scope === "session" ? "session" : "device") : "";
  return {
    enabled: !!config,
    scope,
    // Configured, but the key it ran on was the temporary kind and the browser
    // has since taken it back. Says so instead of reporting a silent "off".
    awaitingKey: !!record && !config,
    everyHours: config ? config.everyHours : 24,
    filename: config ? config.filename : "",
    folder: BG_AUTOBACKUP_FOLDER,
    lastAt: Number(run.lastAt) || 0,
    lastChats: Math.max(0, Number(run.lastChats) || 0),
    lastError: String(run.lastError || "").slice(0, 200),
    nextAt: config && run.lastAt ? Number(run.lastAt) + config.everyHours * 3600000 : 0
  };
}

async function autoBackupConfigure(config) {
  const crypt = self.LCTBackupCrypto;
  if (!crypt || !crypt.validKeyring(config && config.keyring)) {
    return { err: "That backup key could not be verified" };
  }
  const everyHours = Math.min(BG_AUTOBACKUP_MAX_HOURS, Math.max(BG_AUTOBACKUP_MIN_HOURS,
    Math.floor(Number(config.everyHours) || 24)));
  const scope = config.scope === "session" ? "session" : "device";
  const record = { version: 1, enabled: true, scope, everyHours,
    filename: "tvara-auto.lctbackup", setUpAt: Date.now() };
  // Written whole, so switching from "always" to "until I close the browser"
  // drops the persisted key rather than leaving it behind on disk.
  if (scope === "device") record.keyring = config.keyring;
  await chrome.storage.local.set({ [BG_AUTOBACKUP]: record });
  await writeSessionKeyring(scope === "session" ? config.keyring : null);
  await chrome.storage.local.set({ [BG_AUTOBACKUP_STATE]: { lastAt: 0, lastChats: 0, lastError: "" } });
  await ensureAutoBackupAlarm(true);
  const first = await runAutoBackup("setup");
  return { ok: true, state: await autoBackupState(), first };
}

async function autoBackupDisable() {
  await writeSessionKeyring(null);
  await chrome.storage.local.remove([BG_AUTOBACKUP, BG_AUTOBACKUP_STATE]);
  try { await chrome.alarms.clear(BG_AUTOBACKUP_ALARM); } catch { /* alarms unavailable */ }
  return { ok: true, state: await autoBackupState() };
}

/** Every archived chat, straight out of IndexedDB. */
async function archiveSnapshot() {
  const d = await db();
  return new Promise((resolve, reject) => {
    const out = [];
    const req = tx(d, "readonly").openCursor();
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve(out);
      out.push(cursor.value);
      cursor.continue();
    };
  });
}

let autoBackupRunning = false;

async function runAutoBackup(reason) {
  const config = await readAutoBackup();
  if (!config) {
    /* A schedule whose key was only ever remembered for the session. Not a
       failure to hide: the user has to type the passphrase again, and the only
       place that can tell them is this status line. */
    if (await readAutoBackupRecord()) {
      const run = await readAutoBackupRun();
      try {
        await chrome.storage.local.set({ [BG_AUTOBACKUP_STATE]: { ...run, lastCheckedAt: Date.now(),
          lastError: "Your backup password was only remembered until you closed the browser. Enter it again to resume automatic backups." } });
      } catch { /* dead context */ }
      return { status: "needs-password" };
    }
    return { status: "disabled" };
  }
  if (autoBackupRunning) return { status: "already-running" };
  // A snapshot taken mid-pass would be a torn read of a moving archive, and the
  // next scheduled one is minutes away.
  if (bgSyncRunning && reason !== "manual") return { status: "busy" };
  autoBackupRunning = true;
  const note = async (fields) => {
    const run = await readAutoBackupRun();
    try { await chrome.storage.local.set({ [BG_AUTOBACKUP_STATE]: { ...run, ...fields } }); }
    catch { /* dead context */ }
  };
  try {
    const [chats, durable] = await Promise.all([archiveSnapshot(), backupState()]);
    if (!chats.length) {
      await note({ lastError: "", lastCheckedAt: Date.now() });
      return { status: "empty" };
    }
    const sealed = await self.LCTBackupCrypto.seal({
      format: self.LCTBackupCrypto.PAYLOAD_FORMAT,
      version: 1,
      createdAt: Date.now(),
      chats,
      ledger: durable.ledger || { version: 2, checkpoints: {} },
      profile: durable.profile || null
    }, { keyring: config.keyring, ...(await stampCreds()) });

    if (sealed.json.length > BG_AUTOBACKUP_MAX_BYTES) {
      await note({ lastError: "This archive is too large for automatic backup. Export it from the Recall page.", lastCheckedAt: Date.now() });
      return { status: "too-large" };
    }
    // MV3 service workers have no URL.createObjectURL, so the envelope travels
    // to the downloads API as a data URL.
    const url = "data:application/octet-stream;base64," +
      self.LCTBackupCrypto.bytesToBase64(new TextEncoder().encode(sealed.json));
    await new Promise((resolve, reject) => {
      chrome.downloads.download({
        url,
        filename: `${BG_AUTOBACKUP_FOLDER}/${config.filename}`,
        conflictAction: "overwrite",
        saveAs: false
      }, (id) => {
        const error = chrome.runtime.lastError;
        if (error || id === undefined) reject(new Error(error ? error.message : "the download was refused"));
        else resolve(id);
      });
    });
    await markBackup({ chats: chats.length, filename: config.filename, automatic: true });
    await note({ lastAt: Date.now(), lastChats: chats.length, lastError: "", lastCheckedAt: Date.now() });
    return { status: "ok", chats: chats.length };
  } catch (error) {
    await note({ lastError: String((error && error.message) || error).slice(0, 200), lastCheckedAt: Date.now() });
    return { status: "error", error: String((error && error.message) || error) };
  } finally {
    autoBackupRunning = false;
  }
}

async function maybeAutoBackup(reason) {
  const config = await readAutoBackup();
  if (!config) return { status: "disabled" };
  const run = await readAutoBackupRun();
  const due = Date.now() - (Number(run.lastAt) || 0) >= config.everyHours * 3600000;
  return due ? runAutoBackup(reason) : { status: "not-due" };
}

async function ensureAutoBackupAlarm(force) {
  const config = await readAutoBackup();
  try {
    if (!config) { await chrome.alarms.clear(BG_AUTOBACKUP_ALARM); return; }
    const existing = await chrome.alarms.get(BG_AUTOBACKUP_ALARM);
    if (existing && !force) return;
    // Deliberately more frequent than everyHours: the alarm only asks "is it
    // due yet", and a browser that is closed at the exact hour would otherwise
    // skip a whole cycle.
    const period = Math.max(30, Math.min(config.everyHours * 60, 6 * 60));
    await chrome.alarms.create(BG_AUTOBACKUP_ALARM, { delayInMinutes: force ? period : 5, periodInMinutes: period });
  } catch { /* alarms unavailable */ }
}

/* ---------- restore brute-force guard ----------
 * PBKDF2 at a million rounds already makes offline guessing expensive. This
 * covers the other direction: someone at an unlocked machine feeding the
 * restore box a wordlist. Kept in the worker so reloading the page — or opening
 * a second one — does not reset the count. */

const BG_RESTORE_FREE_TRIES = 3;
const BG_RESTORE_MAX_WAIT_MS = 60 * 60 * 1000;

async function restoreGuard() {
  try {
    const { [BG_RESTORE_GUARD]: raw } = await chrome.storage.local.get(BG_RESTORE_GUARD);
    const fails = Math.max(0, Math.floor(Number(raw && raw.fails) || 0));
    const until = Math.max(0, Number(raw && raw.until) || 0);
    return { fails, until, allowed: Date.now() >= until, waitMs: Math.max(0, until - Date.now()) };
  } catch { return { fails: 0, until: 0, allowed: true, waitMs: 0 }; }
}

async function restoreGuardFail() {
  const current = await restoreGuard();
  const fails = current.fails + 1;
  const over = fails - BG_RESTORE_FREE_TRIES;
  const wait = over <= 0 ? 0 : Math.min(BG_RESTORE_MAX_WAIT_MS, 30000 * Math.pow(2, over - 1));
  const until = wait ? Date.now() + wait : 0;
  try { await chrome.storage.local.set({ [BG_RESTORE_GUARD]: { fails, until } }); } catch { /* full */ }
  return { fails, until, allowed: !wait, waitMs: wait };
}

async function restoreGuardReset() {
  try { await chrome.storage.local.remove(BG_RESTORE_GUARD); } catch { /* fine */ }
  return { fails: 0, until: 0, allowed: true, waitMs: 0 };
}

/* ---------- automatic background sync ----------
 * bgSyncAll() was always safe to call repeatedly: it refuses to overlap, it
 * only fetches the delta past each account's checkpoint, and an interrupted
 * pass keeps its previous watermark. So "run it on a schedule" needs no new
 * sync logic — only a clock, which in MV3 means chrome.alarms (a terminated
 * worker cannot hold a timer).
 *
 * The first tick is deliberately late: waking a browser with four
 * authenticated history checks the instant it starts is rude, and it would
 * race a user who is still signing in.
 */
const BG_AUTO_ALARM = "lct-auto-sync";
const BG_RESUME_ALARM = "lct-auto-sync-resume";
const BG_AUTO_STATE = "lct-recall-auto-sync-v1";
const BG_AUTO_FIRST_DELAY_MIN = 10;
const BG_AUTO_PERIOD_MIN = 180;      // every 3 hours

async function autoSyncEnabled() {
  try {
    const { settings } = await chrome.storage.local.get("settings");
    return !settings || settings.autoSync !== false;   // on unless turned off
  } catch { return false; }
}

async function ensureAutoSyncAlarm() {
  try {
    const existing = await chrome.alarms.get(BG_AUTO_ALARM);
    // Re-creating would reset the schedule on every worker wake, so a browser
    // that restarts often would never actually reach a tick.
    if (existing) return;
    // Reloading the extension clears alarms. Carrying the last tick forward
    // stops a reload from buying another full interval — or, worse, from
    // starting a fresh pass every time the worker respawns.
    let delay = BG_AUTO_FIRST_DELAY_MIN;
    try {
      const { [BG_AUTO_STATE]: state } = await chrome.storage.local.get(BG_AUTO_STATE);
      const since = state && state.at ? (Date.now() - state.at) / 60000 : Infinity;
      if (Number.isFinite(since)) {
        delay = Math.min(BG_AUTO_PERIOD_MIN, Math.max(BG_AUTO_FIRST_DELAY_MIN, BG_AUTO_PERIOD_MIN - since));
      }
    } catch { /* no prior tick */ }
    await chrome.alarms.create(BG_AUTO_ALARM, {
      delayInMinutes: delay,
      periodInMinutes: BG_AUTO_PERIOD_MIN
    });
  } catch { /* alarms unavailable */ }
}

/* A pass that has work outstanding comes back promptly rather than waiting out
   the full period. 1 minute is the platform floor.

   Booked BEFORE the first request and REPEATING, not once when a pass ends. An
   MV3 worker is reclaimed mid-fetch routinely and a browser can be killed
   outright; neither reaches the end of a pass, so a one-shot alarm booked there
   was never written and the archive sat until the 3-hour period came round. The
   checkpoint is the resume point, so picking up is just running again — and a
   tick that lands on a live pass costs one already-running answer.
   clearResume() ends it once a pass finishes with nothing left. */
async function scheduleResume() {
  try { await chrome.alarms.create(BG_RESUME_ALARM, { delayInMinutes: 1, periodInMinutes: 1 }); }
  catch { /* alarms unavailable */ }
}

async function clearResume() {
  try { await chrome.alarms.clear(BG_RESUME_ALARM); } catch { /* nothing booked */ }
}

/* Is there a pass to pick up?

   A browser restart and an extension reload both clear every alarm, so work the
   last pass left had nothing to wake it and waited out the full period — up to
   three hours after a restart, which from the user's side is an archive that
   stopped. Reads what the last pass wrote about itself rather than re-deriving
   it: "syncing" is a pass that stopped with chats still to fetch, "paused" is
   one the provider is rate-limiting, and a run that never reached "done" was
   interrupted. */
async function resumeIfUnfinished() {
  if (!(await autoSyncEnabled())) return { status: "disabled" };
  let left = false;
  try {
    const keys = [BG_RUN, ...[...BG_PLATFORM_IDS].map(BG_SYNC_PROG)];
    const got = await chrome.storage.local.get(keys);
    const run = got[BG_RUN];
    left = !!(run && run.state && run.state !== "done");
    for (const id of BG_PLATFORM_IDS) {
      const p = got[BG_SYNC_PROG(id)];
      if (p && (p.state === "syncing" || p.state === "paused")) left = true;
    }
  } catch { /* unreadable: the period alarm is still underneath this */ }
  if (left) await scheduleResume();
  trace("resume-check", left ? "rebooked an unfinished pass" : "nothing outstanding");
  return { status: left ? "resuming" : "idle" };
}

/* A tab just opened one of the providers. That is a better sync trigger than
 * any clock — the session is live, the cookies are warm, and it is the moment
 * the user expects "everything I've ever written" to already be searchable.
 * Throttled here rather than in the page so ten tabs cost one pass. */
const BG_VISIT_STATE = "lct-recall-visit-sync-v1";
const BG_VISIT_MIN_MS = 20 * 60 * 1000;

async function visitSync(platform) {
  // Only the providers the sync engine can actually read. A visit to a host we
  // have no history endpoint for is not a reason to go poll the other four.
  if (!BG_PLATFORM_IDS.has(platform)) return { status: "unsupported" };
  if (!(await autoSyncEnabled())) return { status: "disabled" };
  let last = 0;
  try {
    const { [BG_VISIT_STATE]: state } = await chrome.storage.local.get(BG_VISIT_STATE);
    last = (state && state.at) || 0;
  } catch { /* no prior visit */ }
  if (Date.now() - last < BG_VISIT_MIN_MS) return { status: "throttled", last };
  try { await chrome.storage.local.set({ [BG_VISIT_STATE]: { at: Date.now() } }); }
  catch { /* dead context */ }
  return autoSyncTick();
}

async function autoSyncTick(options = {}) {
  // Switched off mid-pass: the repeating resume alarm must go with it, or it
  // wakes the worker every minute for a pass that returns "disabled".
  if (!(await autoSyncEnabled())) { await clearResume(); return { status: "disabled" }; }
  /* Readings and the plan on each account go stale faster than the archive
     does, and this is the only clock the extension has that does not need a
     tab. Own throttle (15 min), so a resume tick minutes after the last pass
     costs nothing. It also picks up a first sweep the worker was reclaimed in
     the middle of, which is why it runs before the pass rather than after. */
  if (!options.skipQuota) {
    try { await quotaSweep("auto"); } catch { /* readings are not the pass */ }
  }
  const started = Date.now();
  const result = await bgSyncAll({ reason: "auto" });   // owns recovery + overlap guards
  try {
    await chrome.storage.local.set({
      [BG_AUTO_STATE]: { at: started, status: result && result.status }
    });
  } catch { /* dead context */ }
  return result;
}

/* ---------- entitlement renewal ----------
   Without a clock, refresh() only ever ran from the popup — so a user who
   never opened it never renewed, and a refunded licence was never told to
   clear its token. Not forced: needsRefresh() (30d of life left) and
   RETRY_FLOOR_MS (6h) decide whether a tick costs an issuer call. */
const BG_ENT_ALARM = "lct-entitlement";
const BG_ENT_PERIOD_MIN = 720;

async function entitlementTick() {
  try {
    const got = await chrome.storage.local.get("license");
    const lic = got && got.license;
    if (!lic || !lic.key) return;
    const deviceId = await self.LCTDodo.ensureDeviceId();
    await self.LCTEntitlement.refresh(lic, deviceId, {});
  } catch { /* offline, dead context, or no device key — backoff owns the retry */ }
}

/* ---------- session heartbeat ----------
   A separate clock from renewal, and deliberately faster. Renewal asks "may I
   have a new token" and only bothers with ten days of the old one left;
   this asks "am I still signed in", which is the question a device screen's
   Sign out button depends on. Hourly: fast enough that terminating a device is
   a real event, slow enough that five devices cost the issuer 120 calls a day.

   Only an ANSWER can end anything here — see heartbeat() in lib/entitlement.js.
   An unreachable issuer leaves this install exactly as entitled as it was. */
const BG_SESSION_ALARM = "lct-session";
const BG_SESSION_PERIOD_MIN = 60;

const BG_SIGNOUT_NOTE = "lct-signed-out";

/* The device that was signed out is by definition NOT the one the person is
   looking at — there is no popup open on it and no page of ours to write into.
   A system notification is the only surface that reaches it, and without one
   the device simply stops being Pro with no explanation, which reads as a bug
   rather than as something somebody deliberately did.

   Announces the CHANGE, never the state: the caller only reaches here on the
   tick where `live` first came back false. Repeating it hourly would make a
   deliberate sign-out feel like a fault. */
async function notifySignedOut(reason) {
  try {
    if (!chrome.notifications || !chrome.notifications.create) return;
    const revoked = String(reason || "") === "revoked";
    await chrome.notifications.create(BG_SIGNOUT_NOTE, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: revoked ? "Tvara licence revoked" : "This device was signed out",
      // Says the one thing a person needs to hear first: their history is safe.
      message: revoked
        ? "Pro is off on this device. Your archive stays on this machine."
        : "Signed out from another device. Your archive stays on this machine \u2014 sign in to turn Pro back on.",
      priority: 2,
      requireInteraction: false
    });
  } catch { /* notifications unavailable — the popup still carries it */ }
}

/* ---------- the live device channel ----------
   A socket to the account's Durable Object, so signing this device out from
   another one lands here in about a second instead of waiting out the alarm.

   docs/SESSIONS.md §4 designed this and dropped it, on the grounds that keeping
   an MV3 worker awake for a licensing event is a poor trade. That is now
   accepted deliberately — but only the ACCELERATION was ever in question, and
   nothing below decides anything: every path here ends in the same
   markSignedOut() the heartbeat writes, and a socket that never connects costs
   the alarm's interval, not correctness.

   The ping is not politeness. An MV3 worker is killed after 30 seconds of
   silence and WebSocket traffic is what resets that timer, so the interval IS
   the mechanism keeping this channel open. */
const BG_WS_PING_MS = 25e3;
const BG_WS_MIN_BACKOFF_MS = 5e3;
const BG_WS_MAX_BACKOFF_MS = 60e3;
let sessionWs = null;
let sessionWsPing = null;
let sessionWsRetry = null;
let sessionWsBackoff = BG_WS_MIN_BACKOFF_MS;
/* Set when the issuer closes us with 4001. A device that was just signed out
   reconnecting is a loop, and the ticket it would need is gone with the seat. */
let sessionWsDone = false;

function sessionWatchClose() {
  if (sessionWsPing) { clearInterval(sessionWsPing); sessionWsPing = null; }
  if (sessionWs) { try { sessionWs.close(); } catch { /* already closed */ } sessionWs = null; }
}

function sessionWatchRetry() {
  if (sessionWsDone || sessionWsRetry) return;
  const wait = sessionWsBackoff;
  sessionWsBackoff = Math.min(BG_WS_MAX_BACKOFF_MS, Math.round(sessionWsBackoff * 1.8));
  sessionWsRetry = setTimeout(() => {
    sessionWsRetry = null;
    sessionWatchConnect("retry").catch(() => {});
  }, wait);
}

/**
 * Open the channel, or leave it shut and say why.
 *
 * The ticket comes from listSessions(), which is a SIGNED call — that is the
 * whole reason the upgrade can be trusted, since a WebSocket handshake carries
 * no body to sign. One ticket per connection: a reconnect asks again rather
 * than replaying a minute-old one.
 */
async function sessionWatchConnect(reason) {
  if (sessionWsDone) return { status: "signed-out" };
  if (sessionWs) return { status: "open" };
  if (typeof WebSocket === "undefined") return { status: "unsupported" };
  let url;
  try {
    const res = await self.LCTEntitlement.listSessions();
    if (!res || res.branch !== "ok") return { status: res ? res.branch : "network" };
    url = self.LCTEntitlement.sessionWatchUrl((res.data || res.json || {}).ticket);
  } catch { return { status: "error" }; }
  // No ticket is the issuer saying it has no live channel to offer. Not a
  // failure: the heartbeat is the floor and it is still running.
  if (!url) return { status: "no-channel" };

  let ws;
  try { ws = new WebSocket(url); } catch { sessionWatchRetry(); return { status: "error" }; }
  sessionWs = ws;
  ws.addEventListener("open", () => {
    sessionWsBackoff = BG_WS_MIN_BACKOFF_MS;
    trace("watch-open", String(reason || "?"));
    sessionWsPing = setInterval(() => {
      try { ws.send("ping"); } catch { /* closing; the close handler retries */ }
    }, BG_WS_PING_MS);
  });
  ws.addEventListener("message", (ev) => { sessionWatchMessage(ev && ev.data); });
  ws.addEventListener("close", (ev) => {
    if (ev && ev.code === 4001) sessionWsDone = true;
    sessionWatchClose();
    trace("watch-close", String((ev && ev.code) || "?"));
    sessionWatchRetry();
  });
  ws.addEventListener("error", () => { sessionWatchClose(); sessionWatchRetry(); });
  return { status: "connecting" };
}

/* What the object says. Two messages and nothing else is acted on.
   `killed` is this device; `changed` says only that the list moved, which is
   why it carries no fingerprints. */
async function sessionWatchMessage(raw) {
  let msg;
  try { msg = JSON.parse(String(raw || "")); } catch { return; }
  if (!msg || typeof msg.type !== "string") return;
  if (msg.type === "killed") {
    sessionWsDone = true;
    trace("watch-killed", String(msg.reason || "terminated"));
    /* Written by the same two calls the heartbeat uses. The push is a faster
       way to learn the news, never a second way of deciding it. */
    try { await self.LCTEntitlement.applyRemoteSignOut(msg.reason); }
    catch { /* dead context: the heartbeat writes the same thing */ }
    await notifySignedOut(msg.reason);
    sessionWatchClose();
    return;
  }
  if (msg.type === "changed") {
    /* Somebody else's row moved. Nothing is decided here — the device screen
       re-reads /sessions when it is opened, and this only makes sure a popup
       already open is not painting a list that has stopped being true. */
    try { await chrome.runtime.sendMessage({ type: "sessions-changed", version: msg.version }); }
    catch { /* no listener: nothing is open */ }
  }
}

async function sessionTick() {
  lastHeartbeatAt = Date.now();
  await noteHeartbeat(lastHeartbeatAt);
  try {
    const got = await chrome.storage.local.get("license");
    const lic = got && got.license;
    if (!lic || !lic.key) return;
    /* Read BEFORE the call. heartbeat() writes the marker itself, so asking
       afterwards cannot tell "signed out just now" from "signed out last week"
       — and the toast is only owed on the transition. */
    const was = await self.LCTEntitlement.readSignOut();
    const res = await self.LCTEntitlement.heartbeat(lic);
    if (res && res.live === false && !was) await notifySignedOut(res.reason);
    // Came back: a device re-activated elsewhere must not keep a stale toast up.
    if (res && res.live === true && was) {
      try { await chrome.notifications.clear(BG_SIGNOUT_NOTE); } catch { /* fine */ }
    }
  } catch { /* offline, dead context, or no device key — the next tick retries */ }
}

/* The hourly alarm is the floor, not the ceiling.
 *
 * The design called for a Durable Object holding a WebSocket so a sign-out
 * lands in about a second. In an MV3 extension that is the wrong shape: the
 * service worker dies after 30 seconds idle, so holding the socket means
 * pinging it awake forever — a permanently resident worker, on every install,
 * to shorten one licensing event. See docs/SESSIONS.md.
 *
 * This gets most of the way for nothing. The worker already wakes for content
 * script traffic whenever somebody is actually using an AI chat, which is
 * exactly when being signed out matters, so a check-in rides along on a
 * five-minute floor.
 */
const SESSION_ACTIVE_MS = 5 * 60e3;
const BG_HEARTBEAT_AT = "lct-heartbeat-at";
let lastHeartbeatAt = 0;

/* The floor has to OUTLIVE the worker, and a module variable does not.
   An MV3 service worker is killed about 30 seconds after it goes idle and
   respawned on the next content-script message, so `lastHeartbeatAt` resets to
   0 many times an hour and the five-minute floor it is guarding stops existing
   — every respawn asks the issuer again. That is the difference between the
   120 calls a day docs/SESSIONS.md budgets for and several thousand, and it
   bites hardest exactly when somebody is using the product hard: five devices
   share RL_SESSION_MAX (200/hour/key), so the heartbeats start answering 429,
   and a 429 carries no verdict. A device that really was signed out then stops
   finding out — the one job this clock has, lost to its own chatter.

   storage.session is the right home: it survives the respawn and clears on
   browser restart, which is the single moment an unconditional check is
   genuinely wanted anyway. */
async function readHeartbeatAt() {
  /* 0, not lastHeartbeatAt: maybeSessionTick stamps the memory floor to `now`
     before it gets here, so returning that made every comparison `now - now`
     and refused the tick forever instead of falling back to it. No persisted
     floor means the memory floor already ruled — say yes and let it stand. */
  const area = sessionArea();
  if (!area) return 0;
  try {
    const got = await area.get(BG_HEARTBEAT_AT);
    return Number(got && got[BG_HEARTBEAT_AT]) || 0;
  } catch { return 0; }
}

async function noteHeartbeat(at) {
  const area = sessionArea();
  if (!area) return;
  try { await area.set({ [BG_HEARTBEAT_AT]: at }); } catch { /* memory floor stands in */ }
}

function maybeSessionTick() {
  const now = Date.now();
  const was = lastHeartbeatAt;
  if (now - was < SESSION_ACTIVE_MS) return;
  lastHeartbeatAt = now;      // set BEFORE the await: two messages in the same
  dueSessionTick(now, was);   // tick must not both start a request
}

/** The persisted half of the floor, which the line above cannot check without
 *  awaiting — and awaiting there would reopen the same-tick race it closes. */
async function dueSessionTick(now, was) {
  if (now - (await readHeartbeatAt()) < SESSION_ACTIVE_MS) {
    /* Declined, so give the memory floor its old value back. Leaving `now` there
       charged a full SESSION_ACTIVE_MS for a request that never went out: a
       respawn at 4:59 blocked every check until 9:59, doubling the interval this
       clock documents. */
    if (lastHeartbeatAt === now) lastHeartbeatAt = was;
    return;
  }
  await noteHeartbeat(now);
  sessionTick();
}

async function ensureSessionAlarm() {
  try {
    const existing = await chrome.alarms.get(BG_SESSION_ALARM);
    if (existing && existing.periodInMinutes === BG_SESSION_PERIOD_MIN) return;
    await chrome.alarms.create(BG_SESSION_ALARM,
      { delayInMinutes: 2, periodInMinutes: BG_SESSION_PERIOD_MIN });
  } catch { /* alarms unavailable */ }
}

async function ensureEntitlementAlarm() {
  try {
    const existing = await chrome.alarms.get(BG_ENT_ALARM);
    if (existing && existing.periodInMinutes === BG_ENT_PERIOD_MIN) return;
    await chrome.alarms.create(BG_ENT_ALARM,
      { delayInMinutes: 5, periodInMinutes: BG_ENT_PERIOD_MIN });
  } catch { /* alarms unavailable */ }
}

/* Installing IS the go signal. Nothing below waits for a chat site to be
   opened or for a button to be pressed: the allowance readings, the plan on
   each account and the archive all start from here, because an extension whose
   panel is empty until the user stumbles onto the right tab reads as broken.
   Readings first — they land in seconds and they are what the popup draws;
   the archive pass takes minutes and owns its own resume. */
const BG_BOOTSTRAP = "lct-bootstrap-v1";
let bootstrapRunning = null;

async function firstRunBootstrap(reason) {
  // wake() runs as the worker starts and onInstalled follows just behind it.
  // They must share one pass, or a fresh profile can launch two archive scans.
  if (bootstrapRunning) return bootstrapRunning;
  const run = (async () => {
    let ran = false;
    try {
      const held = (await chrome.storage.local.get(BG_BOOTSTRAP))[BG_BOOTSTRAP];
      ran = !!(held && held.at);
    } catch { /* storage unavailable — treat as never run */ }
    // An install is the one reason that overrides the flag: a reinstall wipes
    // storage anyway, and an upgrade from a build without this must still get it.
    if (ran && reason !== "install") return { status: "already" };
    try { await chrome.storage.local.set({ [BG_BOOTSTRAP]: { at: Date.now(), reason } }); }
    catch { /* dead context */ }

    /* The allowance dial and archive are independent. Waiting for an
       unauthenticated provider to time out before starting the archive made a
       newly installed extension look empty for far too long. Both begin now;
       each writes progress as soon as it has a result. */
    const [quota, archive] = await Promise.allSettled([
      quotaSweep("install"),
      autoSyncEnabled().then((enabled) => enabled
        ? autoSyncTick({ skipQuota: true })
        : { status: "disabled" })
    ]);
    return { status: "done", quota: quota.status, archive: archive.status };
  })();
  bootstrapRunning = run;
  try { return await run; }
  finally { if (bootstrapRunning === run) bootstrapRunning = null; }
}

try {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (!alarm) return;
    trace("alarm", alarm.name);
    if (alarm.name === BG_FILL_ALARM) { if (!fillRunning) fillStart(); }
    else if (alarm.name === BG_AUTO_ALARM || alarm.name === BG_RESUME_ALARM) autoSyncTick();
    else if (alarm.name === BG_AUTOBACKUP_ALARM) maybeAutoBackup("alarm");
    else if (alarm.name === BG_ENT_ALARM) entitlementTick();
    else if (alarm.name === BG_SESSION_ALARM) sessionTick();
    else if (alarm.name === BG_ORDER_ALARM) claimPendingOrder().catch(() => {});
  });
  const wake = () => {
    trace("worker-start", thisWorkerId);
    ensureAutoSyncAlarm();
    ensureAutoBackupAlarm();
    ensureEntitlementAlarm();
    ensureSessionAlarm();
    /* Browser start is the one moment a device that was terminated while it was
       switched off can find out before it is used. The alarm's own delay is two
       minutes; this does not wait for it.

       maybeSessionTick, not sessionTick: wake() also runs on every respawn of
       the service worker (see the call below), and an unconditional check there
       is the same flood the floor above exists to stop. At a real browser start
       storage.session is empty, so this still fires immediately. */
    maybeSessionTick();
    // A purchase started before the last shutdown is still owed a licence.
    ensureOrderAlarm().catch(() => {});
    firstRunBootstrap("wake").catch(() => {});   // no-op once it has run
    /* An extension reload and a browser restart both clear alarms, so a fill
       that was mid-queue had nothing left to wake it and stalled at whatever
       percentage it had reached. This is the only listener that runs on both. */
    fillAutoStart("wake").catch(() => {});
    // Same for the listing pass: a restart cleared the alarm that was holding
    // its place, and the period alarm alone is up to three hours away.
    resumeIfUnfinished().catch(() => {});
    /* The socket dies with the worker, so every respawn re-opens it. Cheap when
       there is nothing to open: no identity means no ticket and no call. */
    sessionWatchConnect("wake").catch(() => {});
    // A reinstall wipes storage.local, so the badge has to be repainted from
    // whatever survived rather than assumed to be still on screen.
    readDeletions().then((state) => paintDeletionBadge(Object.keys(state.items).length));
  };
  chrome.runtime.onInstalled.addListener(wake);
  chrome.runtime.onStartup.addListener(wake);
  wake();   // the worker is respawned constantly; keep it alive
} catch (_) { /* alarms API unavailable */ }

/* ---------- first run ----------
   Chrome does not expose an API that pins an extension or opens its native
   extensions menu. It does let us open a first-run tab. Put the actual
   puzzle-menu and pin instruction there immediately, keep it open until the
   browser confirms the pin, and reinforce the same instruction in the
   in-chat tour where our own controls can be physically highlighted. */

try {
  chrome.runtime.onInstalled.addListener(async (details) => {
    if (!details || details.reason !== "install") return;
    try {
      await chrome.storage.local.remove(["lct-welcomed-v1", "lct-tour-v1"]);
      /* Armed, not started: the tour lives in the page and there is no page yet.
         The flag lets the first supported chat run it immediately instead of
         waiting for a conversation long enough to draw a map — a new install is
         usually opened on an empty one, where that wait never ends. */
      await chrome.storage.local.set({ "lct-tour-armed-v1": Date.now() });
    } catch (_) { /* storage unavailable — the onboarding has its own fallback */ }
    // Create before awaiting any provider. This is the install prompt, not a
    // reward for a network request completing.
    try {
      await chrome.tabs.create({ url: chrome.runtime.getURL("onboarding.html?install=1"), active: true });
    } catch (_) { /* a managed browser may prohibit extension tabs */ }
    firstRunBootstrap("install").catch(() => {});
  });
} catch (_) { /* onInstalled unavailable */ }

// Clicking the "a chat was deleted" toast has to land on the decision itself,
// not on a page where the user has to go hunting for it.
try {
  chrome.notifications.onClicked.addListener((id) => {
    if (id === BG_SIGNOUT_NOTE) {
      chrome.notifications.clear(id);
      /* The sign-in button lives in the POPUP, and there is no anchor on the
         Recall page that reaches it — sending them there would be a dead end.
         openPopup() is the only thing that lands on the button itself; it is
         not available on every Chrome, so the Recall page is the fallback
         rather than the destination. */
      const fallback = () => chrome.tabs.create({ url: chrome.runtime.getURL("recall.html") });
      try {
        if (chrome.action && chrome.action.openPopup) chrome.action.openPopup().catch(fallback);
        else fallback();
      } catch { fallback(); }
      return;
    }
    if (id !== "lct-deletions") return;
    chrome.notifications.clear(id);
    chrome.tabs.create({ url: chrome.runtime.getURL("recall.html#deletions") });
  });
} catch (_) { /* notifications API unavailable */ }

/* ---------- entitlement gate ---------- */

/**
 * The paywall. Every gated handler goes through here and nowhere else.
 *
 * Deliberately NOT a cached boolean: a cached `pro` flag in storage is exactly
 * the thing a hand-edited record forges. Each call re-verifies the LCT2
 * signature (cheap — one ECDSA verify, no network).
 *
 * Trial is time-boxed and pinned to first-seen, checked here rather than in the
 * page so wiping local storage does not mint a second one (see trialState).
 */
// Frozen: nobody can delete an entry from the paywall map at runtime to
// route a gated handler around the gate.
const PAID = Object.freeze({
  "recall-search": "archive.search",
  "recall-backup-state": "archive.backup",
  "recall-backup-mark": "archive.backup",
  "recall-autobackup-state": "archive.backup",
  "recall-autobackup-enable": "archive.backup",
  "recall-autobackup-disable": "archive.backup",
  "recall-backup-forget-key": "archive.backup",
  "recall-autobackup-run": "archive.backup",
  "recall-snapshot": "archive.backup",
  /* The same archive, reached from the page instead of the Recall tab. Export
     merges `chat-archive` in as its spine and in-chat search calls `chat-search`
     to reach messages the page never mounted — both are the sync-built archive,
     which is the paid part. Without these two lines the gate three lines above
     is only a gate on the door, not on the wall. Free users keep everything the
     page itself holds: export falls back to the mounted DOM and search to the
     mounted messages. Delete these two lines to give the archive away. */
  "chat-archive": "archive.backup",
  "chat-search": "archive.search",
  "archive-stamp": "archive.backup",
  "recall-restore-ledger": "archive.restore",
  "recall-restore-guard": "archive.restore",
  "recall-restore-guard-fail": "archive.restore",
  "recall-restore-guard-reset": "archive.restore"
});

const TRIAL_MS = 7 * 864e5;
const TRIAL_KEY = "lct-trial-v2";

/**
 * Trial clock, worker-owned and sync-backed. storage.sync survives a local
 * wipe and a reinstall on the same profile, so "clear data, trial again" costs
 * a whole new browser profile instead of one click.
 */
/* A trial that started offline carries the CLIENT's start date, and the client
   is the party with a reason to lie about it. This re-asks the issuer, which
   keyed the real date to a non-extractable device key and remembers it for 400
   days — so "clear everything and start again" gets the original week back
   instead of a fresh one. Throttled: one attempt an hour, and only ever for a
   record that is not already verified. */
const TRIAL_RECHECK_MS = 36e5;          // never verified: hourly
/* Token-backed records are re-asked daily. This is no longer the defence — the
   signature is, and it expires exactly when the week does, so a stale token
   cannot outlive the trial it grants. What the daily call buys is the issuer's
   own corrections: it keys the week on a verified email and only ever moves a
   start date EARLIER, so re-asking is how a client that started its week on one
   install learns the real, earlier date after a second one. */
const TRIAL_REVERIFY_MS = 864e5;
/* A start date cannot be in the future. An hour of slack absorbs an ordinary
   clock that is a little fast; past that the record is not evidence. */
const TRIAL_FUTURE_SLACK_MS = 36e5;

/* Persisted rather than a module variable: this worker unloads within seconds
   of going idle, so an in-memory "last checked" resets constantly and the
   throttle it implements does not exist. */
async function writeTrial(rec) {
  try { await chrome.storage.sync.set({ [TRIAL_KEY]: rec }); } catch { /* quota */ }
  try { await chrome.storage.local.set({ [TRIAL_KEY]: rec }); } catch { /* dead context */ }
  return rec;
}

/* `holds` is whether the token in the record actually grants right now, which
   the caller has already checked. Not re-derived here from rec.tt: a token that
   is present but does not verify — the device key was regenerated, the record
   came from another machine — must be re-asked on the SHORT clock like a
   record with no token at all, or a legitimate user waits a day for a
   correction that takes one request. */
async function verifyTrialStart(rec, nowTrusted, holds) {
  if (!rec) return rec;
  const now = Date.now();
  const startedAt = Number(rec.startedAt) || 0;

  /* Clamp first, and persist the clamp. A future date is either a badly set
     clock or a hand-edited record, and both are answered the same way: the
     trial started no earlier than now. Persisting matters — clamping on every
     read without writing it back would hand out a fresh week every time. */
  if (startedAt > now + TRIAL_FUTURE_SLACK_MS) {
    /* `clamped` is what stops this being a renewable week. Clamping alone still
       hands out seven fresh days, so a record edited once a week never ends.
       A date that cannot be real is not evidence a trial started, so it grants
       nothing until the issuer says otherwise — and the issuer knows, because
       it kept the original. An ordinary offline trial never reaches here: its
       start date is the local clock, which is not in the future. */
    rec = await writeTrial({ ...rec, startedAt: now, verified: false, clamped: true, checkedAt: 0 });
  }

  const started = Number(rec.startedAt) || 0;
  const granting = started + TRIAL_MS > nowTrusted;   // still worth anything?
  const since = now - (Number(rec.checkedAt) || 0);
  /* No token, no grant — so a record without one is due on the SHORT clock
     however verified it claims to be. That covers the upgrade case too: a
     record written before the issuer signed anything says verified:true and
     unlocks nothing, and this is what fetches it a signature within the hour
     instead of at the end of the week. */
  const due = holds
    ? (granting && since >= TRIAL_REVERIFY_MS)
    : (since >= TRIAL_RECHECK_MS);
  if (!due) return rec;

  // Stamp the attempt before the call: an issuer that is down must not be
  // re-asked on every single verdict.
  rec = await writeTrial({ ...rec, checkedAt: now });
  try {
    const deviceFp = await self.LCTEntitlement.sha256Hex(await self.LCTDodo.ensureDeviceId());
    const server = await self.LCTEntitlement.registerTrial(deviceFp);
    /* No signed grant is not an answer. registerTrial already refused a token
       that does not verify against the pinned key or does not bind to this
       device, so reaching here without one means the issuer said "unverified"
       or could not be reached — either way the local record stands unchanged
       and keeps granting nothing. */
    if (!server || !server.tt || !server.startedAt) return rec;
    // The issuer's date wins even when it is EARLIER — that is the whole point.
    // The token carries that date INSIDE the signature, so the clamp marker,
    // which only ever described an unsigned record, goes with it.
    const clean = { ...rec };
    delete clean.clamped;
    return writeTrial({ ...clean, startedAt: server.startedAt, verified: true,
      tt: server.tt, checkedAt: now, ...(server.ks ? { ks: server.ks } : {}),
      ...(server.ksPrev ? { ksPrev: server.ksPrev } : {}) });
  } catch { return rec; }
}

async function trialState() {
  let rec = null;
  try {
    const got = await chrome.storage.sync.get(TRIAL_KEY);
    rec = got && got[TRIAL_KEY];
  } catch { /* sync unavailable */ }
  if (!rec) {
    try {
      const got = await chrome.storage.local.get(TRIAL_KEY);
      rec = got && got[TRIAL_KEY];
    } catch { /* dead context */ }
  }
  /* The high-water clock, not Date.now(). A trial measured against a clock the
     user owns ends whenever they decide it does: winding the machine back a
     year renews it indefinitely. clockNow() never reports earlier than the
     latest time this profile has already seen.
     Read BEFORE verification, because verification needs it to decide whether
     the record is still granting anything worth a request. */
  let nowTrusted = Date.now();
  try { nowTrusted = (await self.LCTEntitlement.clockNow()).trusted; } catch { /* pre-init */ }

  /* The grant, and the ONLY grant: an ECDSA signature from the issuer over this
     identity's start date, bound to this install's device key, expiring when
     the week does. Everything else in the record — the date, the `verified`
     flag, `ks` — is writable by whoever owns the browser, so none of it decides
     anything. Checked on every call rather than cached, for the same reason the
     licence gate is (see PAID above).

     Verified BEFORE the recheck, because the recheck's schedule depends on
     whether what we hold is worth anything, and again after it if the issuer
     handed back a different one. */
  const grantOf = async (r) => {
    if (!r || !r.tt) return null;
    // A gate that throws is a gate that is not answering. No grant, not an error.
    try { return await self.LCTEntitlement.trialGrant(r.tt, nowTrusted); }
    catch { return null; }
  };
  let grant = await grantOf(rec);
  if (rec) {
    const had = rec.tt;
    rec = await verifyTrialStart(rec, nowTrusted, !!(grant && grant.grants));
    if (rec && rec.tt !== had) grant = await grantOf(rec);
  }

  /* Answered from the signature and nothing else, ahead of every check below —
     those exist to judge a record NOBODY signed. Editing the record's own copy
     of the dates, or deleting them, moves nothing here. */
  if (grant && grant.startedAt) {
    return { started: true, active: nowTrusted < grant.until,
      spent: nowTrusted >= grant.until, until: grant.until,
      verified: true, grants: grant.grants, ks: grant.ks,
      // Not in the token — it is the pre-re-key archive secret, kept locally.
      ksPrev: String((rec && rec.ksPrev) || "") };
  }

  const startedAt = Number(rec && rec.startedAt) || 0;
  // NaN, negative, a string, a future date verification could not reach the
  // issuer about — none of those start a trial.
  /* `verified` is a flag anyone can write; `tt` is a signature nobody can
     forge. The clamp is only lifted by the second one. */
  const unsettled = !!(rec && rec.clamped && !rec.tt);
  if (!(startedAt > 0) || startedAt > Date.now() + TRIAL_FUTURE_SLACK_MS || unsettled) {
    // Reported as "never started" so the offer still stands: a user whose clock
    // was wrong gets their trial the moment the issuer can be reached.
    return { started: false, active: false, spent: false, until: 0, ks: "" };
  }

  /* An unsigned week. `active` is about the CLOCK; `grants` is about
     entitlement, and here they part company: the seven days run and unlock
     nothing. That is what makes an issuer outage useless to farm — uninstall,
     reinstall, and the fresh week still opens no Pro feature until an identity
     is proved, at which point the issuer hands back the ORIGINAL start date. */
  const until = startedAt + TRIAL_MS;
  return { started: true, active: nowTrusted < until, spent: nowTrusted >= until,
    until, verified: false, grants: false,
    reason: (grant && grant.reason) || "unsigned", ks: "" };
}

async function startTrial() {
  const cur = await trialState();
  if (cur.started) return cur;                       // one per profile, ever

  /* No week without an address behind it.

     An unverified week is anchored to a keypair in this extension's own
     storage, and uninstalling destroys it. So the week a user had already
     spent came back as a fresh offer on reinstall, and the days they were
     actually owed could not be found again — the issuer had a device row for a
     device that no longer exists and no email to match it to. The verified
     address is the only anchor that survives, and it has to be there BEFORE
     the clock starts, not sometime during the week.

     Both surfaces that draw the button check this first. This is the rule
     itself, so no other caller of `trial-start` can route around it, and so a
     UI holding a stale "signed in" cannot start an orphan week. */
  let verified = false;
  try {
    const rec = await self.LCTEntitlement.readIdentity();
    verified = !!(rec && rec.idt);
  } catch { /* pre-init: treat as signed out */ }
  if (!verified) return { ...cur, branch: "unverified" };

  // Ask the issuer first. It remembers this device across reinstalls and
  // storage wipes, so a returning user gets their ORIGINAL start date back
  // rather than a fresh week. Offline, we fall back to our own clock — a
  // 7-day trial is not worth refusing to work without a network.
  let startedAt = 0, trialTt = "", trialKs = "", trialKsPrev = "";
  try {
    const deviceFp = await self.LCTEntitlement.sha256Hex(await self.LCTDodo.ensureDeviceId());
    const server = await self.LCTEntitlement.registerTrial(deviceFp);
    /* `unverified` is the issuer saying "no identity, so I am keeping no
       record". The week still starts — refusing to run offline is a hostile
       answer to a network problem — but it grants nothing until an identity is
       proved, so there is nothing here worth farming. */
    if (server && !server.unverified && server.tt) {
      startedAt = server.startedAt; trialTt = server.tt; trialKs = server.ks || "";
      trialKsPrev = server.ksPrev || "";
    }
  } catch { /* issuer unreachable */ }

  // Both stores: sync is the durable record, local is the offline fallback.
  /* checkedAt is the throttle stamp, so it only marks an issuer that ANSWERED.
     Stamping it after an unreachable issuer armed the one-hour wait against the
     very first retry: the week started unverified and stayed that way for an
     hour with nothing the user could do. */
  await writeTrial({ startedAt: startedAt || Date.now(), v: 2, checkedAt: trialTt ? Date.now() : 0,
    ...(trialTt ? { tt: trialTt, verified: true } : {}), ...(trialKs ? { ks: trialKs } : {}),
    ...(trialKsPrev ? { ksPrev: trialKsPrev } : {}) });
  return trialState();
}


/* ---------- identity ----------
 *
 * WHY. Every ledger used to key on a device keypair held in this extension's
 * own IndexedDB, and uninstalling destroys it. That made the trial resettable
 * by removing Tvara and adding it back, and it made a paid licence unfindable
 * afterwards — the buyer re-pasted a key out of an email and burned a fresh
 * seat doing it. A verified email survives both.
 *
 * The address is never stored here. It goes to the issuer, which keeps only
 * its hash, and what comes back is an opaque token that names an identity and
 * grants nothing by itself.
 */

/* Empty disables the Google button; the code path stays inert and the OTP
   route is unaffected. Fill in from Google Cloud Console → Credentials →
   OAuth client ID → Web application. */
const GOOGLE_CLIENT_ID = "276513864843-6mf2p200h51i1b1m9ghkuav7fctmt5ku.apps.googleusercontent.com";

/**
 * Google sign-in only where the redirect can be registered.
 *
 * Firefox mints a fresh moz-extension UUID per INSTALL, so its redirect URL is
 * different on every machine and no OAuth client can name it. Rather than
 * offer a button that 400s for every Firefox user, this reports false there
 * and the OTP route — which has no such problem — carries them.
 */
function googleSignInAvailable() {
  if (!GOOGLE_CLIENT_ID) return false;
  try {
    return String(chrome.identity.getRedirectURL()).includes(".chromiumapp.org");
  } catch { return false; }
}

/* The face on the account card: picture URL, display name, address. Read out
   of the id_token this device already holds and kept LOCAL — the issuer is
   told none of it, and it is not in `sync`, because a photo URL is the one
   piece of the identity that is worth nothing on another machine. */
const PROFILE_KEY = "lct-identity-profile-v1";

/** The claims of a JWT, for display only. Nothing here is trusted: the grant
 *  is the issuer's own signed token, checked elsewhere. */
function jwtClaims(token) {
  try {
    const part = String(token || "").split(".")[1] || "";
    if (!part || part.length > 4096) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const out = JSON.parse(json);
    return out && typeof out === "object" ? out : null;
  } catch { return null; }
}

/** Google serves avatars at whatever size the URL asks for. 96px covers a
 *  retina 36px circle and nothing larger is ever rendered. */
function avatarUrl(raw) {
  const url = String(raw || "");
  if (!/^https:\/\/[a-z0-9.-]*\.googleusercontent\.com\//i.test(url)) return "";
  if (url.length > 512) return "";
  return url.replace(/=s\d+(-c)?$/, "=s96-c");
}

async function writeProfile(claims) {
  const profile = {
    picture: avatarUrl(claims && claims.picture),
    name: String((claims && claims.name) || "").slice(0, 64),
    email: String((claims && claims.email) || "").slice(0, 254)
  };
  if (!profile.picture && !profile.name && !profile.email) return null;
  try { await chrome.storage.local.set({ [PROFILE_KEY]: profile }); } catch { /* dead context */ }
  return profile;
}

async function readProfile() {
  try {
    const got = await chrome.storage.local.get(PROFILE_KEY);
    const p = got && got[PROFILE_KEY];
    return p && typeof p === "object" ? p : null;
  } catch { return null; }
}

async function identityState() {
  let rec = null;
  try { rec = await self.LCTEntitlement.readIdentity(); } catch { /* pre-init */ }
  const verified = !!(rec && rec.idt);
  return { verified, at: Number(rec && rec.at) || 0,
    google: googleSignInAvailable(),
    // Only ever alongside a live identity: a face left over from an account
    // this install has signed out of would be naming the wrong person.
    profile: verified ? await readProfile() : null };
}

/** Ask the issuer to mail a code. */
async function identitySendCode(email) {
  try { return await self.LCTEntitlement.identityStart(email); }
  catch { return { branch: "network" }; }
}

/**
 * Spend the code, then settle everything that was waiting on an identity: a
 * trial that was running unverified becomes verified against the issuer's own
 * start date, and a purchase made before the uninstall comes back.
 */
async function identityConfirmCode(email, code) {
  let res;
  try { res = await self.LCTEntitlement.identityVerify(email, code); }
  catch { return { branch: "network" }; }
  if (res.branch !== "ok") return res;
  return { ...res, settled: await settleAfterVerify(res.json) };
}

/**
 * The Google route to the same anchor.
 *
 * `nonce` is minted by the entitlement lib, travels inside the id_token, and
 * is checked against the signature on the request that presents it — so an
 * id_token obtained anywhere else cannot be posted here.
 */
async function identityGoogleSignIn() {
  if (!googleSignInAvailable()) return { branch: "unavailable" };
  const nonce = await self.LCTEntitlement.identityGoogleNonce();
  const redirect = chrome.identity.getRedirectURL();
  const url = "https://accounts.google.com/o/oauth2/v2/auth"
    + "?client_id=" + encodeURIComponent(GOOGLE_CLIENT_ID)
    + "&response_type=id_token"
    /* `profile` buys exactly one thing: the picture and display name in the
       id_token, which is what puts a face on the account card. Both are read
       out of the token locally and never sent to the issuer. */
    + "&scope=" + encodeURIComponent("openid email profile")
    + "&redirect_uri=" + encodeURIComponent(redirect)
    + "&nonce=" + encodeURIComponent(nonce)
    // Always ask which account. Silently reusing whichever one the browser is
    // signed into is how a person anchors their trial to the wrong mailbox.
    + "&prompt=select_account";

  let landed;
  try {
    landed = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
  } catch { return { branch: "cancelled" }; }
  if (!landed) return { branch: "cancelled" };

  /* The id_token comes back in the FRAGMENT, which never reaches a server —
     that is the point of this response type. */
  const hash = String(landed).split("#")[1] || "";
  const idToken = new URLSearchParams(hash).get("id_token") || "";
  if (!idToken) return { branch: "cancelled" };

  let res;
  try { res = await self.LCTEntitlement.identityGoogle(idToken); }
  catch { return { branch: "network" }; }
  if (res.branch !== "ok") return res;
  // Only after the issuer has accepted the token: a face stored against a
  // sign-in that failed would outlive an identity that never existed.
  await writeProfile(jwtClaims(idToken));
  return { ...res, settled: await settleAfterVerify(res.json) };
}

/**
 * What a fresh verification is worth, applied immediately.
 *
 * Two things can be waiting: a week this identity already spent (so the local
 * record must be corrected DOWN to the issuer's date, never up), and a licence
 * it owns (so Pro comes back without a key). Both are best-effort — a failure
 * here leaves the identity verified and the next ordinary check picks it up.
 */
async function settleAfterVerify(answer) {
  const out = { trial: false, restored: false };
  const startedAt = Number(answer && answer.startedAt) || 0;
  if (startedAt) {
    /* The answer says this identity already has a week, but says it in an
       unsigned body — and a date without a signature grants nothing now. Ask
       /trial for the signed record of the SAME week. It cannot start a second
       one: the issuer keys the trial on this identity and hands back the
       existing row, correcting the date downwards if ours drifted. */
    const server = await self.LCTEntitlement.registerTrial("");
    if (server && server.tt) {
      await writeTrial({ startedAt: server.startedAt, v: 2, verified: true,
        tt: server.tt, checkedAt: Date.now(), ...(server.ks ? { ks: server.ks } : {}),
        ...(server.ksPrev ? { ksPrev: server.ksPrev } : {}) });
      out.trial = true;
    }
  }
  if (answer && answer.owns) out.restored = (await identityRestore()).restored === true;
  return out;
}

/**
 * Bring a purchase back after a reinstall.
 *
 * The issuer does the work: it finds the licence this identity owns, checks it
 * is still live upstream, reclaims a seat (evicting this identity's own
 * stalest one rather than refusing the buyer), and hands back a signed token.
 * Nothing here trusts that token — writeToken stores it and the ordinary
 * verify path decides what it is worth.
 */
async function identityRestore() {
  let res;
  try { res = await self.LCTEntitlement.restorePurchase(); }
  catch { return { ok: false, reason: "network" }; }
  if (res.branch === "unverified") return { ok: false, reason: "unverified" };
  if (res.branch !== "ok") return { ok: false, reason: res.branch };
  const json = res.json || {};
  if (!json.restored || typeof json.key !== "string" || !json.key) {
    return { ok: true, restored: false };
  }

  const now = Date.now();
  await chrome.storage.local.set({
    license: { key: json.key, email: "", plan: "pro", kind: "dodo",
      instanceId: "", licenseKeyId: "", activatedAt: now, restored: true },
    "lct-license-state-v1": { lastValidatedAt: now, lastAttemptAt: now, strikes: [] }
  });
  if (typeof json.token === "string" && json.token) {
    try { await self.LCTEntitlement.writeToken({ token: json.token, fetchedAt: now }); }
    catch { /* the next refresh fetches one */ }
  }
  return { ok: true, restored: true, seats: Number(json.seats) || 0 };
}

/**
 * Forget the identity on THIS install only.
 *
 * Deliberately does not touch the issuer's ledger: signing out is not a way to
 * release a spent trial. It also leaves the licence record alone — someone
 * switching the anchored mailbox should not lose the Pro they already have.
 */
async function identitySignOut() {
  try { await self.LCTEntitlement.clearIdentity(); } catch { /* already gone */ }
  try { await chrome.storage.local.remove(PROFILE_KEY); } catch { /* already gone */ }
  return identityState();
}

/** Cached only within a single wake of the worker, never persisted. */
/**
 * Register a seat for a Dodo key, store it, and mint the entitlement.
 *
 * Same three steps the popup performs, in the same order and all awaited. A
 * seat without a token looks like success and unlocks nothing, so a partial
 * result is reported as a failure rather than an "activated".
 */
async function activateLicenseKey(key) {
  const k = String(key || "").trim();
  if (!k) return { ok: false, reason: "empty" };
  if (self.LCTLicense.kindOf(k) === "lct1") {
    const v = await self.LCTLicense.verify(k);
    if (!v.valid) return { ok: false, reason: v.reason || "bad-key" };
    await chrome.storage.local.set({
      license: { key: k, email: v.email || "", plan: "pro", kind: "lct1", activatedAt: Date.now() }
    });
    return { ok: true, kind: "lct1", email: v.email || "" };
  }
  if (!self.LCTDodo.looksLikeKey(k)) return { ok: false, reason: "bad-key" };

  let res;
  try { res = await self.LCTDodo.activateWithSeats(k, {}); }
  catch (error) { return { ok: false, reason: "network", detail: String(error && error.message || error) }; }
  if (!res || !res.ok) return { ok: false, reason: (res && res.reason) || "refused", seats: res && res.seats };

  const now = Date.now();
  const record = {
    key: k, email: res.email || "", plan: "pro", kind: "dodo",
    instanceId: res.instanceId, licenseKeyId: res.licenseKeyId || "", activatedAt: now
  };
  await chrome.storage.local.set({
    license: record,
    "lct-license-state-v1": { lastValidatedAt: now, lastAttemptAt: now, strikes: [] }
  });

  /* Activation, and only activation, may clear a sign-out this device was
     given from somewhere else. The 12-hourly tick must not. */
  const ent = await self.LCTEntitlement.refresh(record, res.deviceId,
    { force: true, activate: true });
  if (!ent.ok) {
    /* `branch` is carried out rather than collapsed into "entitlement". The
       seat is already claimed at this point, so every one of these is a person
       who has PAID and is looking at a failure — and "something went wrong" is
       the difference between an email to support and a chargeback. */
    return { ok: false, reason: ent.revoked ? "revoked" : "entitlement",
             branch: ent.branch || "", seated: true, email: record.email };
  }
  return { ok: true, kind: "dodo", email: record.email, evicted: res.evicted || 0 };
}

/* ---------- checkout ----------

   The Buy button used to open a web page that had a payment link on it. It now
   asks the issuer to open a session and opens THAT, then waits here — because
   the popup is closed within a second of the click and paying takes a minute.

   Two things drive the claim, and neither is trusted on its own:

     - The page the buyer lands on afterwards pings us. Fast, and the ordinary
       case: the licence is active before they have read the thank-you.
     - A one-minute alarm. Slower, and the one that survives the service worker
       being torn down mid-purchase, the tab being closed on the receipt, or the
       browser being quit and reopened an hour later.

   The buyer does nothing in either path. Nothing is pasted, nothing is read out
   of an email, and no licence key is ever in a URL.
*/
const BG_ORDER_ALARM = "lct-order-claim";
const BG_ORDER_KEY = "lct-pending-order-v1";
/* The client half of "a paid order reports expired".
   This used to be 24 hours, to match the issuer's ORDER_TTL_MS, on the reasoning
   that past it the order is gone server-side. That is only true of an order
   NOBODY PAID FOR — the issuer sweeps those after a day and keeps a settled one
   for the support window. So a webhook that ran slow meant this threw away the
   ref for an order the buyer had already paid, before asking anyone about it.
   Age no longer decides: the issuer's own terminal answers — unknown, expired,
   refunded — clear the record (see the tail of claimPendingOrder). This is the
   backstop for an issuer that can never be reached at all. */
const BG_ORDER_KEEP_MS = 180 * 864e5;

async function readPendingOrder() {
  try {
    const got = await chrome.storage.local.get(BG_ORDER_KEY);
    const order = got && got[BG_ORDER_KEY];
    return order && typeof order.ref === "string" ? order : null;
  } catch { return null; }
}

async function clearPendingOrder() {
  try { await chrome.storage.local.remove(BG_ORDER_KEY); } catch { /* dead context */ }
  try { await chrome.alarms.clear(BG_ORDER_ALARM); } catch { /* alarms unavailable */ }
}

/** Re-arm on wake. A purchase started before the last shutdown is still owed. */
async function ensureOrderAlarm() {
  const pending = await readPendingOrder();
  if (!pending) {
    try { await chrome.alarms.clear(BG_ORDER_ALARM); } catch { /* alarms unavailable */ }
    return;
  }
  try {
    if (!(await chrome.alarms.get(BG_ORDER_ALARM))) {
      await chrome.alarms.create(BG_ORDER_ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
    }
  } catch { /* alarms unavailable — the landing-page ping still closes the loop */ }
}

/**
 * Open a checkout and remember what we are owed.
 *
 * The URL is the issuer's answer, and lib/entitlement.js has already refused
 * anything that is not the payment provider's own https host — a server saying
 * "send them here to type a card number" is exactly the instruction that must
 * not be taken on trust.
 */
async function startCheckoutFlow() {
  const res = await self.LCTEntitlement.startCheckout();
  if (res.branch !== "ok") return { ok: false, reason: res.branch };

  try {
    await chrome.storage.local.set({ [BG_ORDER_KEY]: { ref: res.ref, startedAt: Date.now() } });
  } catch { /* dead context — the tab below is still worth opening */ }
  try { await chrome.alarms.create(BG_ORDER_ALARM, { delayInMinutes: 1, periodInMinutes: 1 }); }
  catch { /* alarms unavailable */ }

  try { await chrome.tabs.create({ url: res.url }); }
  catch { return { ok: true, ref: res.ref, url: res.url, opened: false }; }
  return { ok: true, ref: res.ref, url: res.url, opened: true };
}

/**
 * One claim attempt.
 *
 * Returns a state rather than a boolean so a page that is still open can say
 * something true while it waits. Every failure is a state too: this runs on a
 * timer behind a purchase somebody has already paid for, and a thrown error
 * here is a silent one.
 */
async function claimPendingOrder() {
  const pending = await readPendingOrder();
  if (!pending) return { state: "none" };

  if (Date.now() - Number(pending.startedAt || 0) > BG_ORDER_KEEP_MS) {
    await clearPendingOrder();
    return { state: "expired" };
  }

  /* A key already in hand means a previous tick claimed it and activation is
     what failed. Do not ask again — the issuer hands a key back ONCE and would
     answer "claimed" and nothing else. */
  let key = String(pending.key || "");
  let state = key ? "ready" : "";

  if (!key) {
    const res = await self.LCTEntitlement.claimCheckout(pending.ref);
    // Not an answer about the order — a network or proof problem. Keep waiting.
    if (res.branch !== "ok") return { state: "waiting", branch: res.branch };
    state = res.state;
    key = String(res.key || "");

    if (key) {
      /* Persisted BEFORE activation is attempted. A failed activation is
         retryable; a key that only ever lived in a local variable is a person
         who paid, got nothing, and has to be found by hand in support. */
      pending.key = key;
      try { await chrome.storage.local.set({ [BG_ORDER_KEY]: pending }); }
      catch { /* dead context; the emailed copy is the remaining path */ }
    }
  }

  if (key) {
    const act = await activateLicenseKey(key);
    if (act.ok) {
      await clearPendingOrder();
      return { state: "active", email: act.email || "" };
    }
    // Keep the record. The key is ours now and the next tick can try again.
    return { state: "held", reason: act.reason || "", branch: act.branch || "" };
  }

  /* Terminal server-side. "claimed" without a key of our own means this install
     took it and lost it before it could be stored — rare, and the emailed copy
     is the recovery, which is why the popup keeps its paste box. */
  if (state === "refunded" || state === "expired" || state === "claimed" || state === "unknown") {
    await clearPendingOrder();
    return { state };
  }
  return { state: state || "pending" };
}

async function entitlementVerdict() {
  let license = null;
  try {
    const got = await chrome.storage.local.get("license");
    license = got && got.license;
  } catch { /* dead context */ }

  const trial = await trialState();
  if (!license || !license.key) {
    return { entitled: !!trial.grants, via: trial.grants ? "trial" : "none", trial,
      features: trial.grants ? (self.LCTEntitlement?.FEATURES || []) : [] };
  }

  let deviceId = "";
  try { deviceId = await self.LCTDodo.ensureDeviceId(); } catch { /* pre-activation */ }

  const res = await self.LCTEntitlement.evaluate(license, deviceId);
  if (res.entitled) return { ...res, via: res.kind, trial };
  // A dead licence still leaves an unspent trial usable.
  if (trial.grants) return { entitled: true, via: "trial", trial, features: self.LCTEntitlement.FEATURES.slice(), reason: res.reason };
  return { ...res, via: "none", trial };
}

/**
 * Stamp credentials, off the same verdict the gate uses — so a trial seals a
 * real backup and a locked install seals nothing. Pro takes the per-licence
 * secret from its token (stable across renewals, portable to a reinstall);
 * trial takes the one the issuer minted for its device.
 */
async function stampSecret() {
  const v = await entitlementVerdict();
  if (!v.entitled) return null;
  if (v.via === "trial") {
    if (v.trial && v.trial.ks) return v.trial.ks;
    // Offline trial: no issuer secret to anchor to. Mint one locally and keep
    // it, so the file still verifies on the way back in. Weaker than the Pro
    // secret (not server-derived, not portable) — but reaching this at all
    // means passing requireEntitlement, which a locked install cannot.
    return ensureLocalStampSecret();
  }
  if (v.kind === "lct1") {
    const got = await chrome.storage.local.get("license");
    const key = got && got.license && got.license.key;
    return key ? await self.LCTEntitlement.sha256Hex("lct1-archive:" + key, 32) : null;
  }
  return v.ks || null;
}

const LOCAL_STAMP_KEY = "lct-stamp-local-v1";

async function ensureLocalStampSecret() {
  try {
    const got = await chrome.storage.local.get(LOCAL_STAMP_KEY);
    const cur = got && got[LOCAL_STAMP_KEY];
    if (typeof cur === "string" && cur.length >= 40) return cur;
  } catch { /* dead context */ }
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const secret = btoa(String.fromCharCode(...bytes));
  try { await chrome.storage.local.set({ [LOCAL_STAMP_KEY]: secret }); } catch { /* dead context */ }
  return secret;
}

async function stampCreds() {
  const secret = await stampSecret();
  if (!secret) return { stampKey: null, stampSub: "" };
  let bytes;
  try {
    bytes = Uint8Array.from(atob(secret.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  } catch { bytes = new TextEncoder().encode(secret); }
  let stampKey = null;
  try {
    stampKey = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" },
      false, ["sign", "verify"]);
  } catch { /* unusable secret */ }
  let stampSub = "";
  try {
    const got = await chrome.storage.local.get("license");
    if (got && got.license && got.license.key) {
      stampSub = await self.LCTEntitlement.sha256Hex(got.license.key);
    }
  } catch { /* dead context */ }
  return { stampKey, stampSub, secret, alts: await stampAltSecrets() };
}

/**
 * Secrets that only ever OPEN a file, never seal one.
 *
 * The trial archive stamp was re-keyed from the device fingerprint to the
 * identity one. Every v3 backup sealed during a trial before that deploy
 * verifies under the old secret alone, and without this every one of them
 * became permanently unreadable.
 */
async function stampAltSecrets() {
  const v = await entitlementVerdict();
  if (!v.entitled || v.via !== "trial") return [];
  const prev = v.trial && v.trial.ksPrev;
  return prev ? [String(prev)] : [];
}

/* ---------- point-of-use revalidation ----------
   The 12h alarm bounds how long a cancelled licence keeps working in the
   background; this bounds it to the next Pro action. A licence refunded at
   14:00 is refused at 14:00:01, because the action itself pays for the round
   trip once the token has gone stale.

   Only an ANSWER locks. A refusal from the issuer clears the token in
   attempt(); a timeout or an outage leaves the cached verdict exactly as it
   was, so a Pro user offline on a plane is never blocked by their own
   connectivity. The race below is what keeps that promise cheap: a slow
   network costs one action's worth of delay, not the action. */
const ENT_FRESH_MS = 15 * 60e3;
const ENT_BLOCK_MS = 5000;

async function revalidateIfStale() {
  try {
    const rec = await self.LCTEntitlement.readToken();
    // No token: a trial or an LCT1 key, neither of which the issuer decides.
    if (!rec || Date.now() - (rec.fetchedAt || 0) < ENT_FRESH_MS) return;
    const got = await chrome.storage.local.get("license");
    const lic = got && got.license;
    if (!lic || !lic.key || /^LCT1\./.test(lic.key)) return;
    const deviceId = await self.LCTDodo.ensureDeviceId();
    // Forced: an unforced refresh does nothing until the 30d renewal window,
    // and revocation cannot wait 60 days for it to open.
    await self.LCTEntitlement.refresh(lic, deviceId, { force: true });
  } catch { /* offline or dead context — the cached verdict stands */ }
}

async function requireEntitlement(feature) {
  await Promise.race([revalidateIfStale(), sleep(ENT_BLOCK_MS)]);
  const v = await entitlementVerdict();
  if (!v.entitled) return { ok: false, reason: v.reason || "locked" };
  if (v.via !== "trial" && Array.isArray(v.features) && !v.features.includes(feature)) {
    return { ok: false, reason: "feature" };
  }
  return { ok: true, via: v.via, stale: !!v.stale };
}

/* ---------- message router ---------- */

// Keyboard shortcuts
try {
  chrome.commands.onCommand.addListener((name) => {
    chrome.storage.local.set({ "lct-cmd": { name, at: Date.now() } });
  });
} catch (_) { /* commands API unavailable */ }

/* ---------- rapid-query detection ---------- */
// A normal popup opens once; an automated bypass tool hammers entitlement-state
// dozens of times per second. Flagging this does not block the user — it rate-
// limits the response so scripted brute-force cannot converge on a working
// payload in practical time.
const _queryLog = [];      // circular buffer of timestamps
const _QUERY_WINDOW = 60000;
const _QUERY_MAX = 50;

function _queryThrottle() {
  const now = Date.now();
  _queryLog.push(now);
  // Evict entries outside the window
  while (_queryLog.length > 0 && _queryLog[0] < now - _QUERY_WINDOW) _queryLog.shift();
  return _queryLog.length > _QUERY_MAX;
}

// ---------- sender validation ----------
// Content scripts and extension pages originate from a chrome-extension:// URL.
// An externally_connectable page or injected context would carry the web page's
// URL. The id check (below) already blocks other extensions; the URL guard
// catches any message arriving from a web page context.
function _senderAllowed(sender) {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  // Service worker self-messages have no url/tab.
  if (!sender.url && !sender.tab) return true;
  const url = sender.url || (sender.tab && sender.tab.url) || "";
  // Accept: chrome-extension://<own-id>/*, moz-extension://<uuid>/*
  if (/^(chrome|moz)-extension:\/\//i.test(url)) return true;
  // Accept: AI sites the content script runs on (matches manifest host_permissions)
  if (/^https:\/\/(chatgpt\.com|chat\.openai\.com|claude\.ai|gemini\.google\.com|www\.perplexity\.ai|chat\.deepseek\.com|grok\.com)/i.test(url)) return true;
  // Our own post-purchase page, which activates the licence it was handed.
  if (/^https:\/\/tvara-app\.github\.io\//i.test(url)) return true;
  // Accept: localhost and 127.0.0.1 (dev/test, http or https — matches manifest)
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(url)) return true;
  return false;
}

// ---------- closure-captured gate ----------
// The message handler captures this reference at definition time. Reassigning
// the global `requireEntitlement` from DevTools changes nothing — the router
// calls through _gate, which is unreachable from outside this scope.
const _gate = requireEntitlement;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!_senderAllowed(sender)) return false;

  const run = async () => {
    /* Somebody is using the extension, so this is a cheap moment to find out
       whether this device is still signed in. Fire and forget: nothing below
       waits on it, and a failure changes nothing. */
    maybeSessionTick();

    // Rate-limit entitlement probes
    if ((msg && msg.type) === "entitlement-state" && _queryThrottle()) {
      await new Promise((r) => setTimeout(r, 2000)); // throttle, not block
    }

    const feature = PAID[msg && msg.type];
    if (feature) {
      // Use the closure-captured _gate, not the global requireEntitlement.
      const gate = await _gate(feature);
      if (!gate.ok) return { err: "locked", feature, reason: gate.reason };
    }

    switch (msg && msg.type) {
      case "entitlement-state": return entitlementVerdict();
      /* Opening the popup is the other moment a terminated device can find
         out promptly, and it costs one request. Handled here rather than in
         the popup so every network call in the licensing path stays in one
         place, with one backoff. */
      case "session-heartbeat": {
        const got = await chrome.storage.local.get("license");
        const lic = got && got.license;
        if (!lic || !lic.key) return { skipped: "none" };
        /* Honour the same floor as everything else, and record it. maybeSessionTick
           already ran for THIS message, and the popup sends entitlement-refresh
           four lines before it — so one popup open used to spend two of
           RL_SESSION_MAX (200/hour/key, shared across five devices) and, because
           neither floor was stamped, bought nothing the next tick would count. */
        const now = Date.now();
        if (now - lastHeartbeatAt < SESSION_ACTIVE_MS) return { skipped: "recent" };
        if (now - (await readHeartbeatAt()) < SESSION_ACTIVE_MS) return { skipped: "recent" };
        lastHeartbeatAt = now;
        await noteHeartbeat(now);
        return self.LCTEntitlement.heartbeat(lic);
      }
      case "entitlement-refresh": {
        const got = await chrome.storage.local.get("license");
        const lic = got && got.license;
        if (!lic || !lic.key) return { ok: false, branch: "none" };
        const deviceId = await self.LCTDodo.ensureDeviceId();
        return self.LCTEntitlement.refresh(lic, deviceId, {
          force: !!(msg && msg.force), activate: !!(msg && msg.activate)
        });
      }
      /* Activation, driven from the post-purchase page instead of the popup.
         The three steps are the popup's, in the popup's order, because doing
         two of them is the failure that matters: a seat with no entitlement is
         someone who paid and got nothing. */
      case "license-activate": return activateLicenseKey(msg && msg.key);

      /* Extension pages only. `_senderAllowed` admits our own web pages so the
         post-purchase page can report in, and "open a tab at a URL of the
         server's choosing" is not a lever a web page should be able to pull. */
      case "checkout-start": {
        if (!/^(chrome|moz)-extension:\/\//i.test(sender && sender.url || "")) {
          return { ok: false, reason: "forbidden" };
        }
        return startCheckoutFlow();
      }
      // The fast half of the claim: the page the buyer lands on, saying it is
      // there. The alarm is the half that works when they close the tab.
      case "checkout-poll": return claimPendingOrder();
      case "checkout-state": {
        const pending = await readPendingOrder();
        return { pending: !!pending, ref: (pending && pending.ref) || "",
                 held: !!(pending && pending.key) };
      }
      // The page seals the file (it holds the passphrase), but the secret that
      // stamps it comes from here, behind the gate.
      /* Deliberately NOT in the PAID map, and it must never be added to it.
      
         The encrypted .lctbackup is a Pro artifact: seal() binds it to an
         entitlement stamp, open() verifies that stamp, and restoring one is
         Pro. All of that is fine — it is an unattended, reinstall-proof backup,
         which is a convenience worth paying for.
      
         This is a different thing: a plain copy of the user's own conversations,
         which they can take out whenever they like, licence or no licence. The
         archive is often the ONLY surviving copy of a chat the provider has
         since deleted — that is a headline feature of this product — so gating
         the exit is holding a person's own data hostage over a lapsed $1
         licence. It also costs nothing commercially: nobody buys Pro in order
         to press export once. */
      case "recall-export":     return { chats: await archiveSnapshot() };
      case "archive-stamp": {
        const { secret, stampSub, alts } = await stampCreds();
        return secret ? { ok: true, secret, sub: stampSub, alts } : { err: "locked" };
      }
      case "trial-state":  return trialState();
      case "trial-start":  return startTrial();
      case "identity-state":    return identityState();
      case "identity-send":     return identitySendCode(msg && msg.email);
      case "identity-confirm":  return identityConfirmCode(msg && msg.email, msg && msg.code);
      case "identity-google":   return identityGoogleSignIn();
      case "identity-restore":  return identityRestore();
      case "identity-signout":  return identitySignOut();
      // Content scripts cannot read chrome.commands, and the first-run hint
      // must print the keys the browser actually bound rather than the ones
      // the manifest asked for.
      case "commands":
        try { return chrome.commands.getAll(); } catch { return []; }
      // chrome.action is worker-only too, and the tour uses it to decide
      // whether to ask for a pin at all. `known:false` means the browser has
      // no getUserSettings — the ask is shown then, being the lesser annoyance.
      case "toolbar-pinned":
        try {
          const s = await chrome.action.getUserSettings();
          return { pinned: !!(s && s.isOnToolbar), known: true };
        } catch { return { pinned: false, known: false }; }
      case "recall-upsert":      return upsert(msg.chat);
      case "recall-import":      return importBatch(msg.chats);
      case "recall-search":      return search(msg.q, msg.long);
      case "recall-check":       return check(msg.ids);
      case "recall-stats":       return stats();
      // Export reads the archive HERE, behind the gate — not from the page's
      // own IndexedDB handle, which no paywall could sit in front of.
      case "recall-snapshot":    return { chats: await archiveSnapshot(), durable: await backupState() };
      case "recall-wipe":        return wipeRecall();
      case "recall-bg-sync":     return bgSyncAll({ reason: "manual" });
      case "archive-fill-state": return fillState();
      case "archive-fill-start": { fillStart(); return { started: true }; }
      /* Opening the popup is not a request to start a download, so this is the
         auto path and not fillStart(): it declines on a queue the user stopped.
         It exists so a queue is never left waiting for a click. */
      case "archive-fill-auto":  return fillAutoStart(String(msg.reason || "ask").slice(0, 16));
      case "archive-fill-stop":  return fillStop();
      case "recall-auto-tick":   return autoSyncTick();
      case "recall-visit-sync":  return visitSync(msg.platform);
      case "chat-index":         return chatIndex(msg.host, msg.path, { force: msg.force, foreground: !!msg.foreground });
      case "chat-message":       return chatMessage(msg.host, msg.path, msg.id);
      case "chat-search":        return chatSearch(msg.host, msg.path, msg.q);
      case "chat-archive":       return chatArchive(msg.host, msg.path);
      /* Deliberately NOT in PAID, and narrower than chat-archive on purpose.
         It returns ONE conversation: the one the asking tab is looking at. That
         is not the archive product — search, other chats and export stay gated —
         it is the text the page itself would hold if the reader sat there
         scrolling to the top, which is exactly what this replaces. Gating it
         would mean the free half of "put the older messages back" is an
         instruction to go and scroll. */
      case "chat-mount": {
        const want = String(msg.host || "") + String(msg.path || "");
        let from;
        try { const u = new URL(sender && sender.url || ""); from = u.host + u.pathname; }
        catch { return { status: "forbidden" }; }
        if (!want || from !== want) return { status: "forbidden" };
        return chatArchive(msg.host, msg.path);
      }
      // "the page found this chat gone", not "delete this". Nothing outside
      // resolveDeletions() gets to remove archived text on request.
      case "chat-drop":          return noteVanished(msg.id, {}, "opened");
      // The branch walk decides whether the map's positions line up with the
      // page at all, and the worker's network cannot be routed from a test —
      // so the parse is reachable directly, same as the pacing selftest below.
      case "chat-index-selftest": return {
        msgs: chatgptMsgs(msg.conv || {}),
        entries: indexFromMsgs(chatgptMsgs(msg.conv || {}))
      };
      case "account-for":        return accountForHost(String(msg.host || ""), String(msg.hint || "").slice(0, 120));
      // The allowance panel. `quota-observed` is the page handing over numbers
      // the provider already sent it; `quota-refresh` is us asking the provider
      // directly, which is the only path that sees sends from another device.
      case "quota-observed":     return quotaObserved(String(msg.host || ""), msg.observations || [], String(msg.hint || "").slice(0, 120));
      case "quota-refresh":      return quotaPoll(PAGE_PLATFORMS[String(msg.host || "")] || String(msg.platform || ""), String(msg.reason || "manual"));
      case "quota-state":        return quotaState();
      // Every provider, one pass. The popup asks for this when it has nothing
      // to draw, so a panel opened before any chat site was visited fills in.
      case "quota-sweep":        return quotaSweep(String(msg.reason || "manual"));
      case "quota-probe":        return quotaProbe(String(msg.platform || ""), { dryRun: !!msg.dryRun });
      case "quota-diagnose":     return quotaDiagnose(String(msg.platform || ""));
      // The parsers are pure, and a silent regression in them is what turns a
      // real percentage into a plausible wrong one. Reachable so the test page
      // can assert them without a provider.
      /* An open tab sets the request rate and nothing else. It must never
         answer "open" for a tab belonging to another site, which would halve
         the rate for no reason, and never "closed" for one that is open. */
      case "tab-presence-selftest": return presenceFrom(msg.tabs || [], String(msg.host || ""));
      /* A restart clears every alarm, and the period alarm alone is up to three
         hours away — so whether this rebooks an interrupted pass is the
         difference between an archive that carries on and one that stops. */
      case "sync-resume-selftest": return resumeIfUnfinished();
      // What the background did while nobody was watching. See trace() above.
      case "bg-trace":       return readTrace();
      case "bg-trace-clear": { await chrome.storage.local.remove(BG_TRACE); return { ok: true }; }
      case "quota-selftest":     return {
        json: self.LCTQuota.fromJson(msg.json || {}, { now: Number(msg.now) || undefined }),
        headers: self.LCTQuota.fromHeaders(msg.headers || {}, { now: Number(msg.now) || undefined }),
        merged: self.LCTQuota.merge(msg.prev || null, msg.reading || null, { now: Number(msg.now) || undefined }),
        primary: self.LCTQuota.primary(msg.record || null, { now: Number(msg.now) || undefined })
      };
      case "account-roster":     return { accounts: await readAccounts() };
      case "recall-sync-status": return bgSyncStatus();
      case "recall-backup-state": return backupState();
      case "recall-backup-mark": return markBackup(msg.meta);
      case "recall-restore-ledger": return restoreLedger(msg.ledger, msg.meta, msg.profile);
      case "recall-recovery-skip": return skipRecovery();
      case "recall-deletions":        return deletionsList();
      case "recall-deletions-resolve": return resolveDeletions(msg.ids, msg.action);
      case "recall-autobackup-state": return autoBackupState();
      // Forgetting the key stops the schedule too: a scheduled backup with no
      // key is a promise that cannot be kept, and silently not kept is worse.
      case "recall-backup-forget-key": return autoBackupDisable();
      case "recall-autobackup-enable": return autoBackupConfigure(msg.config);
      case "recall-autobackup-disable": return autoBackupDisable();
      case "recall-autobackup-run":   return runAutoBackup("manual");
      // Counting failed restore attempts in the page would reset on reload.
      case "recall-restore-guard":       return restoreGuard();
      case "recall-restore-guard-fail":  return restoreGuardFail();
      case "recall-restore-guard-reset": return restoreGuardReset();
      // The sweep's safety ceiling is the difference between "the user deleted
      // one chat" and "a signed-out listing wiped the archive". It only ever
      // runs behind a live provider walk, so it is reachable here directly.
      case "recall-sweep-selftest": {
        const index = new Map((msg.index || []).map((entry) => [entry.id, entry.rev]));
        return sweepVanished({ id: "selftest", host: "selftest", prefix: "/" },
          index, new Set(msg.listed || []), Number(msg.scanStartedAt) || Date.now(),
          new Set(msg.pending || []));
      }
      // Pacing logic is pure but unreachable from a test page otherwise, and a
      // silent regression here is what lets the sync 429 the provider again.
      case "recall-sync-selftest": return {
        retryAfter: (msg.values || []).map(parseRetryAfter),
        backoff: backoffDelay(Number(msg.attempt) || 0, Number(msg.retryAfterMs) || 0)
      };
      // Drives pageThrough over a scripted server so the safe-degradation exits
      // (offset ignored, limit ignored, short page) are assertable.
      case "recall-page-selftest": {
        // `pages` is keyed by the query fragment a scheme produces, so a test
        // can model a server that honours one spelling and ignores the rest.
        const pages = msg.pages || {};
        const calls = [];
        const out = await pageThrough({ host: "selftest" }, {
          pageSize: Number(msg.pageSize) || 2, sinceMs: Number(msg.sinceMs) || 0,
          delayMs: 0, noCache: true, progress: () => {},
          fetchPage: (page) => {
            calls.push(page);
            // "<param>=*" models a server that accepts the param but ignores
            // it, always returning the same page — distinct from one that has
            // genuinely run out of results.
            const hit = pages[page] !== undefined ? pages[page] : pages[page.split("=")[0] + "=*"];
            if (hit === "error") throw new BgError("net", "http 400");
            return hit || [];
          },
          toMeta: (it) => ({ id: it.id, title: "", createdAt: 0, updatedAt: it.updatedAt })
        });
        return { ids: out.metas.map((m) => m.id), complete: out.complete, paged: out.paged, calls };
      }
      default: return { err: "unknown" };
    }
  };
  run().then(sendResponse, (e) => sendResponse({ err: String(e && e.message || e) }));
  return true; // async response
});
