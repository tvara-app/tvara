/**
 * Tvara, activate the licence on the page the buyer lands on.
 *
 * The gap this closes: someone pays, and then has to find a key in an email,
 * find the extension icon, open the popup, and paste. Four steps between paying
 * and having the thing they paid for, and every one of them is somewhere a
 * person gives up and asks for a refund instead.
 *
 * Dodo appends the key to the return URL when the product has licence keys
 * enabled, so by the time this page loads the key is already here. If Tvara is
 * installed, there is nothing left to ask the buyer to do.
 *
 * This runs ONLY on our own post-purchase page, declared as a single exact
 * match in the manifest. It reads a key that our own payment provider put
 * there, hands it to the worker, and reports what happened. It never reads
 * anything else on the page and never runs anywhere else.
 */
(() => {
  "use strict";

  /* The key can be in the query string, which the page scrubs out of the
     address bar as soon as it has read it, or in the element the page put it
     in. The URL is read first because at document_idle the scrub may already
     have happened; the element is the fallback that survives it. */
  function findKey() {
    try {
      const q = new URLSearchParams(location.search);
      const fromUrl = q.get("license_key") || q.get("licence_key") || q.get("key") || "";
      // Dodo comma-separates multiple keys; one product, one key, take the first.
      if (fromUrl) return fromUrl.split(",")[0].trim();
    } catch { /* no search string */ }
    const el = document.getElementById("key");
    return el ? (el.textContent || "").trim() : "";
  }

  function say(state, text, note) {
    const box = document.getElementById("auto-activate");
    if (!box) return;
    box.hidden = false;
    box.className = "auto " + state;
    box.textContent = text;
    if (note) {
      const small = document.createElement("small");
      small.textContent = note;
      box.appendChild(small);
    }
  }

  async function run() {
    const key = findKey();
    if (!key || key.length > 200) return;          // nothing to do, stay silent

    say("working", "Activating your licence…");

    let res = null;
    try {
      res = await new Promise((resolve) => {
        let done = false;
        const finish = (v) => { if (!done) { done = true; resolve(v); } };
        setTimeout(() => finish(null), 25000);
        chrome.runtime.sendMessage({ type: "license-activate", key }, (r) => {
          void chrome.runtime.lastError;
          finish(r || null);
        });
      });
    } catch { /* extension reloading */ }

    if (res && res.ok) {
      say("ok", "Pro is active on this device.",
        "Nothing else to do. Your key is in your email if you ever need it again.");
      return;
    }

    /* Everything below is a real state a buyer can be in, and each one says
       what to do next. "Something went wrong" is not an instruction. */
    const reason = (res && res.reason) || "unreachable";
    if (reason === "limit" || (res && res.seats)) {
      say("warn", "This licence is already on five devices.",
        "Open the Tvara popup, choose Devices, and release one. Your purchase is fine.");
    } else if (reason === "revoked") {
      say("warn", "The payment provider does not recognise this licence yet.",
        "It can take a moment after payment. Reload this page, or paste the key into the popup.");
    } else if (reason === "entitlement") {
      say("warn", "Activated, but the licence server did not answer.",
        "Pro unlocks by itself once you are back online. Nothing to redo.");
    } else if (reason === "bad-key") {
      say("warn", "That key was not readable.",
        "Copy it from your purchase email and paste it into the Tvara popup.");
    } else {
      // Includes "extension not installed", which is the common case and is
      // not an error: the page already tells them to install it.
      say("idle", "Install Tvara, then paste the key above into its popup.",
        "The extension activates automatically here once it is installed.");
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run, { once: true });
  } else {
    run();
  }
})();
