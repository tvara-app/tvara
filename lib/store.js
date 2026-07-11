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
    get alive() {
      return !dead;
    }
  };
})();
