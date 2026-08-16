/**
 * Long Chat Toolkit — first-run page.
 *
 * Shows the shortcuts the BROWSER actually bound, not the ones the manifest
 * asked for: Chrome silently drops a suggested key that another extension
 * already holds, and printing the wish instead of the fact is how a first-run
 * page teaches someone a keystroke that does nothing.
 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const P = self.LCTProduct;
  const send = (msg) => new Promise((res) => {
    try { chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; res(r); }); }
    catch { res(null); }
  });

  /* ---------- shortcuts ---------- */

  // ⌘⇧K reads as one key to a Mac user; Ctrl+Shift+K is what Windows expects.
  // Chrome hands us the platform's own spelling, so only the separators need
  // tidying.
  function pretty(shortcut) {
    if (!shortcut) return null;
    return shortcut
      .replace(/Command/g, "⌘").replace(/Ctrl/g, "Ctrl")
      .replace(/Shift/g, navigator.userAgent.includes("Mac") ? "⇧" : "Shift")
      .replace(/Alt/g, navigator.userAgent.includes("Mac") ? "⌥" : "Alt")
      .replace(/\+/g, navigator.userAgent.includes("Mac") ? "" : "+");
  }

  async function paintKeys() {
    let commands = [];
    try { commands = await chrome.commands.getAll(); } catch { /* not available */ }
    const byName = new Map(commands.map((c) => [c.name, c.shortcut]));
    for (const li of document.querySelectorAll("#key-list li")) {
      const kbd = li.querySelector(".k");
      const key = pretty(byName.get(li.dataset.cmd));
      if (key) {
        kbd.textContent = key;
        kbd.classList.remove("unset");
      } else {
        // Honest, and it points at the fix rather than pretending.
        kbd.textContent = "not assigned";
        kbd.classList.add("unset");
      }
    }
  }

  /* ---------- trial ---------- */

  function paintTrial(state) {
    const btn = $("trial-start");
    const copy = $("trial-copy");
    if (!state) return;
    if (state.active) {
      const days = Math.max(1, Math.ceil((state.until - Date.now()) / 864e5));
      btn.disabled = true;
      btn.textContent = `Trial running — ${days} day${days === 1 ? "" : "s"} left`;
      copy.textContent = "Everything is unlocked on every platform. Nothing expires from your archive when the trial does — only the search over it.";
    } else if (state.spent) {
      btn.hidden = true;
      copy.textContent = `Your trial has been used on this browser. The speed engine stays free forever; ${P.PRICE} once brings back Total Recall and Context Bridge.`;
      const buy = $("buy-pro");
      buy.textContent = `Get Pro — ${P.PRICE} once, forever`;
      buy.classList.add("primary");
    }
  }

  /* ---------- wiring ---------- */

  $("trial-start").addEventListener("click", async () => {
    $("trial-start").disabled = true;
    await send({ type: "trial-start" });
    paintTrial(await send({ type: "trial-state" }));
  });

  $("buy-pro").addEventListener("click", () => { location.href = P.BUY; });

  for (const chip of document.querySelectorAll(".chip")) {
    chip.addEventListener("click", () => {
      chrome.tabs.create({ url: chip.dataset.url });
    });
  }

  $("shortcuts-link").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({
      url: navigator.userAgent.includes("Edg/")
        ? "edge://extensions/shortcuts"
        : "chrome://extensions/shortcuts"
    });
  });

  const open = (id, url) => $(id).addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url });
  });
  open("guide-link", P.SITE + "#features");
  open("privacy-link", P.PRIVACY);
  open("source-link", P.SOURCE);

  P.applyTo(document);
  paintKeys();
  send({ type: "trial-state" }).then(paintTrial);
})();
