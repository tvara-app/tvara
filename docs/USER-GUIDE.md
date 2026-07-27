# Long Chat Toolkit — Complete User Guide

**Version 0.6.0 · Chrome / Edge (Manifest V3)**

Long Chat Toolkit fixes the thing every heavy AI user hits eventually: after a
few hundred messages, ChatGPT, Claude and the rest grind to a halt — typing
lags, scrolling stutters, the fan spins up. This extension makes a
2,000-message chat feel like a 20-message chat, and then gives you the
navigation tools those sites never built: a minimap, search, an auto table of
contents, starred messages, timestamps, one-click backup — and Total Recall, one search box for every AI conversation you've ever had.

Your archive, search index and backups stay **on your device**. When you ask
Total Recall to check history, the background worker makes authenticated
requests only to the AI providers listed in the extension's host permissions.
There is no Long Chat Toolkit server, analytics pipeline or chat-data upload.

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

### 🌉 Context Bridge — your AI's memory across every tool (Pro)
**The problem it solves:** you figured something out with ChatGPT, now you're
in Claude and it knows none of it — so you re-explain your whole project.
Studies put this context-switching tax at 200+ hours a year.
**What it does:** while composing a prompt on any site, press **⌘⇧U /
Ctrl+Shift+U**. Recall searches your entire cross-platform archive, shows the
most relevant passages, you tick the ones you want, and it inserts them into
your prompt — so the model you're already using answers *with* your
accumulated knowledge from every other tool.
**How it stays private and free:** it doesn't call a Long Chat Toolkit API,
use a key, or run a local model — it simply feeds the context to the model
you're already signed into and paying for.
**Fail-safe:** you always pick before anything is inserted (no surprise
noise), and if the prompt box can't be found it copies the context to your
clipboard so you can paste it — it never touches the page it shouldn't.

### 🧠 Total Recall — search every chat, every platform (Pro)
**The problem it solves:** "I solved this in *some* chat… ChatGPT? Claude?
Which one?" Your knowledge is scattered across hundreds of chats on five
sites, none of which can search each other.
**What it does:** press **⌘⇧K / Ctrl+Shift+K** on any chat site (or open the
Recall page from the popup) → one search box across **every archived chat on
every platform** → click a result and land in that chat with the in-chat
search already open on your words.
**How the archive builds:**
- **Automatic, in the background:** a check runs by itself roughly every 3
  hours, shortly after the browser starts, and whenever you open one of the
  chat sites (at most once every 20 minutes) — no button to press. It
  reads the history endpoints for your signed-in ChatGPT, Claude, DeepSeek and
  Grok accounts and writes only what is missing. Turn it off with **Keep the
  archive current by itself** on the Recall page, and it will only ever check
  when you press **Check for new chats**.
- **Progress is a real number:** while a pass runs, the popup and the Recall
  page show one percentage covering every platform in that pass, not each
  provider restarting from zero.
- **One action, durable delta:** open the Recall page → **Check for new chats**.
  A background worker reads the history endpoints for your signed-in ChatGPT,
  Claude, DeepSeek and Grok accounts, then writes titles, dates and text into
  the local archive. No chat tab needs to stay open.
- **Checkpointed by account:** each successful pass records an account-scoped
  safe watermark. Later checks overlap the last five minutes and deduplicate by
  conversation ID plus provider update time. Reloading the extension restores
  the state; a restart never re-downloads work an earlier pass already
  finished, and the scheduled check only ever fetches the delta past each
  account's checkpoint.
- **Safe interruption:** if a worker restarts or a detail request fails, the
  preceding watermark remains in place. The next manual check retries only the
  unfinished delta and skips already archived revisions.
- **Every platform, always:** any chat you open is also archived as you read
  it. Gemini and Perplexity use this open-and-archive path, or an export file
  you import into Recall.

**Reinstall continuity:** while the archive is idle, choose **Create reinstall
backup**. It saves a versioned `.lctbackup` file: a random file key encrypts the
archive with AES-256-GCM, and that key is itself wrapped under a key stretched
from your passphrase with PBKDF2-SHA-256 at 1,000,000 rounds over a 32-byte
random salt. Both layers authenticate the file's own header, so a file edited to
claim a cheaper KDF, a different compression format, or someone else's key
envelope fails to open rather than opening weaker. Your passphrase is never
stored, never synced, and cannot be recovered — by us or by anyone.

Leave **Also keep writing this backup automatically** ticked and the worker
keeps a current copy in `Downloads/Long Chat Toolkit/` by itself. This is the
part that matters: the manual button only ever helped people who remembered to
press it before uninstalling.

**After a reinstall,** archiving restarts on its own straight away and adds only
what is missing — it does not wait for you to restore anything. The Recall page
offers your previous backup at the top; restoring it merges in, leaving chats
already archived alone and bringing back the older ones your providers no longer
list. Restoring is a shortcut, never a prerequisite.

