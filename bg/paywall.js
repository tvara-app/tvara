/**
 * Tvara background worker — the entitlement gate, the trial, identity and checkout.
 *
 * Split out of bg.js. Loaded by bg.js via importScripts (Chrome) or listed
 * as a background script by tools/pack.mjs (Firefox). Either way this shares
 * ONE global scope with the rest of the worker: what is declared here is
 * callable from every other module, exactly as when this was one file.
 */
"use strict";

/* ---------- entitlement gate ---------- */

/**
 * The paywall. Every gated handler goes through here and nowhere else.
 *
 * Deliberately NOT a cached boolean: a cached `pro` flag in storage is exactly
 * the thing a hand-edited record forges. Each call re-verifies the LCT2
 * signature (cheap — one ECDSA verify, no network).
 *
 * Trial is time-boxed and pinned to first-seen, checked here rather than in the
 * page so wiping local storage does not mint a second one (see trialState).
 */
// Frozen: nobody can delete an entry from the paywall map at runtime to
// route a gated handler around the gate.
const PAID = Object.freeze({
  "recall-search": "archive.search",
  "recall-backup-state": "archive.backup",
  "recall-backup-mark": "archive.backup",
  "recall-autobackup-state": "archive.backup",
  "recall-autobackup-enable": "archive.backup",
  "recall-autobackup-disable": "archive.backup",
  "recall-backup-forget-key": "archive.backup",
  "recall-autobackup-run": "archive.backup",
  "recall-snapshot": "archive.backup",
  /* The same archive, reached from the page instead of the Recall tab. Export
     merges `chat-archive` in as its spine and in-chat search calls `chat-search`
     to reach messages the page never mounted — both are the sync-built archive,
     which is the paid part. Without these two lines the gate three lines above
     is only a gate on the door, not on the wall. Free users keep everything the
     page itself holds: export falls back to the mounted DOM and search to the
     mounted messages. Delete these two lines to give the archive away. */
  "chat-archive": "archive.backup",
  "chat-search": "archive.search",
  "archive-stamp": "archive.backup",
  "recall-restore-ledger": "archive.restore",
  "recall-restore-guard": "archive.restore",
  "recall-restore-guard-fail": "archive.restore",
  "recall-restore-guard-reset": "archive.restore"
});

const TRIAL_MS = 7 * 864e5;
const TRIAL_KEY = "lct-trial-v2";

/**
 * Trial clock, worker-owned and sync-backed. storage.sync survives a local
 * wipe and a reinstall on the same profile, so "clear data, trial again" costs
 * a whole new browser profile instead of one click.
 */
/* A trial that started offline carries the CLIENT's start date, and the client
   is the party with a reason to lie about it. This re-asks the issuer, which
   keyed the real date to a non-extractable device key and remembers it for 400
   days — so "clear everything and start again" gets the original week back
   instead of a fresh one. Throttled: one attempt an hour, and only ever for a
   record that is not already verified. */
const TRIAL_RECHECK_MS = 36e5;          // never verified: hourly
/* Token-backed records are re-asked daily. This is no longer the defence — the
   signature is, and it expires exactly when the week does, so a stale token
   cannot outlive the trial it grants. What the daily call buys is the issuer's
   own corrections: it keys the week on a verified email and only ever moves a
   start date EARLIER, so re-asking is how a client that started its week on one
   install learns the real, earlier date after a second one. */
const TRIAL_REVERIFY_MS = 864e5;
/* A start date cannot be in the future. An hour of slack absorbs an ordinary
   clock that is a little fast; past that the record is not evidence. */
const TRIAL_FUTURE_SLACK_MS = 36e5;

/* Persisted rather than a module variable: this worker unloads within seconds
   of going idle, so an in-memory "last checked" resets constantly and the
   throttle it implements does not exist. */
async function writeTrial(rec) {
  try { await chrome.storage.sync.set({ [TRIAL_KEY]: rec }); } catch { /* quota */ }
  try { await chrome.storage.local.set({ [TRIAL_KEY]: rec }); } catch { /* dead context */ }
  return rec;
}

/* `holds` is whether the token in the record actually grants right now, which
   the caller has already checked. Not re-derived here from rec.tt: a token that
   is present but does not verify — the device key was regenerated, the record
   came from another machine — must be re-asked on the SHORT clock like a
   record with no token at all, or a legitimate user waits a day for a
   correction that takes one request. */
