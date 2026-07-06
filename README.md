# ⚡ Long Chat Toolkit

**Make long AI chats fast again.** Speed windowing, minimap navigation & one-click backup for ChatGPT, Claude, Gemini & Perplexity.

Long conversations grind AI chat UIs to a halt — every message stays fully rendered forever, so a 1,000-message chat means seconds of typing lag and a screaming fan. This toolkit fixes that, locally, in your browser.

## Features

- **⚡ Speed engine** — off-screen messages are windowed with native CSS `content-visibility`, so the browser stops paying for what you can't see. Messages wake instantly when scrolled to. Nothing is removed or mutated.
- **🗺️ Minimap** — a VS Code–style strip of the whole conversation. Your messages, AI messages, code blocks. Hover for previews, click anywhere to jump.
- **🔎 In-chat search** (`⌘⇧F` / `Ctrl+Shift+F`) — searches every message instantly, *including the ones asleep*. The browser's Ctrl+F can't see what isn't rendered; this can.
- **⤵ Resume where you left off** — reopen a long chat and one tap returns you to your exact spot.
- **💾 One-click backup** — export the entire conversation to clean Markdown or JSON, downloaded straight to your disk.

## Pricing

The speed engine is **free everywhere, forever**. Minimap, search & backup are free on ChatGPT; **Pro — $9 once, no subscription** — unlocks them on Claude, Gemini & Perplexity.

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

Private key lives in `tools/.keys/` (gitignored). **Back it up.**

## Architecture

```
content/adapters.js   platform selectors (defensive, multi-fallback, degrade-to-nothing)
content/engine.js     content-visibility windowing + mutation/SPA observers
content/minimap.js    canvas minimap (one draw call, any chat size)
content/exporter.js   Markdown/JSON extraction with code-fence preservation
content/search.js     in-chat search over the full message cache (windowed included)
content/main.js       orchestrator: settings/license/pricing wiring, resume chip
lib/license.js        offline ECDSA license verification (WebCrypto)
popup/                settings UI
```

Design rule: **never break the host page.** Unknown DOM → do nothing. Selector drift → do nothing. Our worst case is the page's normal behavior.

## Store packaging

```bash
node tools/pack.mjs   # → dist/long-chat-toolkit-vX.Y.Z.zip, dev-only localhost matches stripped
```
