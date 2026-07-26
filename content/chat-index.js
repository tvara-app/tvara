/**
 * Long Chat Toolkit — provider conversation index.
 *
 * The host mounts only the recent tail, so the map used to be assembled by
 * walking its scroller to the top: minutes of the page yanking itself around
 * while somebody was trying to read it. The provider hands over the whole
 * conversation in one authenticated request the background already knows how to
 * make, and every message in it carries the id the DOM stamps as
 * data-message-id — so the map can be complete before the first paint, with the
 * viewport never moving.
 *
 * Every failure here is silent. No index simply means the map falls back to
 * what the host has mounted, which is where it started.
 */
(() => {
  "use strict";

  const cache = new Map();     // route -> { entries } | null
  const inflight = new Map();  // route -> Promise
  const routeId = () => location.hostname + location.pathname;

  const testHost = () => document.documentElement.hasAttribute("data-lct-virtual-history");

  function supported(adapter) {
    if (!adapter) return false;
    if (testHost()) return true;
    return adapter.id === "chatgpt" && adapter.convPath && adapter.convPath.test(location.pathname);
  }

  /**
   * The fixture publishes its index through the DOM, not a global: content
   * scripts run in an isolated world and cannot see the page's window.
   */
  function fixtureEntries() {
    const tag = document.getElementById("lct-fixture-index");
    if (!tag) return null;
    try {
      const parsed = JSON.parse(tag.textContent || "[]");
      return Array.isArray(parsed) && parsed.length ? parsed : null;
    } catch (_) { return null; }
  }

  function ask(force) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: "chat-index", host: location.hostname, path: location.pathname, force: !!force },
          (r) => { void chrome.runtime.lastError; resolve(r || null); }
        );
      } catch (_) { resolve(null); }    // extension context already invalidated
    });
  }

  /**
   * @param {object} adapter
   * @param {(entries: object[]) => void} onIndex called once per usable answer:
   *   first the archive's copy (instant, offline), then the provider's
   *   correction if the archived one was stale.
   */
  function load(adapter, onIndex) {
    const route = routeId();
    if (!supported(adapter)) return Promise.resolve(null);

    if (cache.has(route)) {
      const hit = cache.get(route);
      if (hit && onIndex) onIndex(hit.entries);
      return Promise.resolve(hit);
    }
    if (inflight.has(route)) return inflight.get(route);

    const fixture = testHost() ? fixtureEntries() : null;
    if (fixture) {
      const hit = { entries: fixture, source: "fixture" };
      cache.set(route, hit);
      if (onIndex) onIndex(fixture);
      return Promise.resolve(hit);
    }

    const run = (async () => {
      let res = await ask(false);
      if (routeId() !== route) return null;         // they moved on mid-flight
      let hit = null;
      if (res && res.status === "ok" && Array.isArray(res.entries) && res.entries.length) {
        hit = { entries: res.entries, source: res.source };
        cache.set(route, hit);
        if (onIndex) onIndex(res.entries);
      }
      // The archive answer is a cache, not the truth. Ask the provider for the
      // correction once the map has already painted — never before.
      if (!res || res.status !== "ok" || res.stale) {
        await idle();
        if (routeId() !== route) return hit;
        const fresh = await ask(true);
        if (routeId() !== route) return hit;
        if (fresh && fresh.status === "ok" && Array.isArray(fresh.entries) && fresh.entries.length) {
          hit = { entries: fresh.entries, source: fresh.source };
          cache.set(route, hit);
          if (onIndex) onIndex(fresh.entries);
        } else if (fresh && fresh.status === "gone") {
          cache.set(route, null);
          hit = null;
        }
      }
      if (!cache.has(route)) cache.set(route, hit);
      return hit;
    })().finally(() => inflight.delete(route));

    inflight.set(route, run);
    return run;
  }

  const idle = () => new Promise((resolve) => {
    if (self.requestIdleCallback) requestIdleCallback(() => resolve(), { timeout: 1200 });
    else setTimeout(resolve, 120);
  });

  /** Force the next load() for a route to go back to the source. */
  function forget(route) {
    cache.delete(route || routeId());
  }

  /** A branch switch invalidated what we seeded — re-ask the provider. */
  function refresh(adapter, onIndex) {
    forget();
    return load(adapter, onIndex);
  }

  self.LCTChatIndex = { load, forget, refresh, supported };
})();