**When you delete a chat on the provider's site,** the archived copy is *not*
deleted with it. It is held aside and you are asked — a badge on the toolbar
icon, a row in the popup, and a panel on the Recall page naming each chat and
its message count, with **Keep** and **Delete** per chat plus **Keep all** /
**Delete all**. Under *When a chat is deleted on the site* you can make either
answer standing: **always keep my backup copy** (the archive outlives the
provider) or **always delete it from my backup too** (the archive mirrors the
provider exactly). Deletions are noticed by a full history listing that runs
about once a day; if that listing comes back missing an implausible share of
your archive — a signed-out session, a provider hiccup — it is discarded rather
than acted on, so a glitch can never put your whole archive up for deletion.

**Restoring is rate-limited.** Repeated wrong passphrases pause the restore box
for an escalating delay, counted in the background worker, so reloading the page
or opening a second one does not reset it.

**Privacy, provable:** the archive lives in your browser's local extension
storage. The only history network requests are scoped to the declared
first-party AI-provider endpoints. There is no telemetry and no chat-data
upload route of any kind; the single non-provider request the extension can
make is licence verification, and it carries a licence key and a device hash —
nothing else, and never on the free tier. The Recall page shows exactly what's
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
**Opening a chat is still:** the toolkit never scrolls the page on its own.
On ChatGPT the map does not need it to — see *How the map is complete instantly*
below. The **⤒** button on the minimap toolbar is only for mounting every older
message in the page itself, which you want for the site's own Ctrl+F or a full
backup; it scrolls while it runs, says how far along it is, and stops the moment
you touch the page.
**Turn it off:** popup → *Speed engine* toggle.

### 🗺️ Minimap
**What it does:** a compact navigator on the right edge showing the shape of
the whole conversation: your prompts, AI replies and code blocks, with a count
of sleeping messages.
**How to use it:** at rest it is a thin gradient rail on the right edge, about
as wide as a scrollbar, with a bright thumb showing where you are. Move the
pointer onto it and it opens into the full map. Hover any bar for a preview of
that message; click to jump there — one click lands, even hundreds of turns
away and even where the site has unloaded the message. Focus the navigator to
use Home, End, Page Up, Page Down and the arrow keys. The `‹` handle collapses
it to a corner. Its toolbar opens the outline, loads older messages (**⤒**) and
backs up the conversation as Markdown or JSON.

### ⚡ How the map is complete instantly
**What it does:** on ChatGPT, the map shows the whole conversation the moment you
open it — every message, in order — while the page itself has only rendered the
last twenty or so. Nothing scrolls.
**How:** ChatGPT hands over an entire conversation in one request, and every
message in it carries the same ID the page stamps on each rendered message. The
background worker asks for that once, and the map is built from it. Your archived
copy answers first (instantly, and offline), then the live copy corrects it a
beat later. There is no way to make a website load its own older messages without
its page moving — so this removes the need to.
**What you get from it:** hover any point in the conversation, however far back,
and read that message without the site loading anything. The count is the real
count. And the chat you are reading gets fully archived for free.
**Clicking something the page hasn't rendered:** it opens immediately in a small
preview so you can read it now, while the site is asked to load its way back to
it. A pill at the bottom says how far along that is, with a Stop button. When the
real message arrives, the preview steps aside and you land on it.
**Elsewhere:** on sites without that kind of history endpoint, the map still
builds from what is on the page, exactly as before.

