/**
 * Long Chat Toolkit — Chat Card.
 * Hover a conversation link in the site's sidebar → a small card shows what
 * we KNOW about that chat: message count, questions asked, stars, when it was
 * created (real time on ChatGPT via the app's own state) or first seen here,
 * last opened, and whether it's your longest visited chat on this site.
 *
 * Honesty rules:
 *  - We only know chats that were OPENED while the extension is installed —
 *    the platforms don't expose other chats' data in the page, and we have no
 *    network access to ask for it. Unknown chats say so, plainly.
 *  - "Created" is shown ONLY when the platform recorded it (ChatGPT exact
 *    times). Everywhere else the card says "First seen · this device".
 *  - "Longest" always means "longest of your visited chats", never "longest
 *    chat you have".
 */
(() => {
  "use strict";

  const SHOW_DELAY = 320;   // ms of steady hover before the card appears
  const WRITE_EVERY = 2000; // record-write throttle
  const MAX_RECORDS = 200;  // per host — oldest last-opened pruned beyond this

  let adapter = null;
  let store = null;
  let enabled = false;

  let records = {};         // pathname -> {c,u,f,o,e} (count, user msgs, firstSeen, lastOpened, earliestExact)
  let recordsLoaded = false;
  let card = null;
  let hoverTimer = null;
  let writeTimer = null;
  let latestMessages = null;
  let shownFor = null;      // pathname the visible card belongs to
  let titleAnchor = null;   // anchor whose native title we've suppressed
  let savedTitle = null;

  const KEY = () => "chats:" + location.hostname;

  /* ---------- record keeping (always on: it's how the card knows anything) */

  async function loadRecords() {
    const { [KEY()]: r } = await store.get(KEY());
    records = r || {};
    recordsLoaded = true;
  }

  function update(messages) {
    latestMessages = messages;
    if (writeTimer) return;
    writeTimer = setTimeout(writeRecord, WRITE_EVERY);
  }

  async function writeRecord() {
    writeTimer = null;
    const msgs = latestMessages;
    if (!msgs || msgs.length < 2) return;
    if (!recordsLoaded) await loadRecords();

    let users = 0;
    for (const el of msgs) {
      try { if (adapter.role(el) === "user") users++; } catch { /* adapter guard */ }
    }
    const path = location.pathname;
    const prev = records[path];
    const now = Date.now();
    records[path] = {
      c: msgs.length,
      u: users,
      f: prev ? prev.f : now,
      o: now,
      e: self.LCTTimeline.earliest() || (prev ? prev.e : 0) || 0
    };

    // prune: keep the MAX_RECORDS most recently opened
    const paths = Object.keys(records);
    if (paths.length > MAX_RECORDS) {
      paths.sort((a, b) => (records[a].o || 0) - (records[b].o || 0));
      for (const p of paths.slice(0, paths.length - MAX_RECORDS)) delete records[p];
    }
    store.set({ [KEY()]: records });
  }

  /* ---------- the card ---------- */

  function fmt(ms) {
    const d = new Date(ms);
    const opts = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
    return d.toLocaleString(undefined, opts);
  }

  function ensureCard() {
    if (card) return;
    card = document.createElement("div");
    card.id = "lct-chatcard";
    document.documentElement.appendChild(card);
  }

  function line(text, cls) {
    const div = document.createElement("div");
    if (cls) div.className = cls;
    div.textContent = text; // records are data, never markup
    return div;
  }

  function hideCard() {
    clearTimeout(hoverTimer);
    hoverTimer = null;
    shownFor = null;
    if (card) card.style.display = "none";
    restoreTitle();
  }

  // Sites often put the full (untruncated) name in a native `title` attribute
  // for accessibility. Left alone, the browser's own tooltip pops up on top
  // of our card (native tooltips paint above all page content, unstylable)
  // and visually collides with it. Suppress it for as long as our card owns
  // this anchor, then restore it so accessibility isn't affected otherwise.
  function suppressTitle(anchor) {
    if (anchor === titleAnchor) return;
    restoreTitle();
    if (anchor && anchor.hasAttribute("title")) {
      savedTitle = anchor.getAttribute("title");
      anchor.removeAttribute("title");
      titleAnchor = anchor;
    }
  }

  function restoreTitle() {
    if (titleAnchor && savedTitle != null) titleAnchor.setAttribute("title", savedTitle);
    titleAnchor = null;
    savedTitle = null;
  }

  function isLongest(path) {
    const sized = Object.keys(records).filter((p) => records[p].c != null);
    if (sized.length < 2) return false; // "longest of 1" is meaningless
    const mine = records[path].c;
    if (mine == null) return false;
    return sized.every((p) => records[p].c <= mine);
  }

  function renderCard(path, anchorRect) {
    ensureCard();
    card.replaceChildren();
    const rec = records[path];

    if (!rec) {
      card.appendChild(line("Not tracked yet", "lct-cc-title"));
      card.appendChild(line("Open this chat once and Long Chat Toolkit will remember its size and dates.", "lct-cc-dim"));
    } else {
      if (rec.c == null) {
        // synced meta record: real dates from the platform, size not yet known
        card.appendChild(line(rec.ti || "Synced chat", "lct-cc-title"));
        if (rec.e) card.appendChild(line("Created " + fmt(rec.e * 1000)));
        card.appendChild(line("Last active " + fmt(rec.o), "lct-cc-dim"));
        card.appendChild(line("Synced from your history — open once for message counts.", "lct-cc-dim"));
      } else {
      card.appendChild(line(
        `${rec.c.toLocaleString()} messages · ${rec.u.toLocaleString()} questions asked`,
        "lct-cc-title"
      ));
      if (rec.e) card.appendChild(line("Created " + fmt(rec.e * 1000)));
      else card.appendChild(line("First seen " + fmt(rec.f) + " · this device", "lct-cc-dim"));
      card.appendChild(line("Last opened " + fmt(rec.o), "lct-cc-dim"));
      if (isLongest(path)) {
        card.appendChild(line("Your longest visited chat on " + adapter.label, "lct-cc-badge"));
      }
      }
      // stars live under their own per-conversation key — fetch and append
      store.get("stars:" + location.hostname + path).then((res) => {
        const stars = res["stars:" + location.hostname + path];
        const n = stars ? Object.keys(stars).length : 0;
        if (n && shownFor === path) {
          card.insertBefore(
            line(`${n} starred message${n === 1 ? "" : "s"}`, "lct-cc-star"),
            card.children[1] || null
          );
        }
      });
    }

    // position beside the link, clamped to the viewport
    card.style.display = "block";
    card.style.visibility = "hidden";
    card.style.left = "0px";
    card.style.top = "0px";
    const w = card.offsetWidth, h = card.offsetHeight;
    let left = anchorRect.right + 10;
    if (left + w > innerWidth - 8) left = Math.max(8, anchorRect.left - w - 10);
    let top = anchorRect.top;
    if (top + h > innerHeight - 8) top = Math.max(8, innerHeight - h - 8);
    card.style.left = left + "px";
    card.style.top = top + "px";
    card.style.visibility = "visible";
    shownFor = path;
  }

  /* ---------- hover detection (event delegation — no sidebar selectors) */

  function convPathOf(node) {
    // closest same-origin <a> whose pathname looks like a conversation URL.
    // href-shape matching survives site redesigns far better than classnames.
    const a = node && node.closest ? node.closest("a[href]") : null;
    if (!a) return null;
    if (a.closest('[id^="lct-"]')) return null; // never our own UI
    let url;
    try { url = new URL(a.href, location.href); } catch { return null; }
    if (url.origin !== location.origin) return null;
    if (!adapter.convPath || !adapter.convPath.test(url.pathname)) return null;
    return url.pathname;
  }

  function onOver(e) {
    if (!enabled) return;
    const path = convPathOf(e.target);
    if (!path) {
      if (shownFor) hideCard();
      return;
    }
    if (path === shownFor) return;
    clearTimeout(hoverTimer);
    const anchor = e.target.closest("a[href]");
    suppressTitle(anchor);
    const rect = anchor.getBoundingClientRect();
    hoverTimer = setTimeout(async () => {
      if (!recordsLoaded) await loadRecords();
      renderCard(path, rect);
    }, SHOW_DELAY);
  }

  function init(theAdapter, theStore) {
    adapter = theAdapter;
    store = theStore;
    document.addEventListener("mouseover", onOver, { passive: true });
    addEventListener("scroll", hideCard, { passive: true, capture: true });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideCard(); }, true);
    // another tab may update records for this host — stay fresh
    try {
      chrome.storage.onChanged.addListener((changes) => {
        if (changes[KEY()]) records = changes[KEY()].newValue || {};
      });
    } catch { /* storage API unavailable — records just stay session-local */ }
  }

  function setEnabled(on) {
    enabled = !!on;
    if (!on) hideCard();
  }

  self.LCTChatCard = { init, update, setEnabled };
})();
