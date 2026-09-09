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

/* No second pace here.
   bg/fetch.js is the ONE authority on how fast a host is asked — hostSlot()
   serialises request starts and holds intervalFor(host) between them, which is
   the figure that host has actually earned. A fixed sleep on top of it was a
   second floor nobody could see from the pacing code, and it made every chat
   cost the interval PLUS the latency PLUS this: about 1.6s each, for a rate
   limit of one request per 500ms. Removing it changes no rate; it stops the
   queue waiting twice for the same permission. */
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
    // Paged, on one transaction — see scanChats. This walk reads every record
    // in the archive and used to be a request per chat.
    await scanChats((v) => {
      const platform = PAGE_PLATFORMS[v.host] || "";
      // A record with no messages is a title and a promise. One message is
      // a conversation, and re-queueing it every pass was a provider request
      // per one-message chat, forever.
      if (platform && !(Array.isArray(v.msgs) && v.msgs.length >= 1)) {
        (map[platform] = map[platform] || []).push(v.id);
      }
      count++;
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
    /* Asked to stop, still draining. `running` used to stay true until the last
       in-flight fetch returned, so the row went on saying "tap to stop" after
       the user had — nothing on screen changed and the click read as dead. The
       moment a cancel is pending nothing new will be fetched, which is what the
       user asked for, so say so: not running, stopping. */
    const stopping = fillRunning && fillCancel;
    return { ...extra, running: fillRunning && !fillCancel, stopping, resuming, remaining, total };
  } catch {
    return { running: fillRunning && !fillCancel, stopping: fillRunning && fillCancel,
      resuming: false, remaining: {}, total: 0 };
  }
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

/* Which chats this run is allowed to fetch, or null for all of them.
 *
 * Persisted with the queue rather than passed as an argument: an MV3 worker is
 * reclaimed mid-run and the watchdog alarm restarts fillStart() with nothing in
 * hand, so a choice held in a variable would quietly widen back to everything
 * the first time the browser took the worker away. */
async function fillPick() {
  try {
    const got = await chrome.storage.local.get(BG_FILL);
    const pick = got && got[BG_FILL] && got[BG_FILL].pick;
    return pick && typeof pick === "object" && Object.keys(pick).length ? pick : null;
  } catch { return null; }
}

/**
 * The queue, as something a person can choose from: what is waiting, per
 * provider, with the titles that are already archived.
 *
 * Titles only — never message text. This answers "which of these do I want the
 * words for", and the words are the thing that has not been fetched yet.
 */
async function fillQueue(limitPerPlatform = 400) {
  /* Kept current for fillStart(), which still resumes from the stub list. This
     walk is what the PAGE is built from. */
  await ensureStubIndex();

  /* One pass over the archive, not a stub list plus a batched re-read of it.
     The page needs every chat a provider holds, not only the ones still
     waiting: text that is already here can be fetched AGAIN — a conversation
     you carried on after it was archived has messages this copy does not — and
     a list that offers that for one provider and refuses it for five is a
     control that looks broken. Only the small fields are kept, never `msgs`. */
  const per = new Map();
  await scanChats((v) => {
    const platform = PAGE_PLATFORMS[v.host] || "";
    if (!platform) return;
    let e = per.get(platform);
    if (!e) per.set(platform, (e = { archived: 0, waiting: 0, chats: [] }));
    e.archived++;
    // One message is a conversation — see upsert/importBatch. Anything less is
    // a title and a promise, and that is what "waiting" means.
    const held = Array.isArray(v.msgs) && v.msgs.length >= 1;
    if (!held) e.waiting++;
    e.chats.push({
      id: v.id,
      title: String(v.title || "").slice(0, 140),
      updatedAt: Number(v.updatedAt) || 0,
      held
    });
  });

  const out = [];
  for (const adapter of BG_ADAPTERS) {
    const e = per.get(adapter.id);
    if (!e || !e.archived) continue;
    /* Waiting first, then newest. Somebody who opens a provider to pick chats
       is nearly always after the ones that have no text yet; a re-fetch is the
       deliberate case and it can scroll. */
    e.chats.sort((a, b) =>
      (a.held === b.held ? 0 : a.held ? 1 : -1) || (b.updatedAt - a.updatedAt));
    out.push({
      id: adapter.id,
      label: adapter.label,
      total: e.waiting,          // what the row leads with: still to be fetched
      archived: e.archived,
      chats: e.chats.slice(0, limitPerPlatform)
    });
  }
  return { platforms: out, at: Date.now() };
}

/**
 * Stop whatever is running, then start again on the choice just written.
 *
 * A run reads its choice ONCE, before the loop. So handing a new one to a run
 * already in flight changed nothing, and the router answered "started" anyway —
 * pick three chats while a download is going, press Fetch selected, and the page
 * said it had begun while the old queue carried on. That is the button that
 * looks like it does nothing.
 *
 * @returns {"started"|"restarted"|"busy"} what actually happened, so the page
 *          can say it rather than guess.
 */
async function fillRestart() {
  if (!fillRunning) { fillStart(); return "started"; }
  await fillStop();
  // The loop checks fillCancel between chats; one in flight still has to land.
  for (let i = 0; i < 30 && fillRunning; i++) await sleep(200);
  if (fillRunning) return "busy";       // still unwinding: say so, do not lie
  fillStart();
  return "restarted";
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

  /* One chat. Lifted out of the loop so several can be in flight at once —
     see runPlatform(). Returns "stop" when the whole platform should give up
     (a session that is really gone), and nothing otherwise. */
  const fetchOne = async (adapter, recordId) => {
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
        catch {
          await writeFill({ state: "running", note: `${adapter.label}: signed out` });
          return "stop";
        }
        const convId = recordId.startsWith(adapter.host + adapter.prefix)
          ? recordId.slice((adapter.host + adapter.prefix).length) : "";
        if (!convId) { await noteStub(recordId, adapter.host, true); return ""; }
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
          if (kind === "challenge") {
            // The edge refused the request shape, not the session. Preparing
            // again would be refused the same way; stop and say what it was.
            await writeFill({ note: `${adapter.label} blocked the fetch. Open ${adapter.host} in a tab.` });
            return "stop";
          }
          if (kind === "auth") {
            /* Believe it only on the second try. A token that expired mid-run
               is indistinguishable here from a user who signed out, and the
               first is far commoner on a run this long. Drop the cached ctx,
               prepare a fresh one, and stop only if that fails too. */
            let recovered = false;
            try { idxForget(adapter); await idxPrepare(adapter); recovered = true; } catch { /* really gone */ }
            if (recovered) { failed--; return ""; }
            await writeFill({ note: `${adapter.label}: signed out` });
            return "stop";
          }
          if (kind === "gone") await noteStub(recordId, adapter.host, true);
          /* A refusal is already answered where refusals are handled:
             noteRateLimit() halves this host's concurrency and DOUBLES its
             interval on the first one, and trips the circuit on the third.
             Sleeping here as well only idles the lanes that are already being
             paced by it. */
        }
        if ((done + failed) % FILL_REPORT_EVERY === 0) {
          await writeFill({ state: "running", done, failed, platform: adapter.label });
        }
        return "";
  };

  /* One platform, several chats in flight.
   *
   * Sequential, this loop paid the interval AND the round trip for every chat:
   * about 1.6 seconds each against a host that permits a request every 500ms.
   * The lanes do not make it faster than that permission — hostSlot() holds the
   * interval between request STARTS whatever is waiting on it — they stop the
   * pipe standing empty while a response is in the air. targetConcurrency() is
   * the same adaptive figure the history pass uses, re-read per chat, so a 429
   * narrows this queue on the next one rather than at the end of it. */
  const runPlatform = async (adapter, ids) => {
    let at = 0, stopped = false;
    const lane = async (index) => {
      while (!fillCancel && !stopped && at < ids.length) {
        /* Re-read per chat, not once per run. A host that has just refused us
           has its concurrency halved by noteRateLimit(), and a lane above the
           new target retires here instead of finishing the queue at a width
           the host has already objected to. Lane 0 always survives, so a
           narrowed queue slows down rather than stopping. */
        if (index > 0 && index >= targetConcurrency(adapter.host)) return;
        /* Somebody is reading this host. The pacing yield would make every lane
           SLEEP through their visit and then resume together in one burst; this
           retires the lanes instead. The watchdog alarm brings the queue back a
           minute later, and the stub list is the resume point, so standing down
           costs nothing but the wait. */
        if (readerActive(adapter.host)) { stopped = true; return; }
        const recordId = ids[at++];
        if (await fetchOne(adapter, recordId) === "stop") { stopped = true; return; }
      }
    };
    const lanes = Math.max(1, Math.min(targetConcurrency(adapter.host), ids.length));
    await Promise.all(Array.from({ length: lanes }, (_, i) => lane(i)));
  };

  try {
    const pick = await fillPick();
    /* Every provider at once. These are six different hosts with six
       independent budgets and six independent pacers, and one signed-out or
       cooling provider used to hold every queue behind it — the same reasoning
       that made bgSyncAll parallel. */
    await Promise.all(BG_ADAPTERS.map(async (adapter) => {
      if (fillCancel) return;
      // A provider left out of the choice is not fetched at all; one named with
      // no list is fetched whole. Absent choice means everything, as before.
      if (pick && !Object.prototype.hasOwnProperty.call(pick, adapter.id)) return;
      const only = pick ? pick[adapter.id] : null;
      /* An explicit list is the whole instruction, not a filter over the stubs.
         Intersecting the two meant a chat somebody deliberately ticked was
         silently dropped whenever its text was already here — so re-fetching a
         conversation that had grown since it was archived did nothing at all,
         which is exactly what "I can only select ChatGPT" looked like from the
         outside. Bounded, and confined to this adapter's own host. */
      let ids;
      if (Array.isArray(only)) {
        /* Host, not host+prefix: the same conversation is stored under two
           spellings on three providers (DeepSeek /a/chat/s/, Perplexity
           /thread/, Grok /c/ — see chatIdCandidates), so a prefix test would
           reject the very ids the archive handed this page. fetchOne() still
           resolves the conversation id, and skips what it cannot. */
        const host = adapter.host + "/";
        ids = only.filter((id) => typeof id === "string" && id.startsWith(host)).slice(0, 5000);
      } else {
        ids = ((await readStubs())[adapter.id] || []).slice();
      }
      if (!ids.length) return;
      // A chat's text can only be fetched by the account that owns it; a
      // signed-out platform is skipped rather than failed.
      try { await idxPrepare(adapter); }
      catch { await writeFill({ state: "running", note: `${adapter.label}: not signed in` }); return; }
      await runPlatform(adapter, ids);
    }));
    const left = (await fillState()).total;
    // Ended on its own terms: no watchdog until the next start.
    try { await chrome.alarms.clear(BG_FILL_ALARM); } catch { /* no alarms */ }
    /* A choice describes ONE pass, and this is the end of it.
       It is persisted (not held in a variable) so a worker reclaimed mid-run
       resumes the same choice — that path never reaches here. Left behind after
       a pass that DID finish, it silently narrowed every later fetch to the
       same handful for good: the auto queue re-ran two chats, reported
       "partial" because five hundred were still waiting, and came back to run
       the same two again. From the outside that is a fetch button that does
       nothing, forever, and it is what one visit to the picker cost. */
    await writeFill({ state: fillCancel ? "stopped" : (left ? "partial" : "done"),
      done, failed, finishedAt: Date.now(), pick: null });
    return { status: "ok", done, failed, left };
  } finally {
    // Every exit, not only the tidy one: a throw or a budget stop that left the
    // pulse running would keep waking the worker for a run that has ended.
    clearInterval(pulse);
    fillRunning = false;
  }
}
