/**
 * Tvara background worker — one polite HTTP client: backoff, per-host slots, cooldowns, paging.
 *
 * Split out of bg.js. Loaded by bg.js via importScripts (Chrome) or listed
 * as a background script by tools/pack.mjs (Firefox). Either way this shares
 * ONE global scope with the rest of the worker: what is declared here is
 * callable from every other module, exactly as when this was one file.
 */
"use strict";

function parseRetryAfter(value) {
  if (!value) return 0;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, Math.min(secs, 3600) * 1000);
  const when = Date.parse(value);
  return Number.isFinite(when) ? Math.max(0, Math.min(when - Date.now(), 3600000)) : 0;
}

// Full jitter: without it every worker retries on the same tick and the burst
// that caused the 429 repeats exactly.
function backoffDelay(attempt, retryAfterMs) {
  const base = Math.min(30000, 1000 * 2 ** attempt);
  return Math.max(retryAfterMs, Math.round(base * (0.5 + Math.random() * 0.5)));
}

const hostState = new Map();
function hostEntry(host) {
  let s = hostState.get(host);
  if (!s) {
    s = { chain: Promise.resolve(), nextAt: 0, fgNextAt: 0, cooldownUntil: 0, consecutiveRate: 0,
          /* `trip` is the interval that was running when this host last refused
             us — the remembered threshold the decay may never go back below.
             Without it the ramp oscillates: 429, back off, decay all the way to
             the floor that caused it, 429 again, forever. TCP has had a name for
             this since 1988; there is no reason to rediscover it by hand. */
          interval: 0, trip: 0, tabOpen: false, activeAt: 0, trips: 0,
          windowAt: 0, used: 0,
          concurrency: 0, streak: 0 };
    hostState.set(host, s);
  }
  return s;
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ""; }
}

/* The PACING key, which includes the port. In the browser every provider is on
   :443, so this is the hostname and nothing changes. Under test six providers
   are served from one loopback address on six ports, and keyed by hostname
   alone they were ONE host sharing one hourly cap — so the later blocks ran
   against a budget the earlier ones had spent, and read as product bugs.
   Pacing is per origin authority. The ALLOWLIST is per host and stays that
   way: a port is not a permission. */
function paceOf(url) {
  try { return new URL(url).host; } catch { return ""; }
}

function policyFor(host) {
  return BG_HOST_POLICY[host] || { concurrency: 2, minIntervalMs: 700, listDelayMs: 800 };
}

/* How long this host currently wants between requests. The policy figure is a
   floor, never a ceiling: a host that has refused us keeps a longer one until
   it has answered cleanly for a while. */
function intervalFor(host) {
  const s = hostEntry(host);
  // The policy figure is where it STARTS, not where it is pinned.
  return Math.max(intervalFloor(host), s.interval || policyFor(host).minIntervalMs);
}

/* The fastest this host may ever be allowed to get.

   Until it has refused us once, the hard guard rail — a host answering cleanly
   has earned the speed, and holding it at a figure we invented is leaving the
   user's archive unfinished for no reason anyone can point at. After a refusal,
   three quarters of the rate that caused it, permanently: that is the
   difference between converging on the ceiling and oscillating through it. */
function intervalFloor(host) {
  const s = hostEntry(host);
  return s.trip ? Math.max(BG_MIN_INTERVAL_MS, Math.round(s.trip * 0.75)) : BG_MIN_INTERVAL_MS;
}

/* How many workers this host currently deserves. Read every iteration, not once
   at spawn: a 429 halves it mid-pass and the surplus workers stand down on
   their next turn instead of finishing a queue the host is already refusing. */
function targetConcurrency(host) {
  const s = hostEntry(host);
  const base = policyFor(host).concurrency;
  if (!s.concurrency) s.concurrency = base;
  return Math.max(1, Math.min(base * BG_RAMP_CEILING, s.concurrency));
}

