/**
 * Tvara background worker — a vanished chat is a question, not an event.
 *
 * Split out of bg.js. Loaded by bg.js via importScripts (Chrome) or listed
 * as a background script by tools/pack.mjs (Firefox). Either way this shares
 * ONE global scope with the rest of the worker: what is declared here is
 * callable from every other module, exactly as when this was one file.
 */
"use strict";

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
  tellTabs({ type: "lct-deletion-queued", id: recordId, title: summary.title,
    platform: summary.platform || hint.platform || "", messages: summary.messages });
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
    /* The decision lives ON the notice. Sending someone to a page to answer a
       yes/no question is how the question goes unanswered. */
    await chrome.notifications.create("lct-deletions", {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: count === 1 ? "A chat was deleted where you use it" : `${count} chats were deleted where you use them`,
      message: count === 1
        ? "Your backup still has it. Keep the backup copy, or delete it here too?"
        : "Your backup still has them. Keep every copy, or delete them here too?",
      buttons: [{ title: count === 1 ? "Keep my copy" : "Keep all copies" },
                { title: count === 1 ? "Delete it too" : "Delete them too" }],
      priority: 2,
      requireInteraction: true
    });
  } catch { /* notifications unavailable — the badge and the panel still carry it */ }
}

/** The user answered. `action` is "delete" (remove from the backup too) or "keep". */
async function resolveDeletions(ids, action) {
  const wanted = Array.isArray(ids) ? ids.map((id) => String(id).slice(0, 600)) : [];
  const state = await readDeletions();
  const targets = wanted.length ? wanted.filter((id) => state.items[id]) : Object.keys(state.items);
  let undo = "";
  if (action === "delete") {
    undo = await stashForUndo(targets);
    for (const id of targets) await dropChat(id);
  } else if (action !== "keep") {
    return { err: "unknown action" };
  }
  await mutateDeletions((current) => {
    for (const id of targets) delete current.items[id];
    return current;
  });
  try { if (chrome.notifications) await chrome.notifications.clear("lct-deletions"); } catch { /* fine */ }
  return { ok: true, action, count: targets.length, undo };
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
async function sweepVanished(adapter, index, listedIds, scanStartedAt, pendingIds, windowFloorMs = 0) {
  const candidates = [];
  for (const [recordId, revision] of index) {
    if (listedIds.has(recordId)) continue;
    /* The user capped how far back we list. A chat older than that cap was
       never asked for, so its absence says nothing — treating it as deleted
       would put the whole pre-window archive up for deletion the moment
       somebody picks "last 30 days". */
    if (windowFloorMs && Number(revision) < windowFloorMs) continue;
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


/* ---------- undo ----------
   The delete happens at once: one that waits is one the user cannot trust.
   What makes it safe is reversal — the whole record is set aside briefly, so
   Undo is a restore rather than a re-download from a provider that no longer
   has it. */
const BG_UNDO = "lct-deletion-undo-v1";
const BG_UNDO_TTL_MS = 10 * 60 * 1000;   // the toast shows 5s; a slow hand still wins
const BG_UNDO_MAX = 200;

async function stashForUndo(ids) {
  const records = [];
  try {
    const d = await db();
    for (const id of ids.slice(0, BG_UNDO_MAX)) {
      const rec = await reqP(tx(d, "readonly").get(String(id).slice(0, 600)));
      if (rec) records.push(rec);
    }
  } catch { return ""; }
  if (!records.length) return "";
  const token = "u" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  try {
    await chrome.storage.local.set({ [BG_UNDO]: { token, at: Date.now(), records } });
  } catch { return ""; }        // no room to remember: say so rather than promise undo
  return token;
}

/** What the UI may offer to undo, or null. */
async function undoState() {
  try {
    const { [BG_UNDO]: held } = await chrome.storage.local.get(BG_UNDO);
    if (!held || !held.token || Date.now() - (held.at || 0) > BG_UNDO_TTL_MS) return null;
    return { token: held.token, count: (held.records || []).length, at: held.at };
  } catch { return null; }
}

async function undoDeletion(token) {
  const held = await undoState();
  if (!held) return { ok: false, err: "nothing to undo" };
  if (token && token !== held.token) return { ok: false, err: "stale" };
  let records;
  try { records = (await chrome.storage.local.get(BG_UNDO))[BG_UNDO].records || []; }
  catch { return { ok: false, err: "unreadable" }; }
  // importBatch merges and never overwrites a newer body — the right primitive.
  await importBatch(records);
  try { await chrome.storage.local.remove(BG_UNDO); } catch { /* fine */ }
  return { ok: true, restored: records.length };
}

/* The page the user is actually looking at is where a deletion should surface.
   Best effort: no tab, no toast, and the badge still carries it. */
async function tellTabs(payload) {
  try {
    if (typeof chrome.tabs === "undefined") return;
    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (!t || !t.id || !t.url || !/^https:\/\//.test(t.url)) continue;
      if (!BG_ADAPTERS.some((a) => t.url.includes(a.host))) continue;
      try { chrome.tabs.sendMessage(t.id, payload, () => void chrome.runtime.lastError); }
      catch { /* no receiver in that tab */ }
    }
  } catch { /* tabs unavailable */ }
}
