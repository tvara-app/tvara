/**
 * Tvara — first-run page.
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
    let unassigned = 0;
    for (const li of document.querySelectorAll("#key-list li")) {
      const kbd = li.querySelector(".k");
      const key = pretty(byName.get(li.dataset.cmd));
      if (key) {
        kbd.textContent = key;
        kbd.classList.remove("unset");
      } else {
        kbd.textContent = "not assigned";
        kbd.classList.add("unset");
        unassigned++;
      }
    }
    /* Said ONCE, about the card. Chrome drops a suggested shortcut silently
       when another extension already holds the combination, and a bare grey
       "not assigned" reads as "this feature has no shortcut". Repeating the
       explanation on every row — which is what happens when all three collide,
       a common case — turns a small fixable thing into a wall of red. */
    const hint = $("keys-hint");
    if (hint) {
      hint.innerHTML = "";
      if (unassigned) {
        hint.append(unassigned === 1
          ? "One of these is taken by another extension. "
          : `${unassigned} of these are taken by other extensions. `);
      } else {
        hint.append("Your browser owns these. ");
      }
      const a = document.createElement("a");
      a.href = "#"; a.id = "shortcuts-link";
      a.textContent = unassigned ? "Pick your own" : "change any of them";
      a.addEventListener("click", openShortcuts);
      hint.append(a, unassigned ? ". The features work from the popup either way." : ".");
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
      btn.textContent = `Trial running · ${days} day${days === 1 ? "" : "s"} left`;
      copy.textContent = "Everything is unlocked on every platform. When the trial ends your archive stays; only the search over it stops.";
    } else if (state.spent) {
      btn.hidden = true;
      copy.textContent = `Your trial has been used on this browser. The speed engine stays free forever; ${P.PRICE} once brings back Total Recall and Context Bridge.`;
      const buy = $("buy-pro");
      buy.textContent = `Get Pro · ${P.PRICE} once, forever`;
      buy.classList.add("primary");
    }
  }

  /* ---------- wiring ---------- */

  $("trial-start").addEventListener("click", async () => {
    /* send() resolves null on any failure and paintTrial() returns early on a
       null state, so a worker that was still starting up — likely, since this
       tab is opened by the worker's own install handler — left the button
       disabled and unlabelled for the life of the page. Re-enable unless the
       trial actually started. */
    const btn = $("trial-start");
    btn.disabled = true;
    await send({ type: "trial-start" });
    const state = await send({ type: "trial-state" });
    if (state) paintTrial(state);
    else {
      btn.disabled = false;
      btn.textContent = "Couldn't start. Try again";
    }
  });

  $("buy-pro").addEventListener("click", () => { location.href = P.BUY; });

  for (const chip of document.querySelectorAll(".chip")) {
    chip.addEventListener("click", () => {
      chrome.tabs.create({ url: chip.dataset.url });
    });
  }

  /* Named, because paintKeys() rebuilds this line — and with it the link —
     whenever the shortcut state changes, so a listener bound once at load
     would be attached to an element no longer on the page. */
  function openShortcuts(e) {
    if (e) e.preventDefault();
    chrome.tabs.create({
      url: navigator.userAgent.includes("Edg/")
        ? "edge://extensions/shortcuts"
        : "chrome://extensions/shortcuts"
    });
  }
  const shortcutsLink = $("shortcuts-link");
  if (shortcutsLink) shortcutsLink.addEventListener("click", openShortcuts);

  const open = (id, url) => $(id).addEventListener("click", (e) => {
    e.preventDefault();
    chrome.tabs.create({ url });
  });
  open("guide-link", P.SITE + "#features");
  open("privacy-link", P.PRIVACY);
  open("source-link", P.SOURCE);

  P.applyTo(document);
  /* ---------- the first useful thing ----------
     A new install has an archive of nothing, so the feature people pay for
     finds nothing, and they conclude it does not work. Fetching their own
     history is the one action worth putting on this page — and it is honest
     about being a download over their own account, with a count and a stop. */
  let fetchPoll = null;

  function paintFetch(state) {
    const btn = $("fetch-history");
    const status = $("fetch-status");
    const total = (state && state.total) || 0;
    const running = !!(state && state.running);
    if (running) {
      btn.disabled = true;
      btn.textContent = "Fetching…";
      status.hidden = false;
      status.textContent = `${((state && state.done) || 0).toLocaleString()} done · ` +
        `${total.toLocaleString()} to go. You can close this page; it keeps going.`;
      return;
    }
    btn.disabled = false;
    if (!total) {
      btn.textContent = "Fetch my history";
      status.hidden = false;
      status.textContent = state && state.done
        ? "Done. Every chat this browser knows about has its text."
        /* On a fresh install this is the true state, and the old line read as
           an instruction with no object: there is nothing to fetch until a
           chat site has been opened once, which is the card ABOVE this one. */
        : "Nothing waiting yet. Open a chat site once (the buttons above) and your conversations show up here.";
      return;
    }
    btn.textContent = `Fetch ${total.toLocaleString()} chats`;
    if (state && state.note) {
      status.hidden = false;
      status.textContent = `${state.note}. Sign in on that site, then try again.`;
      return;
    }
    status.hidden = true;
  }

  /* The worker can spend a long time in ensureStubIndex() before it reports
     `running`, and a single probe at +500ms landed inside that window: the
     poll chain never armed and this page sat on "Fetch 2,300 chats" while the
     download ran. */
  let fetchExpected = 0;

  async function refreshFetch() {
    const state = await send({ type: "archive-fill-state" });
    paintFetch(state);
    clearTimeout(fetchPoll);
    const waiting = fetchExpected && Date.now() < fetchExpected;
    if (state && state.running) fetchExpected = 0;
    if ((state && state.running) || waiting) fetchPoll = setTimeout(refreshFetch, 1500);
  }

  $("fetch-history").addEventListener("click", async () => {
    const btn = $("fetch-history");
    if (btn.disabled) return;
    btn.disabled = true;
    await send({ type: "archive-fill-start" });
    fetchExpected = Date.now() + 30000;
    setTimeout(refreshFetch, 500);
  });
  $("import-export").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("recall.html#import") });
  });
  refreshFetch();

  paintKeys();
  send({ type: "trial-state" }).then(paintTrial);
})();