### 📑 Outline — auto table of contents
**What it does:** builds a live table of contents from every prompt you sent
plus every heading in the AI's answers. For very long chats it lists the first
400 entries and says so on screen — it never silently truncates.
**How to use it:** click **☰** on the minimap toolbar. Click any entry to jump
straight to that part of the chat (the target pulses so you can't lose it) —
a heading takes you to that heading, not to the top of the answer holding it.
Every row carries its own ☆, so you can star straight from the list.
Two tabs: **Outline** (everything) and **Starred** (only what you starred).
Press `Esc` to close.

### ⭐ Starred messages
**What it does:** bookmarks inside a conversation. The gold in a 500-message
brainstorm — the final schema, the working function — stays one click away.
**How to use it:** hover any message → a small ☆ button appears near its top
right corner → click it. Or open the outline and use the ☆ on any row. The
message gets a gold edge. Find all starred messages in the outline's
**Starred** tab; clicking one goes to it even if the site has unloaded that
part of the chat. Click the ★ again to unstar.
Stars are saved per conversation and survive reloads. They also travel with
your browser profile: the most recent 60 per conversation sync to your other
signed-in browsers, and the full set is always kept on this one.

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
  license key by email, tied to that address.
- **Activating:** popup → paste the key → **Activate**. The extension asks the
  payment provider's licence server to register this device, then stores the
  receipt locally. Only your key and a coarse device label ("Chrome · macOS")
  are sent — no cookies, no conversation text. After activation the key is
  never displayed again (so a screenshot or screen-share can't leak it); the
  popup shows only a masked email like `te•••@gmail.com`.
- **5 devices:** one licence activates on five. A "device" is a signed-in
  browser profile, so your laptop and desktop on the same Chrome profile share
  a single slot — and Firefox or a second profile takes its own.
- **Devices:** popup → **Devices** lists them, with **Release** for the one
  you're on and **Terminate** for the rest. If all five are full when you
  activate, the extension quietly frees your oldest device and carries on; it
  only stops to ask when the slots belong to devices it doesn't recognise.
- **Moving to a new browser:** click **Remove** (which hands the slot back)
  and activate on the new machine with the same key.
- **Re-checks:** at most once a month, and only if you're already online. Two
  refusals a week apart are needed before Pro is withdrawn — an outage, a
  timeout or a flight never costs you access.
- **Keys bought before this (`LCT1.…`)** are unchanged: verified by signature
  on your own machine, no network, no device limit.
- **Lost your key:** contact support from your purchase email.

---

## 7. Privacy — provable, not promised

- **No Long Chat Toolkit server or telemetry.** The manifest grants scoped host
  access only to supported AI providers so an explicit history check can read
  your own account. It does not grant a generic upload destination, and the
  extension contains no analytics or remote-code path.
- **The one exception, stated plainly:** licensing. Activating Pro contacts the
  payment provider's licence server, and our entitlement endpoint, which returns
  a signed 90-day token. A licensed copy renews that token at most every 30 days
  and re-checks the payment provider at most monthly. Between them, four things
  leave the machine: your licence key, a coarse device label ("Chrome · macOS"),
  a hash of a random device id, and the activation receipt id. Never conversation
  text, never a cookie, never an account. The free tier contacts neither, ever.
- **Why a token at all:** paid features are checked against a signature the
  extension verifies offline. That is what makes Pro real without an account,
  a login, or a call every time you search — and it is why the extension keeps
  working on a plane.
- **No accounts, no analytics, no telemetry, no remote code.**
- **When we talk to a provider:** on the sync schedule, when you press a sync
  button, and — on ChatGPT — once when you open a conversation, to read that
  conversation. Nothing leaves your browser either way.
- **Everything is stored locally:** settings, reading positions, stars,
  first-seen times, license key — in your browser's extension storage.
- **ChatGPT timestamp script:** the one page-world script (ChatGPT only) is
  bundled, unminified, read-only, and makes no network calls. It reads
  message times from ChatGPT's own in-page state and nothing else.
- **The backup file assumes it will be stolen.** AES-256-GCM under a random
  per-file key, wrapped by PBKDF2-SHA-256 at 1,000,000 rounds; both layers
  authenticate the header, and a file declaring fewer than 600,000 rounds is
  refused outright rather than opened weakly. Failed restore attempts are
  throttled by the background worker, not the page.
- **Backup key material never roams.** The wrapped key that makes unattended
  backups possible is kept in local extension storage only, never in
  `storage.sync`. Anything able to read it can already read the plaintext
  archive next to it, so it costs nothing to keep — and everything to sync.
- **Nothing deletes your archive but you.** No provider response, failed
  request or odd-looking listing removes archived text. The only code path that
  deletes runs behind your answer to the prompt (or the standing policy you
  chose yourself).
- **Open source.** Read every line: the repo is public.

**Uninstalling** removes local extension data — including the backup key
material, so a wiped browser cannot keep writing readable archives of whatever
comes next. Your `.lctbackup` files stay on your disk. Turn automatic backup on
and there is nothing to remember before uninstalling; a small durable marker
also lets the new install offer the restore, while archiving restarts by itself
either way.

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

The three Pro shortcuts are registered as **browser shortcuts**, so they work
the same on Windows, macOS and Linux and in Chrome, Edge and Firefox. If a
default combo clashes with something on your system, **remap it**: extension
popup → *Keyboard shortcuts* (or visit `chrome://extensions/shortcuts`).


| Keys | Action |
|---|---|
| `⌘⇧U` / `Ctrl+Shift+U` | Context Bridge — inject past context into your prompt (Pro, remappable) |
| `⌘⇧K` / `Ctrl+Shift+K` | Total Recall — search across ALL chats (Pro, remappable) |
| `⌘⇧F` / `Ctrl+Shift+F` | Open in-chat search (remappable) |
| `Enter` / `Shift+Enter` | Next / previous match |
| `Esc` | Close search or outline panel |

---

*Long Chat Toolkit is an independent open-source project. It is not
affiliated with OpenAI, Anthropic, Google, Perplexity, DeepSeek or xAI.
Product names belong to their owners.*
