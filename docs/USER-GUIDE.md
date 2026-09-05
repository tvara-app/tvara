# Tvara · Complete User Guide

**Version 1.0.0 · Chrome / Edge (Manifest V3)**

Tvara keeps **your own AI history on your machine** — every conversation across
ChatGPT, Claude, Gemini, Perplexity, DeepSeek and Grok, searchable in one box,
exportable whenever you want it, and still yours after a reinstall or after the
provider deletes its copy.

It also fixes the thing every heavy AI user hits eventually: after a few hundred
messages those sites grind to a halt. Typing lags, scrolling stutters, the fan
spins up. Tvara makes a 2,000-message chat feel like a 20-message chat, and adds
the navigation those sites never built: a minimap, search, an auto table of
contents, starred messages, timestamps and one-click backup.

The archive is the product. The speed is what you feel first.

Your archive, search index and backups stay **on your device**. When you ask
Total Recall to check history, the background worker makes authenticated
requests only to the AI providers listed in the extension's host permissions.
No conversation text, title or prompt is ever uploaded, and there is no
analytics pipeline of any kind.

Tvara does run one server of its own — a licence issuer. It decides whether a
licence is real and how many devices hold it, and it never receives a word of
your conversations. Section 7 says exactly what it stores and for how long.

---

## 1. What problem does it solve?

AI chat sites keep every message of a conversation fully rendered in the page
forever. The browser pays layout/paint cost for all of it on every keystroke
and every scroll. That's why long chats feel broken.

Other "speed up ChatGPT" extensions fix this by **deleting or truncating** old
messages. Your history is gone until you reload. Tvara uses a
different mechanism: messages outside your view are **put to sleep** (native
CSS `content-visibility` windowing) and **wake instantly** when you scroll
back to them. Nothing is ever removed, hidden or mutated. Scrollback, Ctrl+F…
everything still works. It's just fast.

---

## 2. Installation

**From the store (normal users):** install from the Chrome Web Store / Edge
Add-ons page, then open any supported AI chat site. That's it. The speed
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
| **Claude** (claude.ai) | ✅ Free | 🔒 Pro, or free during the 7-day trial |
| **Gemini** | ✅ Free | 🔒 Pro, or free during the 7-day trial |

The speed engine is **free on every platform, forever**. "Experimental" means
the site's page structure can't be guaranteed yet. If something doesn't
appear there, the extension safely does nothing rather than breaking the page.

---

## 4. The features, one by one

### 🌉 Context Bridge · your AI's memory across every tool (Pro)
**The problem it solves:** you figured something out with ChatGPT, now you're
in Claude and it knows none of it, so you re-explain your whole project.
Studies put this context-switching tax at 200+ hours a year.
**What it does:** while composing a prompt on any site, press **⌘⇧U /
Ctrl+Shift+U**. Recall searches your entire cross-platform archive, shows the
most relevant passages, you tick the ones you want, and it inserts them into
your prompt, so the model you're already using answers *with* your
accumulated knowledge from every other tool.
**How it stays private and free:** it doesn't call a Tvara API,
use a key, or run a local model. It simply feeds the context to the model
you're already signed into and paying for.
**Long chats give more:** a short chat contributes one passage. A long one
contributes several, taken from different points in the thread rather than
three views of the same paragraph — the row says *+2 more from this chat* when
it does.
**Fail-safe:** you always pick before anything is inserted (no surprise
noise), and if the prompt box can't be found it copies the context to your
clipboard so you can paste it. It never touches the page it shouldn't.

### 🧠 Total Recall · search every chat, every platform (Pro)
**The problem it solves:** "I solved this in *some* chat… ChatGPT? Claude?
Which one?" Your knowledge is scattered across hundreds of chats on five
sites, none of which can search each other.
**What it does:** press **⌘⇧K / Ctrl+Shift+K** on any chat site (or open the
Recall page from the popup) → one search box across **every archived chat on
every platform** → click a result and land in that chat with the in-chat
search already open on your words.
**Temporary and private chats:** off by default, because a temporary chat is
you telling that platform not to keep it. Turn on **Archive temporary chats**
in the popup and Tvara keeps them in your local archive too — temporary,
private, incognito and signed-out chats on every supported site. While one is
being archived a small badge sits in the corner of the page, so it is never a
silent recording. These chats are labelled *temporary* in results and cannot be
reopened on the platform: the original was never saved there.

