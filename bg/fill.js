/**
 * Tvara background worker — the text-fill queue for chats archived as titles only.
 *
 * Split out of bg.js. Loaded by bg.js via importScripts (Chrome) or listed
 * as a background script by tools/pack.mjs (Firefox). Either way this shares
 * ONE global scope with the rest of the worker: what is declared here is
 * callable from every other module, exactly as when this was one file.
 */
"use strict";

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
// Written only to reset the worker's idle timer. Nothing reads it.
const BG_FILL_BEAT = "lct-fill-beat";
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
        // A record with no messages is a title and a promise. One message is
        // a conversation, and re-queueing it every pass was a provider request
        // per one-message chat, forever.
        if (platform && !(Array.isArray(v.msgs) && v.msgs.length >= 1)) {
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
  const next = { ...patch };
  /* Stop means stop. fillStop() persists "stopped" while the loop is still
     draining, and an iteration already in flight then wrote "running" back over
     it — after which fillAutoStart saw no stop and restarted the download the
     user had switched off. Only fillStop and the final write may set state
     once a cancel is pending. */
  if (fillCancel && next.state === "running") delete next.state;
  try {
    const got = await chrome.storage.local.get(BG_FILL);
    const prev = (got && got[BG_FILL]) || {};
    await chrome.storage.local.set({ [BG_FILL]: { ...prev, ...next, at: Date.now() } });
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
  const stubs = await readStubs();
  const planned = Object.values(stubs).reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), 0);
  // note cleared: "ChatGPT: signed out" from a previous pass otherwise outlives
  // the sign-in that fixed it and paints this run as stalled from the start.
  await writeFill({ state: "running", startedAt: started, done: 0, failed: 0, planned, note: "" });
  /* The worker's idle timer is reset by EVENTS and EXTENSION API CALLS — not by
     a pending fetch, which is documented to kill the worker outright if a
     response takes over 30 seconds. This loop only wrote storage every third
     chat, and a chat can take BG_FETCH_TIMEOUT_MS (20s) per attempt, so three
     slow ones ran a full minute in silence and the worker was reclaimed at 30
     seconds — mid-fetch, every time, on exactly the slow providers that need
     the patience. bgSyncAll has carried this pulse for the same reason; the
     fill was missing it. */
  const pulse = setInterval(() => {
    chrome.storage.session.set({ [BG_FILL_BEAT]: Date.now() }).catch(() => {});
  }, 20000);
  /* Booked before the first fetch and repeating, so a reclaim that is not a
     budget stop still comes back. The stub list is the resume point, so the
     alarm only has to call fillStart() again. Cleared when the run ends. */
  try { await chrome.alarms.create(BG_FILL_ALARM, { delayInMinutes: 0.5, periodInMinutes: 0.5 }); }
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
        /* No budget here either — same reason. The stub list IS the resume
           point, so a reclaim mid-queue costs one chat, not the run. */
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
          // One message IS a conversation — CLAUDE.md, and importBatch agrees.
          // At >= 2 the single message was discarded and the stub marked done,
          // so that chat stayed bodiless for good.
          if (Array.isArray(msgs) && msgs.length >= 1) {
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
    const left = (await fillState()).total;
    // Ended on its own terms: no watchdog until the next start.
    try { await chrome.alarms.clear(BG_FILL_ALARM); } catch { /* no alarms */ }
    await writeFill({ state: fillCancel ? "stopped" : (left ? "partial" : "done"),
      done, failed, finishedAt: Date.now() });
    return { status: "ok", done, failed, left };
  } finally {
    // Every exit, not only the tidy one: a throw or a budget stop that left the
    // pulse running would keep waking the worker for a run that has ended.
    clearInterval(pulse);
    fillRunning = false;
  }
}