// Serializes request starts per host so minIntervalMs holds across all workers.
/* `foreground` is one request for the conversation somebody has open, and it
   must not queue behind the circuit breaker. That cooldown is fifteen minutes
   long and it exists to stop the BULK sync hammering a provider — charging a
   reader's own chat for the background pass's sins is how "load the older
   messages" turned into a quarter of an hour of nothing. The polite minimum
   interval still applies, so this is a jump in the queue, not a free pass. */
/* When this host's hourly budget rolls over, or 0 while it still has one.
   Read BEFORE a pass starts, exactly as the 429 cooldown is: a pass that
   cannot send anything should say so in a second rather than discover it one
   stalled request at a time. */
function hostBudgetUntil(host) {
  const s = hostEntry(host);
  if (!s.windowAt || Date.now() - s.windowAt >= BG_HOUR_MS) return 0;
  return s.used >= BG_HOURLY_CAP ? s.windowAt + BG_HOUR_MS : 0;
}

function hostSlot(host, opts) {
  const s = hostEntry(host);
  // The pacing figure is intervalFor(host) now — what this host has earned —
  // not the static policy row, so nothing here reads the row directly.
  if (opts && opts.foreground) {
    /* The cooldown is the BACKFILL's punishment, not the reader's.

       This used to hold a foreground request back while the host was cooling,
       on the reasoning that answering a 429 by asking again earns a longer one.
       That is true of a retry loop and false of a person: one request, made
       because they opened a conversation, to the endpoint the site itself calls
       for that same conversation, is indistinguishable from using the site. And
       blocking it is not neutral — the index never arrives, so the map draws
       the four messages the host happens to have mounted out of a hundred, and
       the extension is worse than not being installed.

       Stopping the crawl is what protects the budget. Stopping the reader
       protects nothing and costs them the product. */
    /* Off the queue, but not unpaced. Clicking down a sidebar fires one of
       these per click and un-paced they arrive as a burst — a floor a quarter
       the background interval is imperceptible to a reader and is the
       difference between a burst and a stream. */
    /* Somebody is here. hostSlot()'s background branch reads this and stands
       the backfill down for BG_YIELD_MS — see the constant. */
    s.activeAt = Date.now();
    const soon = Math.max(0, s.fgNextAt - Date.now());
    s.fgNextAt = Date.now() + Math.round(intervalFor(host) / 4);
    /* OFF THE CHAIN, so it never queues behind the backfill.

       This used to join the same FIFO queue as the background pass and merely
       skip the cooldown floor, which meant the one request a reader is actually
       sitting in front of queued behind however many backfill workers were
       already in it — a dozen of them now — and then still paid the pacing
       interval on top. Seconds, for a single call to the endpoint the site
       itself makes, on the reader's own session. The extension was the slowest
       thing on the page.

       It still advances the clock, so the background pass stays polite behind
       it and the host sees no burst. */
    s.nextAt = Date.now() + intervalFor(host);
    return soon ? sleep(soon) : Promise.resolve();
  }
  const work = async () => {
    /* Yield to the reader. A foreground request in the last minute means they
       are on the site now, and the backfill has no deadline worth competing
       with that. */
    const yieldUntil = s.activeAt + BG_YIELD_MS;
    /* …and the hourly budget. Rolling window, reset when it has expired. */
    const now = Date.now();
    if (!s.windowAt || now - s.windowAt >= BG_HOUR_MS) { s.windowAt = now; s.used = 0; }
    const capUntil = s.used >= BG_HOURLY_CAP ? s.windowAt + BG_HOUR_MS : 0;
    const wait = Math.max(
      s.cooldownUntil - Date.now(),
      s.nextAt - Date.now(),
      yieldUntil - Date.now(),
      capUntil ? capUntil - Date.now() : 0,
      0
    );
    /* Refuse rather than sleep it out — see BG_SLOT_MAX_WAIT_MS. The caller
       already knows how to answer this: the pass reports the host as cooling
       down, keeps its resume alarm booked and ENDS, instead of parking the
       worker for the rest of the hour. Counted after the check, because
       nothing is sent when it fails. */
    if (wait > BG_SLOT_MAX_WAIT_MS) {
      throw new BgError("rate", "host budget spent", {
        retryAfterMs: wait, until: Date.now() + wait
      });
    }
    s.used++;
    if (wait > 0) await sleep(wait);
    /* ONE authority on the rate: intervalFor(), which is the figure this host
       has actually earned. The separate background floor that used to sit here
       only ever clamped that discovery, and protecting the reader is the yield
       rule above — which does that job properly. A tab of the site open is
       still worth a wider gap: they are one click from needing the budget. */
    s.nextAt = Date.now() + Math.max(
      intervalFor(host),
      s.tabOpen ? BG_TAB_OPEN_INTERVAL_MS : 0
    );
  };
  s.chain = s.chain.then(work, work);
  return s.chain;
}

