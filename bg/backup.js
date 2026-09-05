/**
 * Tvara background worker — the automatic encrypted backup and its restore guard.
 *
 * Split out of bg.js. Loaded by bg.js via importScripts (Chrome) or listed
 * as a background script by tools/pack.mjs (Firefox). Either way this shares
 * ONE global scope with the rest of the worker: what is declared here is
 * callable from every other module, exactly as when this was one file.
 */
"use strict";

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
