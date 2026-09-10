/**
 * Tvara background worker — the archive pass itself, per platform and per account.
 *
 * Split out of bg.js. Loaded by bg.js via importScripts (Chrome) or listed
 * as a background script by tools/pack.mjs (Firefox). Either way this shares
 * ONE global scope with the rest of the worker: what is declared here is
 * callable from every other module, exactly as when this was one file.
 */
"use strict";

/* ---------- how far back the archive reaches ----------
   Default is everything, and that default is the product: an archive with a
   silent horizon is worse than no archive, because the user only finds the
   hole when they need what is missing. A cap is the user's to set, never
   ours to assume, and setting one removes nothing already held — it only
   stops asking the provider for older pages. */
const HISTORY_WINDOW_MAX_DAYS = 3650;   // ten years; a sanity bound, not a policy

/** Timestamp before which we do not list, or 0 for "everything". */
async function historyWindowFloor() {
  try {
    const { settings } = await chrome.storage.local.get("settings");
    const days = Math.floor(Number(settings && settings.historyDays) || 0);
    if (!(days > 0)) return 0;
    return Date.now() - Math.min(days, HISTORY_WINDOW_MAX_DAYS) * 864e5;
  } catch { return 0; }   // unreadable settings must never shrink the archive
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
      if (rec && rec.mv === 1 && rec.n >= 1) {
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
      if (full.msgs.length >= 1) {
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
        msg: "Archive updates will continue automatically.", at: Date.now()
      }
    });
    return { ok: true, result: "cooling-down" };
  }

  /* 1b. the hourly budget for this host is spent. Same answer as a cooldown,
     for the same reason: the pass can send nothing, so it should say so in a
     second and leave its resume alarm booked, rather than hold the worker open
     while one request sleeps out the rest of the hour. */
  const budgetUntil = hostBudgetUntil(adapter.host);
  if (budgetUntil > Date.now()) {
    trace("pass-skip", `${adapter.id} hourly budget spent, resumes in ` +
      `${Math.round((budgetUntil - Date.now()) / 60000)}m`);
    await chrome.storage.local.set({
      [BG_SYNC_PROG(adapter.id)]: {
        state: "paused", phase: "paused", runId: run.id, platform: adapter.id,
        done: 0, total: 0, cooldownUntil: budgetUntil,
        msg: `${adapter.label} has had its share of requests for this hour. It resumes automatically.`,
        at: Date.now()
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
  /* Read by hostSlot() on every background request. A reader on the site is the
     one moment their rate budget is worth something to them, so that is the
     moment the backfill spends least of it. */
  hostEntry(adapter.host).tabOpen = !!tabs.open;

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
     the same percentage forever. Whatever this pass does not reach is
     journalled, and the next one starts from the journal. */
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
    /* How far back the user wants to go. Default is everything — an archive
       that quietly stops at some horizon is the thing this product exists to
       prevent — but a cap is theirs to set, and it applies to the LISTING, so
       older chats are never asked for. It never deletes what is already held.  */
    const windowFloorMs = await historyWindowFloor();
    const sinceMs = Math.max(windowFloorMs, trustWatermark && !sweeping && !mustIdentify
      ? Math.max(0, checkpoint.safeWatermark - BG_SYNC_OVERLAP_MS) : 0);
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
    // `sinceMs === windowFloorMs` is "this listing covered everything the user
    // asked us to cover" — which is sinceMs === 0 when there is no window, and
    // still a complete answer about the window when there is one.
    if (sinceMs === windowFloorMs && complete && sweepAllowed && metas.length <= BG_PENDING_MAX) {
      const pendingIds = new Set(carried.map((p) => p.id));
      await sweepVanished(adapter, acctIndex, listedIds, scanStartedAt, pendingIds, windowFloorMs);
      await markSwept(adapter.id);
    }

    // 4. work = carried-over pending ∪ freshly listed, fresh meta winning,
    //    minus anything the archive already holds at that revision or newer.
    const byId = new Map();
    for (const p of carried) byId.set(p.id, { id: p.id, rev: p.rev, title: p.title, createdAt: p.createdAt, attempts: p.attempts || 0 });
    for (const m of metas) byId.set(m.id, { id: m.id, rev: m.updatedAt, title: m.title, createdAt: m.createdAt, attempts: 0 });
    /* EVERY LISTED CHAT GETS A RECORD, NOW.

       The listing already carries the title, the created date and the revision
       for every conversation the account has — and it threw all of it away.
       Only a fetched body created a record, so a chat the text backfill had not
       reached yet had no record AT ALL: the hover card showed nothing, the
       archive did not know it existed, and none of that had anything to do with
       whether we could fetch it. Somebody scrolling to a chat from three months
       ago was looking at a blank card for a conversation we had listed minutes
       earlier and simply not written down.

       This costs ZERO extra provider requests — the data is in hand. Title-only
       records are the `meta` shape importBatch already understands: they merge
       rather than overwrite, they never replace a body that exists, and the
       stub list below still marks them as needing text, so the counts fill in
       as the backfill reaches them. Tracking every chat and fetching every
       chat are different problems; only the second one has to be paced. */
    if (metas.length) {
      const meta = metas.map((m) => ({
        id: adapter.host + adapter.prefix + m.id,
        host: adapter.host, path: adapter.prefix + m.id,
        platform: adapter.label, title: m.title,
        createdAt: m.createdAt, updatedAt: m.updatedAt, sourceUpdatedAt: m.updatedAt,
        acct, msgs: [], meta: true
      }));
      for (let at = 0; at < meta.length; at += BG_SYNC_BATCH) {
        await importBatch(meta.slice(at, at + BG_SYNC_BATCH));
      }
    }

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
    /* A tab of the site open still means one request at a time — the reader is
       using it and we are a guest. Otherwise spawn to the ramp ceiling and let
       targetConcurrency() shed what the host will not take. */
    const ceiling = tabs.open
      ? 1
      : Math.max(1, policyFor(adapter.host).concurrency * BG_RAMP_CEILING);
    let live = 0;
    let cursor = 0, archived = 0, fatal = null, circuitOpen = false;
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
      live++;
      try {
      while (!fatal && !circuitOpen) {
        // Over the host's current allowance: stand down rather than queue.
        if (!tabs.open && live > targetConcurrency(adapter.host)) return;
        const slot = cursor++;
        if (slot >= total) return;
        /* No wall clock. A pass used to stop after four minutes and book itself
           back in, which on a large first backfill meant the archive advanced
           in four-minute slices with a wait between each. The worker being
           reclaimed is the only thing that should ever end a pass, and the
           journal plus the repeating resume alarm already carry it across that
           — the budget was protecting nothing the resume did not. */
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
          if (msgs.length < 1) {
            record.msgs = []; record.meta = true;
            // Empty conversations have no message text to retain.
            await noteStub(record.id, adapter.host, true);
          }
          importQueue.push(record);
          if (importQueue.length >= BG_SYNC_BATCH) await flushQueue();
        } catch (error) {
          const kind = error && error.kind;
          const reason = String((error && error.message) || error);
          if (kind === "auth" || kind === "challenge" || reason.includes("unauthorized")) { fatal = error; return; }
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
      } finally { live--; }
    };

    await Promise.all(Array.from({ length: Math.min(ceiling, total) }, worker));
    await flushQueue(true);
    if (fatal) throw fatal;

    const coverage = await accountCount(acct);
    const remaining = await readJob(checkpointKey);
    const left = remaining ? remaining.pending.length : 0;

    if (circuitOpen || left) {
      // Watermark and journal already persisted at step 5 — nothing is lost and
      // the next pass picks up exactly what is left.
      const until = hostEntry(adapter.host).cooldownUntil;
      await saveCheckpoint(checkpointKey, {
        ...(checkpoint || {}), version: 5, platform: adapter.id, anchor, acctScoped: true,
        safeWatermark: complete && !overflow ? scanStartedAt : (checkpoint?.safeWatermark || 0),
        completedAt: Date.now(),
        lastResult: circuitOpen ? "rate-limited" : "partial",
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
            ? `${archived} saved. Archive updates will continue automatically.`
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
  const signedOut = (error && error.kind) === "auth";
  const rateLimited = (error && error.kind) === "rate";
  /* The provider's edge refused the request shape (Cloudflare's managed
     challenge). Not a session verdict: the cookies are fine, and loading the
     site in a tab is what clears it. */
  const challenged = (error && error.kind) === "challenge";
  // A reachable provider that answered in a shape we no longer parse. Saying
  // "couldn't reach" there sends the user to check their connection about
  // something only a new build can fix.
  const shapeChanged = (error && error.kind) === "shape";
  const message = challenged
    ? `${adapter.label} blocked the background check. Open ${adapter.host} in a tab, then check again`
    : signedOut
    ? `Not signed in`
    : /unexpected token\s*['"]?<?|valid json|json\.parse|unexpected provider response|invalid provider response/i.test(reason)
      ? "Checking again automatically."
      : rateLimited
        ? "Archive updates will continue automatically."
        : shapeChanged
          ? `${adapter.label} changed its API. This needs a Tvara update`
          : "Checking again automatically.";
  progressPending = null;
  await chrome.storage.local.set({
    [BG_SYNC_PROG(adapter.id)]: {
      state: rateLimited ? "paused" : "error", phase: rateLimited ? "paused" : "error",
      runId: run.id, platform: adapter.id,
      done: attempted, attempted, total, succeeded, failed, msg: message,
      signedOut, blocked: challenged, at: Date.now()
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
    /* All six platforms at once. This was sequential, on the grounds that four
       platforms in parallel meant "up to 32 concurrent authenticated requests"
       — which counted the total and not the thing that actually matters, which
       is how many land on ANY ONE provider. These are six different origins,
       and hostSlot() serialises request starts per host regardless of how many
       passes are in flight, so a parallel run puts exactly the same load on
       chatgpt.com as a sequential one did and finishes six times sooner.

       Promise.all and not allSettled: bgSyncPlatform() already answers with a
       result object on every failure path rather than rejecting. */
    const settledPasses = await Promise.all(BG_ADAPTERS.map(async (adapter) => {
      // Dormant adapter (Claude Code before its endpoint is known): not an error.
      if (adapter.available && !(await adapter.available())) {
        return { id: adapter.id, result: "dormant", archived: 0, left: 0 };
      }
      const r = await bgSyncPlatform(adapter, run, opts);
      trace("platform", `${adapter.id} ${(r && r.result) || "?"} ` +
        `archived=${(r && r.archived) || 0} left=${(r && r.left) || 0}`);
      return r;
    }));
    results.push(...settledPasses);
    await flushProgress();
    await chrome.storage.local.set({ [BG_RUN]: { ...run, state: "done", finishedAt: Date.now() } });
    // The booking above stands unless this pass finished the work.
    /* "cooling-down" counts. A host inside its rate-limit window answers with
       no `left` and a result of its own, and reading that as a finished pass
       cancelled the 30-second resume alarm — so a throttled platform waited out
       the full three-hour period instead of coming back when the window
       expired. That is the "it resumes automatically" that took twelve times
       longer than it said. */
    const outstanding = results.some((r) => r &&
      (r.left || r.result === "partial" || r.result === "rate-limited" || r.result === "cooling-down"));
    if (!canResume || !outstanding) {
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