async function verifyTrialStart(rec, nowTrusted, holds) {
  if (!rec) return rec;
  const now = Date.now();
  const startedAt = Number(rec.startedAt) || 0;

  /* Clamp first, and persist the clamp. A future date is either a badly set
     clock or a hand-edited record, and both are answered the same way: the
     trial started no earlier than now. Persisting matters — clamping on every
     read without writing it back would hand out a fresh week every time. */
  if (startedAt > now + TRIAL_FUTURE_SLACK_MS) {
    /* `clamped` is what stops this being a renewable week. Clamping alone still
       hands out seven fresh days, so a record edited once a week never ends.
       A date that cannot be real is not evidence a trial started, so it grants
       nothing until the issuer says otherwise — and the issuer knows, because
       it kept the original. An ordinary offline trial never reaches here: its
       start date is the local clock, which is not in the future. */
    rec = await writeTrial({ ...rec, startedAt: now, verified: false, clamped: true, checkedAt: 0 });
  }

  const started = Number(rec.startedAt) || 0;
  const granting = started + TRIAL_MS > nowTrusted;   // still worth anything?
  const since = now - (Number(rec.checkedAt) || 0);
  /* No token, no grant — so a record without one is due on the SHORT clock
     however verified it claims to be. That covers the upgrade case too: a
     record written before the issuer signed anything says verified:true and
     unlocks nothing, and this is what fetches it a signature within the hour
     instead of at the end of the week. */
  const due = holds
    ? (granting && since >= TRIAL_REVERIFY_MS)
    : (since >= TRIAL_RECHECK_MS);
  if (!due) return rec;

  // Stamp the attempt before the call: an issuer that is down must not be
  // re-asked on every single verdict.
  rec = await writeTrial({ ...rec, checkedAt: now });
  try {
    const deviceFp = await self.LCTEntitlement.sha256Hex(await self.LCTDodo.ensureDeviceId());
    const server = await self.LCTEntitlement.registerTrial(deviceFp);
    /* No signed grant is not an answer. registerTrial already refused a token
       that does not verify against the pinned key or does not bind to this
       device, so reaching here without one means the issuer said "unverified"
       or could not be reached — either way the local record stands unchanged
       and keeps granting nothing. */
    if (!server || !server.tt || !server.startedAt) return rec;
    // The issuer's date wins even when it is EARLIER — that is the whole point.
    // The token carries that date INSIDE the signature, so the clamp marker,
    // which only ever described an unsigned record, goes with it.
    const clean = { ...rec };
    delete clean.clamped;
    return writeTrial({ ...clean, startedAt: server.startedAt, verified: true,
      tt: server.tt, checkedAt: now, ...(server.ks ? { ks: server.ks } : {}),
      ...(server.ksPrev ? { ksPrev: server.ksPrev } : {}) });
  } catch { return rec; }
}

async function trialState() {
  let rec = null;
  try {
    const got = await chrome.storage.sync.get(TRIAL_KEY);
    rec = got && got[TRIAL_KEY];
  } catch { /* sync unavailable */ }
  if (!rec) {
    try {
      const got = await chrome.storage.local.get(TRIAL_KEY);
      rec = got && got[TRIAL_KEY];
    } catch { /* dead context */ }
  }
  /* The high-water clock, not Date.now(). A trial measured against a clock the
     user owns ends whenever they decide it does: winding the machine back a
     year renews it indefinitely. clockNow() never reports earlier than the
     latest time this profile has already seen.
     Read BEFORE verification, because verification needs it to decide whether
     the record is still granting anything worth a request. */
  let nowTrusted = Date.now();
  try { nowTrusted = (await self.LCTEntitlement.clockNow()).trusted; } catch { /* pre-init */ }

  /* The grant, and the ONLY grant: an ECDSA signature from the issuer over this
     identity's start date, bound to this install's device key, expiring when
     the week does. Everything else in the record — the date, the `verified`
     flag, `ks` — is writable by whoever owns the browser, so none of it decides
     anything. Checked on every call rather than cached, for the same reason the
     licence gate is (see PAID above).

     Verified BEFORE the recheck, because the recheck's schedule depends on
     whether what we hold is worth anything, and again after it if the issuer
     handed back a different one. */
  const grantOf = async (r) => {
    if (!r || !r.tt) return null;
    // A gate that throws is a gate that is not answering. No grant, not an error.
    try { return await self.LCTEntitlement.trialGrant(r.tt, nowTrusted); }
    catch { return null; }
  };
  let grant = await grantOf(rec);
  if (rec) {
    const had = rec.tt;
    rec = await verifyTrialStart(rec, nowTrusted, !!(grant && grant.grants));
    if (rec && rec.tt !== had) grant = await grantOf(rec);
  }

  /* Answered from the signature and nothing else, ahead of every check below —
     those exist to judge a record NOBODY signed. Editing the record's own copy
     of the dates, or deleting them, moves nothing here. */
  if (grant && grant.startedAt) {
    return { started: true, active: nowTrusted < grant.until,
      spent: nowTrusted >= grant.until, until: grant.until,
      verified: true, grants: grant.grants, ks: grant.ks,
      // Not in the token — it is the pre-re-key archive secret, kept locally.
      ksPrev: String((rec && rec.ksPrev) || "") };
  }

  const startedAt = Number(rec && rec.startedAt) || 0;
  // NaN, negative, a string, a future date verification could not reach the
  // issuer about — none of those start a trial.
  /* `verified` is a flag anyone can write; `tt` is a signature nobody can
     forge. The clamp is only lifted by the second one. */
  const unsettled = !!(rec && rec.clamped && !rec.tt);
  if (!(startedAt > 0) || startedAt > Date.now() + TRIAL_FUTURE_SLACK_MS || unsettled) {
    // Reported as "never started" so the offer still stands: a user whose clock
    // was wrong gets their trial the moment the issuer can be reached.
    return { started: false, active: false, spent: false, until: 0, ks: "" };
  }

  /* An unsigned week. `active` is about the CLOCK; `grants` is about
     entitlement, and here they part company: the seven days run and unlock
     nothing. That is what makes an issuer outage useless to farm — uninstall,
     reinstall, and the fresh week still opens no Pro feature until an identity
     is proved, at which point the issuer hands back the ORIGINAL start date. */
  const until = startedAt + TRIAL_MS;
  return { started: true, active: nowTrusted < until, spent: nowTrusted >= until,
    until, verified: false, grants: false,
    reason: (grant && grant.reason) || "unsigned", ks: "" };
}

