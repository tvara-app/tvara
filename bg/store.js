/**
 * Tvara background worker — the IndexedDB archive: write path, search, per-account views, stats.
 *
 * Split out of bg.js. Loaded by bg.js via importScripts (Chrome) or listed
 * as a background script by tools/pack.mjs (Firefox). Either way this shares
 * ONE global scope with the rest of the worker: what is declared here is
 * callable from every other module, exactly as when this was one file.
 */
"use strict";

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

/* How many whole records one page of a scan holds. Peak memory during a walk
   is one page, and a single archived chat can be a megabyte, so this is small
   on purpose: past a hundred or so the pages stop getting cheaper anyway. */
const SCAN_PAGE = 150;

/**
 * Walk the archive, in order, a page at a time.
 *
 * openCursor() is ONE REQUEST PER RECORD. On a two-thousand-chat archive that
 * is two thousand round trips to the database, and in a real browser every one
 * of them crosses a process boundary to the storage backend. getAll() answers
 * a whole page per request, and the same walk over the same 2,000 chats takes
 * 16 ms instead of 49 — measured, against the archive shape this actually has.
 *
 * The pages are read on ONE transaction: the next getAll is issued from inside
 * the previous one's onsuccess, before control returns to the event loop, so
 * the transaction never commits between pages. That matters — a walk split
 * across transactions is not a snapshot, and the sync engine writing while a
 * search reads could then skip a record or count one twice.
 *
 * `visit` returning false stops the walk.
 */
function scanChats(visit, opts = {}) {
  const page = opts.page || SCAN_PAGE;
  const { lower, upper } = opts;
  return db().then((d) => new Promise((resolve, reject) => {
    let store;
    try { store = tx(d, "readonly"); } catch (e) { return reject(e); }
    let from = lower, exclusive = false;
    const next = () => {
      let range = null;
      try {
        if (from !== undefined && upper !== undefined) range = IDBKeyRange.bound(from, upper, exclusive, false);
        else if (from !== undefined) range = IDBKeyRange.lowerBound(from, exclusive);
        else if (upper !== undefined) range = IDBKeyRange.upperBound(upper);
      } catch (e) { return reject(e); }
      const q = store.getAll(range, page);
      q.onerror = () => reject(q.error);
      q.onsuccess = () => {
        const batch = q.result || [];
        /* A throw from `visit` happens inside an IndexedDB event handler, where
           nothing is waiting to catch it: the promise would then neither
           resolve nor reject and every caller of this walk would hang for the
           life of the worker. One malformed record must not be able to do
           that. */
        try {
          for (const v of batch) {
            if (visit(v) === false) return resolve();
          }
        } catch (e) { return reject(e); }
        // A short page is the end of the store; only a full one can have more.
        if (batch.length < page) return resolve();
        const last = batch[batch.length - 1];
        // Paging needs a key to continue from. Without one the next page would
        // repeat this one forever, so stop rather than loop.
        if (!last || typeof last.id !== "string") return resolve();
        from = last.id;
        exclusive = true;
        next();
      };
    };
    next();
  }));
}

/**
 * Read many records by id, on ONE transaction.
 *
 * A get() per id is a TRANSACTION per id: opened, awaited, committed, several
 * hundred times over just to put titles on a list. Issued together they
 * pipeline inside a single transaction, and the whole batch costs about what a
 * handful of them used to. Every request is fired synchronously here, before
 * anything is awaited — that is what keeps the transaction open across them.
 *
 * A record that cannot be read is left out rather than failing the batch: the
 * callers are drawing lists, and one missing title is a row with no title.
 */
async function recordsByIds(ids) {
  const out = new Map();
  const list = [...new Set(ids)].filter((id) => typeof id === "string" && id);
  if (!list.length) return out;
  let store;
  try {
    const d = await db();
    store = tx(d, "readonly");
  } catch { return out; }
  await Promise.all(list.map((id) => reqP(store.get(id)).then(
    (v) => { if (v) out.set(id, v); },
    () => { /* one unreadable record is not a failed batch */ }
  )));
  return out;
}

/* ---------- write path ---------- */