async function noteRateLimit(host, retryAfterMs, attempt) {
  const s = hostEntry(host);
  s.consecutiveRate++;
  s.streak = 0;
  // Multiplicative decrease, on the FIRST refusal — not after three.
  const base = policyFor(host);
  s.concurrency = Math.max(1, Math.floor((s.concurrency || base.concurrency) / 2));
  // Remember the rate that failed BEFORE changing it — that is the threshold.
  s.trip = Math.max(s.trip, s.interval || base.minIntervalMs);
  // …and halve the RATE, which is the number the provider is actually counting.
  s.interval = Math.min(BG_INTERVAL_MAX_MS, Math.max(base.minIntervalMs, (s.interval || base.minIntervalMs) * 2));
  /* The provider's own number wins outright and nothing of ours is added to
     it — backoffDelay() used to take Retry-After as a FLOOR and then round it
     up with our own exponential curve, so a host asking for 2 seconds was given
     up to 30. Asked for a number, wait exactly that. */
  const delay = retryAfterMs > 0 ? retryAfterMs : backoffDelay(attempt, 0);
  // Cool the whole host, not the one worker: otherwise the other workers each
  // collect their own 429 before any of them notices.
  s.cooldownUntil = Math.max(s.cooldownUntil, Date.now() + delay);
  if (s.consecutiveRate >= BG_RATE_TRIP) {
    /* Three in a row is this host telling us to stop, whether or not it names a
       number. Stop — for fifteen minutes, and for twice as long again each time
       it happens, up to six hours. The reader's own session is sharing this
       budget and it is the one that matters. */
    s.trips++;
    const named = retryAfterMs > 0 ? retryAfterMs : 0;
    const escalated = Math.min(BG_HOST_COOLDOWN_MAX_MS,
      BG_HOST_COOLDOWN_MS * Math.pow(2, Math.min(5, s.trips - 1)));
    s.cooldownUntil = Math.max(s.cooldownUntil, Date.now() + Math.max(named, escalated));
    await persistCooldown(host, s.cooldownUntil);
    return true;   // circuit open
  }
  return false;
}

function noteOk(host) {
  const s = hostEntry(host);
  const base = policyFor(host).concurrency;
  s.consecutiveRate = 0;
  s.streak++;
  /* A long clean run means the last stop did its job. Forgive one escalation
     step so a single bad afternoon does not cost six hours forever. */
  if (s.trips && s.streak >= BG_RAMP_AFTER * 4) s.trips--;
  if (!s.concurrency) s.concurrency = base;
  if (s.streak >= BG_RAMP_AFTER) {
    s.streak = 0;
    s.concurrency = Math.min(base * BG_RAMP_CEILING, s.concurrency + 1);
    /* Decay, not a reset. A host that refused once gets its speed back over
       several clean runs rather than in one step — coming straight back to the
       rate that earned the 429 is how a client oscillates into a longer one. */
    const floor = intervalFloor(host);
    if (s.interval > floor) s.interval = Math.max(floor, Math.round(s.interval * 0.8));
  }
}

