/**
 * Long Chat Toolkit — safe chrome.storage wrapper.
 * When the extension is updated/reloaded, orphaned content scripts keep
 * running in open tabs but every chrome.* call throws ("Extension context
 * invalidated"). Fail closed, once, quietly — features degrade to
 * non-persistent instead of spamming the console forever.
 */
(() => {
  "use strict";

  let dead = false;

  self.LCTStore = {
    async get(keys) {
      if (dead) return {};
      try {
        return await chrome.storage.local.get(keys);
      } catch (_) {
        dead = true;
        return {};
      }
    },
    async set(obj) {
      if (dead) return;
      try {
        await chrome.storage.local.set(obj);
      } catch (_) {
        dead = true;
      }
    },
    /**
     * Read a key from chrome.storage.sync, falling back to the local mirror.
     * Sync is the copy that follows the profile to another browser; local is
     * the copy that survives sync being full, disabled, or signed out. Neither
     * is authoritative on its own, so callers merge both.
     */
    async getBoth(key) {
      if (dead) return { synced: undefined, local: undefined };
      let synced, local;
      try { synced = (await chrome.storage.sync.get(key))[key]; } catch (_) { /* unavailable */ }
      try { local = (await chrome.storage.local.get(key))[key]; }
      catch (_) { dead = true; }
      return { synced, local };
    },

    /**
     * Write local first (it cannot fail on quota the way sync can), then
     * mirror. `syncValue` lets the caller ship a trimmed copy: sync caps items
     * at 8KB, and losing the whole write to quota is worse than losing detail.
     */
    async setBoth(key, value, syncValue) {
      if (dead) return;
      try { await chrome.storage.local.set({ [key]: value }); }
      catch (_) { dead = true; return; }
      try { await chrome.storage.sync.set({ [key]: syncValue === undefined ? value : syncValue }); }
      catch (_) { /* quota/offline — the local copy still holds */ }
    },

    get alive() {
      return !dead;
    }
  };
})();