**How the archive builds:**
- **It starts itself:** the first pass begins the moment the extension is
  installed. Nothing waits for you to open a chat site or press anything.
- **Starting the browser is enough:** every pass runs in the extension's
  background worker on your own signed-in sessions. The browser does not have
  to be the window you are looking at, no chat tab has to be open, and closing
  the popup does not stop anything. If the browser shuts a pass down partway,
  it books itself back in and carries on from where the archive actually is.
- **It never waits for you:** a pass does not stop or pause because a chat
  site is open, because that window is in front, or because Chrome is behind
  another application. Having the site open only slows the pass to one request
  at a time, so it is not competing with you for the provider's rate limit.
- **The text follows the titles, by itself:** a history listing gives every
  conversation's title in one call; the words cost one call each. Those are
  fetched in the background as soon as a pass finds them missing. **Archive
  core** in the popup shows how many are left, and stops it if you want —
  and a download you stop stays stopped.
- **Automatic, in the background:** a check runs by itself roughly every 3
  hours, shortly after the browser starts, and whenever you open one of the
  chat sites (at most once every 20 minutes), no button to press. It
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
stored, never synced, and cannot be recovered, by us or by anyone.

Leave **Also keep writing this backup automatically** ticked and the worker
keeps a current copy in `Downloads/Tvara/` by itself. This is the
part that matters: the manual button only ever helped people who remembered to
press it before uninstalling.

**After a reinstall,** archiving restarts on its own straight away, but it
captures only chats newer than your last backup. An uninstall takes the archive
and leaves the ledger, so the extension knows exactly how many chats this
account had; re-downloading all of them from the provider would spend hours of
requests on chats you have not lost. The popup and the Recall page both offer
the previous backup instead. Restore it and the older chats come back, merged,
leaving anything already archived alone. Choose **Continue without restoring**
and the full history is rebuilt from the providers after all — and if you answer
neither, the offer lapses after a week and the rebuild runs by itself, so
nothing is left permanently uncaptured.

**When you delete a chat on the provider's site,** the archived copy is *not*
deleted with it. It is held aside and you are asked, a badge on the toolbar
icon, a row in the popup, and a panel on the Recall page naming each chat and
its message count, with **Keep** and **Delete** per chat plus **Keep all** /
**Delete all**. Under *When a chat is deleted on the site* you can make either
answer standing: **always keep my backup copy** (the archive outlives the
provider) or **always delete it from my backup too** (the archive mirrors the
provider exactly). Deletions are noticed by a full history listing that runs
about once a day; if that listing comes back missing an implausible share of
your archive, a signed-out session, a provider hiccup. It is discarded rather
than acted on, so a glitch can never put your whole archive up for deletion.

**Restoring is rate-limited.** Repeated wrong passphrases pause the restore box
for an escalating delay, counted in the background worker, so reloading the page
or opening a second one does not reset it.

**Privacy, provable:** the archive lives in your browser's local extension
storage. The only history network requests are scoped to the declared
first-party AI-provider endpoints. There is no telemetry and no chat-data
upload route of any kind; the only non-provider requests are licensing ones,
carrying a licence key, a device public key, a hash of your verified email
address and (unavoidably) your IP — never conversation text. Starting the free
trial makes one of those requests too, which is what stops a reinstall minting
a second free week. The Recall page shows exactly what's
stored (chats, messages, MB) and has a delete-everything button.
**Honesty note:** without an import, Recall only knows chats you've opened
since installing. It says so rather than pretending otherwise.

### ⚡ Speed engine
**What it does:** puts off-screen messages to sleep so the browser stops
paying for what you can't see. A safety zone above and below your viewport
(±1.5 screens) stays awake so scrolling never shows blanks.
**How to use it:** nothing, it's automatic on chats longer than ~25 messages.
The popup shows live proof: *"1,491 messages asleep right now"*, per site,
as an honest **"1,491 of 1,500"** count.
**The engine itself never scrolls.** Windowing is pure CSS; it moves nothing.