/* The COOLDOWN and the learned rate, together.

   An MV3 worker is reclaimed about thirty seconds after it goes idle, and
   hostState is a module Map — so everything AIMD had learned about a host was
   thrown away several times an hour and the next pass started at the floor and
   climbed straight back into the same refusal. An adaptive limiter with no
   memory is not adaptive; it is a loop. This is the memory. */
async function persistCooldown(host, until) {
  try {
    const s = hostEntry(host);
    const { [BG_HOST_COOLDOWN]: raw } = await chrome.storage.local.get(BG_HOST_COOLDOWN);
    const map = (raw && typeof raw === "object") ? raw : {};
    map[host] = { u: until, i: s.interval || 0, t: s.trip || 0 };
    await chrome.storage.local.set({ [BG_HOST_COOLDOWN]: map });
  } catch { /* best effort */ }
}

// A respawned worker has no in-memory cooldown; without this it re-hammers a
// host it was just throttled by.
async function loadCooldown(host) {
  try {
    const { [BG_HOST_COOLDOWN]: raw } = await chrome.storage.local.get(BG_HOST_COOLDOWN);
    const held = raw && typeof raw === "object" ? raw[host] : null;
    // Records written before this carried the rate are plain numbers.
    const until = Number(held && typeof held === "object" ? held.u : held) || 0;
    const s = hostEntry(host);
    if (held && typeof held === "object") {
      s.trip = Math.max(s.trip || 0, Number(held.t) || 0);
      s.interval = Math.max(s.interval || 0, Number(held.i) || 0);
    }
    if (until > Date.now()) s.cooldownUntil = Math.max(s.cooldownUntil, until);
    return until;
  } catch { return 0; }
}

/* The only hosts this worker may call with the user's cookies, read from the
   manifest rather than typed a second time. That keeps it honest in both
   directions: it is exactly what the user granted at install, it cannot drift
   from host_permissions, and it needs no dev-only exception because
   tools/pack.mjs strips the localhost entries out of the shipped build. */
