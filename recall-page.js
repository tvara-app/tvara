/* Total Recall page — search the archive, import official exports, wipe.
   Runs as an extension page: writes stay in the background worker's IndexedDB;
   only its scoped provider-history checks use the declared host permissions. */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));
  const crypt = self.LCTBackupCrypto;

  const setStatus = (id, text, kind = "") => {
    const node = $(id);
    node.className = "status-copy" + (kind ? " " + kind : "");
    node.textContent = text || "";
  };

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.hidden = true;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ---------- plan gating ---------------------------------------------------
     Paid: search, backup/export, restore. Free: the archive keeps building,
     and official provider exports still import — nobody loses history by not
     paying, they lose the tools that get it back out.

     This function paints locks. It does not enforce them: bg.js re-checks the
     signed entitlement on every gated message, so hiding a button is courtesy,
     not security. */

  let unlocked = false;      // search
  let canBackup = false;     // export + auto-backup
  let canRestore = false;    // import a .lctbackup

  async function loadPlan() {
    const verdict = (await send({ type: "entitlement-state" })) || {};
    const feats = Array.isArray(verdict.features) ? verdict.features : [];
    const entitled = !!verdict.entitled;
    const trialOn = entitled && verdict.via === "trial";
    const pro = entitled && !trialOn;
    const trialSpent = !entitled && verdict.trial && verdict.trial.spent;

    unlocked = entitled && (trialOn || feats.includes("archive.search"));
    canBackup = entitled && (trialOn || feats.includes("archive.backup"));
    canRestore = entitled && (trialOn || feats.includes("archive.restore"));

    // Opportunistic renewal — fire and forget, never gates paint.
    send({ type: "entitlement-refresh" });

    const badge = $("plan-badge");
    badge.textContent = pro ? "Pro" : trialOn ? "Trial" : "Free";
    badge.className = "badge " + (pro ? "pro" : trialOn ? "trial" : "");

    // The lock lives inside the archive core rather than replacing it: the
    // stats below stay visible so a locked archive still looks alive, and the
    // trial can be started here instead of only from the popup.
    $("core-locked").hidden = unlocked;
    $("searchbox").hidden = !unlocked;
    $("trial-start").hidden = !!trialSpent;
    if (trialSpent) {
      $("core-locked").querySelector(".locked-title").textContent = "Your trial has ended";
      $("core-locked").querySelector(".locked-copy").textContent =
        "The archive kept building the whole time — nothing was lost. $9 once, from the extension popup, unlocks search again forever.";
    }

    paintPaidSections(verdict);
    paintArchiveState();
  }

  const LOCK_COPY = "Pro feature. Your archive keeps building either way — unlock from the extension popup to get it back out.";

  /** Disable rather than hide: a vanished backup button reads as data loss. */
  function paintPaidSections(verdict) {
    for (const [id, allowed] of [["create-backup", canBackup], ["backup-auto", canBackup],
      ["autobackup-run", canBackup], ["restore-run", canRestore]]) {
      const node = $(id);
      if (!node) continue;
      node.disabled = !allowed;
      node.title = allowed ? "" : LOCK_COPY;
    }
    if (!canBackup) setStatus("backup-status", LOCK_COPY, "");
    if (!canRestore) setStatus("restore-status", LOCK_COPY, "");
    // Grace period: signed, valid, but overdue a renewal. Works, warns.
    if (verdict && verdict.stale) {
      setStatus("backup-status", "Licence needs to check in — reconnect within 14 days to keep Pro.", "warn");
    }
  }

  /** One place the "you're locked" answer from the worker becomes UI copy. */
  function lockedResponse(res) {
    if (!res || res.err !== "locked") return false;
    loadPlan();
    return true;
  }

  $("trial-start").addEventListener("click", async () => {
    await send({ type: "trial-start" });
    await loadPlan();
    $("q").focus();
  });

  /* ---------- search ---------- */

  let queryTimer = null;

  function fmtWhen(ms) {
    if (!ms) return "";
    const d = new Date(ms);
    const opts = { month: "short", day: "numeric" };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString(undefined, opts);
  }

  function row(res) {
    const div = document.createElement("div");
    div.className = "r-item";
    const top = document.createElement("div");
    top.className = "r-title";
    const badge = document.createElement("b");
    badge.textContent = res.platform || res.host;
    const title = document.createElement("span");
    title.textContent = res.title || "Untitled chat"; // data, never markup
    const when = document.createElement("time");
    when.className = "r-when";
    when.textContent = fmtWhen(res.updatedAt);
    top.append(badge, title, when);
    const snip = document.createElement("div");
    snip.className = "r-snip";
    snip.textContent = res.snippet;
    const info = document.createElement("div");
    info.className = "r-info";
    info.textContent = `${res.n} message${res.n === 1 ? "" : "s"}` +
      (res.createdAt ? ` · started ${fmtWhen(res.createdAt)}` : "");
    div.append(top, snip, info);
    div.addEventListener("click", async () => {
      // stash the query so the destination chat opens its in-chat search on it
      await chrome.storage.local.set({
        "recall-jump": { host: res.host, path: res.path, q: $("q").value.trim(), at: Date.now() }
      });
      window.open("https://" + res.host + res.path, "_blank", "noopener");
    });
    return div;
  }

  async function runQuery() {
    const q = $("q").value.trim();
    if (q.length < 2) {
      $("results").replaceChildren();
      $("q-meta").textContent = "";
      paintArchiveState();
      return;
    }
    $("q-meta").textContent = "searching…";
    const res = await send({ type: "recall-search", q });
    if (lockedResponse(res)) { $("q-meta").textContent = ""; return; }
    // A slower earlier query must never repaint over a newer one.
    if (!res || res.err || q !== $("q").value.trim()) return;
    $("results").replaceChildren(...res.results.map(row));
    $("q-meta").textContent = res.results.length
      ? `${res.results.length} chat${res.results.length === 1 ? "" : "s"}`
      : `no matches in ${res.scanned.toLocaleString()} chats`;
    paintArchiveState();
  }

  $("q").addEventListener("input", () => {
    clearTimeout(queryTimer);
    queryTimer = setTimeout(runQuery, 180);
  });
  $("q").addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    $("q").value = "";
    runQuery();
  });

  /* ---------- stats ---------- */

  let archivedChats = null;

  function paintArchiveState() {
    const note = $("archive-empty");
    const hasResults = $("results").childElementCount > 0;
    if (archivedChats === null || archivedChats > 0 || hasResults) { note.hidden = true; return; }
    note.hidden = false;
    note.textContent = unlocked
      ? "Your archive is empty. Run a check below to pull your signed-in history, or import an export file — either way it stays on this device."
      : "Your archive is empty. Run a check below to start building it; search unlocks with the trial.";
  }

  async function loadStats() {
    const s = await send({ type: "recall-stats" });
    if (!s || s.err) return;
    archivedChats = s.chats;
    paintArchiveState();
    const wrap = $("stats");
    wrap.replaceChildren();
    const mk = (num, label) => {
      const d = document.createElement("div");
      d.className = "stat";
      const b = document.createElement("b");
      b.textContent = num;
      const sp = document.createElement("span");
      sp.textContent = label;
      d.append(b, sp);
      return d;
    };
    if (!s.chats) return;
    wrap.append(
      mk(s.chats.toLocaleString(), "chats archived"),
      mk(s.msgs.toLocaleString(), "messages"),
      mk((s.bytes / 1048576).toFixed(1) + " MB", "on disk (text)")
    );
    for (const [p, n] of Object.entries(s.byPlatform).sort((a, b) => b[1] - a[1]).slice(0, 5)) {
      wrap.append(mk(String(n), p.toLowerCase()));
    }
  }

  /* ---------- import: official data exports, parsed 100% locally --------- */

  // Minimal zip reader — enough for export zips, using the browser's native
  // DecompressionStream. No libraries, no network.
  async function unzipEntry(buf, wantName) {
    const dv = new DataView(buf);
    // find End Of Central Directory (scan back for signature 0x06054b50)
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65558); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("not a zip file");
    let off = dv.getUint32(eocd + 16, true);
    const count = dv.getUint16(eocd + 10, true);
    const td = new TextDecoder();
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(off, true) !== 0x02014b50) break;
      const method = dv.getUint16(off + 10, true);
      const csize = dv.getUint32(off + 20, true);
      const nameLen = dv.getUint16(off + 28, true);
      const extraLen = dv.getUint16(off + 30, true);
      const commentLen = dv.getUint16(off + 32, true);
      const localOff = dv.getUint32(off + 42, true);
      const name = td.decode(new Uint8Array(buf, off + 46, nameLen));
      if (name.endsWith(wantName)) {
        // local header: its own name/extra lengths decide where data starts
        const lNameLen = dv.getUint16(localOff + 26, true);
        const lExtraLen = dv.getUint16(localOff + 28, true);
        const data = new Uint8Array(buf, localOff + 30 + lNameLen + lExtraLen, csize);
        if (method === 0) return td.decode(data);
        if (method === 8) {
          const ds = new DecompressionStream("deflate-raw");
          const stream = new Blob([data]).stream().pipeThrough(ds);
          return await new Response(stream).text();
        }
        throw new Error("unsupported compression");
      }
      off += 46 + nameLen + extraLen + commentLen;
    }
    throw new Error(wantName + " not found in zip");
  }

  /** Try multiple known filenames inside a ZIP, return first match. */
  async function unzipFindJson(buf) {
    const candidates = ["conversations.json", "MyActivity.json", "My Activity.json"];
    for (const name of candidates) {
      try { return await unzipEntry(buf, name); } catch {}
    }
    throw new Error("No recognized export file found in ZIP. Expected conversations.json (ChatGPT/Claude) or MyActivity.json (Gemini Takeout).");
  }

  // ChatGPT export: conversations.json = [{title, create_time, update_time,
  // mapping: {id: {message: {author:{role}, create_time, content:{parts}}}}, id}]
  function parseChatGPT(arr) {
    const chats = [];
    for (const conv of arr) {
      try {
        const msgs = [];
        for (const node of Object.values(conv.mapping || {})) {
          const m = node && node.message;
          if (!m || !m.author) continue;
          const role = m.author.role;
          if (role !== "user" && role !== "assistant") continue;
          const parts = (m.content && m.content.parts) || [];
          const text = parts.filter((p) => typeof p === "string").join("\n").trim();
          if (!text) continue;
          msgs.push({ r: role, t: text, ts: m.create_time ? Math.floor(m.create_time) : 0 });
        }
        msgs.sort((a, b) => (a.ts || 0) - (b.ts || 0));
        const id = conv.conversation_id || conv.id;
        if (!id || msgs.length < 2) continue;
        chats.push({
          id: "chatgpt.com/c/" + id,
          host: "chatgpt.com",
          path: "/c/" + id,
          platform: "ChatGPT",
          title: conv.title || "",
          createdAt: conv.create_time ? Math.floor(conv.create_time * 1000) : 0,
          updatedAt: conv.update_time ? Math.floor(conv.update_time * 1000) : Date.now(),
          msgs
        });
      } catch { /* one bad conversation must not sink the import */ }
    }
    return chats;
  }

  // Claude export: conversations.json = [{uuid, name, created_at, updated_at,
  // chat_messages: [{sender: "human"|"assistant", text, created_at}]}]
  function parseClaude(arr) {
    const chats = [];
    for (const conv of arr) {
      try {
        const msgs = (conv.chat_messages || [])
          .map((m) => ({
            r: m.sender === "human" ? "user" : "assistant",
            t: String(m.text || "").trim(),
            ts: m.created_at ? Math.floor(new Date(m.created_at).getTime() / 1000) : 0
          }))
          .filter((m) => m.t);
        if (!conv.uuid || msgs.length < 2) continue;
        chats.push({
          id: "claude.ai/chat/" + conv.uuid,
          host: "claude.ai",
          path: "/chat/" + conv.uuid,
          platform: "Claude",
          title: conv.name || "",
          createdAt: conv.created_at ? new Date(conv.created_at).getTime() : 0,
          updatedAt: conv.updated_at ? new Date(conv.updated_at).getTime() : Date.now(),
          msgs
        });
      } catch { /* skip bad conversation */ }
    }
    return chats;
  }

  // Gemini Takeout: MyActivity.json = [{title, titleUrl, time, products, ...}]
  // Each entry is a single interaction event; group by conversation ID from titleUrl.
  function parseGeminiTakeout(arr) {
    const byConv = {};
    for (const entry of arr) {
      try {
        // Extract conversation ID from titleUrl (e.g., "https://gemini.google.com/app/c/<id>")
        const url = entry.titleUrl || "";
        const m = url.match(/\/app(?:\/c)?\/([0-9a-f-]+)/i);
        if (!m) continue;
        const cid = m[1];
        if (!byConv[cid]) byConv[cid] = { id: cid, title: "", ts: [], texts: [] };
        const conv = byConv[cid];
        // Use the first entry's title as the conversation title
        if (!conv.title && entry.title) conv.title = entry.title.replace(/^Gemini - /, "").trim();
        // Parse timestamp
        if (entry.time) conv.ts.push(new Date(entry.time).getTime());
        // Extract text content from subtitles or header
        const subs = entry.subtitles || [];
        for (const s of subs) {
          if (s.name && s.name.trim()) conv.texts.push({ r: "user", t: s.name.trim() });
        }
        if (entry.header && entry.header.trim()) {
          conv.texts.push({ r: "user", t: entry.header.trim() });
        }
      } catch {}
    }
    const chats = [];
    for (const [cid, conv] of Object.entries(byConv)) {
      const timestamps = conv.ts.sort((a, b) => a - b);
      const createdAt = timestamps[0] || 0;
      const updatedAt = timestamps[timestamps.length - 1] || Date.now();
      // Build messages — Takeout only has prompts, not full responses
      const msgs = conv.texts.map((t, i) => ({
        r: t.r, t: t.t, ts: Math.floor((timestamps[i] || createdAt) / 1000)
      })).filter(m => m.t);
      chats.push({
        id: "gemini.google.com/app/" + cid,
        host: "gemini.google.com",
        path: "/app/" + cid,
        platform: "Gemini",
        title: conv.title || "Untitled",
        createdAt, updatedAt,
        msgs: msgs.length >= 1 ? msgs : [],
        meta: msgs.length < 2  // if only prompts (no responses), store as meta-only
      });
    }
    return chats;
  }

  function detectAndParse(text) {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) throw new Error("unexpected format");
    if (!arr.length) return [];
    if (arr[0] && arr[0].mapping) return parseChatGPT(arr);
    if (arr[0] && arr[0].chat_messages) return parseClaude(arr);
    // Gemini Takeout: each entry has a titleUrl pointing to gemini.google.com
    if (arr[0] && (arr[0].titleUrl || arr[0].header) && arr.some(e => (e.titleUrl || "").includes("gemini"))) {
      return parseGeminiTakeout(arr);
    }
    throw new Error("unrecognized export format — expected ChatGPT, Claude, or Gemini Takeout");
  }

  $("import-file").addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setStatus("import-status", "Reading " + file.name + "…");
    try {
      let text;
      if (file.name.endsWith(".zip")) {
        text = await unzipFindJson(await file.arrayBuffer());
      } else {
        text = await file.text();
      }
      const chats = detectAndParse(text);
      if (!chats.length) throw new Error("no conversations found in the file");
      setStatus("import-status", `Importing ${chats.length.toLocaleString()} chats…`);
      let ok = 0, skipped = 0;
      for (let i = 0; i < chats.length; i += 25) { // chunk: keep messages small
        const r = await send({ type: "recall-import", chats: chats.slice(i, i + 25) });
        ok += (r && r.ok) || 0;
        skipped += (r && r.skipped) || 0;
      }
      setStatus("import-status",
        `Imported ${ok.toLocaleString()} chats${skipped ? ` · ${skipped} skipped` : ""}. All local.`, "ok");
      loadStats();
    } catch (err) {
      setStatus("import-status", "Import failed: " + err.message +
        " — expected a ChatGPT, Claude, or Gemini Takeout export (.zip or .json).", "err");
    }
    e.target.value = "";
  });

  /* ---------- encrypted reinstall backup ---------- */

  let restoreFile = null;

  /** Live strength meter. The passphrase is the only thing protecting the file. */
  function paintStrength() {
    const value = $("backup-passphrase").value;
    const meter = $("backup-strength");
    if (!value) { meter.hidden = true; return; }
    const rated = crypt.ratePassphrase(value);
    meter.hidden = false;
    meter.dataset.score = String(rated.score);
    meter.querySelector(".strength-text").textContent = rated.ok
      ? ["", "Weak", "Fair", "Strong", "Very strong"][rated.score] || "Strong"
      : rated.reason;
  }
  $("backup-passphrase").addEventListener("input", paintStrength);

  async function collectSnapshot() {
    const state = await send({ type: "recall-sync-status" });
    if (state && state.running) throw new Error("Wait for the current sync to finish before creating a backup");

    // Read via the worker, not the page's own IndexedDB handle — the gate has
    // to sit in front of the data, and only bg.js can hold it there.
    const snap = await send({ type: "recall-snapshot" });
    if (snap && snap.err === "locked") throw new Error(LOCK_COPY);
    if (!snap || snap.err) throw new Error("Could not read the archive");
    const chats = snap.chats || [];
    const durable = snap.durable;
    if (!durable || durable.err) throw new Error("Could not read the sync checkpoint");
    if (!chats.length) throw new Error("There is nothing archived to back up yet");
    return {
      format: crypt.PAYLOAD_FORMAT,
      version: 1,
      createdAt: Date.now(),
      chats,
      ledger: durable.ledger || { version: 2, checkpoints: {} },
      // The random salt is not secret. Keeping it inside the encrypted
      // payload lets a fresh browser derive the same opaque account key and
      // safely resume from this backup's checkpoint even without Chrome Sync.
      profile: durable.profile || null
    };
  }

  async function createReinstallBackup() {
    const passphrase = $("backup-passphrase").value;
    const confirmation = $("backup-passphrase-confirm").value;
    const rated = crypt.ratePassphrase(passphrase);
    if (!rated.ok) throw new Error(rated.reason);
    if (passphrase !== confirmation) throw new Error("The passphrases do not match");

    const payload = await collectSnapshot();
    const sealed = await crypt.seal(payload, { passphrase });
    const stamp = new Date().toISOString().slice(0, 10);
    const filename = `long-chat-toolkit-${stamp}.lctbackup`;
    download(new Blob([sealed.json], { type: "application/octet-stream" }), filename);
    await send({ type: "recall-backup-mark", meta: { chats: payload.chats.length, filename } });

    // Setting automatic backup up from the same passphrase costs one extra key
    // derivation and removes the only reason a reinstall ever loses anything:
    // needing to remember to press this button before uninstalling.
    let automatic = "";
    if ($("backup-auto").checked) {
      try {
        const keyring = await crypt.mintKeyring(passphrase);
        const result = await send({ type: "recall-autobackup-enable", config: { keyring, everyHours: 24 } });
        automatic = result && result.ok ? " Automatic backups are on." : " Automatic backup could not be enabled.";
      } catch { automatic = " Automatic backup could not be enabled."; }
    }

    $("backup-passphrase").value = "";
    $("backup-passphrase-confirm").value = "";
    $("backup-strength").hidden = true;
    setStatus("backup-status", `${payload.chats.length.toLocaleString()} chats encrypted in ${filename}.${automatic}`, "ok");
    await paintAutoBackup();
  }

  $("create-backup").addEventListener("click", async () => {
    const button = $("create-backup");
    button.disabled = true;
    setStatus("backup-status", "Encrypting your local archive…");
    try { await createReinstallBackup(); }
    catch (error) { setStatus("backup-status", String(error.message || error), "err"); }
    finally { button.disabled = false; }
  });

  /* ---------- automatic backup ---------- */

  async function paintAutoBackup() {
    const state = await send({ type: "recall-autobackup-state" });
    if (!state || state.err) return;
    $("autobackup-actions").hidden = !state.enabled;
    if (!state.enabled) {
      setStatus("autobackup-status", "Automatic backup is off — the archive only leaves this browser when you press the button.", "");
      return;
    }
    const where = `${state.folder}/${state.filename} in your downloads folder`;
    if (state.lastError) {
      setStatus("autobackup-status", `Automatic backup is on, but the last attempt failed: ${state.lastError}`, "err");
    } else if (state.lastAt) {
      setStatus("autobackup-status",
        `Automatic backup is on — ${state.lastChats.toLocaleString()} chats written ${timeAgo(state.lastAt)} to ${where}. Same passphrase, same encryption.`, "ok");
    } else {
      setStatus("autobackup-status", `Automatic backup is on — the first file will be written to ${where}.`, "");
    }
  }

  $("autobackup-run").addEventListener("click", async () => {
    const button = $("autobackup-run");
    button.disabled = true;
    setStatus("autobackup-status", "Writing an encrypted backup…");
    const result = await send({ type: "recall-autobackup-run" });
    if (result && result.status === "ok") await paintAutoBackup();
    else setStatus("autobackup-status", `Backup did not run: ${(result && (result.error || result.status)) || "unknown reason"}`, "err");
    button.disabled = false;
  });

  $("autobackup-off").addEventListener("click", async () => {
    await send({ type: "recall-autobackup-disable" });
    await paintAutoBackup();
  });

  paintAutoBackup();

  $("restore-file").addEventListener("change", (event) => {
    restoreFile = event.target.files && event.target.files[0];
    $("restore-file-name").textContent = restoreFile ? restoreFile.name : "No backup selected";
    $("restore-run").disabled = !restoreFile || !canRestore;
    setStatus("restore-status", canRestore ? "" : LOCK_COPY);
  });

  function waitLabel(ms) {
    const seconds = Math.ceil(ms / 1000);
    if (seconds < 90) return `${seconds} seconds`;
    return `${Math.ceil(seconds / 60)} minutes`;
  }

  async function restoreReinstallBackup() {
    if (!restoreFile) throw new Error("Choose an encrypted backup file first");
    // Throttling lives in the worker, so reloading this page — or opening a
    // second one — cannot reset the count on a wordlist run.
    const guard = await send({ type: "recall-restore-guard" });
    if (guard && guard.err === "locked") { loadPlan(); throw new Error(LOCK_COPY); }
    if (guard && !guard.allowed) {
      throw new Error(`Too many failed passphrase attempts. Try again in ${waitLabel(guard.waitMs)}.`);
    }
    if (restoreFile.size > crypt.MAX_FILE_BYTES) throw new Error("This file is too large to be a backup");
    const passphrase = $("restore-passphrase").value;
    if (!passphrase) throw new Error("Enter the backup passphrase");

    const text = await restoreFile.text();
    // Envelope shape is checked before any key work, so a malformed file fails
    // fast and never counts against the attempt budget.
    crypt.inspect(text);

    let snapshot;
    try {
      snapshot = await crypt.open(text, passphrase);
    } catch (error) {
      const after = await send({ type: "recall-restore-guard-fail" });
      const suffix = after && !after.allowed ? ` Further attempts are paused for ${waitLabel(after.waitMs)}.` : "";
      throw new Error(String(error.message || error) + suffix);
    }
    await send({ type: "recall-restore-guard-reset" });

    // Merge, never replace: importBatch refuses to overwrite a newer archived
    // revision, so restoring an older backup on top of a browser that has
    // already re-synced adds only what is missing.
    let imported = 0, skipped = 0;
    for (let i = 0; i < snapshot.chats.length; i += 15) {
      setStatus("restore-status", `Restoring ${Math.min(i + 15, snapshot.chats.length)} of ${snapshot.chats.length} chats…`);
      const result = await send({ type: "recall-import", chats: snapshot.chats.slice(i, i + 15) });
      imported += (result && result.ok) || 0;
      skipped += (result && result.skipped) || 0;
    }
    const meta = { version: 1, createdAt: snapshot.createdAt || Date.now(), chats: snapshot.chats.length,
      filename: restoreFile.name };
    const restored = await send({
      type: "recall-restore-ledger", ledger: snapshot.ledger,
      profile: snapshot.profile, meta
    });
    if (!restored || restored.err) throw new Error("Chats were restored, but the sync checkpoint could not be restored");
    $("restore-passphrase").value = "";
    $("restore-file").value = "";
    restoreFile = null;
    $("restore-file-name").textContent = "No backup selected";
    $("restore-run").disabled = true;
    setStatus("restore-status",
      `${imported.toLocaleString()} chat${imported === 1 ? "" : "s"} added to the archive${skipped ? `, ${skipped} already here` : ""}. Checking the gap…`, "ok");
    await loadStats();
    await initSyncUI();
    chrome.runtime.sendMessage({ type: "recall-bg-sync" });
  }

  $("restore-run").addEventListener("click", async () => {
    const button = $("restore-run");
    button.disabled = true;
    try { await restoreReinstallBackup(); }
    catch (error) { setStatus("restore-status", String(error.message || error), "err"); }
    finally { button.disabled = !restoreFile || !canRestore; }
  });

  $("recovery-skip").addEventListener("click", async () => {
    await send({ type: "recall-recovery-skip" });
    setStatus("restore-status", "Dismissed. The archive keeps rebuilding itself from your providers.", "ok");
    await initSyncUI();
  });

  /* ---------- deleted-upstream review ----------
   * The archive deliberately outlives the provider unless the user says
   * otherwise, so every removal is a decision made here. */

  const PLATFORM_NAMES = { chatgpt: "ChatGPT", claude: "Claude", deepseek: "DeepSeek", grok: "Grok", gemini: "Gemini" };

  function deletionRow(item) {
    const row = document.createElement("div");
    row.className = "deletion-row";
    row.dataset.id = item.id;

    const main = document.createElement("div");
    main.className = "deletion-main";
    const title = document.createElement("span");
    title.className = "deletion-title";
    title.textContent = item.title || "Untitled conversation";
    const meta = document.createElement("span");
    meta.className = "deletion-meta";
    const bits = [PLATFORM_NAMES[item.platform] || item.platform || "Unknown"];
    if (item.messages) bits.push(`${item.messages.toLocaleString()} message${item.messages === 1 ? "" : "s"}`);
    if (item.detectedAt) bits.push(`noticed ${timeAgo(item.detectedAt)}`);
    meta.textContent = bits.join(" · ");
    main.append(title, meta);

    const actions = document.createElement("div");
    actions.className = "deletion-actions";
    const keep = document.createElement("button");
    keep.type = "button";
    keep.textContent = "Keep";
    keep.addEventListener("click", () => resolveDeletion([item.id], "keep"));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "secondary danger-action";
    remove.textContent = "Delete";
    remove.addEventListener("click", () => resolveDeletion([item.id], "delete"));
    actions.append(keep, remove);

    row.append(main, actions);
    return row;
  }

  async function resolveDeletion(ids, action) {
    const result = await send({ type: "recall-deletions-resolve", ids, action });
    if (!result || result.err) { setStatus("deletions-status", "That could not be saved", "err"); return; }
    setStatus("deletions-status", action === "delete"
      ? `${result.count} removed from your backup.`
      : `${result.count} kept. They stay searchable here even though the site no longer has them.`, "ok");
    await paintDeletions();
    await loadStats();
  }

  async function paintDeletions() {
    const state = await send({ type: "recall-deletions" });
    if (!state || state.err) return;
    const items = state.items || [];
    $("deletion-policy").value = state.policy || "ask";
    $("deletions").hidden = !items.length;
    if (!items.length) return;
    $("deletions-count").textContent = items.length === 1 ? "1 chat" : `${items.length} chats`;
    $("deletions-list").replaceChildren(...items.map(deletionRow));
  }

  $("deletions-keep-all").addEventListener("click", () => resolveDeletion([], "keep"));
  $("deletions-delete-all").addEventListener("click", function () {
    // Same arming pattern as the wipe button: bulk deletion of the only
    // remaining copy should never be one stray click away.
    if (this.dataset.armed !== "1") {
      this.dataset.armed = "1";
      this.textContent = "Click again to delete them permanently";
      setTimeout(() => { this.dataset.armed = ""; this.textContent = "Delete all from backup"; }, 5000);
      return;
    }
    this.dataset.armed = "";
    this.textContent = "Delete all from backup";
    resolveDeletion([], "delete");
  });

  $("deletion-policy").addEventListener("change", async () => {
    const value = $("deletion-policy").value;
    const { settings } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({ settings: { ...(settings || {}), deletionPolicy: value } });
    setStatus("deletions-status", value === "keep"
      ? "Your backup now outlives the provider. Deleted chats stay here and you will not be asked again."
      : value === "mirror"
        ? "Your backup now mirrors the provider. Chats deleted there will be deleted here too, without asking."
        : "You will be asked each time a chat is deleted on the site.", "ok");
    if (value !== "ask") await resolveDeletion([], value === "mirror" ? "delete" : "keep");
  });

  paintDeletions();
  if (location.hash === "#deletions") {
    $("deletions").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /* ---------- background-owned history sync ---------- */

  const APPS = [
    { id: "chatgpt", label: "ChatGPT" },
    { id: "claude", label: "Claude" },
    { id: "deepseek", label: "DeepSeek" },
    { id: "grok", label: "Grok" }
  ];
  const progKey = (id) => "recall-sync-progress:" + id;
  const activeAccountKey = "lct-recall-active-account-v1";

  function pct(p) {
    if (!p || !p.total) return "";
    return " (" + Math.min(100, Math.round((p.done / p.total) * 100)) + "%)";
  }

  function timeAgo(ms) {
    if (!ms) return "";
    const sec = Math.floor((Date.now() - ms) / 1000);
    if (sec < 60) return "just now";
    const min = Math.floor(sec / 60);
    if (min < 60) return min + " min ago";
    const hr = Math.floor(min / 60);
    return hr + "h ago";
  }

  function renderRow(app) {
    let row = document.getElementById("sync-row-" + app.id);
    if (!row) {
      row = document.createElement("div");
      row.id = "sync-row-" + app.id;
      row.className = "sync-row";
      $("sync-rows").appendChild(row);
    }
    return row;
  }

  function paintRow(app, platform) {
    const row = renderRow(app);
    row.replaceChildren();
    const p = platform && platform.progress;
    const name = document.createElement("b");
    name.textContent = app.label;
    const status = document.createElement("span");
    status.className = "sync-status";
    row.dataset.phase = (p && p.state === "syncing" ? "syncing" : "") ||
      (platform && platform.phase) || (p && p.phase) || "needs-sync";
    if (p && p.state === "syncing") {
      status.textContent = (p.msg || "Checking…") + pct(p);
    } else if (p && (p.state === "error" || p.state === "interrupted")) {
      status.textContent = p.msg;
      status.classList.add("err");
    } else if (p && (p.state === "paused" || p.state === "deferred")) {
      // Waiting on a rate limit or on the user's own tab is neither an error
      // nor "ready to check" — say which, so nobody re-clicks and re-triggers it.
      status.textContent = p.msg;
    } else if (platform && platform.phase === "up-to-date") {
      const checkedAt = platform.checkpoint?.completedAt || p?.at || 0;
      const coverage = platform.checkpoint?.coverage || 0;
      // The headline verdict lives in the summary above; a row only has to say
      // what it holds and when it last looked.
      status.textContent = (coverage ? `${coverage.toLocaleString()} chats archived` : "Up to date") +
        (checkedAt ? ` · checked ${timeAgo(checkedAt)}` : "");
      status.classList.add("ok");
    } else { status.textContent = "Ready to check"; }
    row.append(name, status);
  }

  function updateSyncButton(syncing) {
    const btn = $("sync-all");
    if (syncing) {
      btn.textContent = "Checking…";
      btn.disabled = true;
      btn.classList.add("syncing");
    } else {
      btn.textContent = "Check for new chats";
      btn.disabled = false;
      btn.classList.remove("syncing");
    }
  }

  async function refreshSyncRows() { await initSyncUI(); }

  async function initSyncUI() {
    const status = await send({ type: "recall-sync-status" });
    if (!status || status.err) return;
    const recovery = status.recovery || { state: "ready" };
    // A reinstall no longer blocks anything: archiving has already restarted by
    // the time this paints. Restoring the old file is a shortcut that fills in
    // everything the providers no longer list, not a prerequisite.
    const offered = recovery.state === "restore-offered";
    $("recovery").hidden = false;
    $("recovery").classList.toggle("urgent", offered);
    $("recovery-title").textContent = offered ? "Bring your previous archive back" : "Restore an existing archive";
    $("recovery-skip").hidden = !offered;
    if (offered && recovery.backup) {
      $("recovery-copy").textContent = `This looks like a fresh install, and a ${Number(recovery.backup.chats || 0).toLocaleString()}-chat encrypted backup was made before it. Archiving has already restarted on its own and is adding only what is missing — restore the file to bring back everything older than your providers still list.`;
    } else {
      $("recovery-copy").textContent = "Choose an encrypted Long Chat Toolkit backup to merge it into this browser. Chats already archived here are left alone; only what is missing is added.";
    }
    $("sync-rows").replaceChildren();
    for (const app of APPS) paintRow(app, status.platforms && status.platforms[app.id]);
    paintSummary(status.summary);
    updateSyncButton(!!status.running);
    paintDeletions();
  }

  function paintSummary(summary) {
    const node = $("sync-summary");
    if (!summary || summary.state === "never") { node.hidden = true; return; }
    node.hidden = false;
    node.dataset.state = summary.state;
    if (summary.state === "current") {
      node.textContent = summary.message +
        (summary.checkedAt ? " · last checked " + timeAgo(summary.checkedAt) : "") +
        (summary.connected ? ` · ${summary.connected} provider${summary.connected === 1 ? "" : "s"}` : "");
    } else if (summary.state === "syncing" && summary.total) {
      node.textContent = `${summary.message} (${Math.min(100, Math.round((summary.done / summary.total) * 100))}%)`;
    } else {
      node.textContent = summary.message;
    }
  }

  initSyncUI();

  chrome.storage.onChanged.addListener((changes, area) => {
    // Plan changes have to land here too: without this an open Recall tab keeps
    // its search box after a licence is removed or revoked, until a reload.
    if (area === "local" && (changes.license || changes.trial)) loadPlan();
    if ((area === "local" && APPS.some((a) => changes[progKey(a.id)])) ||
        (area === "local" && changes[activeAccountKey]) ||
        (area === "sync" && changes["lct-recall-sync-ledger-v2"])) {
      refreshSyncRows();
      loadStats();
    }
  });

  // Automatic checks. The setting lives in the shared `settings` object, so it
  // is merged rather than written whole — the popup owns the other keys.
  (async () => {
    try {
      const { settings } = await chrome.storage.local.get("settings");
      $("auto-sync").checked = !settings || settings.autoSync !== false;
    } catch { /* storage unavailable */ }
  })();

  $("auto-sync").addEventListener("change", async () => {
    const { settings } = await chrome.storage.local.get("settings");
    await chrome.storage.local.set({
      settings: { ...(settings || {}), autoSync: $("auto-sync").checked }
    });
  });

  $("sync-all").addEventListener("click", async () => {
    const status = await send({ type: "recall-sync-status" });
    if (status && status.running) {
      refreshSyncRows();
      return;
    }
    $("sync-rows").replaceChildren();
    for (const app of APPS) paintRow(app, { progress: { state: "syncing", msg: "Starting…" }, phase: "checking" });
    updateSyncButton(true);
    send({ type: "recall-bg-sync" }).then(initSyncUI);
  });

  /* ---------- wipe (two clicks — no confirm() popups) ---------- */

  let armed = false;
  $("wipe").addEventListener("click", async () => {
    const btn = $("wipe");
    if (!armed) {
      armed = true;
      btn.classList.add("armed");
      btn.textContent = "Click again to permanently delete";
      setTimeout(() => {
        armed = false;
        btn.classList.remove("armed");
        btn.textContent = "Delete my archive";
      }, 4000);
      return;
    }
    await send({ type: "recall-wipe" });
    armed = false;
    btn.classList.remove("armed");
    btn.textContent = "Delete my archive";
    loadStats();
    initSyncUI();
    $("results").replaceChildren();
    $("q-meta").textContent = "";
  });

  loadPlan().then(() => { loadStats(); $("q").focus(); });
})();
