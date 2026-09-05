/**
 * Tvara background worker — which account a host is signed in as, hashed and cached.
 *
 * Split out of bg.js. Loaded by bg.js via importScripts (Chrome) or listed
 * as a background script by tools/pack.mjs (Firefox). Either way this shares
 * ONE global scope with the rest of the worker: what is declared here is
 * callable from every other module, exactly as when this was one file.
 */
"use strict";

/* ===================== who is signed in, for a content script ===============
 *
 * Usage counting is per ACCOUNT because the limit is per account — that is the
 * whole reason people keep a second one. A page therefore has to know which
 * account it is looking at before it can count anything, and it must not pay a
 * provider round trip to find out on every message sent.
 *
 * So the worker answers, and caches: one handshake per host per TTL, shared by
 * every tab. A page on a provider we do not sync (no adapter — Gemini) supplies
 * its own hint from the URL or the page chrome, which is salted and hashed here
 * exactly like a provider id, so the same rule holds everywhere: raw account
 * identifiers are never stored.
 *
 * The two paths are alternatives, never a fallback for one another: they salt
 * different identities, so the same person would tag as two accounts depending
 * on which one answered. A host with an adapter is therefore identified by the
 * adapter or not at all — a failed handshake yields an empty tag and the page
 * counts per host, which is what it did before accounts existed.
 */

const ACCT_CACHE_TTL = 5 * 60 * 1000;
const acctCache = new Map();      // host -> { at, value }

async function accountForHost(host, hint = "") {
  const key = host + "|" + hint;
  const hit = acctCache.get(key);
  if (hit && Date.now() - hit.at < ACCT_CACHE_TTL) return hit.value;

  const adapter = BG_ADAPTERS.find((a) => a.host === host);
  let value = { acct: "", label: "", ordinal: 0, plan: "", identified: false };

  /* Prefer whichever source can actually name the account, not whichever is
     nearer. An adapter flagged `namesAccount: false` has no endpoint that says
     who is signed in, so every account on that host collapses to one
     device-level tag — while the page, looking at the account switcher or the
     /u/N seat, can tell two of them apart. Gemini is the case that makes this
     matter: two Google accounts really are open side by side in one profile,
     and a shared tag counts both against one limit. It also saves the prepare()
     round trip we would only discard. */
  const preferHint = !!hint && (!adapter || adapter.namesAccount === false);

  /* Nothing to check the hint against here — but a hint is still stable per
     account, which is all a usage tally needs. */
  const fromHint = async () => {
    const platformId = PAGE_PLATFORMS[host] || host;
    const acct = tagOfKey(await identityCheckpointKey({ id: platformId }, "hint:" + hint));
    const meta = await noteAccount(platformId, acct, { handle: hint, identified: false });
    return {
      acct, label: (meta && meta.label) || "", ordinal: (meta && meta.ordinal) || 1,
      plan: "", identified: false
    };
  };

  try {
    if (preferHint) {
      value = await fromHint();
    } else if (adapter) {
      try {
        const ctx = await adapter.prepare();
        const acct = await accountTag(adapter, ctx);
        const meta = await noteAccount(adapter.id, acct, {
          handle: ctx.handle, plan: ctx.plan, identified: ctx.identified !== false
        });
        value = {
          acct, label: (meta && meta.label) || "", ordinal: (meta && meta.ordinal) || 1,
          plan: (meta && meta.plan) || "", identified: ctx.identified !== false
        };
      } catch (error) {
        /* The adapter could not answer — the host permission was declined, the
           session lapsed, the provider changed shape. The two paths salt
           different identities, so this is a FALLBACK and never an alternative:
           preferring the hint while the adapter still works would tag the same
           person twice. Here the choice is the hint or nothing, and Gemini is
           the case that makes it matter — two Google accounts really are open
           side by side, and per-host counting cannot tell them apart. */
        if (!hint) throw error;
        value = await fromHint();
      }
    } else if (hint) {
      value = await fromHint();
    }
  } catch {
    // Signed out, offline, or the provider changed shape. An empty tag is a
    // valid answer: the page falls back to counting per host, which is what it
    // did before accounts existed.
    value = { acct: "", label: "", ordinal: 0, plan: "", identified: false };
  }
  acctCache.set(key, { at: Date.now(), value });
  return value;
}

// Hosts we count usage on but do not sync from. Keyed here so a usage tally and
// a sync checkpoint can never disagree about what a platform is called.
const PAGE_PLATFORMS = {
  "gemini.google.com": "gemini",
  "www.perplexity.ai": "perplexity",
  "chatgpt.com": "chatgpt",
  "chat.openai.com": "chatgpt",
  "claude.ai": "claude",
  "chat.deepseek.com": "deepseek",
  "grok.com": "grok"
};
