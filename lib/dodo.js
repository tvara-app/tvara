/**
 * Long Chat Toolkit — Dodo Payments licence activation and device seats.
 *
 * A Pro key activates on at most SEAT_LIMIT devices. Dodo owns the count; this
 * file owns identity and bookkeeping. Three PUBLIC endpoints (no API key, no
 * server of ours) do the work:
 *
 *   POST /licenses/activate    {license_key, name}                  -> 201 {id, customer}
 *   POST /licenses/validate    {license_key, license_key_instance_id?} -> 200 {valid}
 *   POST /licenses/deactivate  {license_key, license_key_instance_id}   -> 200
 *
 * Their CORS echoes the chrome-extension:// origin, so this needs NO host
 * permission — the manifest still grants network reach to nothing but the AI
 * sites you use.
 *
 * What leaves the machine: the licence key and a coarse device label. Never a
 * cookie (credentials are omitted explicitly, and this file must never call
 * bg.js's bgFetch, which attaches them), never conversation text, never the
 * device UUID in full.
 *
 * The seat registry lives in chrome.storage.sync so a second Chrome signed
 * into the same profile recognises itself and re-uses its seat instead of
 * burning another. The KEY stays in storage.local — a bearer secret has no
 * business traversing profile sync.
 *
 * No chrome.* call may happen at load time: test/test-license.mjs loads this
 * file in a bare Node sandbox to unit-test the pure logic.
 */