const BG_ALLOWED_HOSTS = (() => {
  const out = new Set();
  try {
    for (const pattern of chrome.runtime.getManifest().host_permissions || []) {
      const m = /^[a-z*]+:\/\/([^/*]+)/i.exec(pattern);
      if (m && m[1]) out.add(m[1].toLowerCase());
    }
  } catch { /* a manifest we cannot read is not a reason to call anywhere */ }
  return out;
})();

async function bgFetch(url, opts = {}) {
  const host = hostOf(url);
  const pace = paceOf(url);
  /* Two guards that cost nothing and close the same class of hole.

     A conversation id from a provider's own listing is interpolated into some
     of these URLs (`this.base + conv + "/load-responses"`), and a value like
     "@evil.com/" would re-point the whole URL at another host: `new URL()`
     reads everything before the "@" as credentials. Checking the PARSED host
     against the allowlist catches that whatever the string looked like.

     And redirects were followed by default while credentials were included.
     lib/dodo.js already refuses to follow one, with a comment saying why — a
     redirect off-host means a stranger's response gets parsed as a provider's
     and written into the archive. This is the same rule, applied to the path
     that actually carries the user's history. */
  if (!BG_ALLOWED_HOSTS.has(host)) {
    throw new BgError("net", `refusing to call ${host || "an unparseable URL"}`);
  }
  /* No Cookie header: it is a forbidden request header, so fetch() drops any
     value set here. `credentials: "include"` below is what actually carries the
     provider session, and it needs no chrome.cookies permission. */
  const headers = {
    Accept: "application/json, text/plain, */*",
    ...(opts.headers || {})
  };
  /* Per-call ceilings. The history pass is worth four attempts and twenty
     seconds a piece — it is the archive, and it can take its time. An allowance
     reading is not: it is a number on a panel the user is looking at right now,
     and a provider that has not answered in a few seconds should leave a ring
     unfilled rather than hold the whole dial. */
  const attempts = Math.max(1, Number(opts.attempts) || BG_FETCH_ATTEMPTS);
  const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || BG_FETCH_TIMEOUT_MS);
  const init = { ...opts };
  delete init.attempts;
  delete init.timeoutMs;

  let lastRate = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    await hostSlot(pace, opts);
    let r;
    const timeoutCtl = new AbortController();
    const timeoutTimer = setTimeout(() => timeoutCtl.abort(), timeoutMs);
    try {
      r = await fetch(url, {
        ...init, headers, credentials: "include",
        redirect: "error",            // never off-host with the user's session
        referrerPolicy: "no-referrer",
        signal: timeoutCtl.signal
      });
    } catch (_) {
      if (attempt === attempts - 1) throw new BgError("net", "network unavailable");
      await sleep(backoffDelay(attempt, 0));
      continue;
    } finally {
      clearTimeout(timeoutTimer);
    }
    if (r.status === 429 || (r.status === 503 && r.headers.get("Retry-After"))) {
      const retryAfterMs = parseRetryAfter(r.headers.get("Retry-After"));
      const circuitOpen = await noteRateLimit(pace, retryAfterMs, attempt);
      lastRate = new BgError("rate", "rate-limited", { retryAfterMs, circuitOpen });
      if (circuitOpen) throw lastRate;
      continue;   // retry in place so the caller's slot isn't burned
    }
    if (r.status === 401 || r.status === 403) throw new BgError("auth", "unauthorized", { status: r.status });
    if (r.status === 404 || r.status === 410) throw new BgError("gone", "http " + r.status, { status: r.status });
    if (!r.ok) {
      if (r.status >= 500 && attempt < attempts - 1) { await sleep(backoffDelay(attempt, 0)); continue; }
      // The status rides along because not every provider spells "this
      // conversation is gone" as a 404 — Perplexity says 400 — and an adapter
      // can only reclassify what it can see.
      throw new BgError("net", "http " + r.status, { status: r.status });
    }
    noteOk(pace);
    return r;
  }
  throw lastRate || new BgError("net", "request failed");
}

async function bgJson(response) {
  // Providers occasionally return their HTML application shell or sign-in
  // page from an otherwise successful request. Parse the body ourselves so
  // the sync UI receives a useful provider error, never a raw JSON exception.
  const text = await response.text();
  try { return JSON.parse(text); }
  catch {
    throw new Error(/^\s*</.test(text) ? "unexpected provider response" : "invalid provider response");
  }
}

/**
 * Walk a provider's conversation list page by page.
 *
 * Pagination on these endpoints is undocumented and differs between builds, so
 * every exit degrades safely rather than looping or overclaiming:
 *   - server ignored `limit` and returned everything → that IS the full set
 *   - server ignored `offset` and repeated a page → stop, report incomplete
 *   - short page → genuine end
 * `complete` is only ever true when the walk actually reached the end, because
 * the caller uses it to decide whether the watermark may advance.
 */
async function walkScheme(adapter, opts, scheme) {
  const { pageSize, sinceMs, progress, fetchPage, toMeta } = opts;
  const delayMs = opts.delayMs != null ? opts.delayMs : policyFor(adapter.host).listDelayMs;
  const metas = [];
  const seen = new Set();
  let complete = false, ordered = true, previous = Infinity, hitOld = false, paged = false;
  /* "The provider listed conversations and we understood none of them" is a
     different fact from "the account is empty", and it is the one that hides.
     An adapter whose id field gets renamed produces metas with no id, every one
     is skipped here, and the walk ends looking exactly like a clean listing of
     an empty account. Counted so the caller can tell the two apart. */
  let sawItems = 0, namedItems = 0;

  for (let page = 0; page < BG_LIST_MAX_PAGES; page++) {
    if (page) await sleep(delayMs);
    let items;
    try { items = await fetchPage(scheme.param(page, pageSize), pageSize); }
    catch (error) {
      if (error && (error.kind === "auth" || error.kind === "rate")) throw error;
      break;   // this scheme's params upset the endpoint — try another
    }
    if (!items.length) { complete = true; break; }

    let fresh = 0;
    for (const it of items) {
      sawItems++;
      const meta = toMeta(it);
      if (!meta || !meta.id) continue;
      namedItems++;
      if (seen.has(meta.id)) continue;
      seen.add(meta.id);
      fresh++;
      if (meta.updatedAt > previous) ordered = false;
      previous = meta.updatedAt;
      if (sinceMs && meta.updatedAt <= sinceMs) { hitOld = true; continue; }
      metas.push(meta);
    }
    progress(metas.length, 0, `Listing chats… ${metas.length}`);

    // Server ignored `limit` and handed back the whole list — that IS the end.
    if (page === 0 && items.length > pageSize) { complete = true; break; }
    if (!fresh) break;                                   // paging param ignored
    if (page > 0) paged = true;                          // it genuinely advanced
    if (items.length < pageSize) { complete = true; break; }
    if (hitOld && ordered) { complete = true; break; }    // newest-first, past the watermark
  }
  metas.sort((a, b) => b.updatedAt - a.updatedAt);
  return { metas, complete, paged, unreadable: sawItems > 0 && namedItems === 0 };
}

async function readScheme(host) {
  try {
    const { [BG_PAGE_SCHEME]: raw } = await chrome.storage.local.get(BG_PAGE_SCHEME);
    const entry = raw && typeof raw === "object" ? raw[host] : null;
    if (!entry) return null;
    if (!entry.id && Date.now() - (entry.at || 0) > BG_SCHEME_RETRY_MS) return null;
    return entry;
  } catch { return null; }
}

async function rememberScheme(host, id) {
  try {
    const { [BG_PAGE_SCHEME]: raw } = await chrome.storage.local.get(BG_PAGE_SCHEME);
    const map = raw && typeof raw === "object" ? raw : {};
    map[host] = { id: id || null, at: Date.now() };
    await chrome.storage.local.set({ [BG_PAGE_SCHEME]: map });
  } catch { /* best effort */ }
}

/**
 * Walk a provider's conversation list, discovering how it paginates.
 *
 * Only Claude documents its scheme (limit/offset). For the others the walk
 * tries each candidate until one actually advances past page one, then caches
 * the winner per host so later passes go straight to it. Every exit degrades
 * safely: a scheme that is ignored, rejected, or unsupported yields at most one
 * page and `complete: false`, so the caller never advances the watermark past
 * chats it did not see.
 */
async function pageThrough(adapter, opts) {
  const schemes = opts.schemes || BG_PAGE_SCHEMES;
  const known = opts.noCache ? null : await readScheme(adapter.host);

  // Already established that this endpoint cannot page: take one page and stop
  // rather than re-probing every pass.
  if (known && !known.id) return walkScheme(adapter, opts, schemes[0]);

  const order = known
    ? schemes.filter((s) => s.id === known.id).concat(schemes.filter((s) => s.id !== known.id))
    : schemes;

  let best = null;
  for (const scheme of order) {
    const attempt = await walkScheme(adapter, opts, scheme);
    if (!best || attempt.metas.length > best.metas.length) best = attempt;
    if (attempt.paged) {
      // Includes re-discovery: a cached scheme that stopped working falls
      // through to the remaining candidates rather than giving up.
      if (!opts.noCache && (!known || known.id !== scheme.id)) await rememberScheme(adapter.host, scheme.id);
      return attempt;
    }
    if (attempt.complete) return attempt;   // one page held the whole history
  }
  if (!opts.noCache) await rememberScheme(adapter.host, null);
  return best || { metas: [], complete: false, paged: false, unreadable: false };
}
