# ⚡ Long Chat Toolkit

**Make long AI chats fast again.** Speed windowing, minimap, outline, search, starred messages & one-click backup for ChatGPT, Claude, Gemini, Perplexity, DeepSeek & Grok.

📖 **[Complete user guide →](docs/USER-GUIDE.md)**

Long conversations grind AI chat UIs to a halt — every message stays fully rendered forever, so a 1,000-message chat means seconds of typing lag and a screaming fan. This toolkit fixes that, locally, in your browser.

## Features

- **➡️ Continue in a new chat** — the thing everyone does by hand when a conversation gets long, slow, or runs into a limit: scroll up, copy some fragments, open a fresh chat, re-explain the project. One click instead. It opens a new conversation on the same platform with the context already in the prompt box — what you originally asked, the messages you starred, where the code stands, how it ended. Every word is quoted from the chat; there is no summariser here, because there is no server and no API key, and a paraphrase nobody asked for is not a feature. Nothing is sent for you.
- **⏳ Told before you hit the wall** — these apps have no meter and no countdown: the first signal is "usage limit reached", by which point the session is over and the context you built is gone. A notification at 20%, and again at 10%, on whichever platform is running down — once per level, never a stream. Off in one click.
- **🌉 Context Bridge (Pro)** — the memory layer for all your AI. Composing a prompt on any site? Press `⌘⇧U` / `Ctrl+Shift+U`: Recall finds relevant passages from your entire cross-platform history, you pick, and it injects them into your prompt — so the model you're already using answers *with* your accumulated knowledge. No servers, no API keys (it feeds context to the model you're already in), all local. Fails safe to the clipboard if the prompt box can't be found. Shortcut is a browser-native, remappable command (works across Chrome/Edge/Firefox and every OS).
- **🗺️ Instant complete map** — on ChatGPT the minimap shows every message the moment you open a conversation, while the page has only rendered the tail, and without scrolling anything. Hover any point in the history and read it; click it and it opens instantly while the site loads its way back to it.
- **🧠 Total Recall (Pro)** — one search box for every AI conversation you've ever had, across all platforms (`⌘⇧K` / `Ctrl+Shift+K`). Its background archive worker keeps itself current — a check runs roughly every 3 hours, shortly after the browser starts, and whenever you open one of the chat sites (switchable off), reading only the new gap in your own ChatGPT, Claude, DeepSeek or Grok history, with account-scoped checkpoints and no full resync on reload. One percentage covers the whole pass. Archive text stays local; there is no Long Chat Toolkit server or telemetry.
- **⚡ Speed engine** — off-screen messages are windowed with native CSS `content-visibility`, so the browser stops paying for what you can't see. On long virtualized ChatGPT conversations, an initial pass asks the host to mount older available turns, then returns you to where you were reading. Messages wake instantly when scrolled to. Nothing is removed or mutated.
- **🕒 Message timestamps** — AI chat sites don't show *when* anything was said; hover any message to see its time. ChatGPT: real send times for the entire history (read locally from the app's own state by a tiny read-only page-world script). Claude/Gemini: honest "first seen on this device" times from the moment you install — never faked as send times.
- **🗺️ Minimap** — a compact conversation navigator for the whole loaded chat. Your messages, AI messages, code blocks. Hover for previews and times, click anywhere to jump, or use Home, End, Page Up, Page Down and arrow keys while it is focused.
- **🔎 In-chat search that reaches past the page** (`⌘⇧F` / `Ctrl+Shift+F`, or the magnifier on the navigator) — these hosts keep only part of a long chat mounted, so searching one finds a fraction of the matches: measured live, 8 hits where the conversation held 217. It searches the archived copy too and walks you to a match the page has never rendered, previewing it while the host catches up. The count says where the answers are — hover it for "8 on this page, 207 further back".
- **⤵ Resume where you left off** — reopen a long chat and one tap returns you to the exact message you were reading (anchored to the message, not pixels — survives reloads and reflows).
- **🗑️ Deleted there ≠ deleted here** — when a chat disappears from the provider, the archived copy is *not* thrown away with it. It is quarantined, flagged in the popup and listed on the Recall page with its title and message count, and you decide: keep the backup copy, or delete it here too. Standing policies exist for both extremes (`always keep` / `always mirror`). A once-daily full listing is what notices deletions at all — and it refuses to act on an implausible one, so a signed-out session can never present your whole archive for deletion.
- **🔁 Automatic encrypted backup** — set a passphrase once and the worker keeps writing a `.lctbackup` to `Downloads/Long Chat Toolkit/` on a schedule, so a reinstall never costs you an archive. The passphrase is never stored, never synced and not recoverable; the file is AES-256-GCM under a wrapped random file key with the header authenticated, so editing the KDF cost or any other parameter breaks the tag instead of being obeyed.
- **♻️ Reinstall picks up where you left off** — a fresh install starts re-archiving immediately and adds only what is missing, rather than blocking on a restore. Restoring the old file afterwards merges into it: chats already archived are left alone, older ones the provider no longer lists come back.
- **💾 One-click backup of the WHOLE conversation** — clean, structured Markdown or JSON with timestamps, paragraphs, lists and code fences preserved. Not the slice the host happens to have mounted: where the page holds 197 of 1,471 messages, the file holds 1,471.
- **📑 Outline** — an auto table of contents: every prompt you sent plus every heading in the answers, click to jump. Capped at 400 entries with the cap disclosed on screen.
- **⭐ Starred messages** — hover any message to star it; find the gold of a long brainstorm again in one click. Saved per conversation, locally.
- **🪪 Chat Card** — hover a conversation in the sidebar: message count, questions asked, stars, created (real time on ChatGPT) / first-seen date, last opened, and a "your longest visited chat" badge. Local records only — no API calls, chats you haven't opened honestly say "Not tracked yet".
- **⏳ Allowance, audited** — the figures behind the warning above: how much of each plan's limit is left, as **the provider's own figure**, with the time it resets. The popup leads with a verdict — *"nothing is running low"* or *"Claude is running low — 12% left, resets 9:46 PM"* — because a row of "100%" answers a question nobody asks. It is a percentage because that is what these services actually meter: Claude weights a rolling multi-hour window by tokens, ChatGPT caps per model — so "31 of 45 messages" is a number with no referent, and we don't show one. The extension reads the quota data the sites already send your browser and, when you open the popup, asks the provider directly — which is why usage from your phone or another browser is included. **A provider that publishes nothing gets an empty ring and the words "not reported"**, never an estimate. Every figure is auditable: hover a row to see which field and which arithmetic produced it, or open **Allowance tracking → check accuracy** in the popup to compare it against what the site itself displays, side by side. Switchable off in one click.

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
content/main.js              orchestrator: settings/license/pricing wiring, resume, health report
bg.js                        archive DB, provider sync, deletion review, scheduled backup
lib/backup-crypto.js         the .lctbackup envelope — one implementation, both sides
lib/store.js                 storage wrapper that survives extension reloads
lib/license.js               license verdict: offline ECDSA (LCT1) or an activation receipt
lib/dodo.js                  Dodo Payments activation, 5-device seats, monthly re-check
lib/entitlement.js           LCT2 token: the server-signed half of the paywall
lib/product.js               every outward-facing URL, in one frozen object
popup/                       settings UI
welcome.html/.js/.css        first run: the three shortcuts, as the browser actually bound them
diag/health.html             adapter health across your open chat tabs
diag/quota.html              allowance accuracy, checkable against the site itself
server/entitlement-worker.js the issuer — the one place a client cannot patch
```

Design rule: **never break the host page.** Unknown DOM → do nothing. Selector drift → do nothing. Our worst case is the page's normal behavior.

## Shipping

```bash
npm test                      # 493 assertions across five suites — all of them, every time
node tools/preflight.mjs      # can this be submitted and sold today? blockers, with fixes
node tools/pack.mjs           # → dist/…-vX.Y.Z.zip  (add --firefox for the untested FF build)
./server/deploy.sh <ext-id>   # the entitlement issuer, deployed and then PROVEN
```

**preflight** is the gate. It reads the code, not the plan: version drift between
the manifest and the zip, a permission the store listing forgets to justify, a
claim in the README that no longer matches the constant it describes, a price
with no checkout behind it, a licence issuer that is not actually deployed.
It exits non-zero while any of that is true.

**pack** refuses to build a zip that references a file it does not contain —
manifest entries, `<script src>`, and `chrome.runtime.getURL()` alike. The zip
before this check shipped a `content/recall-sync.js` that had been deleted
months earlier.

The payment link lives in **one place**: the `#checkout` href on
`docs/index.html`. Every Buy button in the extension points at that page rather
than at a checkout URL, so changing provider, product or price never needs a
store review — and while the link is still the placeholder, the page says so
instead of sending buyers to a dead checkout.