async function startTrial() {
  const cur = await trialState();
  if (cur.started) return cur;                       // one per profile, ever

  /* No week without an address behind it.

     An unverified week is anchored to a keypair in this extension's own
     storage, and uninstalling destroys it. So the week a user had already
     spent came back as a fresh offer on reinstall, and the days they were
     actually owed could not be found again — the issuer had a device row for a
     device that no longer exists and no email to match it to. The verified
     address is the only anchor that survives, and it has to be there BEFORE
     the clock starts, not sometime during the week.

     Both surfaces that draw the button check this first. This is the rule
     itself, so no other caller of `trial-start` can route around it, and so a
     UI holding a stale "signed in" cannot start an orphan week. */
  let verified = false;
  try {
    const rec = await self.LCTEntitlement.readIdentity();
    verified = !!(rec && rec.idt);
  } catch { /* pre-init: treat as signed out */ }
  if (!verified) return { ...cur, branch: "unverified" };

  // Ask the issuer first. It remembers this device across reinstalls and
  // storage wipes, so a returning user gets their ORIGINAL start date back
  // rather than a fresh week. Offline, we fall back to our own clock — a
  // 7-day trial is not worth refusing to work without a network.
  let startedAt = 0, trialTt = "", trialKs = "", trialKsPrev = "";
  try {
    const deviceFp = await self.LCTEntitlement.sha256Hex(await self.LCTDodo.ensureDeviceId());
    const server = await self.LCTEntitlement.registerTrial(deviceFp);
    /* `unverified` is the issuer saying "no identity, so I am keeping no
       record". The week still starts — refusing to run offline is a hostile
       answer to a network problem — but it grants nothing until an identity is
       proved, so there is nothing here worth farming. */
    if (server && !server.unverified && server.tt) {
      startedAt = server.startedAt; trialTt = server.tt; trialKs = server.ks || "";
      trialKsPrev = server.ksPrev || "";
    }
  } catch { /* issuer unreachable */ }

  // Both stores: sync is the durable record, local is the offline fallback.
  /* checkedAt is the throttle stamp, so it only marks an issuer that ANSWERED.
     Stamping it after an unreachable issuer armed the one-hour wait against the
     very first retry: the week started unverified and stayed that way for an
     hour with nothing the user could do. */
  await writeTrial({ startedAt: startedAt || Date.now(), v: 2, checkedAt: trialTt ? Date.now() : 0,
    ...(trialTt ? { tt: trialTt, verified: true } : {}), ...(trialKs ? { ks: trialKs } : {}),
    ...(trialKsPrev ? { ksPrev: trialKsPrev } : {}) });
  return trialState();
}


/* ---------- identity ----------
 *
 * WHY. Every ledger used to key on a device keypair held in this extension's
 * own IndexedDB, and uninstalling destroys it. That made the trial resettable
 * by removing Tvara and adding it back, and it made a paid licence unfindable
 * afterwards — the buyer re-pasted a key out of an email and burned a fresh
 * seat doing it. A verified email survives both.
 *
 * The address is never stored here. It goes to the issuer, which keeps only
 * its hash, and what comes back is an opaque token that names an identity and
 * grants nothing by itself.
 */

/* Empty disables the Google button; the code path stays inert and the OTP
   route is unaffected. Fill in from Google Cloud Console → Credentials →
   OAuth client ID → Web application. */
const GOOGLE_CLIENT_ID = "276513864843-6mf2p200h51i1b1m9ghkuav7fctmt5ku.apps.googleusercontent.com";