function clampChat(chat) {
  const src = chat.msgs || [];
  const msgs = src.slice(-MAX_MSGS).map((m) => {
  const raw = String(m.t || "");
  const bound = boundFor(raw);
  return {
    // The provider's own message id. On ChatGPT this is the same string the DOM
    // carries as data-message-id, which is what lets a stored record seed the
    // in-page map with no network call at all.
    i: String(m.i || "").slice(0, 80),
    /* Coerced, and every reader downstream assumes it. Callers must therefore
       RESOLVE an unknown role before they get here — the page flush does — or
       an unmarked turn is stored as the model's with nothing left to say it was
       a guess. resolveMsgRoles() exists to undo the records written before that
       was true, and it can only work from the shape of the whole transcript. */
    r: m.r === "user" ? "user" : "assistant",
    t: clampText(raw, bound),
    // Remember that this one lost its tail. MAX_MSG_CHARS is a bound chosen for
    // the search index, not for export, and a long answer written to a .md file
    // cut mid-sentence with nothing to say so is the kind of quiet loss this
    // project exists to not commit. Export reads this flag and says so.
    ...(raw.length > bound ? { c: 1 } : {}),
    // A turn whose whole content is a picture. Without it an empty message is
    // indistinguishable from a provider placeholder and every read drops it.
    ...(m.m ? { m: 1 } : {}),
    ts: typeof m.ts === "number" ? m.ts : 0
  };
  });
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

/**
 * A message's text, cut to the storage bound — without cutting a fence in half.
 *
 * An ultra-long code block is exactly what reaches this limit, and a cut inside
 * one leaves an opening ``` with no close: every reader downstream then renders
 * the REST of the conversation as code. Close what the cut opened.
 */
/* A message that is mostly CODE gets more room. 4,000 characters is a search
   index's budget for prose and about sixty lines of a program — and "here is
   the file" answers are exactly the ones people go looking for again. Bounded
   all the same: this is an archive, not a repository. */
const MAX_CODE_CHARS = 16000;
/* Built rather than written out: test/test-parsers.mjs lifts these functions
   by counting braces and treats a backtick as opening a template string, so
   three of them in a row inside a regex reads as an unterminated one and the
   whole suite dies. Same reason pplxAnswer() spells its brackets in charCodes. */
const FENCE = "`".repeat(3);
const boundFor = (text) => (String(text || "").includes(FENCE) ? MAX_CODE_CHARS : MAX_MSG_CHARS);

function clampText(value, bound) {
  const text = String(value || "");
  // Built, not written out — see the note on FENCE above; and self-contained,
  // because test/test-parsers.mjs lifts this function on its own.
  const fence = "`".repeat(3);
  const cap = Number(bound) || 4000;
  if (text.length <= cap) return text;
  const cut = text.slice(0, cap);
  return (cut.split(fence).length - 1) % 2 ? cut + "\n" + fence : cut;
}

async function upsert(chat) {
  if (!chat || !chat.id || !Array.isArray(chat.msgs)) return { ok: false };
  const isMeta = chat.meta === true && chat.msgs.length === 0;
  /* One message is a conversation. The floor was two, which quietly dropped
     every chat somebody opened, asked once and left — and those are exactly the
     ones a person later cannot find, because nothing kept them. A meta write
     (title, no body) is still the separate case below. */
  if (!isMeta && chat.msgs.length < 1) return { ok: false };
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
  archiveChanged();
  // >= 1, matching importBatch: a one-message chat is not a stub, and marking
  // it as one re-queued it into the fill list on every page flush.
  await noteStub(clamped.id, clamped.host, clamped.n >= 1);
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
      if (!isMeta && chat.msgs.length < 1) { skipped++; failed.push(cid); continue; }
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
      /* A stub is a record with no text, and one message IS text. This read
         `>= 2` while importBatch refused anything under two, so the two agreed.
         Once a single-message chat became worth archiving they stopped: the
         chat was stored, then marked bodiless, so the fill queue fetched it
         again on every pass for the life of the install — a download that could
         never finish, on exactly the chats somebody opened once and left. */
      stubUpdates.push({ id: clamped.id, host: clamped.host, hasBody: clamped.n >= 1 });
      ok++;
      stored.push(id);
    } catch { skipped++; failed.push(cid); }
  }
  await noteStubs(stubUpdates);
  if (ok) archiveChanged();
  return { ok, skipped, stored, failed };
}

