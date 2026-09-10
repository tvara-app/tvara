/**
 * Tvara background worker — what the pass is doing, in the shape the pages draw.
 *
 * Split out of bg.js. Loaded by bg.js via importScripts (Chrome) or listed
 * as a background script by tools/pack.mjs (Firefox). Either way this shares
 * ONE global scope with the rest of the worker: what is declared here is
 * callable from every other module, exactly as when this was one file.
 */
"use strict";

function safeProgressMessage(message) {
  const text = String(message || "");
  return /rate[- ]?limit|waiting briefly before continuing/i.test(text)
    ? "Archive updates will continue automatically."
    : text;
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
    const heldProgress = store[BG_SYNC_PROG(adapter.id)] || null;
    const progress = heldProgress ? { ...heldProgress, msg: safeProgressMessage(heldProgress.msg) } : null;
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
/** A provider this browser could not ask: signed out, or refused at the edge. */
function unreachable(p) {
  return !!(p.progress && (p.progress.signedOut || p.progress.blocked));
}

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
      checkedAt: 0, connected: entries.filter((p) => !unreachable(p)).length };
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
  /* Signed out and blocked-at-the-edge are the same shape of fact: a provider
     this browser could not ASK. Neither is a failure of the archive, and
     leading the headline with one meant the reassuring line a fully-synced
     archive has earned could never appear. The provider's own row still says
     exactly what happened — that is where it is actionable. */
  const connected = known.filter((p) => !unreachable(p));
  const failing = connected.filter((p) => p.progress && p.progress.state === "error");
  if (failing.length) {
    return {
      state: "error",
      message: `${failing[0].label}: ${failing[0].progress.msg}`,
      checkedAt: 0,
      connected: connected.length
    };
  }
  /* An "interrupted" record from a pass that has SINCE been superseded is a
     leftover, not a pass waiting to be picked up. `claude-code` is dormant by
     design — it has no documented endpoint, so it never runs — and the install
     sweep marked it interrupted once. Nothing could ever clear that, so this
     line read "Paused · pick up where it stopped" permanently while every real
     platform was up to date, and the button offering to pick it up could not:
     the adapter it was waiting on does not run. A record speaks for the pass
     that is on record only if it carries that pass's id; one from an older
     pass, or from before ids were written at all, does not. The syncing branch
     above already discounts other runs the same way. */
  const paused = connected.filter((p) => {
    const pr = p.progress;
    if (!pr || pr.state !== "interrupted") return false;
    // No pass on record to compare against: keep the old behaviour.
    if (!runId) return true;
    return String(pr.runId || "") === String(runId);
  });
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