/**
 * Google sign-in only where the redirect can be registered.
 *
 * Firefox mints a fresh moz-extension UUID per INSTALL, so its redirect URL is
 * different on every machine and no OAuth client can name it. Rather than
 * offer a button that 400s for every Firefox user, this reports false there
 * and the OTP route — which has no such problem — carries them.
 */
function googleSignInAvailable() {
  if (!GOOGLE_CLIENT_ID) return false;
  try {
    return String(chrome.identity.getRedirectURL()).includes(".chromiumapp.org");
  } catch { return false; }
}

/* The face on the account card: picture URL, display name, address. Read out
   of the id_token this device already holds and kept LOCAL — the issuer is
   told none of it, and it is not in `sync`, because a photo URL is the one
   piece of the identity that is worth nothing on another machine. */
const PROFILE_KEY = "lct-identity-profile-v1";

/** The claims of a JWT, for display only. Nothing here is trusted: the grant
 *  is the issuer's own signed token, checked elsewhere. */
function jwtClaims(token) {
  try {
    const part = String(token || "").split(".")[1] || "";
    if (!part || part.length > 4096) return null;
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const out = JSON.parse(json);
    return out && typeof out === "object" ? out : null;
  } catch { return null; }
}

/** Google serves avatars at whatever size the URL asks for. 96px covers a
 *  retina 36px circle and nothing larger is ever rendered. */