## Filling the archive

A listing hands over every conversation's title in one request; the text costs
one request each. So the pass writes the titles first — and used to decide, on
the next run, that those chats were already archived, because a title-only
record carries the provider's own revision and the sync compares revisions.
Measured on a real archive: **2,303 chats holding 15,765 messages**, seven each,
for conversations that run to hundreds. Total Recall is the paid feature, and it
could only match titles for 61% of them.

Emptiness is now tracked as records are written, reconciled once against an
existing archive (one 25MB scan, 187ms), and the popup offers the work as
something a person can start and watch: *"Download the text of 1,415 chats —
about 35 min"*, with progress, a stop, and resumption from wherever the archive
actually is rather than from a cursor it had to remember.

## Selling it

Four things, once. `node tools/preflight.mjs` fails until all of them are true,
so this list is enforced rather than remembered.

1. **Create the product** with the payment provider (merchant of record, so VAT
   and invoices are theirs, not ours). One-time price, no subscription.
2. **Point it home.** Paste the payment link into the `#checkout` href in
   `docs/index.html`, and set the provider's success/redirect URL to
   `…/thanks.html` — the page that tells a buyer what to do with the key they
   just bought. Both are one line each.
3. **Deploy the issuer:** `./server/deploy.sh <extension-id>`. A licence cannot
   unlock anything until this exists, which is why preflight blocks on it.