/* ---------- search ---------- */

/* ---------- the cheap "no" ----------
   Search is AND: every query word has to appear somewhere, so ONE missing word
   is the whole chat gone. Finding that out used to cost a full lowercase copy
   of the chat — every message allocated again — for every chat in the archive,
   almost all of which do not match. A case-insensitive regex answers the same
   question against the text already in memory and allocates nothing.

   Only for plain ASCII queries. `toLowerCase().indexOf(w)` and a
   case-insensitive regex agree on those; across the whole of Unicode their
   case folding is not guaranteed to, and a fast path that drops a real result
   is worse than no fast path at all. Anything else takes the old road. */
const RE_META = /[.*+?^${}()|[\]\\]/g;
const asciiWord = (w) => /^[\x20-\x7e]+$/.test(w);

function probesFor(words) {
  if (!words.every(asciiWord)) return null;
  return words.map((w) => new RegExp(w.replace(RE_META, "\\$&"), "i"));
}

function mayMatch(chat, probes) {
  const title = typeof chat.title === "string" ? chat.title : "";
  const msgs = Array.isArray(chat.msgs) ? chat.msgs : [];
  for (const re of probes) {
    if (re.test(title)) continue;
    let found = false;
    for (const m of msgs) {
      if (re.test(m.t)) { found = true; break; }
    }
    if (!found) return false;
  }
  return true;
}