(() => {
  "use strict";

  const LIVE = "https://live.dodopayments.com";
  const TEST = "https://test.dodopayments.com";
  const API_OVERRIDE_KEY = "lct-dodo-api";   // dev only: set to TEST to use test mode
  const SEAT_LIMIT = 5;
  const TIMEOUT_MS = 10000;
  const MAX_BODY = 64 * 1024;
  const MAX_SEATS = 16;                       // registry clamp; real cap is Dodo's
  const REVALIDATE_MS = 30 * 864e5;           // at most monthly
  const RETRY_FLOOR_MS = 24 * 864e5;          // ...and at most daily when it fails
  const STRIKE_SPREAD_MS = 7 * 864e5;         // two "invalid" answers must be this far apart

  const DEVICE_KEY = "lct-device-id-v1";
  const SEATS_KEY = "lct-seats-v1";
  const STATE_KEY = "lct-license-state-v1";

  // Pin the fetch reference at load time so that overriding window.fetch or
  // self.fetch after this IIFE runs cannot intercept licence network calls.
  const _fetch = typeof fetch === "function" ? fetch.bind(self) : null;

  /* ---------- pure helpers (unit-tested in Node) ---------- */

  /** Map an HTTP status onto a branch name. Status 0 means the fetch itself failed. */
  function classify(status) {
    if (status === 200 || status === 201) return "ok";
    if (status === 422) return "limit";
    if (status === 403) return "inactive";
    if (status === 404) return "notfound";
    if (status === 0) return "network";
    if (status >= 500) return "service";
    return "badrequest";
  }

  /** Cheap shape gate so a typo never causes a network call. */
  function looksLikeKey(k) {
    return typeof k === "string" && k.length >= 8 && k.length <= 64 && /^[A-Za-z0-9._-]+$/.test(k);
  }

  /** The seat we evict to make room: the one activated longest ago, never our own. */
  function oldestSeat(seats, excludeDeviceId) {
    let best = null;
    for (const id of Object.keys(seats || {})) {
      if (id === excludeDeviceId) continue;
      const seat = seats[id];
      if (!seat || typeof seat.instanceId !== "string") continue;
      if (!best || (seat.activatedAt || 0) < (best[1].activatedAt || 0)) best = [id, seat];
    }
    return best;
  }

  /**
   * Two authoritative "not valid" answers, at least a week apart, before Pro is
   * withdrawn. One bad answer is never enough — see maybeRevalidate for why
   * every other outcome (offline, 5xx, garbage body) is a no-op.
   */
  function shouldDowngrade(strikes) {
    if (!Array.isArray(strikes) || strikes.length < 2) return false;
    return strikes[strikes.length - 1] - strikes[0] >= STRIKE_SPREAD_MS;
  }

  /** Coarse, non-identifying: "Chrome · macOS". No hostname, no username. */
  function deviceLabel() {
    const d = (typeof navigator !== "undefined" && navigator.userAgentData) || null;
    let browser = "Browser";
    if (d && Array.isArray(d.brands)) {
      const real = d.brands.find((b) => !/not.*a.*brand/i.test(b.brand));
      if (real) browser = real.brand;
    } else if (typeof navigator !== "undefined" && /Firefox\//.test(navigator.userAgent || "")) {
      browser = "Firefox";
    } else if (typeof navigator !== "undefined" && /Edg\//.test(navigator.userAgent || "")) {
      browser = "Edge";
    } else if (typeof navigator !== "undefined" && /Chrome\//.test(navigator.userAgent || "")) {
      browser = "Chrome";
    }
    const os = (d && d.platform) ||
      (typeof navigator !== "undefined" && navigator.platform) || "";
    return (os ? browser + " · " + os : browser).slice(0, 40);
  }

  /** What Dodo's dashboard shows for this seat. 8 hex of the id, never the whole UUID. */
  function instanceName(deviceId) {
    return (deviceLabel() + " · " + String(deviceId || "").slice(0, 8)).slice(0, 60);
  }

  /** Never let a key reach a status string, a log or the DOM. */
  function redact(text) {
    return String(text == null ? "" : text).replace(/[A-Za-z0-9._-]{8,}/g, "•••");
  }

  async function fingerprint(key) {
    const bytes = new TextEncoder().encode(String(key));
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(hash).slice(0, 4)]
      .map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  /* ---------- durable storage (sync, silently falling back to local) ---------- */
  // Mirrors bg.js getDurable/setDurable. Duplicated rather than shared: those
  // are private to the service worker, and hoisting sync-engine plumbing onto a
  // global to save four lines would be a worse trade.

  async function syncGet(keys) {
    try { return await chrome.storage.sync.get(keys); }
    catch { try { return await chrome.storage.local.get(keys); } catch { return {}; } }
  }

  async function syncSet(obj) {
    try { await chrome.storage.sync.set(obj); return true; }
    catch { try { await chrome.storage.local.set(obj); } catch { /* dead context */ } return false; }
  }

  /* ---------- network ---------- */

  async function apiBase() {
    try {
      const got = await chrome.storage.local.get(API_OVERRIDE_KEY);
      const override = got && got[API_OVERRIDE_KEY];
      if (override === "test" || override === TEST) return TEST;
    } catch { /* no storage — fall through to live */ }
    return LIVE;
  }

  /**
   * The only network call in the licensing path. Never throws: every failure is
   * a status, so no caller can mistake an outage for a bad key.
   */
  async function api(path, body) {
    let base;
    try { base = await apiBase(); } catch { base = LIVE; }
    const url = base + path;
    try {
      const res = await _fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        credentials: "omit",        // explicit: bg.js's fetch path includes cookies, this must not
        redirect: "error",          // never follow a redirect carrying the key to another origin
        referrerPolicy: "no-referrer",
        cache: "no-store",
        mode: "cors",
        signal: AbortSignal.timeout(TIMEOUT_MS)
      });
      if (new URL(res.url || url).origin !== new URL(base).origin) {
        return { status: 0, branch: "network", json: null };
      }
      const text = (await res.text()).slice(0, MAX_BODY);
      let json = null;
      try { json = JSON.parse(text); } catch { /* non-JSON body — the status still decides */ }
      return { status: res.status, branch: classify(res.status), json };
    } catch {
      return { status: 0, branch: "network", json: null };
    }
  }

  async function activate(key, name) {
    const r = await api("/licenses/activate", { license_key: key, name });
    return {
      branch: r.branch,
      instanceId: (r.json && r.json.id) || "",
      licenseKeyId: (r.json && r.json.license_key_id) || "",
      email: (r.json && r.json.customer && r.json.customer.email) || ""
    };
  }

  async function validate(key, instanceId) {
    const body = { license_key: key };
    if (instanceId) body.license_key_instance_id = instanceId;
    const r = await api("/licenses/validate", body);
    // A bogus key answers 200 {valid:false} — it never 404s. Only a literal
    // boolean false is authoritative; anything else must not count against you.
    const valid = r.branch === "ok" && r.json && r.json.valid === true;
    const authoritative = r.branch === "ok" && r.json && typeof r.json.valid === "boolean";
    return { branch: r.branch, valid, authoritative };
  }

  async function deactivate(key, instanceId) {
    const r = await api("/licenses/deactivate", {
      license_key: key, license_key_instance_id: instanceId
    });
    // 403 means the instance is already gone — for our purposes that is success.
    return { branch: r.branch === "inactive" ? "gone" : r.branch };
  }

  /* ---------- device identity ---------- */

  /**
   * One id per synced browser profile — so a laptop and a desktop signed into
   * the same Chrome profile share a seat rather than burning two. Written and
   * awaited BEFORE any network call, so a crash can never orphan an instance
   * we have no id for.
   */
  async function ensureDeviceId() {
    const got = await syncGet(DEVICE_KEY);
    const rec = got && got[DEVICE_KEY];
    if (rec && typeof rec.id === "string" && rec.id.length >= 8) return rec.id;
    const id = crypto.randomUUID();
    await syncSet({ [DEVICE_KEY]: { id, mintedAt: Date.now() } });
    return id;
  }

  /**
   * Fresh installs get their synced id minutes late, so two profiles can both
   * mint one and both activate. Converge without coordination: oldest mint
   * wins, ties broken lexicographically. Best-effort repair, never noisy.
   */
  async function reconcileDeviceId(remote, local) {
    if (!remote || !local || remote.id === local.id) return local && local.id;
    const remoteWins = (remote.mintedAt || 0) < (local.mintedAt || 0) ||
      ((remote.mintedAt || 0) === (local.mintedAt || 0) && remote.id < local.id);
    return remoteWins ? remote.id : local.id;
  }

  /* ---------- seat registry ---------- */

  function normalizeRegistry(value) {
    const seats = {};
    const raw = (value && value.seats) || {};
    for (const id of Object.keys(raw).slice(0, MAX_SEATS)) {
      const s = raw[id];
      if (!s || typeof s.instanceId !== "string") continue;
      seats[id] = {
        instanceId: s.instanceId.slice(0, 64),
        label: String(s.label || "Unknown device").slice(0, 40),
        activatedAt: Number(s.activatedAt) || 0,
        lastSeenAt: Number(s.lastSeenAt) || 0,
        ...(s.orphan ? { orphan: true } : {})
      };
    }
    return { version: 1, keyFp: String((value && value.keyFp) || ""), seats };
  }

  async function readSeats() {
    const got = await syncGet(SEATS_KEY);
    return normalizeRegistry(got && got[SEATS_KEY]);
  }

  async function mutateSeats(fn) {
    const reg = await readSeats();
    const next = normalizeRegistry(fn(reg) || reg);
    await syncSet({ [SEATS_KEY]: next });
    return next;
  }

  /** A registry belonging to a different licence is not ours to reason about. */
  async function ensureRegistryForKey(key) {
    const fp = await fingerprint(key);
    const reg = await readSeats();
    if (reg.keyFp === fp) return reg;
    return mutateSeats(() => ({ version: 1, keyFp: fp, seats: {} }));
  }

  /* ---------- orchestration ---------- */

  /**
   * The activation state machine. Returns a plain verdict; the popup owns all
   * copy. Never loops: `attempt` is threaded explicitly so eviction can happen
   * at most once, no matter what the server says.
   */
  async function activateWithSeats(key, opts) {
    const onState = (opts && opts.onState) || (() => {});
    const attempt = (opts && opts.attempt) || 0;

    onState("verifying");
    const deviceId = await ensureDeviceId();      // awaited before any fetch
    const reg = await ensureRegistryForKey(key);
    const mine = reg.seats[deviceId];

    // Second Chrome on the same synced profile: prove the seat is still ours
    // rather than spending another one.
    if (attempt === 0 && mine && mine.instanceId) {
      const v = await validate(key, mine.instanceId);
      if (v.branch === "ok" && v.valid) {
        await mutateSeats((r) => {
          if (r.seats[deviceId]) r.seats[deviceId].lastSeenAt = Date.now();
          return r;
        });
        return { ok: true, reused: true, deviceId, instanceId: mine.instanceId, email: "" };
      }
      if (v.branch === "ok") {
        // Genuinely stale (different licence, or killed elsewhere) — drop it.
        await mutateSeats((r) => { delete r.seats[deviceId]; return r; });
      } else {
        // Fail-open protects an activation we already hold; it must never
        // bootstrap a new one from an unverified paste.
        return { ok: false, branch: v.branch };
      }
    }

    const res = await activate(key, instanceName(deviceId));

    if (res.branch === "ok") {
      const now = Date.now();
      // Registry first: a crash between the two writes leaves a recoverable
      // seat rather than an instance nobody can name.
      await mutateSeats((r) => {
        r.seats[deviceId] = {
          instanceId: res.instanceId, label: deviceLabel(), activatedAt: now, lastSeenAt: now
        };
        return r;
      });
      return {
        ok: true, deviceId, instanceId: res.instanceId,
        licenseKeyId: res.licenseKeyId, email: res.email
      };
    }

    if (res.branch === "limit") {
      if (attempt > 0) return { ok: false, branch: "limit", deviceId };
      const victim = oldestSeat(reg.seats, deviceId);
      if (!victim) return { ok: false, branch: "limit", deviceId, unknownDevices: true };

      onState("evicting");
      const gone = await deactivate(key, victim[1].instanceId);
      if (gone.branch !== "ok" && gone.branch !== "gone") {
        return { ok: false, branch: gone.branch === "notfound" ? "notfound" : gone.branch };
      }
      await mutateSeats((r) => { delete r.seats[victim[0]]; return r; });
      const retried = await activateWithSeats(key, { onState, attempt: attempt + 1 });
      if (retried.ok) retried.evicted = victim[1].label;
      return retried;
    }

    return { ok: false, branch: res.branch, deviceId };
  }

  async function terminateSeat(key, targetDeviceId) {
    const reg = await readSeats();
    const seat = reg.seats[targetDeviceId];
    if (!seat) return { ok: true };               // already gone from our view
    const r = await deactivate(key, seat.instanceId);
    // "gone" is a stale registry, not a failure: the network answer always wins.
    if (r.branch === "ok" || r.branch === "gone") {
      await mutateSeats((reg2) => { delete reg2.seats[targetDeviceId]; return reg2; });
      return { ok: true };
    }
    return { ok: false, branch: r.branch };
  }

  async function releaseThisDevice(key) {
    const deviceId = await ensureDeviceId();
    return terminateSeat(key, deviceId);
  }

  /** Mark a seat we could not release, so the device screen can explain it. */
  async function markOrphan(deviceId) {
    await mutateSeats((r) => {
      if (r.seats[deviceId]) r.seats[deviceId].orphan = true;
      return r;
    });
  }

  /* ---------- lazy re-validation ---------- */

  async function readState() {
    try {
      const got = await chrome.storage.local.get(STATE_KEY);
      const s = (got && got[STATE_KEY]) || {};
      return {
        lastValidatedAt: Number(s.lastValidatedAt) || 0,
        lastAttemptAt: Number(s.lastAttemptAt) || 0,
        strikes: Array.isArray(s.strikes) ? s.strikes.slice(-2) : [],
        lastErrorCode: String(s.lastErrorCode || "")
      };
    } catch {
      return { lastValidatedAt: 0, lastAttemptAt: 0, strikes: [], lastErrorCode: "" };
    }
  }

  async function writeState(patch) {
    const cur = await readState();
    try { await chrome.storage.local.set({ [STATE_KEY]: { ...cur, ...patch } }); }
    catch { /* dead context */ }
  }

  function shouldRevalidate(record, state, now) {
    if (!record || !record.key || record.revokedAt) return false;
    if (/^LCT1\./.test(record.key)) return false;          // offline keys never phone home
    if (!record.instanceId) return false;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return false;
    const since = state.lastValidatedAt || record.activatedAt || 0;
    if (now - since < REVALIDATE_MS) return false;
    if (now - (state.lastAttemptAt || 0) < RETRY_FLOOR_MS) return false;
    return true;
  }

  let revalidating = false;

  /**
   * Fire-and-forget, never awaited, never blocking paint. Fail-open is the
   * whole contract: only a 200 with a literal `valid:false` counts against the
   * user. Offline, 5xx, timeouts and garbage bodies do nothing but push the
   * retry floor out.
   */
  async function maybeRevalidate(record) {
    if (revalidating) return { skipped: "in-flight" };
    const now = Date.now();
    const state = await readState();
    if (!shouldRevalidate(record, state, now)) return { skipped: "gated" };

    revalidating = true;
    try {
      const v = await validate(record.key, record.instanceId);
      if (!v.authoritative) {
        await writeState({ lastAttemptAt: now, lastErrorCode: v.branch });
        return { outcome: "inconclusive", branch: v.branch };
      }
      if (v.valid) {
        await writeState({ lastValidatedAt: now, lastAttemptAt: now, strikes: [], lastErrorCode: "" });
        const deviceId = await ensureDeviceId();
        await mutateSeats((r) => {
          if (r.seats[deviceId]) r.seats[deviceId].lastSeenAt = now;
          return r;
        });
        return { outcome: "valid" };
      }
      // Advance lastValidatedAt too, or every popup open would re-strike.
      const strikes = [...state.strikes, now].slice(-2);
      await writeState({ lastValidatedAt: now, lastAttemptAt: now, strikes, lastErrorCode: "invalid" });
      if (!shouldDowngrade(strikes)) return { outcome: "strike", strikes: strikes.length };
      try {
        const got = await chrome.storage.local.get("license");
        const lic = got && got.license;
        // Keep the key: the user may be able to fix this with support.
        if (lic && lic.key) await chrome.storage.local.set({ license: { ...lic, revokedAt: now } });
      } catch { /* dead context */ }
      return { outcome: "revoked" };
    } finally {
      revalidating = false;
    }
  }

  // ---------- anti-inspection ----------
  const _hide = (fn) => {
    Object.defineProperty(fn, "toString", {
      value: () => "function () { [native code] }",
      writable: false, configurable: false
    });
    return fn;
  };
  _hide(activateWithSeats); _hide(maybeRevalidate); _hide(validate);
  _hide(activate); _hide(deactivate);

  // Frozen and non-configurable: runtime reassignment has no effect.
  const _dodoApi = Object.freeze({
    SEAT_LIMIT,
    // pure
    classify, looksLikeKey, oldestSeat, shouldDowngrade, shouldRevalidate,
    deviceLabel, instanceName, redact, fingerprint, normalizeRegistry, reconcileDeviceId,
    // network
    activate, validate, deactivate,
    // state
    ensureDeviceId, readSeats, mutateSeats, ensureRegistryForKey, readState, writeState,
    // orchestration
    activateWithSeats, terminateSeat, releaseThisDevice, markOrphan, maybeRevalidate
  });
  Object.defineProperty(self, "LCTDodo", {
    value: _dodoApi, writable: false, enumerable: true, configurable: false
  });
})();