Putting the older messages *back* into the page is a separate feature —
*Load full history on open*, which is on by default. On providers that publish
a transcript endpoint (ChatGPT) it fetches the conversation in a single request
and renders the older turns straight into the page, with no scrolling at all.
On providers that publish none (Gemini, Perplexity) the only way up is to ask
the site to page its own history, which does scroll — so it runs behind a
freeze: a still copy of the page covers it, you keep the pixels you were
looking at, and any input at all stops it and hands the live page straight
back. A bar at the bottom says how far along it is, with a Stop button.

The **⤒** button on the minimap toolbar does the same thing on demand.

**Turn it off:** popup → *Load full history on open*.
**Turn it off:** popup → *Speed engine* toggle.

### 🗺️ Minimap
**What it does:** a compact navigator on the right edge showing the shape of
the whole conversation: your prompts, AI replies and code blocks, with a count
of sleeping messages.
**How to use it:** at rest it is a thin gradient rail on the right edge, about
as wide as a scrollbar, with a bright thumb showing where you are. Move the
pointer onto it and it opens into the full map. Hover any bar for a preview of
that message; click to jump there. One click lands, even hundreds of turns
away and even where the site has unloaded the message. Focus the navigator to
use Home, End, Page Up, Page Down and the arrow keys. The `‹` handle collapses
it to a corner. Its toolbar opens the outline, loads older messages (**⤒**) and
backs up the conversation as Markdown or JSON.

### ⚡ How the map is complete instantly
**What it does:** on ChatGPT, the map shows the whole conversation the moment you
open it. Every message, in order, while the page itself has only rendered the
last twenty or so. Nothing scrolls.
**How:** ChatGPT hands over an entire conversation in one request, and every
message in it carries the same ID the page stamps on each rendered message. The
background worker asks for that once, and the map is built from it. Your archived
copy answers first (instantly, and offline), then the live copy corrects it a
beat later. There is no way to make a website load its own older messages without
its page moving, so this removes the need to.
**What you get from it:** hover any point in the conversation, however far back,
and read that message without the site loading anything. The count is the real
count. And the chat you are reading gets fully archived for free.
**Clicking something the page hasn't rendered:** it opens immediately in a small
preview so you can read it now, while the site is asked to load its way back to
it. A pill at the bottom says how far along that is, with a Stop button. When the
real message arrives, the preview steps aside and you land on it.
**Elsewhere:** on sites without that kind of history endpoint, the map still
builds from what is on the page, exactly as before.

### 📑 Outline · auto table of contents
**What it does:** builds a live table of contents from every prompt you sent
plus every heading in the AI's answers. For very long chats it lists the first
400 entries and says so on screen. It never silently truncates.
**How to use it:** click **☰** on the minimap toolbar. Click any entry to jump
straight to that part of the chat (the target pulses so you can't lose it),
a heading takes you to that heading, not to the top of the answer holding it.
Every row carries its own ☆, so you can star straight from the list.
Two tabs: **Outline** (everything) and **Starred** (only what you starred).
Press `Esc` to close.

### ⭐ Starred messages
**What it does:** bookmarks inside a conversation. The gold in a 500-message
brainstorm, the final schema, the working function, stays one click away.
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
conversation, **including sleeping messages** (it searches a text cache, not
the rendered page, so speed mode costs you nothing).
**How to use it:** press **⌘⇧F** (Mac) / **Ctrl+Shift+F** (Windows/Linux).
Type, the match counter updates live. **Enter** jumps to the next match,
**Shift+Enter** to the previous, **Esc** closes. Each jump scrolls to the
match and pulses it.

### 🕒 Message timestamps
**What it does:** AI chat sites never show *when* anything was said. Hover
any message and a small time tag appears.
**Honesty rule:** on **ChatGPT** you get the *real send time* of your entire
history (read locally from the app's own state by a tiny read-only script,
no network, no changes to the page). On other sites, browsers simply don't
have historical send times, so messages are stamped from the moment the
extension first sees them and labeled **"First seen … · this device"**.
Messages that existed before install honestly say **"Time unknown (sent
before install)"**. A first-seen time is never dressed up as a send time.
**Turn it off:** popup → *Timestamps* toggle.

### 🪪 Chat Card · sidebar hover insights
**What it does:** hover any conversation in the site's sidebar and a small
card tells you about that chat before you open it: how many messages it has,
how many questions you asked, how many messages you starred, when it was
created or first seen, when you last opened it, and whether it's your
longest chat on that site.
**How to use it:** just hover a chat in the sidebar for a moment. No clicks.
**The honesty rules (read this):**
- The card only knows chats you've **opened at least once** since installing,
  the sites don't put other chats' data in the page, and this extension has no
  network access to ask their servers. Unopened chats say "Not tracked yet."
