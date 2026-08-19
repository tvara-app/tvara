/**
 * Tvara — product constants.
 *
 * Every outward-facing URL lives here and nowhere else, so a link can never
 * drift between the popup, the Recall page and the welcome screen.
 *
 * BUY deliberately points at our own pricing page instead of straight at the
 * payment provider. A checkout URL is the one string most likely to change —
 * new provider, new product id, a launch discount — and a hard-coded one would
 * need a fresh store review (days) to fix. The pricing page is ours and updates
 * in seconds; the extension never has to know who takes the money.
 *
 * Loaded in: popup, recall page, welcome page, and bg.js via importScripts.
 * Must not touch chrome.* at load time — test harnesses load it bare.
 */
(() => {
  "use strict";

  const SITE = "https://tharuntejandhe.github.io/tvara/";

  const P = {
    SITE,
    BUY: SITE + "#buy",
    HELP: SITE + "#faq",
    DEVICES: SITE + "#devices",
    PRIVACY: SITE + "#privacy",
    SOURCE: "https://github.com/Tharuntejandhe/tvara",
    SUPPORT_EMAIL: "tharuntejandhe@gmail.com",

    /* ---------- the price ----------
       ONE definition. It used to be typed into seventeen files, which is a
       promise to disagree with itself the first time it changes — and a page
       saying one price next to a checkout charging another is the kind of
       mismatch that produces refunds, not sales.
       Everything the extension shows reads this; the pricing page carries its
       own copy (it is a static site, deployed separately) and preflight fails
       the build if the two ever disagree. */
    PRICE: "$3",
    PRICE_NUM: 3,

    /**
     * Fill every price into a page at load. Markup carries the SENTENCE and
     * this supplies the number:
     *
     *   <button data-price="Get Pro — {price} once, forever"></button>
     *
     * so the copy stays where a person editing copy would look for it, and the
     * figure cannot be stale anywhere.
     */
    applyTo(root) {
      const doc = root || document;
      for (const el of doc.querySelectorAll("[data-price]")) {
        el.textContent = String(el.getAttribute("data-price"))
          .replace(/\{price\}/g, P.PRICE);
      }
    },

    /**
     * The store page for THIS install, derived from the id the browser gave us
     * — so it is right the moment we publish and needs no constant to update.
     *
     * `update_url` is present only when the copy was installed from a store;
     * an unpacked dev build returns null rather than a link to a 404.
     */
    storeUrl() {
      try {
        const mf = chrome.runtime.getManifest();
        if (!mf || !mf.update_url) return null;
        const id = chrome.runtime.id;
        if (!id) return null;
        return /microsoft|edge/i.test(mf.update_url)
          ? `https://microsoftedge.microsoft.com/addons/detail/${id}`
          : `https://chromewebstore.google.com/detail/${id}/reviews`;
      } catch { return null; }
    }
  };

  Object.freeze(P);
  if (typeof self !== "undefined") self.LCTProduct = P;
  if (typeof module !== "undefined" && module.exports) module.exports = P;
})();
