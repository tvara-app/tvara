# ⚡ Long Chat Toolkit

**Make long AI chats fast again.** Speed windowing, minimap, outline, search, starred messages & one-click backup for ChatGPT, Claude, Gemini, Perplexity, DeepSeek & Grok.

📖 **[Complete user guide →](docs/USER-GUIDE.md)**

Long conversations grind AI chat UIs to a halt — every message stays fully rendered forever, so a 1,000-message chat means seconds of typing lag and a screaming fan. This toolkit fixes that, locally, in your browser.

## Features

- **🌉 Context Bridge (Pro)** — the memory layer for all your AI. Composing a prompt on any site? Press `⌘⇧U` / `Ctrl+Shift+U`: Recall finds relevant passages from your entire cross-platform history, you pick, and it injects them into your prompt — so the model you're already using answers *with* your accumulated knowledge. No servers, no API keys (it feeds context to the model you're already in), all local. Fails safe to the clipboard if the prompt box can't be found. Shortcut is a browser-native, remappable command (works across Chrome/Edge/Firefox and every OS).
- **🧠 Total Recall (Pro)** — one search box for every AI conversation you've ever had, across all platforms (`⌘⇧K` / `Ctrl+Shift+K`). Its background archive worker keeps itself current — a check runs roughly every 6 hours and shortly after the browser starts (switchable off), reading only the new gap in your own ChatGPT, Claude, DeepSeek or Grok history, with account-scoped checkpoints and no full resync on reload. One percentage covers the whole pass. Archive text stays local; there is no Long Chat Toolkit server or telemetry.
- **⚡ Speed engine** — off-screen messages are windowed with native CSS `content-visibility`, so the browser stops paying for what you can't see. Messages wake instantly when scrolled to. Nothing is removed or mutated.
- **🕒 Message timestamps** — AI chat sites don't show *when* anything was said; hover any message to see its time. ChatGPT: real send times for the entire history (read locally from the app's own state by a tiny read-only page-world script). Claude/Gemini: honest "first seen on this device" times from the moment you install — never faked as send times.
- **🗺️ Minimap** — a VS Code–style strip of the whole conversation. Your messages, AI messages, code blocks. Hover for previews and times, click anywhere to jump.
- **🔎 In-chat search** (`⌘⇧F` / `Ctrl+Shift+F`) — instant full-text search of the whole loaded conversation with match counter and Enter/Shift+Enter jumping, even across sleeping messages (we search a text cache, not the rendered page).
- **⤵ Resume where you left off** — reopen a long chat and one tap returns you to the exact message you were reading (anchored to the message, not pixels — survives reloads and reflows).
- **💾 One-click backup** — export the loaded conversation to clean, structured Markdown or JSON with timestamps, paragraphs, lists and code fences preserved.
- **📑 Outline** — an auto table of contents: every prompt you sent plus every heading in the answers, click to jump. Capped at 400 entries with the cap disclosed on screen.
- **⭐ Starred messages** — hover any message to star it; find the gold of a long brainstorm again in one click. Saved per conversation, locally.
- **🪪 Chat Card** — hover a conversation in the sidebar: message count, questions asked, stars, created (real time on ChatGPT) / first-seen date, last opened, and a "your longest visited chat" badge. Local records only — no API calls, chats you haven't opened honestly say "Not tracked yet".

## Pricing

The speed engine is **free everywhere, forever**. All tools are free on ChatGPT (and on Perplexity, DeepSeek & Grok while support is experimental). A **7-day free trial** — one click in the popup, no signup — unlocks everything on every platform. **Pro — $9 once, no subscription** — Total Recall on every platform (including ChatGPT) + all tools on Claude & Gemini, forever.

## 🔒 Privacy — provable, not promised

- **No Long Chat Toolkit server or telemetry.** The only network-capable paths are the declared first-party AI-provider endpoints used when you explicitly check history. Archive text is kept in local extension storage; the only portable copy is the encrypted backup file you choose to download.
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
