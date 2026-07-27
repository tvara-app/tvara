/**
 * Long Chat Toolkit — entitlement issuer (Cloudflare Worker).
 *
 * The one place a client cannot patch. Holds two secrets:
 *   DODO_API_KEY  — server-side licence validation
 *   SIGNING_KEY   — ECDSA P-256 PKCS8, base64. Pair of lib/entitlement.js's public key.
 *
 * POST /entitlement {license_key, device, instance_id} -> 200 {token}
 * Token: LCT2.<b64url(payload)>.<b64url(P1363 sig)>, bound to key + device, 90d.
 *
 * Deploy:
 *   wrangler secret put DODO_API_KEY
 *   wrangler secret put SIGNING_KEY      # node tools/genkey.mjs worker-key
 *   wrangler deploy
 *
 * Bindings expected: KV namespace `RL` (rate limit + seat ledger).
 */

const TTL_MS = 90 * 864e5;
const FEATURES = ["archive.search", "archive.backup", "archive.restore"];
const SEAT_LIMIT = 5;

const RL_MAX = 20;              // requests per key per window
const RL_WINDOW_S = 3600;
const DODO_TIMEOUT_MS = 8000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;  // reject requests older than 5 min
const TRIAL_TTL_MS = 7 * 864e5;           // 7 days — must match client
const TRIAL_RL_MAX = 5;                   // trial registrations per device per day

/* ---------- codec ---------- */

const enc = new TextEncoder();

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function sha256Hex(value, bytes = 16) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(String(value)));
  return [...new Uint8Array(digest).slice(0, bytes)]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ---------- origin policy ---------- */

/**
 * Only our own extension may call this. ALLOWED_ORIGINS is a comma-separated
 * env var of chrome-extension://<id> / moz-extension://<uuid> values.
 * Absent = allow any extension origin (dev only — set it in production).
 */
function originAllowed(origin, env) {
  if (!origin) return false;
  if (!/^(chrome|moz)-extension:\/\/[a-z0-9-]+$/i.test(origin)) return false;
  const list = String(env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.length === 0 || list.includes(origin);
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin"
  };
}

const json = (body, status, origin) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      ...corsHeaders(origin)
    }
  });

/* ---------- rate limit ---------- */

/** Per-key window counter. Degrades open if KV is unavailable. */
async function rateLimited(env, keyFp, ip) {
  if (!env.RL) return false;
  const bucket = `rl:${keyFp}:${Math.floor(Date.now() / (RL_WINDOW_S * 1000))}`;
  try {
    const seen = Number(await env.RL.get(bucket)) || 0;
    if (seen >= RL_MAX) return true;
    await env.RL.put(bucket, String(seen + 1), { expirationTtl: RL_WINDOW_S * 2 });
    // Track distinct IPs per key — sharing shows up here before seats do.
    await env.RL.put(`ip:${keyFp}:${await sha256Hex(ip, 8)}`, "1", { expirationTtl: 30 * 86400 });
    return false;
  } catch { return false; }
}

/* ---------- Dodo ---------- */

/**
 * Authoritative licence check. Validate is the same endpoint the extension can
 * reach, but calling it here means the answer reaches signing code the client
 * never touches. The secret key adds the customer record on top.
 */
async function dodoValidate(env, licenseKey, instanceId) {
  const base = env.DODO_MODE === "test"
    ? "https://test.dodopayments.com" : "https://live.dodopayments.com";
  const body = { license_key: licenseKey };
  if (instanceId) body.license_key_instance_id = instanceId;

  let res;
  try {
    res = await fetch(base + "/licenses/validate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(env.DODO_API_KEY ? { Authorization: `Bearer ${env.DODO_API_KEY}` } : {})
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DODO_TIMEOUT_MS)
    });
  } catch {
    return { branch: "service" };
  }

  if (res.status === 404) return { branch: "notfound" };
  if (res.status === 403) return { branch: "inactive" };
  if (res.status === 422) return { branch: "limit" };
  if (res.status >= 500) return { branch: "service" };
  if (!res.ok) return { branch: "badrequest" };

  let data = null;
  try { data = await res.json(); } catch { return { branch: "service" }; }

  // Only a literal true is a pass. Missing field is not consent.
  if (data && data.valid === true) {
    return { branch: "ok", email: (data.customer && data.customer.email) || "" };
  }
  return { branch: "invalid" };
}

/* ---------- seat ledger ---------- */

/**
 * Server-side device count. lib/dodo.js keeps a client registry for UX; this is
 * the copy that decides. Clearing extension storage does not reset it.
 */
async function claimSeat(env, keyFp, devFp) {
  if (!env.RL) return { ok: true, seats: 0 };
  const ledgerKey = `seats:${keyFp}`;
  try {
    const raw = await env.RL.get(ledgerKey, "json");
    const seats = (raw && typeof raw === "object" ? raw : {});
    const now = Date.now();

    if (!seats[devFp] && Object.keys(seats).length >= SEAT_LIMIT) {
      // Evict only genuinely idle seats; an active fleet must hit the wall.
      const stale = Object.entries(seats)
        .filter(([, t]) => now - Number(t) > TTL_MS)
        .sort((a, b) => Number(a[1]) - Number(b[1]));
      if (!stale.length) return { ok: false, seats: Object.keys(seats).length };
      delete seats[stale[0][0]];
    }

    seats[devFp] = now;
    await env.RL.put(ledgerKey, JSON.stringify(seats), { expirationTtl: 400 * 86400 });
    return { ok: true, seats: Object.keys(seats).length };
  } catch {
    return { ok: true, seats: 0 };   // KV down must not lock a paying user out
  }
}