function score(chat, words, lowered) {
  // every word must appear somewhere; score = total hits, title hits ×3
  let total = 0;
  // A record written by an older build, or brought back by a hand-edited
  // import, can be missing either of these. Reading a query as "no match" is
  // survivable; throwing here stops the whole search.
  const title = (typeof chat.title === "string" ? chat.title : "").toLowerCase();
  /* Lowercased ONCE, not once per word. The words loop is bounded at 8, so the
     nesting was already linear rather than quadratic — but it re-lowercased
     every message in the chat on every pass, which on a real archive is the
     whole body of text allocated eight times over for one query. Measured on
     archive-sized data: 128ms to 95ms, same score out. */
  const lows = lowered || (Array.isArray(chat.msgs) ? chat.msgs : []).map((m) => String(m && m.t || "").toLowerCase());
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

/* ---------- typing forward ----------
   The recall page searches as you type, and each search reads the whole
   archive — fourteen megabytes deserialized, four or five times over, for one
   word being entered.

   It does not have to. Search is AND over substrings, so adding characters can
   only ever NARROW the answer: a chat that contains "attention" already
   contains "atten", and a chat that fails on an added word was going to fail
   anyway. Every result of a longer query is therefore inside the shorter
   query's results, and a query that extends the last one is answered from that
   set instead of from the archive.

   The set is held against the archive's write counter, so a chat the sync
   engine adds invalidates it rather than staying invisible until the query is
   retyped. And only while the set is small: narrowing five thousand candidates
   is not cheaper than the scan it replaces. */
let lastSearch = null;                  // { words, ids, scanned, seq }
const NARROW_MAX = 600;

/** Whether `words` can be answered from a previous query's results. Adding a
 *  word narrows; extending the last word narrows; anything else — a word
 *  shortened, changed, or removed — can only widen, and goes to the archive. */
function narrowsFrom(prev, words) {
  if (!prev || !Array.isArray(prev.words) || !prev.words.length) return false;
  if (words.length < prev.words.length) return false;
  for (let i = 0; i < prev.words.length - 1; i++) {
    if (words[i] !== prev.words[i]) return false;
  }
  const tail = prev.words[prev.words.length - 1];
  return String(words[prev.words.length - 1] || "").startsWith(tail);
}

async function search(query, long) {
  const words = String(query || "").toLowerCase().split(/\s+/).filter((w) => w.length >= 2).slice(0, 8);
  if (!words.length) { lastSearch = null; return { results: [], scanned: 0 }; }
  const results = [];
  const matched = [];                   // every id that matched, not just the top
  const probes = probesFor(words);

  const consider = (chat) => {
    if (!chat || !Array.isArray(chat.msgs)) return;
    // The rejection pass: allocation-free, and it is the answer for almost
    // every chat in the archive.
    if (probes && !mayMatch(chat, probes)) return;
    /* One lowercase pass per chat, shared by the scorer and the snippet.
       They each made their own, so the whole archive body was lowercased
       twice for every query that matched. */
    const lowered = chat.msgs.map((m) => String(m && m.t || "").toLowerCase());
    const s = score(chat, words, lowered);
    if (s <= 0) return;
    matched.push(chat.id);
    const snip = snippetFor(chat, words, long, lowered);
    results.push({
      id: chat.id, host: chat.host, path: chat.path, platform: chat.platform,
      title: chat.title, n: chat.n, createdAt: chat.createdAt,
      updatedAt: chat.updatedAt, score: s, snippet: snip.text, role: snip.role,
      // Temporary chat: no original to reopen on the platform.
      ...(chat.temp ? { temp: 1 } : {}),
      ...(long ? { passages: passagesFor(chat, words, lowered, passageCap(chat.n || 0)) } : {})
    });
  };

  const prev = lastSearch;
  const narrow = !!prev && prev.seq === archiveSeq && prev.ids.length <= NARROW_MAX &&
    narrowsFrom(prev, words);
  let scanned;
  if (narrow) {
    const found = await recordsByIds(prev.ids);
    // In the previous answer's order, so a tie between two equal scores lands
    // the same way it did a keystroke ago.
    for (const id of prev.ids) consider(found.get(id));
    /* The archive this answer descends from, not the handful re-read to
       produce it: "no matches in 12 chats" would be a false statement about an
       archive of two thousand. */
    scanned = prev.scanned;
  } else {
    scanned = 0;
    await scanChats((chat) => { scanned++; consider(chat); });
  }
  lastSearch = { words, ids: matched, scanned, seq: archiveSeq };
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
  await scanChats((v) => {
    if (v && typeof v.id === "string") index.set(v.id, Number(v.sourceUpdatedAt || v.updatedAt || 0));
  }, { lower: start, upper: start + "\uffff" });
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

/* Every archive write bumps this. It lives in memory on purpose: a worker that
   is reclaimed loses it, and losing it costs exactly one recount. */
let archiveSeq = 0;
let statsCache = null;                  // { seq, value }
const archiveChanged = () => { archiveSeq++; };

/**
 * How much this browser is holding.
 *
 * Cursors every record and sums every message length, so it is not something to
 * poll — and the popup DOES poll it, because the headline has to move while a
 * background pass archives chats underneath it. Cached against the write
 * counter: asking twice with nothing written between costs nothing.
 */
async function stats() {
  if (statsCache && statsCache.seq === archiveSeq) return statsCache.value;
  const value = await statsScan();
  statsCache = { seq: archiveSeq, value };
  return value;
}

async function statsScan() {
  let chats = 0, msgs = 0, bytes = 0;
  const byPlatform = {};
  await scanChats((v) => {
    if (!v) return;
    chats++; msgs += Number(v.n) || 0;
    if (Array.isArray(v.msgs)) for (const m of v.msgs) bytes += (m && m.t ? m.t.length : 0);
    byPlatform[v.platform || v.host] = (byPlatform[v.platform || v.host] || 0) + 1;
  });
  return { chats, msgs, bytes, byPlatform };
}

async function wipe() {
  const d = await db();
  archiveChanged();
  await reqP(tx(d, "readwrite").clear());
  return { ok: true };
}

/* ===================== background sync engine ===================== */
/* Runs entirely in the service worker — no tabs needed. Uses host_permissions
   to make authenticated API requests directly with the user's cookies. */

/* Per-host pacing. These are STARTING POINTS, not ceilings: concurrency now
   really does ramp up on a clean streak and halve on a 429 — the comment here
   claimed that for a long time while `streak` and `concurrency` were written
   and never read once, so the numbers below were flat constants. A healthy
   connection climbs to 3x these; a host that pushes back is cut in half on the
   first refusal, which is faster than any fixed number can be. */
