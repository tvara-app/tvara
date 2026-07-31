# ⚡ Long Chat Toolkit

**Make long AI chats fast again.** Speed windowing, minimap, outline, search, starred messages & one-click backup for ChatGPT, Claude, Gemini, Perplexity, DeepSeek & Grok.

📖 **[Complete user guide →](docs/USER-GUIDE.md)**

Long conversations grind AI chat UIs to a halt — every message stays fully rendered forever, so a 1,000-message chat means seconds of typing lag and a screaming fan. This toolkit fixes that, locally, in your browser.

## Features

- **🌉 Context Bridge (Pro)** — the memory layer for all your AI. Composing a prompt on any site? Press `⌘⇧U` / `Ctrl+Shift+U`: Recall finds relevant passages from your entire cross-platform history, you pick, and it injects them into your prompt — so the model you're already using answers *with* your accumulated knowledge. No servers, no API keys (it feeds context to the model you're already in), all local. Fails safe to the clipboard if the prompt box can't be found. Shortcut is a browser-native, remappable command (works across Chrome/Edge/Firefox and every OS).
- **🗺️ Instant complete map** — on ChatGPT the minimap shows every message the moment you open a conversation, while the page has only rendered the tail, and without scrolling anything. Hover any point in the history and read it; click it and it opens instantly while the site loads its way back to it.
- **🧠 Total Recall (Pro)** — one search box for every AI conversation you've ever had, across all platforms (`⌘⇧K` / `Ctrl+Shift+K`). Its background archive worker keeps itself current — a check runs roughly every 3 hours, shortly after the browser starts, and whenever you open one of the chat sites (switchable off), reading only the new gap in your own ChatGPT, Claude, DeepSeek or Grok history, with account-scoped checkpoints and no full resync on reload. One percentage covers the whole pass. Archive text stays local; there is no Long Chat Toolkit server or telemetry.
- **⚡ Speed engine** — off-screen messages are windowed with native CSS `content-visibility`, so the browser stops paying for what you can't see. On long virtualized ChatGPT conversations, an initial pass asks the host to mount older available turns, then returns you to where you were reading. Messages wake instantly when scrolled to. Nothing is removed or mutated.
- **🕒 Message timestamps** — AI chat sites don't show *when* anything was said; hover any message to see its time. ChatGPT: real send times for the entire history (read locally from the app's own state by a tiny read-only page-world script). Claude/Gemini: honest "first seen on this device" times from the moment you install — never faked as send times.
- **🗺️ Minimap** — a compact conversation navigator for the whole loaded chat. Your messages, AI messages, code blocks. Hover for previews and times, click anywhere to jump, or use Home, End, Page Up, Page Down and arrow keys while it is focused.
- **🔎 In-chat search** (`⌘⇧F` / `Ctrl+Shift+F`) — instant full-text search of the whole loaded conversation with match counter and Enter/Shift+Enter jumping, even across sleeping messages (we search a text cache, not the rendered page).
- **⤵ Resume where you left off** — reopen a long chat and one tap returns you to the exact message you were reading (anchored to the message, not pixels — survives reloads and reflows).
- **🗑️ Deleted there ≠ deleted here** — when a chat disappears from the provider, the archived copy is *not* thrown away with it. It is quarantined, flagged in the popup and listed on the Recall page with its title and message count, and you decide: keep the backup copy, or delete it here too. Standing policies exist for both extremes (`always keep` / `always mirror`). A once-daily full listing is what notices deletions at all — and it refuses to act on an implausible one, so a signed-out session can never present your whole archive for deletion.
- **🔁 Automatic encrypted backup** — set a passphrase once and the worker keeps writing a `.lctbackup` to `Downloads/Long Chat Toolkit/` on a schedule, so a reinstall never costs you an archive. The passphrase is never stored, never synced and not recoverable; the file is AES-256-GCM under a wrapped random file key with the header authenticated, so editing the KDF cost or any other parameter breaks the tag instead of being obeyed.
- **♻️ Reinstall picks up where you left off** — a fresh install starts re-archiving immediately and adds only what is missing, rather than blocking on a restore. Restoring the old file afterwards merges into it: chats already archived are left alone, older ones the provider no longer lists come back.
- **💾 One-click backup** — export the loaded conversation to clean, structured Markdown or JSON with timestamps, paragraphs, lists and code fences preserved.
- **📑 Outline** — an auto table of contents: every prompt you sent plus every heading in the answers, click to jump. Capped at 400 entries with the cap disclosed on screen.
- **⭐ Starred messages** — hover any message to star it; find the gold of a long brainstorm again in one click. Saved per conversation, locally.
- **🪪 Chat Card** — hover a conversation in the sidebar: message count, questions asked, stars, created (real time on ChatGPT) / first-seen date, last opened, and a "your longest visited chat" badge. Local records only — no API calls, chats you haven't opened honestly say "Not tracked yet".
- **⏳ Allowance left** — how much of each plan's limit you have left, as **the provider's own figure**, with the time it resets. It is a percentage because that is what these services actually meter: Claude weights a rolling multi-hour window by tokens, ChatGPT caps per model — so "31 of 45 messages" is a number with no referent, and we don't show one. The extension reads the quota data the sites already send your browser and, when you open the popup, asks the provider directly — which is why usage from your phone or another browser is included. **A provider that publishes nothing gets an empty ring and the words "not reported"**, never an estimate. Every figure is auditable: hover a row to see which field and which arithmetic produced it, or open **Allowance tracking → check accuracy** in the popup to compare it against what the site itself displays, side by side. Switchable off in one click.

