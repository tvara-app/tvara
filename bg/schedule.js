/**
 * Tvara background worker — every alarm the worker owns, plus the live device socket.
 *
 * Split out of bg.js. Loaded by bg.js via importScripts (Chrome) or listed
 * as a background script by tools/pack.mjs (Firefox). Either way this shares
 * ONE global scope with the rest of the worker: what is declared here is
 * callable from every other module, exactly as when this was one file.
 */
"use strict";

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
  /* 0.5 is the platform floor — Chrome refuses anything under 30 seconds and
     warns. Used only while work is outstanding, so this is not a standing cost:
     clearResume() ends it as soon as a pass finishes clean. */
  try { await chrome.alarms.create(BG_RESUME_ALARM, { delayInMinutes: 0.5, periodInMinutes: 0.5 }); }
  catch { /* alarms unavailable */ }
}

async function clearResume() {
  try { await chrome.alarms.clear(BG_RESUME_ALARM); } catch { /* nothing booked */ }
}

/* Is there a pass to pick up?

   An extension reload clears every alarm. (A browser restart does not, in
   Chrome — alarms persist across sessions — but that is Chrome's promise and
   not one this worker should rest on, and a reload happens on every update.)
   Work the last pass left then has nothing to wake it and waits out the full
   period, which from the user's side is an archive that stopped. Reads what the last pass wrote about itself rather than re-deriving
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
   never opened it never renewed. needsRefresh() applies the renewal window
   and bounded retry schedule. */
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
/* The attempt in flight, so two callers cannot each open a socket. */
let sessionWsOpening = null;
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
  /* One attempt at a time. The three guards above are re-entered across the
     await below — wake() runs on every MV3 service worker respawn and the
     ticket call is a network round trip — so two callers both got past them and
     opened two sockets, of which only the SECOND was ever tracked. The first
     kept its ping interval for the life of the worker, firing every 25 seconds
     at a socket nobody owned: "WebSocket is already in CLOSING or CLOSED
     state", forever, with nothing able to clear it. */
  if (sessionWsOpening) return sessionWsOpening;
  sessionWsOpening = sessionWatchOpen(reason);
  try { return await sessionWsOpening; } finally { sessionWsOpening = null; }
}

async function sessionWatchOpen(reason) {
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
  /* THIS socket's ping handle, held locally. The module-level one names
     whichever socket is current, which is not the same thing — a socket that
     has been replaced can no longer reach its own interval through it. */
  let ping = null;
  const stopPing = () => {
    if (!ping) return;
    if (sessionWsPing === ping) sessionWsPing = null;
    clearInterval(ping);
    ping = null;
  };
  ws.addEventListener("open", () => {
    // Lost a race with another connect. Close quietly; do not claim the channel.
    if (sessionWs !== ws) { try { ws.close(); } catch { /* already closed */ } return; }
    sessionWsBackoff = BG_WS_MIN_BACKOFF_MS;
    trace("watch-open", String(reason || "?"));
    ping = setInterval(() => {
      /* send() does NOT throw on a CLOSING or CLOSED socket — the spec throws
         only while CONNECTING — so the browser logs the state error itself and
         the catch never runs. Ask the socket instead, and stand the interval
         down rather than logging once every 25 seconds. */
      if (ws.readyState !== WebSocket.OPEN) return stopPing();
      try { ws.send("ping"); } catch { stopPing(); }
    }, BG_WS_PING_MS);
    sessionWsPing = ping;
  });
  ws.addEventListener("message", (ev) => {
    if (sessionWs !== ws) return;
    sessionWatchMessage(ev && ev.data);
  });
  ws.addEventListener("close", (ev) => {
    stopPing();
    // A kill is a kill whichever socket carried it.
    if (ev && ev.code === 4001) sessionWsDone = true;
    /* A socket that has already been replaced must not take the live one with
       it: sessionWatchClose() closes whatever sessionWs currently names, and
       sessionWatchRetry() would then reconnect on top of a healthy channel. */
    if (sessionWs !== ws) return;
    sessionWatchClose();
    trace("watch-close", String((ev && ev.code) || "?"));
    sessionWatchRetry();
  });
  ws.addEventListener("error", () => {
    stopPing();
    if (sessionWs !== ws) return;
    sessionWatchClose();
    sessionWatchRetry();
  });
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