function avatarUrl(raw) {
  const url = String(raw || "");
  if (!/^https:\/\/[a-z0-9.-]*\.googleusercontent\.com\//i.test(url)) return "";
  if (url.length > 512) return "";
  return url.replace(/=s\d+(-c)?$/, "=s96-c");
}

async function writeProfile(claims) {
  const profile = {
    picture: avatarUrl(claims && claims.picture),
    name: String((claims && claims.name) || "").slice(0, 64),
    email: String((claims && claims.email) || "").slice(0, 254)
  };
  if (!profile.picture && !profile.name && !profile.email) return null;
  try { await chrome.storage.local.set({ [PROFILE_KEY]: profile }); } catch { /* dead context */ }
  return profile;
}

async function readProfile() {
  try {
    const got = await chrome.storage.local.get(PROFILE_KEY);
    const p = got && got[PROFILE_KEY];
    return p && typeof p === "object" ? p : null;
  } catch { return null; }
}

async function identityState() {
  let rec = null;
  try { rec = await self.LCTEntitlement.readIdentity(); } catch { /* pre-init */ }
  const verified = !!(rec && rec.idt);
  return { verified, at: Number(rec && rec.at) || 0,
    google: googleSignInAvailable(),
    // Only ever alongside a live identity: a face left over from an account
    // this install has signed out of would be naming the wrong person.
    profile: verified ? await readProfile() : null };
}

/** Ask the issuer to mail a code. */
async function identitySendCode(email) {
  try { return await self.LCTEntitlement.identityStart(email); }
  catch { return { branch: "network" }; }
}

/**
 * Spend the code, then settle everything that was waiting on an identity: a
 * trial that was running unverified becomes verified against the issuer's own
 * start date, and a purchase made before the uninstall comes back.
 */
async function identityConfirmCode(email, code) {
  let res;
  try { res = await self.LCTEntitlement.identityVerify(email, code); }
  catch { return { branch: "network" }; }
  if (res.branch !== "ok") return res;
  return { ...res, settled: await settleAfterVerify(res.json) };
}

/**
 * The Google route to the same anchor.
 *
 * `nonce` is minted by the entitlement lib, travels inside the id_token, and
 * is checked against the signature on the request that presents it — so an
 * id_token obtained anywhere else cannot be posted here.
 */
/* ---------- everything that does not need the click ----------
   Opening Google's window is the slow part of signing in and nothing here can
   make it faster. What CAN come off the critical path is the rest: the service
   worker waking up (it is reclaimed constantly, and a cold start is parsing
   the whole worker before a single line of this runs) and minting the nonce.

   The popup asks for this the moment the pointer lands on the button, which is
   a hundred milliseconds or so before the click, and by then the worker is
   alive and the URL is built. Held in a module variable on purpose: it is an
   optimisation, not state, and losing it to a reclaim costs nothing but the
   old path. The nonce it was built with is in storage.session either way, so
   whichever URL is used, the value the issuer verifies against is the one that
   was stored with it. */
let _googlePrepared = null;                 // { url, at }
const GOOGLE_PREPARE_TTL = 2 * 60 * 1000;

async function identityGoogleUrl() {
  const nonce = await self.LCTEntitlement.identityGoogleNonce();
  const redirect = chrome.identity.getRedirectURL();
  return "https://accounts.google.com/o/oauth2/v2/auth"
    + "?client_id=" + encodeURIComponent(GOOGLE_CLIENT_ID)
    + "&response_type=id_token"
    /* `profile` buys exactly one thing: the picture and display name in the
       id_token, which is what puts a face on the account card. Both are read
       out of the token locally and never sent to the issuer. */
    + "&scope=" + encodeURIComponent("openid email profile")
    + "&redirect_uri=" + encodeURIComponent(redirect)
    + "&nonce=" + encodeURIComponent(nonce)
    // Always ask which account. Silently reusing whichever one the browser is
    // signed into is how a person anchors their trial to the wrong mailbox.
    + "&prompt=select_account";
}

async function identityGooglePrepare() {
  if (!googleSignInAvailable()) return { branch: "unavailable" };
  try { _googlePrepared = { url: await identityGoogleUrl(), at: Date.now() }; }
  catch { return { ok: false }; }
  return { ok: true };
}

async function identityGoogleSignIn() {
  if (!googleSignInAvailable()) return { branch: "unavailable" };
  const ready = _googlePrepared && Date.now() - _googlePrepared.at < GOOGLE_PREPARE_TTL
    ? _googlePrepared.url : null;
  _googlePrepared = null;                   // one launch per prepared nonce
  const url = ready || await identityGoogleUrl();
  return identityGoogleLaunch(url);
}

async function identityGoogleLaunch(url) {
  let landed;
  try {
    landed = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
  } catch { return { branch: "cancelled" }; }
  if (!landed) return { branch: "cancelled" };

  /* The id_token comes back in the FRAGMENT, which never reaches a server —
     that is the point of this response type. */
  const hash = String(landed).split("#")[1] || "";
  const idToken = new URLSearchParams(hash).get("id_token") || "";
  if (!idToken) return { branch: "cancelled" };

  let res;
  try { res = await self.LCTEntitlement.identityGoogle(idToken); }
  catch { return { branch: "network" }; }
  if (res.branch !== "ok") return res;
  // Only after the issuer has accepted the token: a face stored against a
  // sign-in that failed would outlive an identity that never existed.
  await writeProfile(jwtClaims(idToken));
  return { ...res, settled: await settleAfterVerify(res.json) };
}

/**
 * What a fresh verification is worth, applied immediately.
 *
 * Two things can be waiting: a week this identity already spent (so the local
 * record must be corrected DOWN to the issuer's date, never up), and a licence
 * it owns (so Pro comes back without a key). Both are best-effort — a failure
 * here leaves the identity verified and the next ordinary check picks it up.
 */
async function settleAfterVerify(answer) {
  const out = { trial: false, restored: false };
  const startedAt = Number(answer && answer.startedAt) || 0;
  if (startedAt) {
    /* The answer says this identity already has a week, but says it in an
       unsigned body — and a date without a signature grants nothing now. Ask
       /trial for the signed record of the SAME week. It cannot start a second
       one: the issuer keys the trial on this identity and hands back the
       existing row, correcting the date downwards if ours drifted. */
    const server = await self.LCTEntitlement.registerTrial("");
    if (server && server.tt) {
      await writeTrial({ startedAt: server.startedAt, v: 2, verified: true,
        tt: server.tt, checkedAt: Date.now(), ...(server.ks ? { ks: server.ks } : {}),
        ...(server.ksPrev ? { ksPrev: server.ksPrev } : {}) });
      out.trial = true;
    }
  }
  if (answer && answer.owns) out.restored = (await identityRestore()).restored === true;
  return out;
}

/**
 * Bring a purchase back after a reinstall.
 *
 * The issuer does the work: it finds the licence this identity owns, checks it
 * is still live upstream, reclaims a seat (evicting this identity's own
 * stalest one rather than refusing the buyer), and hands back a signed token.
 * Nothing here trusts that token — writeToken stores it and the ordinary
 * verify path decides what it is worth.
 */
async function identityRestore() {
  let res;
  try { res = await self.LCTEntitlement.restorePurchase(); }
  catch { return { ok: false, reason: "network" }; }
  if (res.branch === "unverified") return { ok: false, reason: "unverified" };
  if (res.branch !== "ok") return { ok: false, reason: res.branch };
  const json = res.json || {};
  if (!json.restored || typeof json.key !== "string" || !json.key) {
    return { ok: true, restored: false };
  }

  const now = Date.now();
  await chrome.storage.local.set({
    license: { key: json.key, email: "", plan: "pro", kind: "dodo",
      instanceId: "", licenseKeyId: "", activatedAt: now, restored: true },
    "lct-license-state-v1": { lastValidatedAt: now, lastAttemptAt: now, strikes: [] }
  });
  if (typeof json.token === "string" && json.token) {
    try { await self.LCTEntitlement.writeToken({ token: json.token, fetchedAt: now }); }
    catch { /* the next refresh fetches one */ }
  }
  return { ok: true, restored: true, seats: Number(json.seats) || 0 };
}

/**
 * Forget the identity on THIS install only.
 *
 * Deliberately does not touch the issuer's ledger: signing out is not a way to
 * release a spent trial. It also leaves the licence record alone — someone
 * switching the anchored mailbox should not lose the Pro they already have.
 */
async function identitySignOut() {
  try { await self.LCTEntitlement.clearIdentity(); } catch { /* already gone */ }
  try { await chrome.storage.local.remove(PROFILE_KEY); } catch { /* already gone */ }
  return identityState();
}

/** Cached only within a single wake of the worker, never persisted. */
/**
 * Register a seat for a Dodo key, store it, and mint the entitlement.
 *
 * Same three steps the popup performs, in the same order and all awaited. A
 * seat without a token looks like success and unlocks nothing, so a partial
 * result is reported as a failure rather than an "activated".
 */
async function activateLicenseKey(key) {
  const k = String(key || "").trim();
  if (!k) return { ok: false, reason: "empty" };
  if (self.LCTLicense.kindOf(k) === "lct1") {
    const v = await self.LCTLicense.verify(k);
    if (!v.valid) return { ok: false, reason: v.reason || "bad-key" };
    await chrome.storage.local.set({
      license: { key: k, email: v.email || "", plan: "pro", kind: "lct1", activatedAt: Date.now() }
    });
    return { ok: true, kind: "lct1", email: v.email || "" };
  }
  if (!self.LCTDodo.looksLikeKey(k)) return { ok: false, reason: "bad-key" };

  let res;
  try { res = await self.LCTDodo.activateWithSeats(k, {}); }
  catch (error) { return { ok: false, reason: "network", detail: String(error && error.message || error) }; }
  if (!res || !res.ok) return { ok: false, reason: (res && res.reason) || "refused", seats: res && res.seats };

  const now = Date.now();
  const record = {
    key: k, email: res.email || "", plan: "pro", kind: "dodo",
    instanceId: res.instanceId, licenseKeyId: res.licenseKeyId || "", activatedAt: now
  };
  await chrome.storage.local.set({
    license: record,
    "lct-license-state-v1": { lastValidatedAt: now, lastAttemptAt: now, strikes: [] }
  });

  /* Activation, and only activation, may clear a sign-out this device was
     given from somewhere else. The 12-hourly tick must not. */
  const ent = await self.LCTEntitlement.refresh(record, res.deviceId,
    { force: true, activate: true });
  if (!ent.ok) {
    /* `branch` is carried out rather than collapsed into "entitlement". The
       seat is already claimed at this point, so every one of these is a person
       who has PAID and is looking at a failure — and "something went wrong" is
       the difference between an email to support and a chargeback. */
    return { ok: false, reason: ent.revoked ? "revoked" : "entitlement",
             branch: ent.branch || "", seated: true, email: record.email };
  }
  return { ok: true, kind: "dodo", email: record.email, evicted: res.evicted || 0 };
}

/* ---------- checkout ----------

   The Buy button used to open a web page that had a payment link on it. It now
   asks the issuer to open a session and opens THAT, then waits here — because
   the popup is closed within a second of the click and paying takes a minute.

   Two things drive the claim, and neither is trusted on its own:

     - The page the buyer lands on afterwards pings us. Fast, and the ordinary
       case: the licence is active before they have read the thank-you.
     - A one-minute alarm. Slower, and the one that survives the service worker
       being torn down mid-purchase, the tab being closed on the receipt, or the
       browser being quit and reopened an hour later.

   The buyer does nothing in either path. Nothing is pasted, nothing is read out
   of an email, and no licence key is ever in a URL.
*/
const BG_ORDER_ALARM = "lct-order-claim";
const BG_ORDER_KEY = "lct-pending-order-v1";
/* The client half of "a paid order reports expired".
   This used to be 24 hours, to match the issuer's ORDER_TTL_MS, on the reasoning
   that past it the order is gone server-side. That is only true of an order
   NOBODY PAID FOR — the issuer sweeps those after a day and keeps a settled one
   for the support window. So a webhook that ran slow meant this threw away the
   ref for an order the buyer had already paid, before asking anyone about it.
   Age no longer decides: the issuer's own terminal answers — unknown, expired,
   refunded — clear the record (see the tail of claimPendingOrder). This is the
   backstop for an issuer that can never be reached at all. */
const BG_ORDER_KEEP_MS = 180 * 864e5;

async function readPendingOrder() {
  try {
    const got = await chrome.storage.local.get(BG_ORDER_KEY);
    const order = got && got[BG_ORDER_KEY];
    return order && typeof order.ref === "string" ? order : null;
  } catch { return null; }
}

async function clearPendingOrder() {
  try { await chrome.storage.local.remove(BG_ORDER_KEY); } catch { /* dead context */ }
  try { await chrome.alarms.clear(BG_ORDER_ALARM); } catch { /* alarms unavailable */ }
}

/** Re-arm on wake. A purchase started before the last shutdown is still owed. */
async function ensureOrderAlarm() {
  const pending = await readPendingOrder();
  if (!pending) {
    try { await chrome.alarms.clear(BG_ORDER_ALARM); } catch { /* alarms unavailable */ }
    return;
  }
  try {
    if (!(await chrome.alarms.get(BG_ORDER_ALARM))) {
      await chrome.alarms.create(BG_ORDER_ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
    }
  } catch { /* alarms unavailable — the landing-page ping still closes the loop */ }
}

/**
 * Open a checkout and remember what we are owed.
 *
 * The URL is the issuer's answer, and lib/entitlement.js has already refused
 * anything that is not the payment provider's own https host — a server saying
 * "send them here to type a card number" is exactly the instruction that must
 * not be taken on trust.
 */
async function startCheckoutFlow() {
  const res = await self.LCTEntitlement.startCheckout();
  if (res.branch !== "ok") return { ok: false, reason: res.branch };

  try {
    await chrome.storage.local.set({ [BG_ORDER_KEY]: { ref: res.ref, startedAt: Date.now() } });
  } catch { /* dead context — the tab below is still worth opening */ }
  try { await chrome.alarms.create(BG_ORDER_ALARM, { delayInMinutes: 1, periodInMinutes: 1 }); }
  catch { /* alarms unavailable */ }

  try { await chrome.tabs.create({ url: res.url }); }
  catch { return { ok: true, ref: res.ref, url: res.url, opened: false }; }
  return { ok: true, ref: res.ref, url: res.url, opened: true };
}

/**
 * One claim attempt.
 *
 * Returns a state rather than a boolean so a page that is still open can say
 * something true while it waits. Every failure is a state too: this runs on a
 * timer behind a purchase somebody has already paid for, and a thrown error
 * here is a silent one.
 */
async function claimPendingOrder() {
  const pending = await readPendingOrder();
  if (!pending) return { state: "none" };

  if (Date.now() - Number(pending.startedAt || 0) > BG_ORDER_KEEP_MS) {
    await clearPendingOrder();
    return { state: "expired" };
  }

  /* A key already in hand means a previous tick claimed it and activation is
     what failed. Do not ask again — the issuer hands a key back ONCE and would
     answer "claimed" and nothing else. */
  let key = String(pending.key || "");
  let state = key ? "ready" : "";

  if (!key) {
    const res = await self.LCTEntitlement.claimCheckout(pending.ref);
    // Not an answer about the order — a network or proof problem. Keep waiting.
    if (res.branch !== "ok") return { state: "waiting", branch: res.branch };
    state = res.state;
    key = String(res.key || "");

    if (key) {
      /* Persisted BEFORE activation is attempted. A failed activation is
         retryable; a key that only ever lived in a local variable is a person
         who paid, got nothing, and has to be found by hand in support. */
      pending.key = key;
      try { await chrome.storage.local.set({ [BG_ORDER_KEY]: pending }); }
      catch { /* dead context; the emailed copy is the remaining path */ }
    }
  }

  if (key) {
    const act = await activateLicenseKey(key);
    if (act.ok) {
      await clearPendingOrder();
      return { state: "active", email: act.email || "" };
    }
    // Keep the record. The key is ours now and the next tick can try again.
    return { state: "held", reason: act.reason || "", branch: act.branch || "" };
  }

  /* Terminal server-side. "claimed" without a key of our own means this install
     took it and lost it before it could be stored — rare, and the emailed copy
     is the recovery, which is why the popup keeps its paste box. */
  if (state === "refunded" || state === "expired" || state === "claimed" || state === "unknown") {
    await clearPendingOrder();
    return { state };
  }
  return { state: state || "pending" };
}

async function entitlementVerdict() {
  let license = null;
  try {
    const got = await chrome.storage.local.get("license");
    license = got && got.license;
  } catch { /* dead context */ }

  const trial = await trialState();
  if (!license || !license.key) {
    return { entitled: !!trial.grants, via: trial.grants ? "trial" : "none", trial,
      features: trial.grants ? (self.LCTEntitlement?.FEATURES || []) : [] };
  }

  let deviceId = "";
  try { deviceId = await self.LCTDodo.ensureDeviceId(); } catch { /* pre-activation */ }

  const res = await self.LCTEntitlement.evaluate(license, deviceId);
  if (res.entitled) return { ...res, via: res.kind, trial };
  // A dead licence still leaves an unspent trial usable.
  if (trial.grants) return { entitled: true, via: "trial", trial, features: self.LCTEntitlement.FEATURES.slice(), reason: res.reason };
  return { ...res, via: "none", trial };
}

/**
 * Stamp credentials, off the same verdict the gate uses — so a trial seals a
 * real backup and a locked install seals nothing. Pro takes the per-licence
 * secret from its token (stable across renewals, portable to a reinstall);
 * trial takes the one the issuer minted for its device.
 */
async function stampSecret() {
  const v = await entitlementVerdict();
  if (!v.entitled) return null;
  if (v.via === "trial") {
    if (v.trial && v.trial.ks) return v.trial.ks;
    // Offline trial: no issuer secret to anchor to. Mint one locally and keep
    // it, so the file still verifies on the way back in. Weaker than the Pro
    // secret (not server-derived, not portable) — but reaching this at all
    // means passing requireEntitlement, which a locked install cannot.
    return ensureLocalStampSecret();
  }
  if (v.kind === "lct1") {
    const got = await chrome.storage.local.get("license");
    const key = got && got.license && got.license.key;
    return key ? await self.LCTEntitlement.sha256Hex("lct1-archive:" + key, 32) : null;
  }
  return v.ks || null;
}

const LOCAL_STAMP_KEY = "lct-stamp-local-v1";

async function ensureLocalStampSecret() {
  try {
    const got = await chrome.storage.local.get(LOCAL_STAMP_KEY);
    const cur = got && got[LOCAL_STAMP_KEY];
    if (typeof cur === "string" && cur.length >= 40) return cur;
  } catch { /* dead context */ }
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const secret = btoa(String.fromCharCode(...bytes));
  try { await chrome.storage.local.set({ [LOCAL_STAMP_KEY]: secret }); } catch { /* dead context */ }
  return secret;
}

async function stampCreds() {
  const secret = await stampSecret();
  if (!secret) return { stampKey: null, stampSub: "" };
  let bytes;
  try {
    bytes = Uint8Array.from(atob(secret.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  } catch { bytes = new TextEncoder().encode(secret); }
  let stampKey = null;
  try {
    stampKey = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" },
      false, ["sign", "verify"]);
  } catch { /* unusable secret */ }
  let stampSub = "";
  try {
    const got = await chrome.storage.local.get("license");
    if (got && got.license && got.license.key) {
      stampSub = await self.LCTEntitlement.sha256Hex(got.license.key);
    }
  } catch { /* dead context */ }
  return { stampKey, stampSub, secret, alts: await stampAltSecrets() };
}

/**
 * Secrets that only ever OPEN a file, never seal one.
 *
 * The trial archive stamp was re-keyed from the device fingerprint to the
 * identity one. Every v3 backup sealed during a trial before that deploy
 * verifies under the old secret alone, and without this every one of them
 * became permanently unreadable.
 */
async function stampAltSecrets() {
  const v = await entitlementVerdict();
  if (!v.entitled || v.via !== "trial") return [];
  const prev = v.trial && v.trial.ksPrev;
  return prev ? [String(prev)] : [];
}

/* ---------- point-of-use revalidation ----------
   The 12h alarm bounds how long a cancelled licence keeps working in the
   background; this bounds it to the next Pro action. A licence refunded at
   14:00 is refused at 14:00:01, because the action itself pays for the round
   trip once the token has gone stale.

   Only an ANSWER locks. A refusal from the issuer clears the token in
   attempt(); a timeout or an outage leaves the cached verdict exactly as it
   was, so a Pro user offline on a plane is never blocked by their own
   connectivity. The race below is what keeps that promise cheap: a slow
   network costs one action's worth of delay, not the action. */
const ENT_FRESH_MS = 15 * 60e3;
const ENT_BLOCK_MS = 5000;

async function revalidateIfStale() {
  try {
    const rec = await self.LCTEntitlement.readToken();
    // No token: a trial or an LCT1 key, neither of which the issuer decides.
    if (!rec || Date.now() - (rec.fetchedAt || 0) < ENT_FRESH_MS) return;
    const got = await chrome.storage.local.get("license");
    const lic = got && got.license;
    if (!lic || !lic.key || /^LCT1\./.test(lic.key)) return;
    const deviceId = await self.LCTDodo.ensureDeviceId();
    // Forced: an unforced refresh does nothing until the 30d renewal window,
    // and revocation cannot wait 60 days for it to open.
    await self.LCTEntitlement.refresh(lic, deviceId, { force: true });
  } catch { /* offline or dead context — the cached verdict stands */ }
}

async function requireEntitlement(feature) {
  await Promise.race([revalidateIfStale(), sleep(ENT_BLOCK_MS)]);
  const v = await entitlementVerdict();
  if (!v.entitled) return { ok: false, reason: v.reason || "locked" };
  if (v.via !== "trial" && Array.isArray(v.features) && !v.features.includes(feature)) {
    return { ok: false, reason: "feature" };
  }
  return { ok: true, via: v.via, stale: !!v.stale };
}