## Pricing

The speed engine is **free everywhere, forever**. All tools are free on ChatGPT (and on Perplexity, DeepSeek & Grok while support is experimental). A **7-day free trial** — one click in the popup, no signup — unlocks everything on every platform. **Pro — $9 once, no subscription** — Total Recall on every platform (including ChatGPT) + all tools on Claude & Gemini, forever.

## 🔒 Privacy — provable, not promised

- **No Long Chat Toolkit server or telemetry.** The only network-capable paths are the declared first-party AI-provider endpoints, used to check history and — while **Allowance tracking** is on — to ask for your remaining plan allowance when you open the popup, when a page loads, and after you send a message (at most once a minute per provider). Archive text is kept in local extension storage; the only portable copy is the encrypted backup file.
- **The allowance observer reads numbers, not conversations.** To show a figure that agrees with the site, a page-world script watches the responses those sites already receive. It is passive: requests are never altered, blocked, delayed or replayed, and the page gets exactly what the network gave it. It reads rate-limit **response headers**, and it only opens a response body when the URL's own path says it is about limits — never chat traffic, never a stream. What crosses to the extension is a list of numbers (`remaining`, `limit`, `percentage`, `reset`); no bodies, no tokens, no URLs. Diagnostic samples replace every string long enough to be prose with its length before storing. This is the one place the extension hooks `fetch`/`XHR`, it is switchable off in the popup, and with it off the hooks disable themselves.
- **The backup file assumes it will be stolen.** PBKDF2-SHA256 at 1,000,000 rounds over a 32-byte random salt derives a key that only ever wraps a fresh random file key; the body is AES-256-GCM under that. Both layers authenticate the header, so a downgraded iteration count, a swapped compression field or a key envelope lifted from another file fails to open rather than opening weaker. Files declaring fewer than 600,000 rounds are refused outright. Repeated wrong passphrases lock the restore box with an escalating delay held in the worker, so reloading the page is not a way out of it. The passphrase is never stored, never synced, and cannot be recovered by anyone including us.
- **Backup key material never roams.** The wrapped file key that makes unattended backups possible lives in extension-local storage only — never `storage.sync`. Anything that can read it can already read the plaintext archive beside it, so it costs nothing; putting it on a sync server would.
- **Nothing deletes your archive but you.** No provider response, no failed request and no listing glitch removes archived text. The only code path that deletes is the one behind your answer to the prompt.
- **Licensing without an account.** Pro works on **5 devices** — release one from the popup any time. Activation contacts the payment provider's licence server once; after that the extension re-checks at most monthly and never withdraws Pro because of a network error. Keys sold before this (`LCT1.…`) stay fully offline, verified by ECDSA P-256 inside the extension.
- **Open source.** Read every line.

## Install (dev)

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.
2. Open a long ChatGPT/Claude/Gemini chat — or the torture test:
   ```bash
   cd test && python3 -m http.server 8080
   # visit http://localhost:8080/synthetic.html
   ```
3. Type in the input box with the extension off vs on. Feel it.

## License issuing (owner only)

```bash
node tools/genkey.mjs init                 # once — creates keypair, patches public key
node tools/genkey.mjs issue buyer@mail.com # per sale — prints their Pro key
```

The private key lives in `~/.lct-keys/` — outside this folder, because Chrome scans unpacked-extension directories and a signing key has no business inside one. **Back it up.**

## Architecture

```
content/adapters.js          platform selectors (defensive, multi-fallback, degrade-to-nothing)
content/engine.js            content-visibility windowing + IO safety zone + mutation/SPA observers
content/minimap.js           canvas minimap (one draw call, any chat size)
content/exporter.js          structured Markdown/JSON extraction (blocks, lists, code fences, times)
content/search.js            in-chat search over the full message cache (windowed included)
content/timeline.js          message times: first-seen clock + honest labeling + lazy-mount guard
content/inject/fiber-times.js ChatGPT exact times — read-only, page-world, no network, auto-degrades
content/main.js              orchestrator: settings/license/pricing wiring, anchor-based resume
bg.js                        archive DB, provider sync, deletion review, scheduled backup
lib/backup-crypto.js         the .lctbackup envelope — one implementation, both sides
lib/store.js                 storage wrapper that survives extension reloads
lib/license.js               license verdict: offline ECDSA (LCT1) or an activation receipt
lib/dodo.js                  Dodo Payments activation, 5-device seats, monthly re-check
popup/                       settings UI
```

Design rule: **never break the host page.** Unknown DOM → do nothing. Selector drift → do nothing. Our worst case is the page's normal behavior.

## Store packaging

```bash
node tools/pack.mjs   # → dist/long-chat-toolkit-vX.Y.Z.zip, dev-only localhost matches stripped
```
