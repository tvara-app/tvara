# Long Chat Toolkit — Complete User Guide

**Version 0.5.0 · Chrome / Edge (Manifest V3)**

Long Chat Toolkit fixes the thing every heavy AI user hits eventually: after a
few hundred messages, ChatGPT, Claude and the rest grind to a halt — typing
lags, scrolling stutters, the fan spins up. This extension makes a
2,000-message chat feel like a 20-message chat, and then gives you the
navigation tools those sites never built: a minimap, search, an auto table of
contents, starred messages, timestamps, one-click backup — and Total Recall, one search box for every AI conversation you've ever had.

Everything runs **100% on your device**. The extension has **zero network
permissions** — it is technically incapable of sending your conversations
anywhere. That's not a promise, it's enforced by the browser.

---

## 1. What problem does it solve?

AI chat sites keep every message of a conversation fully rendered in the page
forever. The browser pays layout/paint cost for all of it on every keystroke
and every scroll — that's why long chats feel broken.

Other "speed up ChatGPT" extensions fix this by **deleting or truncating** old
messages — your history is gone until you reload. Long Chat Toolkit uses a
different mechanism: messages outside your view are **put to sleep** (native
CSS `content-visibility` windowing) and **wake instantly** when you scroll
back to them. Nothing is ever removed, hidden or mutated. Scrollback, Ctrl+F…
everything still works — it's just fast.

---

## 2. Installation

**From the store (normal users):** install from the Chrome Web Store / Edge
Add-ons page, then open any supported AI chat site. That's it — the speed
engine is on by default.

**From source (developers):**
1. Clone the repo, open `chrome://extensions`
2. Enable **Developer mode** → **Load unpacked** → select the repo folder
3. Open a long chat, or the bundled test page:
   `cd` into the repo, run `python3 -m http.server 8080`, and visit
   `http://localhost:8080/test/demo.html` (a realistic 1,500-message chat)

No account. No signup. No settings you *have* to touch.

---

## 3. Supported platforms

| Platform | Speed engine | Tools (minimap, search, outline, stars, timestamps, backup) |
|---|---|---|
| **ChatGPT** (chatgpt.com) | ✅ Free | ✅ Free |
| **Perplexity** | ✅ Free | ✅ Free (support is experimental) |
| **DeepSeek** (chat.deepseek.com) | ✅ Free | ✅ Free (support is experimental) |
| **Grok** (grok.com) | ✅ Free | ✅ Free (support is experimental) |
| **Claude** (claude.ai) | ✅ Free | 🔒 Pro — or free during the 7-day trial |
| **Gemini** | ✅ Free | 🔒 Pro — or free during the 7-day trial |

The speed engine is **free on every platform, forever**. "Experimental" means
the site's page structure can't be guaranteed yet — if something doesn't
appear there, the extension safely does nothing rather than breaking the page.

---

## 4. The features, one by one

### 🧠 Total Recall — search every chat, every platform (Pro)
**The problem it solves:** "I solved this in *some* chat… ChatGPT? Claude?
Which one?" Your knowledge is scattered across hundreds of chats on five
sites, none of which can search each other.
**What it does:** press **⌘⇧K / Ctrl+Shift+K** on any chat site (or open the
Recall page from the popup) → one search box across **every archived chat on
every platform** → click a result and land in that chat with the in-chat
search already open on your words.
**How the archive builds:**
- **One button, all history:** open the Recall page → **Sync all history**. It
  asks your open ChatGPT and Claude tabs to pull every conversation — titles,
  dates and full text — straight from your own account, showing live progress
  per app. Apps that aren't open get a one-click **Open & sync**. Big
  histories take a while and keep going in that tab; you can walk away.
- **Automatic forever after:** once synced, ChatGPT and Claude quietly keep
  themselves current every time you visit — no button, no thought.
