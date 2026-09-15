/**
 * Tvara background worker — pacing policy, the durable trace, checkpoints, the ledger, the work journal.
 *
 * Split out of bg.js. Loaded by bg.js via importScripts (Chrome) or listed
 * as a background script by tools/pack.mjs (Firefox). Either way this shares
 * ONE global scope with the rest of the worker: what is declared here is
 * callable from every other module, exactly as when this was one file.
 */
"use strict";

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
   slow real API under normal conditions, short enough that one stalled host
   cannot hold a whole pass open. */
const BG_FETCH_TIMEOUT_MS = 20000;
const BG_RATE_TRIP = 3;                          // consecutive 429s → circuit opens
/* Additive increase: one more worker per clean run of this many requests.
   Multiplicative decrease is the halving in noteRateLimit(). Standard AIMD,
   which is what every one of these providers' own docs asks a client to do. */
const BG_RAMP_AFTER = 24;
/* THE RATE, not the worker count, is what a provider measures.
   hostSlot() serialises request STARTS on one chain per host, so the pass runs
   at 1/minIntervalMs however many workers are in flight — which means the AIMD
   on concurrency below barely moves the number the host actually sees. Halving
   workers changed how many were open at once and left the rate at ~3/s. So the
   interval adapts too, and it is the one that matters: doubled on a refusal,
   decayed back toward the policy figure on a clean run. */
const BG_INTERVAL_MAX_MS = 8000;
/* The slowest a LEARNED floor may settle. BG_INTERVAL_MAX_MS bounds how far one
   refusal doubles the interval; a provider that genuinely needs more than eight
   seconds between requests has to be allowed to teach the floor past it, or no
   pace this worker can reach is one it accepts. */
const BG_FLOOR_MAX_MS = 60 * 1000;
/* TWO WORKLOADS, ONE BUDGET — and only one of them has anybody waiting on it.
   The conversation in front of the reader is one request and it has to be
   instant. The backfill is thousands of requests and NOBODY is waiting for it:
   whether it finishes in an hour or a day changes nothing anyone can see.

   Removing the four-minute pass budget turned the backfill from "4 minutes
   every 3 hours" into "flat out until the whole archive is done", and at the
   policy interval that is ~3 requests a second, sustained, for hours. The
   reader then clicks a chat and gets "Too many requests" — a refusal the
   backfill earned and the reader paid for.

   So the backfill gets a floor of its own, far below anything a person would
   notice, and a much slower one again while a tab of that host is open, which
   is exactly when the reader needs the budget. The foreground path is
   untouched and still waits for nothing. */
/* THE GAP. 500ms between requests to one host, and never less.

   This is a chosen figure, not a discovered one — two requests a second, which
   is slower than a person clicking through their own sidebar and roughly a
   fifth of what the backfill was doing when it took the account down.

   The adaptive machinery below still runs, but it can now only ever make the
   gap WIDER: a refusal doubles it and the memory of that refusal holds, while
   the clean-run decay bottoms out here rather than accelerating past it. So the
   steady state is exactly this number, and the only thing that moves it is a
   host asking for more room. Per-host figures above 500ms (Perplexity's 700)
   still stand; this is a floor, not an override. */
const BG_MIN_INTERVAL_MS = 500;
/* THE VOLUME CEILING, which the 500ms gap does not give you.

   A gap governs the RATE; it says nothing about the TOTAL. Two thousand three
   hundred transcripts at 500ms is still two thousand three hundred requests
   inside twenty minutes, and every one of these providers publishes its limits
   as requests-per-minute and requests-per-DAY, not as a minimum spacing. A
   client that is perfectly paced and never stops is exactly the shape that
   trips a daily quota — politely, and completely.

   So the backfill gets a budget as well as a pace: this many requests per host
   per rolling hour, after which it waits for the window to roll. A first
   backfill then takes several quiet hours instead of twenty loud minutes,
   which costs nobody anything — nothing is waiting on it. The foreground is
   exempt: it is a handful of requests and it is the one the reader is sitting
   in front of. */
