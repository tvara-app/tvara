/**
 * Tvara — Chat Card.
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

  const DASH = "\u2014"; // stands in for every value we genuinely do not have

  // Glanceable date for the value column: "today", "yesterday", "3 Aug",
  // "3 Aug 2025". The column is narrow — a clock time would not fit.
  function shortDate(ms) {
    const d = new Date(ms);
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (ms >= midnight) return "today";
    if (ms >= midnight - 864e5) return "yesterday";
    const opts = { day: "numeric", month: "short" };
    if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString(undefined, opts);
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

  function row(label, value, empty) {
    const r = document.createElement("div");
    r.className = "lct-cc-row";
    const k = document.createElement("div");
    k.className = "lct-cc-k";
    k.textContent = label;
    const v = document.createElement("div");
    v.className = "lct-cc-v" + (empty ? " lct-cc-v-empty" : "");
    v.textContent = value; // records are data, never markup
    r.append(k, v);
    return r;
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

  function renderCard(path, anchorRect, name) {
    ensureCard();
    card.replaceChildren();
    const rec = records[path];

    card.appendChild(line((rec && rec.ti) || name || "This chat", "lct-cc-name"));

    if (!rec) {
      // Nothing known. Every field says so rather than inventing a number.
      card.appendChild(row("Messages", DASH, true));
      card.appendChild(row("You asked", DASH, true));
      card.appendChild(row("Starred", DASH, true));
      card.appendChild(row("Created", DASH, true));
      card.appendChild(row("Last opened", "not tracked yet", true));
      card.appendChild(line(
        "Not tracked yet. Open this chat once and Tvara will remember its size and dates.",
        "lct-cc-foot"
      ));
    } else {
      const synced = rec.c == null; // history-sync meta: real dates, size unknown
      card.appendChild(row("Messages", synced ? DASH : rec.c.toLocaleString(), synced));
      card.appendChild(row("You asked", synced ? DASH : rec.u.toLocaleString(), synced));

      // stars live under their own per-conversation key — the row is placed
      // now (so nothing below it jumps) and filled when the read lands
      const starRow = row("Starred", DASH, true);
      card.appendChild(starRow);
      const starKey = "stars:" + location.hostname + path;
      store.get(starKey).then((res) => {
        const stars = res[starKey];
        const n = stars ? Object.keys(stars).length : 0;
        if (shownFor !== path || !starRow.isConnected) return;
        const v = starRow.lastChild;
        v.textContent = n ? n.toLocaleString() : "0";
        v.className = "lct-cc-v" + (n ? " lct-cc-v-star" : " lct-cc-v-empty");
      });

      if (rec.e) card.appendChild(row("Created", shortDate(rec.e * 1000)));
      else card.appendChild(row("First seen", shortDate(rec.f)));
      card.appendChild(row("Last opened", shortDate(rec.o)));

      if (synced) {
        card.appendChild(line("Synced from your history. Open once for message counts.", "lct-cc-foot"));
      } else if (!rec.e) {
        card.appendChild(line("First seen is when this device met the chat, not when you started it.", "lct-cc-foot"));
      }
      if (!synced && isLongest(path)) {
        card.appendChild(line("Your longest visited chat on " + adapter.label, "lct-cc-badge"));
      }
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
    // prefer the native title (untruncated) over the visibly clipped label
    const name = (savedTitle != null && titleAnchor === anchor ? savedTitle : anchor.textContent || "")
      .replace(/\s+/g, " ").trim().slice(0, 80);
    hoverTimer = setTimeout(async () => {
      if (!recordsLoaded) await loadRecords();
      renderCard(path, rect, name);
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
