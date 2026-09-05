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

/* ---------- the rest of the worker ----------
   Loaded in the order bg.js used to declare them, so evaluation order is what
   it always was. importScripts is synchronous: every listener below is still
   registered in the same turn the worker starts, which is what MV3 requires. */
/* The one list. The packer derives Firefox's background.scripts from it, ESLint
   derives each file's cross-module globals from it, and the ship check reads it,
   so nothing here may be spelled out twice. */
const BG_MODULES = [
  "bg/store.js",
  "bg/state.js",
  "bg/fetch.js",
  "bg/providers.js",
  "bg/chat-index.js",
  "bg/deletions.js",
  "bg/accounts.js",
  "bg/quota.js",
  "bg/sync.js",
  "bg/fill.js",
  "bg/status.js",
  "bg/backup.js",
  "bg/schedule.js",
  "bg/bootstrap.js",
  "bg/paywall.js"
];
try {
  importScripts(...BG_MODULES);
} catch (_) {
  /* Firefox loads these as background scripts and the test loader reads bg.js
     bare, so a throw here is normal in both. In Chrome it is not, and Chrome's
     own report — "An unknown error occurred when fetching the script" — names
     nothing. Retry one at a time to name the file, but ONLY when none of them
     ran: a failed fetch runs none, while a throw from inside a module has
     already run its predecessors, and re-running those redeclares every const. */
  if (typeof db !== "function") {
    for (const m of BG_MODULES) {
      try { importScripts(m); }
      catch (err) { console.error("[tvara] worker module failed:", m, (err && err.message) || err); }
    }
  }
}

/* A caught importScripts is how Firefox and the test loader work, so a typo
   here would otherwise produce a silently half-dead worker. Say so instead. */
if (typeof db !== "function" || typeof requireEntitlement !== "function") {
  console.error("[tvara] worker modules did not load — bg/ is missing or unreadable");
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
    // Same for the listing pass: a reload clears the alarm holding its place,
    // and the period alarm alone is up to three hours away.
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
    // The buttons carry the decision; the body opens the list for a closer look.
    chrome.action?.openPopup?.().catch(() => {
      chrome.tabs.create({ url: chrome.runtime.getURL("recall.html#deletions") });
    });
  });
} catch (_) { /* notifications API unavailable */ }

/* Keep / Delete answered from the notice itself. A yes/no question that costs a
   page visit is a question that does not get answered. */
try {
  chrome.notifications.onButtonClicked.addListener(async (id, index) => {
    if (id !== "lct-deletions") return;
    try { await chrome.notifications.clear(id); } catch { /* already gone */ }
    const answer = await resolveDeletions([], index === 1 ? "delete" : "keep");
    if (index === 1 && answer && answer.undo) {
      tellTabs({ type: "lct-deletion-undo-offer", token: answer.undo, count: answer.count });
    }
  });
} catch (_) { /* notification buttons unavailable */ }

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
const _gate = typeof requireEntitlement === "function"
  ? requireEntitlement
  /* The paywall module did not load. Deny, rather than throw at the top level:
     a worker that dies here registers no listener at all, so nothing works and
     nothing can say why. Fail closed and stay alive. */
  : async () => ({ ok: false, reason: "worker-modules-missing" });

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
      // Paths only, from Resource Timing — no bodies, no queries.
      case "api-seen":
        return noteApiSeen(sender && sender.url ? new URL(sender.url).hostname : "", msg.paths);
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
      // Counts and dates for the hover card. No text — see chatStats().
      case "chat-stats":         return chatStats(msg.host, msg.path);
      // Linkless history rows (Gemini): resolve by title, then answer as usual.
      case "chat-stats-by-title": {
        const path = await chatPathByTitle(msg.host, msg.title);
        return path ? { ...(await chatStats(msg.host, path)), path } : { n: 0, held: 0, unknown: true };
      }
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
        /* HOST, not host + path.

           This compared the requested path against sender.url's path, and
           sender.url is the URL Chrome recorded for the frame — which a
           pushState does not reliably update. Every one of these sites is a
           single-page app and every conversation is reached by pushState, so
           `location.pathname` was the chat the reader had open while
           `sender.url` was still the one they landed on. The comparison failed
           on every call, forever: observed in the field as mount:forbidden#46,
           forty-six refusals of a transcript that was sitting in the archive.

           The path never carried the security anyway. What this gate is for is
           stopping a content script on one provider reading another provider's
           records, and that is entirely a question of ORIGIN — a page on
           chatgpt.com can already navigate itself to any chatgpt.com
           conversation it likes, so refusing to hand it one of its own is a
           check against nobody. The host comparison stands; the path goes. */
        const wantHost = String(msg.host || "");
        let fromHost;
        try { fromHost = new URL(sender && sender.url || "").host; }
        catch { return { status: "forbidden" }; }
        if (!wantHost || !msg.path || fromHost !== wantHost) return { status: "forbidden" };
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
      case "recall-deletions-resolve": {
        const answer = await resolveDeletions(msg.ids, msg.action);
        if (msg.action === "delete" && answer && answer.undo) {
          tellTabs({ type: "lct-deletion-undo-offer", token: answer.undo, count: answer.count });
        }
        return answer;
      }
      case "recall-deletions-undo":       return undoDeletion(msg.token);
      case "recall-deletions-undo-state": return undoState();
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
