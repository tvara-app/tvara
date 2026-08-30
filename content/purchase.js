/**
 * Tvara — finish the purchase on the page the buyer lands on.
 *
 * The gap this closes: someone pays, and then has to find a key in an email,
 * find the extension icon, open the popup, and paste. Four steps between paying
 * and having the thing they paid for, and every one of them is somewhere a
 * person gives up and asks for a refund instead.
 *
 * What changed. The key used to arrive appended to this page's URL and this
 * file read it out of the query string. It no longer travels that way at all:
 * the extension opened the checkout itself, it holds the order ref, and it
 * claims the licence from the licence server over a device key that WebCrypto
 * will not export. So this page has nothing secret on it, and this script has
 * nothing to read — it asks the background to get on with the claim and reports
 * what happened.
 *
 * That makes the fast half of a two-part mechanism. The slow half is a
 * one-minute alarm in bg.js, which is what finishes the job when the buyer
 * closes this tab on the receipt, or quits the browser mid-payment. Neither is
 * trusted alone.
 *
 * Runs ONLY on our own post-purchase page, declared as a single exact match in
 * the manifest. It reads nothing on the page and runs nowhere else.
 */
(() => {
  "use strict";

  function say(state, text, note) {
    const box = document.getElementById("auto-activate");
    if (!box) return;
    // Tells the page's own timeout that the extension is here, so it stops
    // waiting to announce that we are not.
    box.dataset.owned = "1";
    box.hidden = false;
    box.className = "auto " + state;
    box.textContent = text;
    if (note) {
      const small = document.createElement("small");
      small.textContent = note;
      box.appendChild(small);
    }
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /** One round trip to the background, or null if it never answered. */
  function poll() {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      setTimeout(() => finish(null), 25000);
      try {
        chrome.runtime.sendMessage({ type: "checkout-poll" }, (r) => {
          void chrome.runtime.lastError;
          finish(r || null);
        });
      } catch { finish(null); }                    // extension reloading
    });
  }

  /* The licence is minted asynchronously after the payment clears, and the
     redirect regularly beats it here by a few seconds. That is a race, not a
     failure. Backing off rather than hammering: the last value repeats, so this
     keeps trying for as long as the tab is open without ever polling hard. */
  const BACKOFF_MS = [1000, 2000, 3000, 5000, 5000, 8000, 8000, 10000];
  const next = (i) => BACKOFF_MS[Math.min(i, BACKOFF_MS.length - 1)];
  const DEADLINE_MS = 10 * 60 * 1000;

  async function run() {
    say("working", "Confirming your payment…");

    const startedAt = Date.now();
    for (let i = 0; ; i++) {
      const res = await poll();

      /* The background did not answer at all — mid-update, mid-reload, or torn
         down. Worth one more try; the alarm is behind us either way. */
      if (!res) {
        if (Date.now() - startedAt > 30000) {
          say("warn", "Tvara is installed but its background service didn't answer.",
            "Reload this page. If that doesn't help, paste the key from your email into the popup — your purchase is fine.");
          return;
        }
        await wait(next(i));
        continue;
      }

      if (res.state === "active") {
        say("ok", "Pro is active on this device.",
          "Nothing else to do. Your key is in your email if you ever need it again.");
        return;
      }

      /* Every branch below is a real state a buyer can be in, and each says
         what to do next. "Something went wrong" is not an instruction.

         Everyone reading these has ALREADY PAID. The distance between a precise
         next step and a vague apology is the distance between a support email
         and a chargeback, so no branch here is allowed to guess. */
      if (res.state === "none") {
        /* No order in flight. Either this browser is not the one that opened
           the checkout, or the licence was already activated and cleaned up. */
        say("idle", "No purchase is waiting on this browser.",
          "If you just paid somewhere else, paste the key from your email into the Tvara popup.");
        return;
      }

      if (res.state === "refunded") {
        say("warn", "That purchase was refunded.",
          "There is nothing to activate. Reply to your purchase email if that is not right.");
        return;
      }

      if (res.state === "expired" || res.state === "unknown" || res.state === "claimed") {
        say("warn", "We couldn't finish this automatically.",
          "Your payment went through and your key is in your email — paste it into the Tvara popup. Or mail tvara.exten@gmail.com and I'll sort it out.");
        return;
      }

      if (res.state === "held") {
        // The key arrived; registering the device is what failed. Named
        // failures get named advice, because most of them are fixable.
        const HELD = {
          limit: ["This licence is already on five devices.",
            "Open the Tvara popup, choose Devices, and release one. Your purchase is fine."],
          clockskew: ["Your device's clock is too far out to verify the licence.",
            "Set date and time to update automatically. This retries on its own once the clock is right."],
          nodevice: ["This browser profile won't let Tvara create its device key.",
            "Storage may be blocked or the profile damaged. Try a normal (non-private) window, or another profile. Your purchase is fine."],
          outdated: ["This copy of Tvara is older than the licence server.",
            "Update the extension from your browser's store. Your key is saved and activates itself afterwards."]
        };
        const known = HELD[res.reason] || HELD[res.branch];
        if (known) { say("warn", known[0], known[1]); return; }
        // Unnamed: keep waiting. The key is stored and the alarm keeps trying.
        say("working", "Almost there — registering this device…",
          "Your key has arrived and is saved. This finishes on its own.");
        await wait(next(i));
        continue;
      }

      // pending / paid / waiting — the ordinary case in the seconds after a
      // payment, and the only thing to do is give it a moment.
      say("working", res.state === "paid"
        ? "Payment confirmed. Issuing your licence…"
        : "Confirming your payment…");

      if (Date.now() - startedAt > DEADLINE_MS) {
        say("warn", "This is taking longer than it should.",
          "Your payment went through. It will finish in the background — or paste the key from your email into the popup now.");
        return;
      }
      await wait(next(i));
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run, { once: true });
  } else {
    run();
  }
})();