- On **ChatGPT** the card shows the chat's **real creation time** (from the
  app's own local state). On other sites it says "First seen … · this device".
  We never dress a first-seen date up as a creation date.
- "Your longest **visited** chat" means exactly that, longest among chats
  we've seen, never a claim about your whole history.
- Counts are from the last time you opened the chat, so a chat that grew since
  then shows its last-known size.

### ⤵ Resume where you left off
**What it does:** remembers the exact message you were reading in each long
chat, anchored to the message itself, not pixel position, so it survives
reloads and layout changes.
**How to use it:** reopen a long chat. If your last reading position is
off-screen, a **"↓ Resume where you left off"** chip appears. Click it to
jump back. Scroll away deliberately and the chip dismisses itself.

### 💾 One-click backup
**What it does:** exports the loaded conversation to a clean file on your
disk. Your chats belong to you, not to a tab.
**How to use it:** minimap toolbar → **⤓** for **Markdown** (headings, lists,
code fences and timestamps preserved, drops straight into Obsidian/Notion)
or **{ }** for **JSON** (structured: role, text, timestamp per message, for
your own scripts).

---

## 5. The popup (click the toolbar icon)

- **Badge.** Your current plan: `Free`, `Trial` (amber) or `Pro`.
- **Big number.** Messages asleep right now, with a per-site "N of total"
  breakdown. This is the engine's live proof of work.
- **Six toggles.** Speed engine · Minimap · Timestamps · Load full history on
  open · Archive temporary chats · Allowance tracking. Changes apply to open
  tabs instantly; no reload needed.
- **Upgrade card** (when not Pro), the trial button, the license field, and
  what Pro includes.

---

## 6. Free trial, Pro, and licensing

- **7-day free trial:** popup → **Start 7-day free trial**. It asks you to
  press **Continue with Google** first. That is the whole signup: no password,
  no form, and Tvara asks Google for your email address and nothing else. Every
  tool then unlocks on every platform, including Claude and Gemini. The popup
  counts down the days; when it ends, free platforms stay free and the speed
  engine stays on everywhere.

  Signing in makes the trial *yours* rather than your install's, and it is
  required before the clock starts — not a suggestion beside a button that
  would have worked anyway. A week with no address behind it is tied to a key
  living inside this installation, and uninstalling destroys it: the days you
  had spent would come back as a fresh offer, and the ones you were owed could
  not be found again. With an address, uninstall and reinstall and you neither
  lose the days you had left nor get a fresh week — sign in with the same
  account and it picks up exactly where it was, and the popup says so.

  Google sign-in needs Chrome or Edge. Firefox gives every installation a
  different internal address, which Google will not accept as a sign-in
  destination, so the trial and Pro cannot be started there; the free features
  work normally.
- **Pro, $1, once, forever:** no subscription. Buying gets you a licence key by
  email, tied to that address. Verify the same address in the popup and
  **Restore my purchase** brings Pro back after a reinstall without pasting the
  key at all.
- **Buying:** popup → **Get Pro**. The extension asks our licence server to
  open a checkout for that one purchase and opens it in a tab; there is no
  payment page on the website and no payment link inside the extension. When
  the payment clears, the licence is delivered back to the copy of Tvara that
  started it and switches itself on — nothing to copy, nothing to paste. Your
  key is never put in a web address, so it cannot end up in browser history or
  in profile sync. It is emailed to you as well.
