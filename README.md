# ⚡ Long Chat Toolkit

**Make long AI chats fast again.** Speed windowing, minimap, outline, search, starred messages & one-click backup for ChatGPT, Claude, Gemini, Perplexity, DeepSeek & Grok.

📖 **[Complete user guide →](docs/USER-GUIDE.md)**

Long conversations grind AI chat UIs to a halt — every message stays fully rendered forever, so a 1,000-message chat means seconds of typing lag and a screaming fan. This toolkit fixes that, locally, in your browser.

## Features

- **⚡ Speed engine** — off-screen messages are windowed with native CSS `content-visibility`, so the browser stops paying for what you can't see. Messages wake instantly when scrolled to. Nothing is removed or mutated.
- **🕒 Message timestamps** — AI chat sites don't show *when* anything was said; hover any message to see its time. ChatGPT: real send times for the entire history (read locally from the app's own state by a tiny read-only page-world script). Claude/Gemini: honest "first seen on this device" times from the moment you install — never faked as send times.
- **🗺️ Minimap** — a VS Code–style strip of the whole conversation. Your messages, AI messages, code blocks. Hover for previews and times, click anywhere to jump.
- **🔎 In-chat search** (`⌘⇧F` / `Ctrl+Shift+F`) — instant full-text search of the whole loaded conversation with match counter and Enter/Shift+Enter jumping, even across sleeping messages (we search a text cache, not the rendered page).
- **⤵ Resume where you left off** — reopen a long chat and one tap returns you to the exact message you were reading (anchored to the message, not pixels — survives reloads and reflows).
- **💾 One-click backup** — export the loaded conversation to clean, structured Markdown or JSON with timestamps, paragraphs, lists and code fences preserved.
- **📑 Outline** — an auto table of contents: every prompt you sent plus every heading in the answers, click to jump. Capped at 400 entries with the cap disclosed on screen.
- **⭐ Starred messages** — hover any message to star it; find the gold of a long brainstorm again in one click. Saved per conversation, locally.
- **📦 Collapse code blocks** — one toggle folds every code block to a single line; click to expand, double-click to fold back.

## Pricing

The speed engine is **free everywhere, forever**. All tools are free on ChatGPT (and on Perplexity, DeepSeek & Grok while support is experimental). A **7-day free trial** — one click in the popup, no signup — unlocks everything on every platform. **Pro — $9 once, no subscription** — keeps the tools unlocked on Claude & Gemini forever.

## 🔒 Privacy — provable, not promised

- **Zero network permissions.** Check `manifest.json`: this extension *cannot* make network requests. Your chats never leave your machine — not because we promise, but because the browser won't let us.
- **Offline licensing.** Pro keys are verified cryptographically (ECDSA P-256) inside the extension. No account, no server, no phone-home. Ever.
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
lib/license.js               offline ECDSA license verification (WebCrypto)
popup/                       settings UI
```

Design rule: **never break the host page.** Unknown DOM → do nothing. Selector drift → do nothing. Our worst case is the page's normal behavior.

## Store packaging

```bash
node tools/pack.mjs   # → dist/long-chat-toolkit-vX.Y.Z.zip, dev-only localhost matches stripped
```