/* A self-imposed ceiling on requests per host per hour.
   It is NOT what protects a session from being rate-limited — that is
   intervalFor(), which doubles on the FIRST refusal, and the circuit breaker
   that trips on the third. Both react to the provider's own signal. This is a
   blunt daily budget, and at 400 it was the binding constraint on every large
   archive: a 2,300-chat queue took six hours no matter how fast the fetch got,
   because the hour ran out long before the work did. 1,200 is one request per
   three seconds averaged over an hour — still far below the one-per-500ms this
   code already permits in a burst, and the adaptive floor above is untouched. */
const BG_HOURLY_CAP = 1200;
const BG_HOUR_MS = 60 * 60 * 1000;
/* The longest a single request may be held in the pacing queue.
   Everything legitimate is under it — the polite interval tops out at
   BG_INTERVAL_MAX_MS, an open tab widens it to BG_TAB_OPEN_INTERVAL_MS, and
   yielding to a reader is BG_YIELD_MS. Only two things exceed it: a 429
   cooldown, which bgSyncPlatform already checks for BEFORE the pass, and the
   hourly cap, which used to be enforced by sleeping out the rest of the hour
   INSIDE the pass — holding bgSyncRunning, so every later sync and every
   manual "Check now" was answered "already-running" until Chrome recycled the
   worker. A wait that outlasts the pass is not pacing, it is a stall. */
const BG_SLOT_MAX_WAIT_MS = 90 * 1000;
const BG_TAB_OPEN_INTERVAL_MS = 2000;
/* THE STOP, sized from what actually worked here.

   a038c93 ran this engine at three workers on 150ms pacing — roughly twenty
   requests a second — and answered a 429 with a twenty-second pause across all
   workers. That shipped, and it never caused the trouble we have been chasing.
   Which says the recovery does not need to be long; it needs to EXIST, and the
   thing that broke the account was the sustained rate with no stop at all, not
   a stop that was too short.

   So: twenty seconds on the first refusal, doubling if it keeps happening, and
   capped at fifteen minutes rather than the six hours that sat here — six hours
   is a punishment for the reader, not a protection of them. Behind it, the
   500ms gap and the sixty-second yield to anyone actually using the site, both
   of which that version had no equivalent of. */
const BG_HOST_COOLDOWN_MS = 20 * 1000;
const BG_HOST_COOLDOWN_MAX_MS = 15 * 60 * 1000;
/* …and while somebody is actually USING the host, the backfill stops.

   Not "a tab is open" — that was tried and it was wrong: a chat site left open
   in a pinned tab held the pass off for days, and the archive only ever moved
   when the popup forced a run. The signal is a foreground request, which is
   this extension answering a person: they opened a conversation, so they are
   here, right now, and every request the backfill makes for the next minute
   comes out of the budget they are about to need.

   A minute after they stop, it picks itself up. Nothing is lost — the pass is
   journalled and the resume alarm is already ticking. */
const BG_YIELD_MS = 60 * 1000;
/* Was 3x. A 429 arrived in the field at that posture, so the ceiling comes down
   and the streak that earns a step up gets three times longer. The decrease is
   unchanged and still fires on the first refusal: climb slowly, fall fast. */
const BG_RAMP_CEILING = 2;                       // multiple of the policy figure
/* THE PROVIDER'S NUMBER FIRST, AND A STOP OF OUR OWN BEHIND IT.
   Honour `Retry-After` exactly when a host sends one — obeying the number they
   name is how you stay inside a limit, and none of these six publishes a figure
   for the endpoints this reads. Where no number is named, back off on the curve
   their own docs ask for. What sits behind both is BG_HOST_COOLDOWN_MS: three
   refusals in a row stops the host outright, because the budget being spent
   belongs to the reader and they need it more than the backfill does. */
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

/* Read-modify-write on ONE storage key, serialised.

   A pass runs six platforms at once and several of them edit the same record:
   the sweep state, the trace ring. Each read the old value, each wrote its own
   edit back, and the last writer erased the others — so the anomaly that
   explains "we saw your history vanish and did not believe it" was dropped
   whenever another platform finished its sweep in the same moment, and the
   trace kept one platform's line out of six. Both are the diagnostics, losing
   exactly when there is most to diagnose. One chain per key: the edits queue
   instead of racing. A rejected edit never breaks the chain for the next one. */
