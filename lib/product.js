/**
 * Tvara — product constants.
 *
 * Every outward-facing URL lives here and nowhere else, so a link can never
 * drift between the popup, the Recall page and the diagnostics pages.
 *
 * There is deliberately NO buy URL here any more.
 *
 * It used to be our own pricing page, which was already better than a hard-coded
 * checkout link: a payment URL is the string most likely to change — new
 * provider, new product id, a launch discount — and changing a constant in a
 * shipped extension costs a store review. Pointing at a page we control made
 * that an edit instead of a release.
 *
 * It is now not a URL at all. The popup asks the issuer to open a checkout
 * session (POST /checkout) and opens what it is handed, so the extension knows
 * neither the price, nor the product, nor who takes the money — and the licence
 * comes back over the same device proof as everything else instead of in a
 * redirect URL. See the checkout section of server/entitlement-worker.js.
 *
 * Loaded in: popup, recall page, diag pages, and bg.js via importScripts.
 * Must not touch chrome.* at load time — test harnesses load it bare.
 */
(() => {
  "use strict";

  const SITE = "https://tvara-app.github.io/";

  const P = {
    SITE,
    HELP: SITE + "#faq",
    DEVICES: SITE + "#devices",
    PRIVACY: SITE + "#privacy",
    SUPPORT_EMAIL: "tvara.exten@gmail.com",

    supportMailUrl(subject = "Tvara support") {
      const body = [
        "Hi Tvara team,",
        "",
        "I need help with my Tvara install.",
        "",
        "Please can you take a look?",
        ""
      ].join("\n");
      const params = new URLSearchParams({
        view: "cm",
        fs: "1",
        to: P.SUPPORT_EMAIL,
        from: P.SUPPORT_EMAIL,
        su: subject,
        body
      });
      return `https://mail.google.com/mail/?${params.toString()}`;
    },

    /* ---------- the price ----------
       ONE definition. It used to be typed into seventeen files, which is a
       promise to disagree with itself the first time it changes — and a page
       saying one price next to a checkout charging another is the kind of
       mismatch that produces refunds, not sales.
       Everything the extension shows reads this; the pricing page carries its
       own copy (it is a static site, deployed separately) and preflight fails
       the build if the two ever disagree. */
    PRICE: "$1",
    PRICE_NUM: 1,

    /**
     * Fill every price into a page at load. Markup carries the SENTENCE and
     * this supplies the number:
     *
     *   <button data-price="Get Pro · {price} once, forever"></button>
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

    /* The only hosts a stored record may send someone to. One list: it used to
       be typed out in popup.js, recall-page.js and content/recall.js with a
       comment in each asking the next person to keep all three identical. */
    CHAT_HOSTS: Object.freeze([
      "chatgpt.com", "chat.openai.com", "claude.ai",
      "chat.deepseek.com", "grok.com", "www.perplexity.ai", "gemini.google.com"
    ]),

    /**
     * A stored record's host and path as a URL to open, or null to refuse.
     *
     * The host was checked against the allowlist and the two halves were then
     * CONCATENATED, which the allowlist does not survive. A record's path is a
     * length clamp, not a validated field — deliberately, because dropping a
     * malformed-but-honest record at write time loses the user's own history —
     * so a page can archive itself with a path of "@evil.example/", and
     * "https://claude.ai" + "@evil.example/" is a link to evil.example with
     * claude.ai as its userinfo. Resolving the path AGAINST the host and
     * re-checking the origin is what makes the allowlist mean what it says.
     */
    chatUrl(host, path) {
      const name = String(host || "");
      if (!P.CHAT_HOSTS.includes(name)) return null;
      const base = "https://" + name;
      let url;
      try { url = new URL(String(path || "/"), base + "/"); } catch { return null; }
      if (url.origin !== base) return null;
      return url.href;
    },

    /**
     * The plan chip. ONE definition — it lived twice, in popup.js and
     * recall-page.js, character for character, which is two surfaces free to
     * disagree about one licence.
     *
     * A purchase and a trial both unlock everything, so these used to differ by
     * pill fill alone. Pro carries the brand accent and a verified mark, and
     * nothing else on any surface is allowed that fill.
     *
     * Built from nodes rather than a template string so textContent stays
     * exactly "Pro" / "Trial" / "Free": an SVG child contributes no text, a
     * stray space would, and the store screenshot harness compares untrimmed.
     */
    paintBadge(el, pro, trialActive) {
      if (!el) return;
      el.replaceChildren();
      if (pro) {
        const NS = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(NS, "svg");
        svg.setAttribute("viewBox", "0 0 16 16");
        svg.setAttribute("aria-hidden", "true");
        const path = document.createElementNS(NS, "path");
        path.setAttribute("d", "M3.6 8.5l2.9 2.9 5.9-6.1");
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", "currentColor");
        path.setAttribute("stroke-width", "2.8");
        path.setAttribute("stroke-linecap", "round");
        path.setAttribute("stroke-linejoin", "round");
        svg.appendChild(path);
        el.appendChild(svg);
      }
      el.appendChild(document.createTextNode(pro ? "Pro" : trialActive ? "Trial" : "Free"));
      el.className = "badge " + (pro ? "pro" : trialActive ? "trial" : "free");
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