- **Every platform, always:** any chat you open on any site is archived as you
  read it. Gemini, Grok, DeepSeek and Perplexity have no history API (their own
  platforms don't expose one), so they rely on this open-and-archive path — or
  a Claude/ChatGPT export file you drop on the Recall page.

**Privacy, provable:** the archive lives in your browser's local extension
storage. This extension has **no network permissions**, so the archive
physically cannot be uploaded anywhere. The Recall page shows exactly what's
stored (chats, messages, MB) and has a delete-everything button.
**Honesty note:** without an import, Recall only knows chats you've opened
since installing — it says so rather than pretending otherwise.

### ⚡ Speed engine
**What it does:** puts off-screen messages to sleep so the browser stops
paying for what you can't see. A safety zone above and below your viewport
(±1.5 screens) stays awake so scrolling never shows blanks.
**How to use it:** nothing — it's automatic on chats longer than ~25 messages.
The popup shows live proof: *"1,491 messages asleep right now"*, per site,
as an honest **"1,491 of 1,500"** count.
**Turn it off:** popup → *Speed engine* toggle.

### 🗺️ Minimap
**What it does:** a VS Code-style strip on the right edge showing the shape of
the whole conversation — your prompts, AI replies, code blocks — with a count
pill on top.
**How to use it:** hover any bar for a preview of that message; click to jump
there. The `‹` handle collapses/expands the strip. Under the minimap sits a
small toolbar with three buttons: **☰ outline**, **⤓ Markdown backup**,
**{ } JSON backup**.

### 📑 Outline — auto table of contents
**What it does:** builds a live table of contents from every prompt you sent
plus every heading in the AI's answers. For very long chats it lists the first
400 entries and says so on screen — it never silently truncates.
**How to use it:** click **☰** on the minimap toolbar. Click any entry to jump
straight to that part of the chat (the target pulses so you can't lose it).
Two tabs: **Outline** (everything) and **Starred** (only what you starred).
Press `Esc` to close.

### ⭐ Starred messages
**What it does:** bookmarks inside a conversation. The gold in a 500-message
brainstorm — the final schema, the working function — stays one click away.
**How to use it:** hover any message → a small ☆ button appears near its top
right corner → click it. The message gets a gold edge. Find all starred
messages in the outline's **Starred** tab. Click the ★ again to unstar.
Stars are saved per conversation, locally, and survive reloads.

### 🔎 In-chat search
**What it does:** instant full-text search across the entire loaded
conversation — **including sleeping messages** (it searches a text cache, not
the rendered page, so speed mode costs you nothing).
**How to use it:** press **⌘⇧F** (Mac) / **Ctrl+Shift+F** (Windows/Linux).
Type — the match counter updates live. **Enter** jumps to the next match,
**Shift+Enter** to the previous, **Esc** closes. Each jump scrolls to the
match and pulses it.

### 🕒 Message timestamps
**What it does:** AI chat sites never show *when* anything was said. Hover
any message and a small time tag appears.
**Honesty rule:** on **ChatGPT** you get the *real send time* of your entire
history (read locally from the app's own state by a tiny read-only script —
no network, no changes to the page). On other sites, browsers simply don't
have historical send times — so messages are stamped from the moment the
extension first sees them and labeled **"First seen … · this device"**.
Messages that existed before install honestly say **"Time unknown (sent
before install)"**. A first-seen time is never dressed up as a send time.
**Turn it off:** popup → *Timestamps* toggle.

### 🪪 Chat Card — sidebar hover insights
**What it does:** hover any conversation in the site's sidebar and a small
card tells you about that chat before you open it: how many messages it has,
how many questions you asked, how many messages you starred, when it was
created or first seen, when you last opened it — and whether it's your
longest chat on that site.
**How to use it:** just hover a chat in the sidebar for a moment. No clicks.
**The honesty rules (read this):**
- The card only knows chats you've **opened at least once** since installing —
  the sites don't put other chats' data in the page, and this extension has no
  network access to ask their servers. Unopened chats say "Not tracked yet."
- On **ChatGPT** the card shows the chat's **real creation time** (from the
  app's own local state). On other sites it says "First seen … · this device" —
  we never dress a first-seen date up as a creation date.
- "Your longest **visited** chat" means exactly that — longest among chats
  we've seen, never a claim about your whole history.
- Counts are from the last time you opened the chat, so a chat that grew since
  then shows its last-known size.

### ⤵ Resume where you left off
**What it does:** remembers the exact message you were reading in each long
chat — anchored to the message itself, not pixel position, so it survives
reloads and layout changes.
**How to use it:** reopen a long chat. If your last reading position is
off-screen, a **"↓ Resume where you left off"** chip appears — click it to
jump back. Scroll away deliberately and the chip dismisses itself.

### 💾 One-click backup
**What it does:** exports the loaded conversation to a clean file on your
disk — your chats belong to you, not to a tab.
**How to use it:** minimap toolbar → **⤓** for **Markdown** (headings, lists,
code fences and timestamps preserved — drops straight into Obsidian/Notion)
or **{ }** for **JSON** (structured: role, text, timestamp per message — for
your own scripts).

---

## 5. The popup (click the toolbar icon)

- **Badge** — your current plan: `Free`, `Trial` (amber) or `Pro`.
- **Big number** — messages asleep right now, with a per-site "N of total"
  breakdown. This is the engine's live proof of work.
- **Three toggles** — Speed engine · Minimap · Timestamps. Changes apply
  to open tabs instantly; no reload needed.
- **Upgrade card** (when not Pro) — the trial button, the license field, and
  what Pro includes.

---

## 6. Free trial, Pro, and licensing

- **7-day free trial:** popup → *"Start 7-day free trial — no signup"*. One
  click. Every tool unlocks on every platform, including Claude and Gemini.
  The popup counts down the days; when it ends, free platforms stay free and
  the speed engine stays on everywhere.
- **Pro — $9, once, forever:** no subscription, no account. Buying gets you a
  license key (`LCT1.…`) tied to your email.
- **Activating:** popup → paste the key → **Activate**. Verification is
  cryptographic (ECDSA P-256) and happens **entirely offline** — no server is
  contacted, ever. After activation the key is stored locally and never
  displayed again (so a screenshot or screen-share can't leak it); the popup
  shows only a masked email like `te•••@gmail.com`.
- **Moving to a new browser:** click **Remove** in the popup, then activate
  on the new machine with the same key.
- **Lost your key:** contact support from your purchase email.

---

## 7. Privacy — provable, not promised

- **Zero network permissions.** Open `manifest.json`: the only permission is
  `storage`. The browser itself prevents this extension from making network
  requests. Your conversations cannot leave your machine through it.
- **No accounts, no analytics, no telemetry, no remote code.**
- **Everything is stored locally:** settings, reading positions, stars,
  first-seen times, license key — in your browser's extension storage.
- **ChatGPT timestamp script:** the one page-world script (ChatGPT only) is
  bundled, unminified, read-only, and makes no network calls. It reads
  message times from ChatGPT's own in-page state and nothing else.
- **Open source.** Read every line: the repo is public.

**Uninstalling** removes all extension data. Backups you exported are
ordinary files on your disk and stay yours.

---

## 8. Troubleshooting & FAQ

**The minimap/tools don't appear on a site.**
The chat may be shorter than ~25 messages (the engine doesn't bother below
that), or the site is one of the experimental platforms whose page structure
changed. The extension never breaks a page — it just steps back. Check the
popup: if the site row shows counts, the engine is working.

**Do the tools appear on Claude/Gemini without Pro?**
Only during the trial. The speed engine itself always works there for free.

**Does the speed engine change or delete my messages?**
No. Sleeping messages remain in the page, untouched. Scroll to them — or
search — and they're there. Backup exports include them too.

**Why does my message say "Time unknown (sent before install)"?**
Outside ChatGPT, browsers have no way to know historical send times. We
refuse to fake one. Every message from install day onward gets a real
first-seen stamp.

**Search finds text I can't see.**
That's by design — it searches sleeping messages too and wakes the right one
when you jump.

**Does the trial reset if I reinstall?**
Trial state lives in local extension storage. We keep it honest but simple —
it's a convenience, not a fortress. The product costs $9 once; if you find
yourself gaming the trial twice, it's probably worth the coffee money.

**Something glitched on a site update.**
AI sites ship UI changes constantly. If a feature stops appearing, it's
usually a selector that needs a one-line update — report it on GitHub and it
gets fixed fast. The speed engine is deliberately built to fail silent and
safe.

---

## 9. Keyboard reference

| Keys | Action |
|---|---|
| `⌘⇧K` / `Ctrl+Shift+K` | Total Recall — search across ALL chats (Pro) |
| `⌘⇧F` / `Ctrl+Shift+F` | Open in-chat search |
| `Enter` / `Shift+Enter` | Next / previous match |
| `Esc` | Close search or outline panel |

---

*Long Chat Toolkit is an independent open-source project. It is not
affiliated with OpenAI, Anthropic, Google, Perplexity, DeepSeek or xAI.
Product names belong to their owners.*