const bgEditChains = new Map();
function editLocal(key, edit) {
  const prev = bgEditChains.get(key) || Promise.resolve();
  const next = prev.then(async () => {
    const held = (await chrome.storage.local.get(key))[key];
    const value = await edit(held);
    if (value !== undefined) await chrome.storage.local.set({ [key]: value });
  });
  bgEditChains.set(key, next.catch(() => {}));
  return next;
}

async function trace(event, detail) {
  try {
    await editLocal(BG_TRACE, (held) => {
      const rows = Array.isArray(held) ? held : [];
      rows.push({ t: Date.now(), e: String(event).slice(0, 40),
        ...(detail == null ? {} : { d: String(detail).slice(0, 160) }) });
      return rows.slice(-BG_TRACE_MAX);
    });
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
const BG_PLATFORM_IDS = new Set(["chatgpt", "claude", "claude-code", "deepseek", "grok", "perplexity", "gemini"]);
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
/* Was 24h: a chat deleted on another device stayed reachable in this archive
   for a day before anyone was asked. One pass period instead — listing is
   cheap, and the delta pass already runs this often. */
const BG_SWEEP_MS = 3 * 60 * 60 * 1000;
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
/* How long a pending restore holds the history rebuild off.
   Was seven days, and that was the bug behind "my old chats never came back":
   somebody who reinstalls and does not restore — because the backup file is
   gone, or they never saw the offer — got a WEEK of passes that archived only
   new chats and deliberately refused to re-fetch the old ones. Six hours is
   long enough for a person who is going to restore to do it, and short enough
   that not restoring costs an afternoon rather than a week. A restore landing
   afterwards still merges; nothing is downloaded twice. */
const BG_RESTORE_HOLD_MS = 6 * 60 * 60 * 1000;

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

/* ---------- API paths the provider page was seen to call ----------
   Claude Code has no documented endpoint and a guessed URL archives nothing
   while looking healthy. content/main.js reports paths out of Resource Timing
   — paths only, no bodies, no queries. Ids collapse to "*". */
const BG_API_SEEN = "lct-api-seen-v1";
const BG_API_SEEN_MAX = 60;                       // paths kept per host
const BG_API_SEEN_TTL_MS = 30 * 864e5;            // a path unseen for a month is stale

/** "/api/organizations/9f2.../code_sessions?limit=20" → "/api/organizations/<org>/code_sessions" */
function normalizeApiPath(raw) {
  let path = String(raw || "").split(/[?#]/)[0].slice(0, 200);
  if (!path.startsWith("/")) return "";
  return path.split("/").map((seg) =>
    /^[0-9a-f]{8}-?[0-9a-f-]{8,}$/i.test(seg) || /^(sess|session|conv|msg)_[A-Za-z0-9]{6,}$/.test(seg) ||
    (seg.length >= 16 && /^[A-Za-z0-9_-]+$/.test(seg) && /\d/.test(seg))
      ? "*" : seg).join("/");
}

async function readApiSeen(host) {
  try {
    const { [BG_API_SEEN]: raw } = await chrome.storage.local.get(BG_API_SEEN);
    const entry = raw && raw[host];
    if (!entry || !Array.isArray(entry.paths)) return [];
    if (Date.now() - (Number(entry.at) || 0) > BG_API_SEEN_TTL_MS) return [];
    return entry.paths;
  } catch { return []; }
}

async function noteApiSeen(host, paths) {
  const clean = [...new Set((Array.isArray(paths) ? paths : [])
    .map(normalizeApiPath).filter((p) => p && p.startsWith("/api")))].slice(0, BG_API_SEEN_MAX);
  if (!clean.length) return { noted: 0 };
  const key = String(host || "").slice(0, 120);
  if (!key) return { noted: 0 };
  try {
    const { [BG_API_SEEN]: raw } = await chrome.storage.local.get(BG_API_SEEN);
    const all = raw && typeof raw === "object" ? raw : {};
    const prior = all[key] && Array.isArray(all[key].paths) ? all[key].paths : [];
    all[key] = { at: Date.now(), paths: [...new Set([...clean, ...prior])].slice(0, BG_API_SEEN_MAX) };
    await chrome.storage.local.set({ [BG_API_SEEN]: all });
    return { noted: clean.length };
  } catch { return { noted: 0 }; }
}
