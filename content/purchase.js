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

  function activate(key) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      setTimeout(() => finish(null), 25000);
      try {
        chrome.runtime.sendMessage({ type: "license-activate", key }, (r) => {
          void chrome.runtime.lastError;
          finish(r || null);
        });
      } catch { finish(null); }                    // extension reloading
    });
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /* The licence is created asynchronously after the payment clears, so a fast
     redirect can arrive before it exists and the issuer answers "unknown
     licence". That is a race, not a failure, and it used to be handed to the
     buyer as "reload this page" — a manual step, on the one page where nobody
     should have to do anything, in the seconds right after paying.
     Four tries over ~15s covers it. Anything still unknown after that is a real
     problem and gets the message it always did. */
  const RETRY_MS = [2000, 4000, 8000];

  async function run() {
    const key = findKey();
    if (!key || key.length > 200) return;          // nothing to do, stay silent

    say("working", "Activating your licence…");

    let res = await activate(key);
    for (let i = 0; i < RETRY_MS.length; i++) {
      // Only the not-yet-issued branch is worth waiting on. A seat limit, a bad
      // key or a wrong clock will answer exactly the same in eight seconds.
      const notYet = res && !res.ok && res.reason === "revoked";
      if (!notYet) break;
      say("working", "Confirming your purchase with the payment provider…");
      await wait(RETRY_MS[i]);
      res = await activate(key);
    }

    if (res && res.ok) {
      say("ok", "Pro is active on this device.",
        "Nothing else to do. Your key is in your email if you ever need it again.");
      return;
    }

    /* Everything below is a real state a buyer can be in, and each one says
       what to do next. "Something went wrong" is not an instruction.

       Every person reading these has ALREADY PAID. The distance between a
       precise next step and a vague apology is the distance between a support
       email and a chargeback, so no branch here is allowed to guess. */
    const reason = (res && res.reason) || "unreachable";
    const branch = (res && res.branch) || "";

    if (reason === "limit" || (res && res.seats)) {
      say("warn", "This licence is already on five devices.",
        "Open the Tvara popup, choose Devices, and release one. Your purchase is fine.");
    } else if (reason === "revoked") {
      say("warn", "The payment provider still does not recognise this licence.",
        "We waited and retried. Reload this page in a minute, or paste the key into the popup. Your payment went through — email tvara.exten@gmail.com with the key if it keeps saying this.");
    } else if (branch === "clockskew") {
      /* Not a licence problem at all, and it is the one failure here the buyer
         can fix in thirty seconds — but only if we say so. The issuer refuses
         requests more than five minutes off to stop replay, and a machine with
         a wrong clock trips it on every attempt, forever. */
      say("warn", "Your device's clock is too far out to verify the licence.",
        "Set the date and time to update automatically, then reload this page. Your purchase is fine.");
    } else if (branch === "nodevice") {
      /* No device keypair could be created — hardened privacy modes and
         corrupted profiles both do this. Without one there is nothing to prove
         and the issuer will refuse every time, so retrying is not the advice. */
      say("warn", "This browser profile won't let Tvara create its device key.",
        "Storage may be blocked or the profile damaged. Try a normal (non-private) window, or another profile. Your purchase is fine.");
    } else if (branch === "outdated") {
      say("warn", "This copy of Tvara is older than the licence server.",
        "Update the extension from the Chrome Web Store, then reload this page.");
    } else if (branch === "proof") {
      say("warn", "The licence server did not accept this device.",
        "Reload this page to try again. If it keeps happening, email tvara.exten@gmail.com with your key.");
    } else if (branch === "throttled") {
      say("warn", "Too many attempts in a short time.",
        "Wait a minute, then reload this page. Nothing is wrong with your purchase.");
    } else if (reason === "entitlement") {
      say("warn", "Activated, but the licence server did not answer.",
        "Pro unlocks by itself once you are back online. Nothing to redo.");
    } else if (reason === "bad-key") {
      say("warn", "That key was not readable.",
        "Copy it from your purchase email and paste it into the Tvara popup.");
    } else {
      /* This branch used to read "Install Tvara, then paste the key" — advice
         that was wrong every single time it appeared. This file is a content
         script: it cannot run unless the extension is installed, so nobody
         without it has ever seen this box. What actually happened is that the
         background service worker did not answer within 25 seconds, usually
         because the extension was mid-update or mid-reload. */
      say("warn", "Tvara is installed but its background service didn't answer.",
        "Reload this page. If that doesn't do it, paste the key into the popup by hand — your purchase is fine.");
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run, { once: true });
  } else {
    run();
  }
})();