- **Activating by hand:** popup → paste the key → **Activate**. This is how you
  add your second through fifth device, and how you recover if a delivery goes
  astray. The extension asks the payment provider's licence server to register
  this device, then stores the receipt locally. Only your key and a coarse
  device label ("Chrome · macOS") are sent, no cookies, no conversation text.
  After activation the key is never displayed again (so a screenshot or
  screen-share can't leak it); the popup shows only a masked email like
  `te•••@gmail.com`.
- **5 devices:** one licence activates on five. A "device" is a signed-in
  browser profile, so your laptop and desktop on the same Chrome profile share
  a single slot, and Firefox or a second profile takes its own.
- **Devices:** popup → **Devices** lists them, with **Release** for the one
  you're on and **Terminate** for the rest. If all five are full when you
  activate, the extension quietly frees your oldest device and carries on; it
  only stops to ask when the slots belong to devices it doesn't recognise.
- **Naming a device:** each row shows the name you gave that machine, or, if
  you have not named it, what the browser will say about it: the operating
  system with its major version, the handset model on Android, and the browser.
  A browser extension cannot read the computer's own name — there is no API
  that exposes "DESKTOP-8FJ2K1" or "Anirudh's MacBook Pro" to a web page or an
  extension, on any platform — so a name you recognise has to be typed once.
  Press **Name it** on your own row, type a name, and every other device on the
  account sees it at its next check-in. You can only rename the device you are
  on: the licence server keys the name to the device that proved the request,
  so no machine can label another one.
- **When a device appears:** signing in is what puts a machine on this list.
  You do not have to buy anything or start a trial first, and you do not have
  to wait for a check-in — the row is written while you are signing in, so the
  device screen already shows the machine you are sitting at the first time you
  open it. Your own device is always on the list even if the licence server
  cannot be reached; a device the server has no record of yet cannot be signed
  out, because there is nothing on the server to sign out.
- **Your account photo:** once you sign in with Google, your profile picture
  sits in the top-right corner of the popup, in a ring whose colour is your
  plan — Free, Trial or Pro — with the same word on the pill beside it. The
  picture and your name are read out of the sign-in token by the extension and
  kept on this device only; they are never sent to our servers, and they are
  removed when you sign out. If Google serves no picture, the circle shows your
  initial instead.
- **Moving to a new browser:** click **Remove** (which hands the slot back)
  and activate on the new machine with the same key. **Remove frees a slot; it
  does not switch a device off.** A removed browser that still has the key
  keeps Pro and takes a slot again at its next check, unless all five are full
  by then. To stop a machine you no longer control, email support and we will
  clear the licence.
- **Re-checks:** before a Pro action, whenever the last check is over fifteen
  minutes old — only if you're already online. A background alarm runs every
  twelve hours too, but only contacts the issuer while the signed 30-day token
  is inside its final 10 days. One authoritative refusal — the issuer saying
  the licence is unknown or inactive — withdraws Pro at once; an outage, a
  timeout or a flight never costs you access.
- **Keys bought before this (`LCT1.…`)** are unchanged: verified by signature
  on your own machine, no network, no device limit.
- **Lost your key:** contact support from your purchase email.

---

## 7. Privacy · provable, not promised

- **Your conversations never leave your device.** The manifest grants scoped
  host access only to supported AI providers so an explicit history check can
  read your own account. It does not grant a generic upload destination, and the
  extension contains no analytics, telemetry or remote-code path.
- **The exception, stated plainly:** licensing. Activating Pro contacts the
  payment provider's licence API and our own licence issuer, which returns a
  signed 30-day token. A licensed copy renews that token once it has under 10
  days of life left, and re-checks before a Pro action when the last check is
  over fifteen minutes old. **Starting the free trial
  contacts the issuer too** — an earlier version of this guide said the free
  tier never contacted anything, which was not correct. What leaves the machine:
  your licence key, a coarse device label ("Chrome · macOS"), your device's
  public key, the activation receipt id, your email address once at
  verification (the issuer mails the code and keeps only a hash of the
  address), and the IP any request carries. Never conversation text, never a
  cookie. **Your Google profile picture and display name are not on that
  list.** Signing in with Google asks for them so the popup can show whose
  account it is; the extension reads them out of the sign-in token on your own
  machine and stores them there. Neither is ever sent to the issuer, and both
  are deleted when you sign out.
- **What the issuer keeps:** a hash of your licence key, a fingerprint per
  active device with a last-seen time, a **hash** of your verified email
  address, and your trial start date — each up to 400 days, enforced by a
  cleaner that runs daily rather than by a promise — plus a **hashed** IP for
  30 days, used to flag one key being used from implausibly many places for a
  human to review. Past that threshold it also keeps a count and a timestamp
  against the licence for 90 days, as evidence for that review. It never blocks
  anyone automatically.

  Two things are deliberately kept longer. **The link between your verified
  address and a licence you bought** is what makes Pro come back after a
  reinstall without a key to find, so it lives as long as the licence does —
  deleting it on a timer would take your purchase with it. **A revocation** (a
  refund) is permanent, for the obvious reason. Your email address itself is
  never kept in readable form anywhere. Email support to see or delete any of
  it.
- **Your device key:** generated once per install and **non-extractable** — the
  browser will not export the private half to us, to you, or to anyone. It only
  proves a request came from this device, so a device slot cannot be claimed by
  someone who merely has your licence key.
- **Why a token at all:** paid features are checked against a signature the
  extension verifies offline. That is what makes Pro real without an account,
  a login, or a call every time you search, and it is why the extension keeps
  working on a plane.
- **No accounts, no analytics, no telemetry, no remote code, no third-party SDK.**
- **Your archive is never held hostage.** Exporting everything the extension has
  archived never requires a licence — not if Pro lapses, is refunded, or you
  remove this device.
- **When we talk to a provider:** on the sync schedule, when you press a sync
  button, and, on ChatGPT, once when you open a conversation, to read that
  conversation. Nothing leaves your browser either way.
- **Everything is stored locally:** settings, reading positions, stars,
  first-seen times, license key, in your browser's extension storage.
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
  archive next to it, so it costs nothing to keep, and everything to sync.
- **Nothing deletes your archive but you.** No provider response, failed
  request or odd-looking listing removes archived text. The only code path that
  deletes runs behind your answer to the prompt (or the standing policy you
  chose yourself).
- **Open source.** Read every line: the repo is public.

**Uninstalling** removes local extension data, including the backup key
material, so a wiped browser cannot keep writing readable archives of whatever
comes next. Your `.lctbackup` files stay on your disk. Turn automatic backup on
and there is nothing to remember before uninstalling; a small durable marker
also lets the new install offer the restore, while archiving restarts by itself
either way — capturing new chats meanwhile rather than downloading the whole
history a second time.

---

## 8. Troubleshooting & FAQ

**The minimap/tools don't appear on a site.**
The chat may be shorter than ~25 messages (the engine doesn't bother below
that), or the site is one of the experimental platforms whose page structure
changed. The extension never breaks a page. It just steps back. Check the
popup: if the site row shows counts, the engine is working.

**Do the tools appear on Claude/Gemini without Pro?**
Only during the trial. The speed engine itself always works there for free.

**Does the speed engine change or delete my messages?**
No. Sleeping messages remain in the page, untouched. Scroll to them, or
search, and they're there. Backup exports include them too.

**Why does my message say "Time unknown (sent before install)"?**
Outside ChatGPT, browsers have no way to know historical send times. We
refuse to fake one. Every message from install day onward gets a real
first-seen stamp.

**Search finds text I can't see.**
That's by design. It searches sleeping messages too and wakes the right one
when you jump.

**Does the trial reset if I reinstall?**
No. It used to: the trial was pinned to a keypair held in the extension's own
storage, and uninstalling destroyed it, so a reinstall was a fresh week. It is
now recorded against your verified email address, on the server, for 400 days.
Reinstall, switch browsers or wipe your profile and verifying the same address
returns the original start date, with whatever days were left still on it.

**Can I get a second week with a different email address?**
No. The week is recorded against the address *and* against the install, so
verifying a second address in the same browser picks up the week that browser
has already spent rather than starting a new one.

**I reinstalled and Pro is gone.**
Sign in in the popup and press **Restore my purchase**. Because buying requires
signing in, that is all it takes — no key to find.
It also reclaims the device slot the old install was holding, so reinstalling
repeatedly cannot use up your five devices.

**Something glitched on a site update.**
AI sites ship UI changes constantly. If a feature stops appearing, it's
usually a selector that needs a one-line update, report it on GitHub and it
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
| `⌘⇧U` / `Ctrl+Shift+U` | Context Bridge, inject past context into your prompt (Pro, remappable) |
| `⌘⇧K` / `Ctrl+Shift+K` | Total Recall, search across ALL chats (Pro, remappable) |
| `⌘⇧F` / `Ctrl+Shift+F` | Open in-chat search (remappable) |
| `Enter` / `Shift+Enter` | Next / previous match |
| `Esc` | Close search or outline panel |

---

*Tvara is an independent open-source project. It is not
affiliated with OpenAI, Anthropic, Google, Perplexity, DeepSeek or xAI.
Product names belong to their owners.*