/* ---------- signing ---------- */

let signingKey = null;

async function getSigningKey(env) {
  if (signingKey) return signingKey;
  const raw = Uint8Array.from(atob(String(env.SIGNING_KEY || "")), (c) => c.charCodeAt(0));
  signingKey = await crypto.subtle.importKey(
    "pkcs8", raw, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]
  );
  return signingKey;
}

async function mintToken(env, claims) {
  const payload = enc.encode(JSON.stringify(claims));
  const key = await getSigningKey(env);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, payload);
  return `LCT2.${b64url(payload)}.${b64url(sig)}`;
}

/* ---------- handler ---------- */

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      if (!originAllowed(origin, env)) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (!originAllowed(origin, env)) return new Response("forbidden", { status: 403 });
    if (request.method !== "POST") return json({ error: "method" }, 405, origin);

    const url = new URL(request.url);

    // ---------- trial registration ----------
    if (url.pathname === "/trial") {
      let body;
      try { body = await request.json(); } catch { return json({ error: "bad json" }, 400, origin); }

      const devFp = String((body && body.device) || "");
      if (!/^[a-f0-9]{16,64}$/.test(devFp)) return json({ error: "bad device" }, 400, origin);

      // Rate limit: prevent mass trial registration from one device
      if (env.RL) {
        const bucket = `trial-rl:${devFp}:${Math.floor(Date.now() / 864e5)}`;
        try {
          const seen = Number(await env.RL.get(bucket)) || 0;
          if (seen >= TRIAL_RL_MAX) return json({ error: "slow down" }, 429, origin);
          await env.RL.put(bucket, String(seen + 1), { expirationTtl: 86400 });
        } catch { /* KV down — degrade open */ }
      }

      // Check if this device already used a trial
      if (env.RL) {
        const trialKey = `trial:${devFp}`;
        try {
          const existing = await env.RL.get(trialKey, "json");
          if (existing && existing.startedAt) {
            // Already has a trial — return the existing one
            return json({ already: true, startedAt: existing.startedAt }, 200, origin);
          }
          // Register new trial
          const rec = { startedAt: Date.now(), device: devFp };
          await env.RL.put(trialKey, JSON.stringify(rec), { expirationTtl: Math.ceil(TRIAL_TTL_MS / 1000) + 86400 });
          return json({ ok: true, startedAt: rec.startedAt }, 201, origin);
        } catch {
          // KV unavailable — allow the trial client-side only
          return json({ ok: true, startedAt: Date.now(), kvDown: true }, 201, origin);
        }
      }
      return json({ ok: true, startedAt: Date.now() }, 201, origin);
    }

    if (url.pathname !== "/entitlement") return json({ error: "not found" }, 404, origin);

    let body;
    try { body = await request.json(); } catch { return json({ error: "bad json" }, 400, origin); }

    const licenseKey = String((body && body.license_key) || "");
    const devFp = String((body && body.device) || "");
    const instanceId = String((body && body.instance_id) || "").slice(0, 64);
    const clientTs = Number(body && body.ts) || 0;

    if (!/^[A-Za-z0-9._-]{8,64}$/.test(licenseKey)) return json({ error: "bad key" }, 400, origin);
    if (!/^[a-f0-9]{16,64}$/.test(devFp)) return json({ error: "bad device" }, 400, origin);

    // Reject replayed requests: the client sends a timestamp; if it is older
    // than MAX_CLOCK_SKEW_MS the request was either captured and replayed, or
    // the client's clock is wildly off. Both are reason to refuse.
    if (clientTs > 0) {
      const drift = Math.abs(Date.now() - clientTs);
      if (drift > MAX_CLOCK_SKEW_MS) return json({ error: "clock skew" }, 400, origin);
    }

    const keyFp = await sha256Hex(licenseKey);
    const ip = request.headers.get("CF-Connecting-IP") || "";

    if (await rateLimited(env, keyFp, ip)) return json({ error: "slow down" }, 429, origin);

    const check = await dodoValidate(env, licenseKey, instanceId);
    if (check.branch === "notfound" || check.branch === "invalid") return json({ error: "unknown licence" }, 404, origin);
    if (check.branch === "inactive") return json({ error: "licence inactive" }, 403, origin);
    if (check.branch !== "ok") return json({ error: "upstream" }, 503, origin);

    const seat = await claimSeat(env, keyFp, devFp);
    if (!seat.ok) return json({ error: "device limit reached", seats: seat.seats }, 422, origin);

    const now = Date.now();
    const token = await mintToken(env, {
      v: 2,
      sub: keyFp,
      dev: devFp,
      plan: "pro",
      feat: FEATURES,
      email: check.email || "",
      iat: now,
      exp: now + TTL_MS,
      jti: crypto.randomUUID()
    });

    return json({ token, exp: now + TTL_MS, seats: seat.seats }, 200, origin);
  }
};