4. **The price lives in two constants** — `PRICE` in `lib/product.js` and
   `PRICE` in `docs/index.html` — because the extension and the site deploy
   separately. Everything else reads them. Preflight fails if they disagree or
   if a stale figure survives in prose.

A purchase is withdrawn by an **answer**, never by an outage: a licence the
provider reports as unknown or inactive clears the token, but an issuer that
cannot be reached — a lapsed domain, a proxy, us shutting the Worker down years
from now — leaves Pro working and merely marked overdue. Nobody who paid once
loses what they paid for because our server had a bad day.

## When a platform redesigns

These sites change their markup without notice, and the adapters are built to
degrade quietly rather than break the page — which means a redesign looks like
"still works" right up until it doesn't. The popup's **Health** link answers the
real question in one click: for every chat tab you have open, whether the
messages we found still match that platform's own attributes (`primary`), or
whether we are running on a fallback layer (`DEGRADED`), plus the composer,
scroller, role split and sleep count. It reads no message text, strips the
conversation id, and copies a paste-ready report.

That is also how to check a live site after any change here — the test suite
runs against mock providers and a synthetic page, so it can prove the logic and
never the selectors.

### Letting the checks run themselves

```bash
./tools/chrome-clone.sh --list        # your Chrome profiles, by name
./tools/chrome-clone.sh "Profile 3"   # clone that one, open it with a debug port
npm run attach                        # read the health report out of its tabs
```

`chrome-clone` copies the profile you name — cookies, sessions, extensions —
into `~/.lct-chrome` and launches THAT. So the browser under test is the one
you actually use, already signed in, rather than a blank one you have to set up
twice. The original is untouched; `rm -rf ~/.lct-chrome` forgets the copy.

It has to be a copy: since Chrome 136 the debugging port is refused on your
normal profile directory, on purpose, so that a page you visit cannot reach a
browser holding all your logins. The clone carries the live sessions of
whichever profile you pick, so pick the one you test with.

Or `./tools/chrome-debug.sh` for the same thing with an empty profile, when
you would rather sign in fresh than copy anything. `npm run attach:watch`
re-reads every 30s while you work.

`attach` talks to a Chrome you are already using instead of driving one of its
own: same tabs, same logins, nothing to sign into twice. It asks the
extension's service worker for the same report the popup's Health link shows,
so checking a live site stops being a screenshot-and-paste round trip.

The separate profile directory (`~/.lct-chrome`) is not a style choice —
since Chrome 136 the debugging port is refused on the default profile on
purpose, so that a web page cannot reach a browser holding your real logins.
While that port is open, anything on the machine can drive that window; it is
bound to localhost, it dies with the browser, and it should hold test accounts
only.

### Or a browser of its own

To check every platform at once, in a browser that is nobody else's:

```bash
npm run verify:login   # once — sign in to your test accounts in a throwaway profile
npm run verify:live    # thereafter — opens each site, prints a verdict per platform
npm run verify:live -- --only chatgpt,claude
```

It runs the real extension in its own Chrome profile under `~/.lct-verify`
(`rm -rf ~/.lct-verify` forgets everything, sessions included), asks the
extension's service worker for the same health report the popup shows, and
writes `test/.work/live/report.md` — counts and verdicts, no message text, no
conversation ids. Google refuses to sign in inside an automated browser, so
check Gemini by hand with the Health page.
