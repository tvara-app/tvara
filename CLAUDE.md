# Tvara — working notes

Chrome MV3 extension. A local archive of every AI chat the user has, plus the
tools that make a long chat usable. One IndexedDB on the extension origin; the
background service worker owns it and is the only authority on what is paid.

Providers: ChatGPT, Claude, DeepSeek, Grok, Perplexity, Gemini.

## What this is for

**Your own AI history, kept on your machine, and honest about what it holds.**
Everything else follows from that sentence, and when a decision is close, it is
the tie-breaker:

1. **Nothing leaves the device.** No chat text, title or prompt is uploaded by
   any code path. The one server is the licence issuer, and it never sees a
   word of a conversation.
2. **Never lose what the user wrote.** A provider deleting a chat does not
   delete the copy here; a shrinking write never replaces a fuller record; a
   backup exists so a reinstall costs nothing. When in doubt, keep it and ask.
3. **Say what is true, or say nothing.** A count the code cannot vouch for is
   marked approximate; an allowance nobody published reads "not reported", never
   an estimate; a plan that cannot be read is blank, never "Free". A wrong
   answer that looks right is the worst outcome in this codebase, and most of
   the rules below exist because one shipped.
4. **A feature that silently does nothing reads as broken.** The map, the card
   and the speed engine appear everywhere, on every provider, free.
5. **Never break the host page.** Unknown DOM, drifted selector, missing
   endpoint: do nothing at all. The worst case is the site behaving normally.

Speed is how this started and is still the first thing a user feels, but the
product is the archive — the tools exist to make what it holds usable.

## Layout

| Path | What it owns |
|---|---|
| `bg.js` | Service worker entry: the `importScripts` list, every event listener, the message router. ~490 lines. |
| `bg/` | The rest of the worker, one file per concern: `store` `state` `fetch` `providers` `chat-index` `deletions` `accounts` `quota` `sync` `fill` `status` `backup` `schedule` `bootstrap` `paywall`. |
| `lib/entitlement.js` | Licence + trial + identity + device sessions, client side. Signs every issuer call. |
| `lib/dodo.js`, `lib/license.js` | Payment provider, offline `LCT1` key verification. |
| `content/` | Per-site scripts. `adapters.js` is the only file that knows a host's DOM. |
| `content/richtext.js` | Code highlighting and LaTeX → MathML for archived text. No library: the CSP blocks every CDN. |
| `content/deletion-toast.js` | "A chat was deleted", asked in the page, with Keep/Delete on it and a 5s undo. |
| `popup/` | The popup, the device screen, the account card. |
| `pages/` | Every full-page surface: `recall.html` (search), `archive.html` (check, backup, restore, delete), `fetch.html` (what text to fetch), `onboarding.html`. `pages.css` and `pages.js` are named for the SET they serve — `recall.css` styled three pages and `recall-page.js` drove two. |
| `content/chatcard.js` | The hover card. Reads the archive via `chat-stats`, never the DOM alone. |
| `server/` | Cloudflare Worker (`entitlement-worker.js`), D1 schema, `AccountDO`. |
| `docs/SESSIONS.md` | The device-session design, including decisions that were reversed. |

## The worker is one scope, split across files

`bg.js` and every file in `bg/` share ONE global scope. Chrome loads them with
`importScripts` (synchronous, so listeners still register in the worker's first
turn); `tools/pack.mjs` lists the same files as plain Firefox background scripts,
**derived from the `importScripts` call** so the two can never drift. Rules:

- **No `type: "module"` on the Firefox background, ever.** Module scope is
  per-file; it would hide every function from every other file.
- **A new module has to be added to `BG_MODULES` in `bg.js`** — the array the
  worker spreads into `importScripts`, and the single source of truth for the
  packer, ESLint, and the tests. It is spelled out ONCE: the failure path
  re-imports the same array, and the packer dedupes what it parses.
- **A dead worker says nothing.** Chrome reports a failed `importScripts` as
  "An unknown error occurred when fetching the script", which names no file, and
  the next line — `const _gate = requireEntitlement` — then threw and took every
  listener with it. So the batch failure retries one module at a time to name
  the file (only when none of them ran; a throw from inside a module has already
  run its predecessors, and re-running those redeclares every const), and the
  gate falls back to a deny. Fail closed and stay alive.
- **Anything reading the worker as text reads all of it.** `tools/worker-source.mjs`
  (`workerFiles` / `workerSource`) exists for that; reading `bg.js` alone now
  checks the router and nothing else, and passes while it does.
- ESLint derives each file's cross-module globals from the sources, so a typo is
  still `no-undef`. Unused *top-level* names are not flagged in `bg/` — the
  linter cannot see the sibling that calls them.

## Rules that are not negotiable

- **The worker decides entitlement.** `requireEntitlement()` and the `PAID` map
  in `bg.js`. Pages hide locked UI as a courtesy; hiding is never the gate.
- **Dates come out of signatures.** A trial's start date is read from the
  issuer's `LCTT1` token, never from the local record — that record is writable
  by whoever owns the browser.
- **`chrome.alarms` is the only clock.** An MV3 worker is reclaimed constantly.
  A module variable is not state; `storage.local` or `storage.session` is.
- **No chat text leaves the machine.** The only outbound calls are to the
  declared providers (to copy history in) and to the issuer (licence key hash,
  device hash, identity token).
- **A trial needs a verified address before it starts.** An unverified week is
  anchored to a keypair an uninstall destroys, so it can never be recovered.
- **The freeze copy is not the conversation.** `makeFreeze()` clones the whole
  scroller to hold a still picture during a walk, and that clone carries every
  marker the selectors match on. `adapter.messages()` drops anything inside
  `#lct-freeze` — scoped to that one id, because an `lct-` prefix test also drops
  a host element that happens to be named that way. Without it the count doubles,
  the archive flush writes each message twice, and the walk's own "have we
  reached the total?" test passes before a single request.
- **One message is a conversation, in all three places.** `upsert`, `importBatch`
  and the fill queue must agree on `>= 1`. They disagreed for a while: upsert
  called a one-message chat a stub, the fill pass fetched it, threw the single
  message away and marked it done — forever.
- **Every archive read resolves both ids.** `recordFor()` in `bg/chat-index.js`
  wraps `chatIdCandidates`; `chatStats` did and `chatArchive`/`chatMessage`/
  `chatSearch` did not, so the card said "archived" and opening it said "missing".

The popup's headline number is live: `stats()` in `bg/store.js` is cached
against an in-memory write counter (`archiveChanged()` on every upsert, import,
drop and wipe), so the popup can ask every few seconds while it is open and pay
nothing when nothing was written. It used to be read once per open, so the count
only moved if you closed the panel and opened it again.

**A reload is not an install.** `firstRunBootstrap()` lets `reason === "install"`
override the already-ran flag, because a reinstall wipes storage and an upgrade
from an older build must still get the pass. But pressing Reload on an unpacked
extension is ALSO reported as an install, and storage survives it — so every
reload started the whole sweep again and the panel went back to "Capturing 35 of
498" on a browser that already held them. The stored bootstrap record carries
the extension VERSION, and that is what tells the two apart; an empty archive
still runs, so a first pass that failed is not left stuck.

**A dead worker must say so once, not a dozen times.** Every `bg/` module
failing to load produced a panel of small emptinesses — no counts, no
allowance, rows stuck on "checking" — and they get reported one at a time as
separate bugs. `worker-health` is answered by `bg.js` BEFORE any module is
touched, because it is the one question a half-loaded worker can still answer
about itself, and the popup raises `#worker-dead` naming the files that could
not be read. Silence counts: a worker that cannot answer that did not start.

**A dead worker gets one chance to fix itself.** Naming the files that would
not load is the diagnosis, not the cure: the extension stays dead until
somebody presses Reload, and nobody does — the symptom reads as six separate
features being broken rather than as one worker that never started. Every time
this has been seen the files were on disk and readable, so what is stale is the
service-worker registration, and `chrome.runtime.reload()` is what rebuilds it.
`bgHeal()` does that at most twice, keyed on the extension VERSION and cleared
by a healthy start, and the count is written BEFORE the reload — an unrecorded
attempt is an extension that restarts itself forever. `bgHealNext()` is pure so
the bound is provable without a browser (`test/test-parsers.mjs`); it is the one
thing here that must never be wrong.

**A rate-limit floor must never be able to create a permanent blank.**
`quotaPoll` skips a platform polled recently — and returned before writing
anything, so one early poll that set the clock without leaving a probe report
blocked every later attempt and the row sat on "checking…" for the life of the
install. The floor now applies only once something has been LEARNED about that
platform: no probe report means it has never been read at all.

**A 403 is two different facts wearing one number.** Cloudflare's managed
challenge is served as `403` with `cf-mitigated: challenge` and an HTML
"Just a moment…" body, and claude.ai serves exactly that to the worker's
fetches. `bgFetch` called every 403 `auth`, so it reached the panel as
**"Not signed in"** on an account that was signed in the whole time — the least
actionable thing this extension can say, and the one wrong answer that looks
like a real one. A challenge is now its own kind: the row says the provider
blocked the background check and that opening the site in a tab clears it, the
stored allowance rows are NOT retired (the session is intact, so they are still
about the right person), and `signedOut` stays false. Only `401`, and a `403`
whose body is not the interstitial, is still a verdict about the session.

A provider that could not be ASKED — signed out, or refused at the edge — is
excluded from the headline exactly as a signed-out one always was
(`unreachable()` in `bg/status.js`). Its own row still says what happened,
which is where it is actionable; leading with it meant the reassuring line a
fully-synced archive has earned could never appear. The suite proves the
classifier against the live edge: it has no Claude mock, so `claude.ai` answers
the real challenge.

**The offer is watching it work, not a list of feature names.** The card used
to say "Total Recall, Context Bridge and every tool on Claude & Gemini" to
somebody who had owned the extension for ninety seconds and knew what none of
those were. Nobody buys a description. So a locked install is granted a few
REAL searches over its own archive — their conversations, their words, the
actual feature — and then the gate closes and the card points at what they just
saw. The 7-day trial and the one-time purchase sit beside it the whole way.

It is a GRANT, and the shape of the grant is the whole of its safety.
`requireEntitlement()` is untouched: the router asks it first, and only then,
for `recall-search` ALONE, spends an allowance the worker counts
(`tasteSpend()` in `bg/paywall.js`). Search is a demonstration; backup, restore
and export are the archive leaving the building, and they get no taste. The
counter is spent on searches rather than on time, so nobody loses their taste
to a week passing, and it lives in `storage.sync` like the trial clock, so
clearing local storage does not mint another one.

**Never probe the gate with `recall-search`.** It answers results before it
answers "locked", so an assertion that a forged token, a foreign key or a
hand-written Pro record "stays locked" is satisfied by the TASTE rather than by
the gate — it would go green on a build whose paywall had been deleted. The
security suite probes with `recall-snapshot` (archive.backup, no exception) and
B13 spends the taste before it starts. Both were written against
`recall-search` and both had to move the day the taste landed.

**Total Recall is the search, and nothing else.** Checking providers for new
chats, the encrypted reinstall backup, restoring one, choosing what text to
fetch and deleting the archive are all FREE, and a free control reached only
through a paid page reads as a thing you have not bought. `pages/fetch.html` took
the picker; `pages/archive.html` takes the rest, and `pages/recall.html` keeps a
door to both. One script (`pages/pages.js`) still serves both pages, so every top-level hook
goes through `on(id, ev, fn)` and every paint tolerates an absent node — a
control that lives on the other page is missing, not broken.

**One endpoint answering nothing is not a signed-out session.** Claude's
`prepare()` read `/api/organizations` and, finding no usable org, declared the
session dead — which sends somebody to sign in to an account they are already
signed into. It falls back to `/api/bootstrap`, which claude.ai itself loads on
every visit and carries the same organisations under `account.memberships`; only
when NEITHER names one is this signed out. An `auth` refusal still short-circuits,
because that one is final.

**A finished provider is not a missing one.** The picker was built from the
stub index — chats holding a title and no text — so a provider whose text was
all fetched had no stubs and `fillQueue` skipped it entirely. Five of six
platforms vanished from the one page whose job is to say what is there, and
missing read exactly like never archived. `fillQueue()` now makes ONE pass over
the archive and returns every chat a provider holds, each carrying `held` —
replacing a stub list plus a batched re-read of it. A row says `624 waiting` or
`all 28 fetched · re-fetch`; a finished provider opens like any other, because
text already here can be fetched AGAIN: a conversation carried on since it was
archived has messages this copy does not.

**A refusal is about ONE provider, and only `auth` is about the session.**
The text fetch runs all six at once, so a platform that will not answer is not
the run failing — but `bg/fill.js` wrote one `note` field, last writer wins, and
wrote every failure as "signed out" or "not signed in". A rate limit (ChatGPT
backing off after a burst), a bot challenge and an unreachable network all
reached the row as a verdict about the account, on a session that was signed in
the whole time; the popup then appended "Sign in, then tap to continue" to
whatever it said, so even the challenge note ended "…open it in a tab.. Sign in,
then tap to continue." `fillWhy()` writes ONE sentence carrying its own remedy
and `noteFill()` keys it per provider (cleared when that platform answers), so
the row can say "ChatGPT is rate-limiting. It picks up again on its own. (+1
more)" while five platforms carry on downloading. Same rule as `quotaWhy()`;
this was the fetch row's copy of the same defect. `writeFill()` goes through
`editLocal()` now — six providers and several lanes inside each write that one
key, and a read-then-write loses whichever landed first.

**The export is a document, not a memory dump.** A stored record is a storage
shape — `r`, `t`, `ts`, `i`, `c`, `m`, `n`, `mv`, epoch milliseconds — chosen to
keep thousands of conversations small in IndexedDB, and `pages/pages.js` wrote it
to the file byte for byte: somebody opening their own history found one-letter
keys and no readable dates.

`archiveDocument()` is now the single ordering and the single shape, and three
buttons write it out, so they cannot disagree:

- **A page (`.html`)** — one self-contained file, every conversation in full,
  a contents list, `Ctrl/Cmd+F` over the lot. **Deliberately not a generated
  PDF**: a PDF writer here means vendoring a library plus a Unicode font, the
  better part of a megabyte in front of an extension whose whole promise is
  speed, to reproduce badly what the browser already does — `Ctrl/Cmd+P` on this
  file paginates it with `break-before: page` per conversation.
- **A list (`.csv`)** — one row per CONVERSATION, because that is the shape a
  spreadsheet is for. One row per message is not: an answer is four thousand
  characters of prose and code, and a cell is one line. Leading BOM, or Excel
  reads UTF-8 as mojibake.
- **Everything (`.json`)** — version 3, every field spelled out (`role`, `text`,
  `at`, `providerMessageId`, `truncated`, `imageOnly`), ISO 8601 times, a
  `fields` block that explains the file inside the file. Nothing imports it;
  being readable is its whole job.

Ordered provider, then TITLE, then the whole conversation — newest-first was the
write order dressed up, and a file is read by looking something up in it. An
untitled chat sorts last: it is not the head of the alphabet.

**The readable page is built from the user's own chat text**, so every
interpolation goes through `esc()` and a picture renders only under the archive
panel's own scheme allowlist (`https?:` or `data:image/`). B11y asserts the
output carries no `<script`, no `on…=` attribute and no other scheme — the check
that no path skipped the escaping.

**Customize belongs on the button it customizes.** "Choose what to fetch" had a
row of its own and read as a second thing to do. It is one decision about the
fetch button, so it sits on that row. A `<button>` cannot contain another and
the icon and text must stay direct children of the row's grid, so the hit area
is a real button laid UNDER them (`.row-hit`, `inset: 0`) with both above it.
When there is nothing to choose the control is WITHDRAWN, not removed
(`visibility`, never `hidden`): its column stays, so the sub-line cannot rewrap
and the row cannot change height under a reaching hand. B21a measures it.

**Choosing what to fetch is its own page (`pages/fetch.html`), not a Recall panel.**
Recall is the SEARCH feature and it is gated. Deciding what the archive should
hold is neither, and burying a free control inside a paid page is how a thing
that works comes to look like a thing you have not bought.

**A choice describes ONE pass.** The pick is persisted rather than held in a
variable so a worker reclaimed mid-run resumes the same choice — and it was
never cleared, so a pass that FINISHED left it behind and every later fetch was
narrowed to the same handful for good: the auto queue re-ran two chats, reported
"partial" because five hundred were still waiting, and came back to run the same
two again. From the outside that is a fetch button that does nothing, forever,
bought with one visit to the picker. `fillStart()` clears it at its own end; the
reclaim path never reaches there, which is exactly the distinction that matters.

An explicit list is the whole instruction, not a filter over the stubs.
Intersecting the two dropped any chat whose text was already here, so ticking it
did nothing. Scoped to the adapter's HOST, never host+prefix — three providers
store one chat under two spellings (`chatIdCandidates`), so a prefix test would
reject the very ids this page just handed out.

**A run reads its choice once, before the loop.** So handing a new one to a run
already in flight changed nothing, and the router answered `started: true`
anyway — pick three chats while a download is going, press Fetch selected, and
the page says it has begun while the old queue carries on. `fillRestart()`
stops, waits for the loop to land, and starts on the new choice; where it cannot
(a fetch still in the air) it answers `busy` and the page says so rather than
claiming success.

**Fetching text is per chat, so choosing what to fetch is per chat.**
`archive-fill-start` takes an optional `pick` — a provider left out is not
fetched, one named with no list is fetched whole, and no `pick` at all still
means everything. It is persisted with the queue, never held in a variable: the
watchdog alarm restarts `fillStart()` with nothing in hand after a reclaim, so a
choice in memory would quietly widen back to everything. `archive-fill-queue`
lists what is waiting per provider with TITLES only — the words are the thing
that has not been fetched yet — and the per-provider cap is stated on screen,
because a cap nobody mentions is a lie about how much is there.

## Background work

Everything archives itself. Nothing waits to be asked, and nothing reads
whether the browser is focused.

- `firstRunBootstrap()` runs a pass the moment the extension is installed.
- `lct-auto-sync` — every 3 h. Steady state.
- `lct-auto-sync-resume` — 1 min, **repeating**, booked BEFORE the first request
  of a pass and cleared only when a pass ends with nothing left. This is what
  carries a pass across the worker being reclaimed mid-fetch.
- `resumeIfUnfinished()` on `wake()` — a browser restart clears alarms, so
  outstanding work is rebooked from what the last pass wrote about itself.
- `lct-fill-resume` — 1 min, repeating, for the text-fill queue.
- **The text queue runs every provider at once, and several chats within each.**
  Six hosts have six independent budgets and six independent pacers; one
  signed-out or cooling provider used to hold every other queue behind it. The
  lanes inside a provider do NOT make it faster than the host permits —
  `hostSlot()` holds `intervalFor(host)` between request STARTS whatever is
  waiting on it — they stop the pipe standing empty while a response is in the
  air. `targetConcurrency()` is re-read per chat, so a 429 narrows the queue on
  the next one; lane 0 always survives, so a narrowed queue slows rather than
  stops. The fixed `FILL_PAUSE_MS` sleep is gone: it was a second rate floor
  outside the pacing code, and it made every chat cost the interval PLUS the
  round trip PLUS 350 ms.
- **`BG_HOURLY_CAP` is a budget, not the rate limiter.** What protects a session
  is `intervalFor()` doubling on the FIRST refusal and the circuit breaker
  tripping on the third — both driven by the provider's own signal. At 400 the
  cap was the binding constraint on every large archive: the hour ran out long
  before the work did, whatever the fetch speed. 1,200 is one request per three
  seconds averaged over an hour, well under the one-per-500 ms already permitted
  in a burst.
- Budget: `BG_PASS_BUDGET_MS` (4 min) covers the **listing and the fetching**
  together, with `BG_MIN_FETCH_MS` (60 s) guaranteed to the fetch loop so a slow
  listing can never starve it.
- An open tab of the site only drops the pass to one request at a time. It is
  never a reason to defer. Window focus is read nowhere.
- **A pass must never sleep past its own budget.** The hourly cap
  (`BG_HOURLY_CAP`, per host) used to be enforced by sleeping out the rest of
  the hour INSIDE `hostSlot()` — holding `bgSyncRunning`, so every later sync
  and every manual "Check now" was answered "already-running" until Chrome
  recycled the worker. A wait longer than `BG_SLOT_MAX_WAIT_MS` (90 s, above
  every legitimate one: the polite interval, an open tab, `BG_YIELD_MS`) now
  throws instead, the platform reports "cooling-down", the resume alarm stays
  booked and the pass ENDS.
- **Pacing is keyed per ORIGIN AUTHORITY, the allowlist per host.** `paceOf()`
  keeps the port, `hostOf()` does not. In the browser every provider is on :443
  so the two are identical; under test six providers share one loopback address
  on six ports, and keyed by hostname alone they were one host sharing one
  hourly budget — the later suites ran against a budget the earlier ones had
  spent. A port is not a permission: `BG_ALLOWED_HOSTS` stays hostname-only.
- **A learned rate outlives the worker, and it comes down again.** Chrome
  reclaims the worker ~30 s after it goes idle, so a rate held in memory is
  re-learned by every new worker — at full speed, refused each time. Three rules
  in `bg/fetch.js` / `bg/state.js`, all measured on a real ChatGPT account:
  - `noteRateLimit()` saves the trip and interval on EVERY refusal, not only
    when the breaker opens after three.
  - `hostSlot()` — the gate on every request, foreground and background — reads
    the saved rate back once per host per worker before the first request. Only
    the listing used to, so the text download re-learned from 500 ms and its
    save wrote 500 over a learned 18,964.
  - `persistCooldown()` MERGES and never lowers a saved rate — except a
    relaxation. After `BG_TRIP_RELAX_AFTER_MS` (20 min) with no refusal the rate
    steps down by `BG_TRIP_RELAX_FACTOR` (×0.8), and again every 20 min it stays
    quiet. ChatGPT also limits by a rolling window across the whole account, so
    a floor that only rose capped that account at one chat a minute for good.
    A step too far costs one refusal. `r`/`x` (refused/relaxed at) are stored
    with it; a record older than those fields starts its quiet clock on load.
  `test/test-pacing.mjs` builds a FRESH worker per request and restores only
  what the real `loadCooldown()` reads back. Its first version kept the pacer in
  memory and passed while all of this was broken.
- **A page loading is proof the session is alive.** Each chat page asks the
  worker to sync as it loads (`visitSync()`, `bg/schedule.js`). The 20-min floor
  is PER PROVIDER, and a provider whose last pass FAILED is re-checked at once.
  One shared timestamp meant six open tabs throttled five behind the first, and
  somebody who had just signed in read "Not signed in" for three hours.
- **The welcome page says the copy takes time.** A new user's first move is to
  open a chat that has a title and no text yet, which reads as a blank page. It
  says 5–10 minutes is TYPICAL, not promised (a rate-limited account can take
  over an hour), then shows the real count and an ETA measured from this run.
- **Six platforms run at once, so a read-modify-write on one key is a race.**
  `editLocal()` (`bg/state.js`) chains them per key. The sweep state and the
  trace ring were both read-then-written by every platform: the last writer
  erased the rest, so the anomaly that explains "we saw your history vanish and
  did not believe it" vanished whenever another platform swept in the same
  moment, and the trace kept one platform's line out of six. Both are the
  diagnostics, losing exactly when there is most to diagnose.
- `trace()` writes a durable ring of what the worker did — pass starts, alarms,
  per-platform results, budget stops. Read it with
  `chrome.runtime.sendMessage({type:"bg-trace"}, console.log)` from the service
  worker console. It is the only way to see a worker nobody is watching.

## What plan the account is on, and how much is left

Both come from a response the allowance probe was already fetching — a label is
never worth a request of its own. `planFrom(path, json)` on an adapter
(`bg/providers.js`) is where each provider states it, and what it says beats
whatever the handshake inferred:

- **ChatGPT** — `/backend-api/wham/usage` is **Codex**, not the chat
  allowance. Its own response says "You're out of Codex messages", and on a plan
  that barely includes Codex it reads 100% used — so a Go account with 300
  reasoning messages left read "0 left". It still carries
  `rate_limit.primary_window` / `secondary_window` (`used_percent`, `reset_at`,
  `limit_window_seconds`) and `plan_type`, and still counts, but the endpoint
  names its meter (`meter: "codex"` in `QUOTA_ENDPOINTS`, looked up by PATH —
  the learned `working` list is rebuilt from a field whitelist and would drop
  it), `tagMeter()` stamps every window it produced, and the row says "Codex".
  `conversation/init` carries the per-feature counters.
  `/backend-api/accounts/check/…` → `entitlement.subscription_plan`
  (`chatgptplusplan`, `chatgptproplan`, …). `/api/auth/session` does NOT carry a
  plan; the field the handshake used to read has never existed there, so every
  ChatGPT account reported no plan at all.
- **Claude** — `rate_limit_tier` on the organisation
  (`default_claude_max_20x`), then `raven_type`, then the older `capabilities`
  list. Capabilities alone called a Max account "Pro" and, on an org that lists
  neither, a paying account "Free". `/api/organizations/{org}/usage` also states
  `plan_name` outright, and carries `five_hour` / `seven_day` utilisation.
- **Perplexity** — `/rest/user/settings` → `subscription_tier` gated on
  `subscription_status`, so a lapsed Pro is not still called Pro. Its live
  counters are at `/rest/rate-limit/all`.
- **Gemini** — **batchexecute routes on the page a call claims to come from.**
  `rpc()` hardcoded `source-path=/app` for every call and sent no extension
  header. That is right for the LISTING, which is why archiving worked — the
  usage RPC is served to `/usage` with `x-goog-ext-73010989-jspb: [0]`, and
  asked from `/app` it answers nothing, so the panel said Gemini published no
  allowance while gemini.google.com/usage was showing one.
- **DeepSeek publishes no allowance at all.** It enforces with `429` plus a
  proof-of-work challenge, not with a quota endpoint. "no limit published" on
  that row is the true answer, not a gap to be filled with an estimate.
- **Gemini** — no REST API at all: the allowance is a batchexecute RPC
  (`jSf9Qc`, args `[]`), answering `[tierCode, [window, …], overageFlag]` where
  a window is `[?, fractionSpent, kind, [[epochSeconds, nanos]]]`, kind 1 the
  five-hour window and 2 the week. Read `fractionSpent` and the reset and
  NOTHING ELSE: index 0 is not a remaining count — two independent readers of
  this RPC never use it for a window — and publishing it as "N left" is exactly
  the confident wrong number this panel exists to avoid. Kind 3 is not a window
  at all; it is the AI-credit balance, and index 0 there IS a remaining count.
  `tierCode` (1 free, 2 pro, 3/6 ultra, 4 plus) is the ONLY statement of a plan
  this host makes anywhere. Windows are found structurally, so a new bucket
  with a layout of its own cannot reject the two that parse.
  `QUOTA_ENDPOINTS.gemini` marks it `native: true` because it is not a URL.

`planName()` matches on SUBSTRINGS, never a table of exact strings: these tiers
get renamed without notice, and a renamed tier reading as "Free" is the one
wrong answer that looks like a real one.

**A tier is one word, so match it as a token.** OpenAI spells them
`chatgptgoplan` and `chatgptprolite`, not `chatgpt_go` — so `planName()` strips
the product word and the `plan` suffix before testing. Without that, **Go**
matched nothing and the account reported no plan at all, and **Pro Lite**
matched `pro` and reported the tier above it. `go` is then tested only as a
whole token: as a substring it lives inside google, cargo and django, and a
badge invented out of one of those is worse than no badge.

**A window that states its length in seconds states which window it is.**
ChatGPT calls its two `primary` and `secondary` and says nothing else, so
`limit_window_seconds` is the only thing separating the five-hour session limit
from the week. `SPAN_SEC_KEYS` in `lib/quota.js` reads it BEFORE `LIMIT_KEYS` —
`limit_window_seconds` matches those too, and taken as a ceiling it becomes a
limit of 18000 of nothing.

**Perplexity's answers are keyed by ID, not by class.** `id^="markdown-content-"`
— one per answer — is the only hook on that host that is neither a hashed class
nor a guess, and because every probe looked at CLASSES the whole platform fell
through to nothing: no map at all. The layer lifts each answer to the turn that
holds exactly one of them, then splits that turn into what was asked and what
came back, or the strip would draw one tick per exchange and report "0 asked".
`test/perplexity-turns.html` is two exchanges; four ticks, two each way.

**A percentage is not a ratio.** Anthropic documents `utilization` as 0..100.
Read through the generic "a value under 1 is a fraction" rule, a session 0.4%
spent became "40% used" and the panel told somebody who had barely started that
60% was left — under 1%, which is most of a fresh five-hour window, the figure
was not imprecise, it was inverted. `PCT_KEYS` entries now carry `whole: true`
for keys that name themselves percentages; only `ratio`/`fraction` keys scale.

**The same limit, stated twice, is one limit.** Claude states its five-hour
window as a percentage in `/usage` AND as remaining/limit headers on the send
path, under two different keys — so both survived the merge and `rank()` picked
between them by score. They disagree (headers count tokens, the page counts a
weighted allowance), so the row flipped as each was refreshed: right one minute,
wrong the next. `merge()` keeps ONE share per span — freshest, and on a tie the
percentage the provider stated over one computed from a pair. Counts are
untouched: a provider can meter several different things on one clock, but it
never states two different shares of one allowance.

**A provider that publishes two windows is answering two questions.** Claude
states a five-hour session limit AND a week; the row leads with the one that
stops you soonest and the figure is a BUTTON that steps to the others.
`ranked()` in `lib/quota.js` is the whole list, `primary()` its head. Two rules
the switch cannot break: only windows that STATE a figure are options — landing
on "not reported" is a step to nothing, though it is still a real row when it is
all a provider gave us — and the list is sorted by each row's LEADING window,
never the selected one, or a row jumps out from under the cursor as you step
through it. The choice lives in `winPick`, outside the paint, because the panel
repaints every few seconds.

**A platform with no allowance to publish is not a row on this panel.**
`NO_ALLOWANCE` holds DeepSeek, which enforces with 429 plus a proof-of-work
challenge and has no quota endpoint, so its row could only ever say "no limit
published" — a permanent line of nothing among the figures. It is archived like
every other provider; only the placeholder is suppressed, so the day it does
publish a number the row comes back.

**The session limit is the one that stops you.** A window now carries how long
it IS (`spanSec`, from what the provider calls it — `five_hour`, `seven_day`,
`weekly`), and `rank()` breaks a tie by preferring the SHORTER one. Claude
publishes both; the weekly figure is usually the lower of the two, so ranking by
urgency alone showed the week and hid the five-hour session limit — the one that
stops you in the middle of an answer, which is the whole reason anybody opens
this panel. The row names the window and says when it turns over: "76% left ·
5h · resets 9:46 PM".

**A side feature is not the allowance.** ChatGPT meters deep research, image
generation and voice separately from the plan, and `rank()` led with "4 left ·
deep research" while the figure the reader asked about sat behind it. Niche
meters take a penalty, never an exclusion: where one is all the provider
published, it is still the truth and it is still shown. The penalty is a TIER,
not points: `rank()` orders a real allowance with a figure, then a side meter
with a figure, then anything figure-less, and scores only within a tier. As −3
on a score where a percentage is worth 8 and a count 4, Codex's percentage beat
the real allowance's count every time.

**A remover of readings only removes readings.** `forgetQuotaFor()` and
`retireUnknownQuotaTags()` read with `getByPrefix(prefix, [QUOTA_PROBE_KEY])`
and then deleted every key that came back — so `lct-quota-probe-v1`, the learned
endpoint list, was wiped by every SUCCESSFUL poll and every sign-out. It was
never on disk. Three things followed, and all three were reported as separate
faults: every poll re-probed every candidate against the user's own session
(six endpoints per platform, on every popup tick), the per-platform poll floor
never applied because "no report" is how the code says "never read at all", and
the probe's stored `error` — the one record that says WHY a provider could not
be read — was destroyed before anybody could look at it. On a build with no
`storage.local.getKeys()` the read is `get(null)`, so one 401 would have taken
the entire extension store. `keysUnder()` is the rule: never remove a key the
prefix does not own. N1 in `test/test-accounts.mjs` could not see it — it
asserts the report after a FAILED probe, and neither remover runs on that path.

**Only `auth` is a statement about the session.** The 403 classifier fixed this
one layer down; `quotaPoll` then did it again at the top, mapping every
non-challenge failure to "not signed in" — a timeout, a rate limit, a dead
network, all reaching the panel as a verdict about the account, which sends
somebody to sign in to an account they are already signed into. `quotaWhy()`
turns the error KIND into the words, and the probe records that kind so the
learned-note path answers the same way; matching words in the sentence the
probe wrote (`/not signed in|unreachable/`) is what called a rate limit a
sign-out.

**A window that states no figure is not a reading.** It is a deadline with
nothing attached, and it outlives every real window because a future reset
never goes stale. Live, Perplexity's rate-limit response carried one beside
"3 pro searches left": after `FRESH_MS` the real counters aged out, the empty
one did not, and the row degraded from a number to "not reported" out of the
same response. `ranked()` drops a window carrying no percentage, no remaining
and no limit; with none left the row says the provider answered and reported
nothing, which is true. A figure of ZERO is a figure — it is the one the reader
most needs.

Rules the panel cannot break:

- **Which seat holds the allowance is decided from the NUMBERS, not before
  them.** Every organisation a claude.ai login owns reports the same tier, so
  picking one by plan alone was a coin toss settled by whichever the API listed
  first — usually the personal org nobody uses, reporting "100% left" while the
  site said a quarter of the week was gone. `quotaSeats()` now returns every
  seat tied at the best plan and `pickAllowanceSeat()` (`bg/quota.js`) keeps the
  one being SPENT; the losers are dropped from the live set rather than stored,
  because they are one subscription seen twice. Where no seat publishes a share
  there is nothing to compare, so the first is kept rather than a preference
  invented.
- **One login, one allowance row.** `accounts()` lists every ORGANISATION —
  the archive is per organisation, a chat lives in one — but a subscription is
  not. Polling each org stored each as its own account, so one subscriber saw
  "Claude Pro" twice and the row that won was whichever org answered last,
  usually the unused one at 100% left. `quotaSeats()` is the adapter naming the
  seat that holds the allowance (`bestPlanSeat`, by `planRank`).
- **A grab-bag is a plan source, not a meter.** `/api/bootstrap`,
  `/api/organizations/{org}`, `/backend-api/accounts/check` carry the whole
  app's start-up state, and any remaining/limit pair inside one reads as an
  allowance — an untouched "30 of 30" scores HIGHER than the real meter,
  because a computed percentage outranks a percentage with only a reset beside
  it. Those candidates are `planOnly: true`: their plan is read, their numbers
  are dropped. `quotaSig()` covers `planOnly` and `native`, or yesterday's
  learned list keeps treating them as meters for a day.
- **A row is about somebody who is signed in.** An auth failure
  (`error.kind === "auth"`, never a timeout) clears that platform's readings,
  and a pass that stores something retires readings for accounts the login no
  longer has — the second organisation, or a free account replaced by a paid
  one. Only where the adapter can name an account: where it cannot (Gemini,
  DeepSeek, Grok) the tags come from the page and the seat list is not
  authoritative.
- **Asking directly means asking again.** A `manual` or `popup` refresh drops
  the cached handshake first, because signing in as a different account is
  exactly when a five-minute-old context describes the wrong person. The open
  panel's own minute tick is `watch`, which goes through every floor there is.

## Motion, and why there is no animation library

`lib/motion.js` is loaded by the popup, Total Recall, the fetch picker and the
onboarding page. It is not a small GSAP: it is the four things an animation
library actually gets used for here, and nothing else.

- **There cannot be a library.** `script-src 'self'` blocks every CDN, so any
  runtime would have to be vendored — tens of kilobytes in front of a panel
  whose whole promise is that it is fast, and on six content scripts if it went
  there too. The GSAP *technique* is what is worth having; the download is not.
- **One `requestAnimationFrame` loop for every value in flight.** A loop per
  tween is how this usually gets written and it is why panels judder. Asserted:
  six tweens started in one turn schedule exactly ONE frame callback.
- **Transform and opacity only.** Nothing animates width, height, top or left.
  The progress rail fills by `scaleX`, not by width.
- **`quickTo` retargets rather than restarts**, for values written on a timer.
- **A hidden document runs nothing.** Every job finishes on the spot and the
  loop is cancelled — a closed popup must not hold a frame callback open.
- **The formatter of a counting number always receives a WHOLE number.**
  Rounding inside each caller means the one that forgets counts a percentage up
  through 62.4177%, which reads as a readout glitching rather than a value
  arriving. It is rounded once, in `number()`, and a frame that lands on the
  same integer writes nothing at all.
- **`prefers-reduced-motion` turns every entry point into a plain assignment** —
  including `flip()`, which still performs the caller's mutation, because that
  is the actual state change and only the travel was decoration.

**Nothing meaningful lives in a native tooltip.** `title` is a delayed grey box
that covers the thing it explains, cannot be styled, never appears on a touch
device and is unreachable by keyboard — and the popup is read at a GLANCE. The
window switch has carried an `aria-label` and no `title` since it was written
(`test/test-extension.mjs` A1e asserts the absence); the rest of the popup and
`pages/` now match it. Say it on screen, or say it to a screen reader with
`aria-label` — and on an element whose role exposes one, which a bare `<span>`
does not (`#account-ring` is `role="img"` for exactly that). Two of these were
duplicates of text already on screen, and one — the overdue-licence sentence —
was written to a `dataset.note` no stylesheet has ever rendered.

## Nothing moves that the reader did not move

A control that appears mid-glance pushes everything under it, and what that
reads as is the panel lurching — usually at the exact moment somebody is
reaching for the button below it. Three rules, in order of preference:

1. **Reserve the space.** `.fill-bar` is a permanent hairline rail: it is
   already there before there is any progress, and only its fill moves. It used
   to be `hidden` until a download started, which added ten pixels to that row
   and dropped every row beneath it. A sub-line that changes at runtime
   (`.row-sub[aria-live]`) holds two lines' worth of room whether it needs them
   or not. `test/test-extension.mjs` B21a measures the row's computed height
   idle and busy and requires them equal.
2. **Where a change genuinely adds or removes something, FLIP it.** Measure,
   let the layout happen, then animate the difference away as transforms:
   nothing reflows during the motion and every row lands where the browser was
   going to put it anyway. `showRows()` in the popup routes every appearing and
   disappearing row through this.
3. **Placeholders are the same size as the thing they stand in for**, and they
   never wear that thing's class. A skeleton row wearing `.r-item` or
   `.pick-row` is counted as a result by everything downstream — the
   empty-archive notice read one as a hit, and a test waiting for the first
   search result matched a grey box with no text in it.

The picker (`pages/fetch.js`) is built once and EDITED. Rebuilding it on every
tick throws away the checkbox that has focus and the reader's place in a list of
a thousand titles — for a checkbox, which is the smallest interaction there is.

Hover changes colour, never geometry: that rule predates all of this and it
stays. A PRESS is different — it is the moment somebody committed to something,
and it is answered in the same frame with a small `scale()`.

## Walking the archive

Three rules, all measured against a real browser rather than `fake-indexeddb`,
which has no IPC and will tell you the opposite (it did):

- **`openCursor` is one request per record.** `scanChats()` in `bg/store.js`
  reads a page of whole records per request instead, on ONE transaction — the
  next `getAll` is issued from inside the previous one's `onsuccess`, before
  control returns to the event loop, so the walk is still a snapshot. A walk
  split across transactions is not, and the sync engine writing while a search
  reads could then skip a record or count one twice.
- **Reading N records by id is N transactions unless you say otherwise.**
  `recordsByIds()` issues every `get` synchronously on one transaction so they
  pipeline: 400 chats went from 40 ms to 8 ms. The fetch picker was doing a
  `recordFor()` per chat — up to eight hundred transactions per provider just
  to put titles on a list.
- **A visitor that throws inside an IndexedDB event handler settles nothing.**
  The promise would neither resolve nor reject and every caller would hang for
  the life of the worker. One malformed record must not be able to do that.

## Searching as you type

Search is AND over substrings, so adding characters can only ever NARROW the
answer: a chat containing "attention" already contains "atten", and a chat that
fails on an added word was going to fail anyway. So a query that extends the
last one is answered from that query's results rather than from the archive —
on 2,000 chats and 14 MB, 80 ms for the first keystroke and 2 ms for every one
after it.

- `narrowsFrom()` is the whole rule and it is pure, so it is tested without a
  store. Saying "yes" wrongly loses search results silently, which is the one
  failure this project must not have — so a word shortened, changed, removed or
  reordered all go back to the archive.
- The set is held against the archive's write counter (`archiveSeq`), or a chat
  the sync engine adds stays invisible until the query is retyped.
- Only while the set is small: narrowing five thousand candidates is not cheaper
  than the scan it replaces.
- **`scanned` still describes the ARCHIVE**, not the handful of records re-read
  to answer. "no matches in 12 chats" would be a false statement about an
  archive of two thousand.

`mayMatch()` is the other half: one missing word is the whole chat gone, and
answering that with a case-insensitive regex against the text already in memory
allocates nothing, where building a lowercase copy of every chat allocated the
whole archive. It runs only for plain-ASCII queries — across the whole of
Unicode, `toLowerCase()` and regex case folding are not guaranteed to agree, and
a fast path that drops a real result is worse than no fast path. It is only ever
allowed to be wrong in the safe direction, and 4,000 random cases check that.

## Numbers move

Everything in the popup is read at a glance, so a number that JUMPS reads as a
glitch — the eye cannot tell a repaint from a change. `tweenNumber()` counts to
the new value over ~420 ms, `setLine()` gives a changed sentence one beat of
fade, and the dial's arcs travel from the geometry last drawn (the dial is
rebuilt every paint, so a CSS transition has nothing to move from unless the
node is born at the OLD value and moved on the next frame). First paint never
animates a value it has not shown before, and `prefers-reduced-motion` turns all
of it into a plain assignment.

## Device sessions

D1 owns who is signed in. `AccountDO` (`server/account-do.js`) holds one
hibernatable WebSocket per device and is told **after** the kill commits, so a
sign-out lands on the removed device in about a second and raises a system
notification. The socket is an accelerator: a device that never connects still
dies on its next heartbeat. See `docs/SESSIONS.md` §4 for the reversal that put
it there.

## Counting messages, and who wrote them

- **The provider's transcript is ground truth.** `chatIndex()` fetches the whole
  conversation; the DOM holds whatever the host felt like mounting, which on
  these sites is a tail. Any count taken from the DOM is a lower bound and must
  never be allowed to shrink a recorded one.
- **Nothing about a message's text says who typed it.** Role heuristics that
  read content ("markdown means the model", "short means the person") report a
  prompt written as a numbered list as an answer. `adapter.role()` may return
  `""` for unknown; `resolveRoles()` (`content/adapters.js`) fills gaps by
  alternation from the nearest stated role. Only a stated role is ever memoized.
- **Never coerce an unknown role.** `role(el) === "user" ? "user" : "assistant"`
  writes every unmarked turn down as the model's, and it is what reaches the
  archive. Resolve the whole list at once — the page flush (`content/indexer.js`),
  the diagnostics split (`content/main.js`) and the card all do.
- **The archive already holds records written the old way.** `resolveMsgRoles()`
  in `bg.js` re-derives a split that is every message one speaker, and it is
  deliberately narrow: every role stated, all the same, four or more. Two
  adjacent assistant turns are a real record, not a broken one.
- **The minimap resolves the whole list too.** It used to ask `adapter.role()`
  per element and `draw()` reads `""` as assistant — so on a surface that states
  no role (a Claude Code session) every turn painted as the model's.
- **A count it cannot vouch for says so.** `computeApprox()` compares the matched
  turns against `adapter.canon`; off the primary selector the strip shows a `~`
  badge and the aria-label reads "about N turns". The map always appears; the
  number never lies about how sure it is.
- **Counts and the split travel together.** Take the total from one source and
  the split from another and a card reports nine messages of which eleven were
  yours. `chatStats` returns `held` alongside `n` for the same reason: a record
  can claim more messages than it holds.
- **One tick per turn, whatever matched.** `outermost()` in
  `content/adapters.js` is the last thing every adapter's list goes through: an
  element contained by another in the same list is dropped, because a nested
  match is never a message its ancestor does not already hold. It is one
  `contains()` per element, not one per pair — `querySelectorAll` answers in
  document order and nothing kept is inside anything else kept, so only the
  last kept element can contain the next. Grok's layer 1 also refuses a
  `[role="listitem"]` whose parent is a `<ul>`/`<ol>`: a bulleted list inside an
  answer matched that selector once per bullet.
- **One tick per TURN, not per body.** A primary layer matches turn containers
  and needs nothing more. A fallback matches whatever is left, and one answer
  can hold several of those: Gemini's `<model-response>` carries one
  `<message-content>` for its working and another for the reply, so the day the
  custom element names change every answer counts twice — all of it painted as
  the model's. `oncePerTurn()` (`content/adapters.js`) lifts each match to the
  container a turn IS (`adapter.turnSel`) and collapses duplicates; an element
  with no such ancestor is kept where it is, so it can never remove a turn. The
  thinking filter tests `closest`, not `matches`, for the same reason: the
  thinking block is a CONTAINER, and on a fallback layer what matched is the
  body inside it. `test/gemini-turns.html` is two exchanges; four ticks on both
  layers, `?drift=1` renaming the custom elements.
- **A marker node is not a turn.** ChatGPT keys its DOM nodes by TRANSCRIPT
  message id, and one visible answer carries several — a reasoning summary, a
  browsing block, the answer itself. Its `<article>` is the turn, and
  `chatgptTurns()` keeps one node per article. The same thing reaches the
  archive: `chatgptMsgs` kept every mapping node it could not rule out, so
  thoughts, browsing displays and streaming placeholders were stored as
  messages. A two-message chat then mapped as FOUR ticks, two of them inside the
  answer — which reads as parts of one long response being counted separately,
  and is how it was reported.
- **An empty message is only a turn when it is a picture.** The fetch keeps one
  that carries a non-text part and marks it `m: 1`; everything else empty is
  dropped. Records written before that still hold the placeholders, so
  `turnMsgs()` (`bg/chat-index.js`) drops them again on every read — the map,
  the card and the archive view all go through it, because a count and a split
  that disagree is the bug the card is most often reported for.
- **The densest container is one answer at least as often as it is the thread.**
  `heuristicMessages` ranks by child count, and on a SHORT chat the winner is
  the body of the longest reply — every paragraph a "message". It now refuses a
  candidate whose texty children are mostly prose tags (`P`, `H*`, `UL`, `PRE`,
  `TABLE`…) or that sits next to a paragraph. Refusing is the right answer:
  no map is honest, a map of eight ticks for two messages is not.
- **One message is a conversation.** No floor of two anywhere: not in
  `importBatch`, not in the chat card, not in the page flush, and the minimap
  paints from the first message. The last floor of four was in `minimap.js`'s
  own `style.display` test, where nobody saw it because it hid the map rather
  than shortening it: a two-message chat had no map at all, and the day its
  count was corrected from four ticks to two the map would have disappeared —
  the fix reading as the break.

## What is free, and what the header says

The speed engine, the **minimap** and the **hover card** are free everywhere:
they are what the product looks like, and a platform where they silently never
appear reads as broken rather than as locked. The card is four integers about
the user's own conversation, which is why `chat-stats` is deliberately not in
the worker's `PAID` map — gating it in the page contradicted that and made the
card never appear on Claude. Search, outline, timestamps and backup stay Pro on
Claude and Gemini (`FREE_TOOL_PLATFORMS`, `content/main.js`).

`.rows` in the popup is a two-column grid, and **only a toggle row takes half
the width** — everything else spans the pair by default (`popup/popup.css`). A
panel left in one column sizes that column to its own content: the deletion
panel opened, its buttons widened column one, and the right-hand toggles were
pushed clean out of the popup while their row heights stayed. Spanning by
default is what stops the next panel repeating it.

The popup header says which plan is running in three ways at once: the word in
`#plan-badge` (text unchanged — three harnesses match it exactly), the pill's
colour, and the rim of the account circle, which for a trial is an arc that
drains as the week does. Any one of them failing still leaves the state legible.

## A rendered formula is not text

KaTeX writes the MathML and the visual glyphs side by side, so `textContent`
returns every symbol twice — `Q∈Rn×dk` — and MathJax's SVG output returns none
at all, so a standalone equation is not mangled, it is silently gone. Both
renderers keep the source they were handed.

- `LCTRichText.textWithMath()` (`content/richtext.js`) walks an element and
  STOPS at a math container, taking `annotation[encoding="application/x-tex"]`,
  then `data-latex`, then `script[type=math/tex]`, then `aria-label`, then the
  MathML text — and writes it back as `$…$`, or `$$…$$` for a display block. So
  the archive holds LaTeX: searchable, exportable, and renderable again.
- **Display maths is a block.** `BLOCK_SEL` in `content/indexer.js` had no
  `.katex-display` / `mjx-container`, and because it DID match the paragraphs
  around them the whole-element fallback never ran — every standalone equation
  was dropped from the archive while the prose either side survived.
- The renderer's LaTeX subset covers what a chat actually contains, and an
  unknown command is emitted verbatim rather than dropped. `mathvariant` goes on
  the token, never on the `<mrow>` a braced argument produces — set there,
  Chrome ignores it and `\mathbb{R}` renders as a plain R.
- `test/richtext-harness.html` loads `content/richtext.js` as a PAGE script, so
  the tests can call it: a content script's globals live in an isolated world
  `page.evaluate` cannot reach. It is never shipped (`test/` is not in SHIP).

Three more things a message is made of, all of them handled in `textWithMath`:

- **Code keeps its fence and its indentation.** A `<pre>` becomes ```` ```lang ````
  with the language the highlighter left on it. The tidy-up that collapses runs
  of spaces is right for prose and wrong for Python, so code is parked under a
  private-use marker and put back after it.
- **A picture is a message.** An `<img>` becomes `![alt](src)`, and the panel
  renders it (http/https/blob/`data:image` only — never a scheme that can run
  something). Before, a message that was only an image arrived as an empty row.
- **The model thinking out loud is not the message.** `SKIP_SEL` drops the
  reasoning panel from the text, from the map's snippets, and — when something
  survives the filter — from the turn list itself, so it can never draw a tick.
  Attributes and element names only. DeepSeek's thinking chain sits behind a
  per-deploy hashed class, but `.ds-think-content` is stable and is the hook —
  it holds a second `.ds-markdown` of its own, which is why that host's messages
  read as the reasoning followed by the answer.

Two lists, not one. `THINK_SEL` is thinking alone and is the only one allowed to
drop a whole TURN — a host that named its wrapper "reasoning-turn" would empty
the map. `SKIP_SEL` adds the chrome nobody typed (buttons, icon buttons, the
action bar, a code block's toolbar) and is used ONLY on text, where the worst
case is a word less rather than a message less. **Neither skips a wrapper that
holds an `<img>`**: these hosts wrap a picture in
`<button aria-label="Open image: shot.png">`, so a blanket skip of buttons threw
the message away with its own toolbar. An icon button holds an `<svg>`, never an
`<img>`.

**Where two elements meet with no space, the page decides whether it is a new
line.** Claude lays each question and answer of a card out as two
`<span style="display:block">` with nothing between them, so a walk that joined
text nodes stored "Where will this run?on the free tier". `textWithMath()` adds a
break at a junction where both sides are non-space and either neighbour is a
BOX by computed display (`LCTRichText.isBox`: block, flex, grid, list-item —
never `inline*`, never `contents`). A `<br>` is a break. Tag names are only the
fallback when there is no computed style. Records already archived welded stay
so; the provider's own transcript, which the text download writes, never was.

`content/exporter.js` runs the same rules — the three above and `isBox` from the
same file — so a file and a preview of the same conversation cannot disagree.
It had its own tag list and exported the welded line while the preview was
fixed. `test/test-extension.mjs` B2w checks both walkers on the same cases.

**A fence must not swallow the answer.** `renderMarkdown()` is what the panel
paints an archived message with, and its opener demanded nothing after the
language — so ```` ```js title="x" ```` was not a fence at all, and the CLOSING
fence opened one that ran to the end of the message. Every paragraph after it
painted as code, in one `<pre>` that scrolls sideways because prose does not
wrap there. The language is now the first word, any line starting with three
backticks closes a block, and where the message holds no closer the remainder
has to EARN it — one line `strongCode()` says prose could not have produced.
Otherwise the fence is text and the paragraphs stay paragraphs.

**Not every formula is written between double dollars.**
`$\begin{aligned} … \end{aligned}$` is as common as `$$…$$`, and nothing caught
it: the block openers want `$$` or `\[`, and `INLINE_MATH` stops at a newline.
A multi-line derivation arrived as its own source. An environment now opens a
display block with or without dollars around it, and refuses when no `\end` is
in reach rather than swallowing the rest of the message.

**An image or a link inside a sentence is not on its own line.** The block path
only matched one alone, so a picture mid-paragraph — and every markdown link —
reached the reader as the literal `![alt](src)`. `appendImage()` and
`appendLink()` are the single place the scheme allowlist lives: http(s), blob
and `data:image` render, anything that could run is named instead.

`test/markdown-harness.html` loads `history-loader.js` as a PAGE script for the
same reason the richtext one does — a content script's globals are unreachable
from `page.evaluate`. Before it, the renderer the panel actually uses had no
test at all, which is why these three kept coming back.

**A drawn diagram is the same trap as a rendered formula.** Mermaid, Graphviz
and PlantUML render to an inline `<svg>`, and walking one returns its node
labels welded together — "StartLoad dataDone". `diagramSource()` takes the
source the host kept (`data-diagram-source`, `data-source`, or the `<pre>` still
sitting behind a Code/Diagram toggle) and fences it; failing that the message
says a diagram is here rather than spilling labels into a sentence. The `<pre>`
and the `<svg>` are both in the DOM when there is a toggle, so whichever the
walk reaches first emits the source and the other is skipped. An icon is an
`<svg>` too: `svgIsDiagram()` separates them on structure — `<text>` inside, six
children, or 120px — never on what the labels say.

**Language, from wherever the host puts it**: `language-*` / `lang-*` classes,
`data-language`, highlight.js's bare class beside its own marker (`hljs python`,
filtered through `NOT_A_LANG`), or the strip above the block — DeepSeek's
banner, Gemini's decoration bar — read from its OWN text nodes, because the Copy
button lives in that strip and reading it whole named the language `rustcopy`.

**An ultra-long block gets more room and is never cut open.** `boundFor()` gives
a message holding a fence 16,000 characters instead of 4,000, and `clampText()`
closes a fence the cut opened — otherwise every reader downstream renders the
REST of the conversation as code. Past 20,000 characters the preview stops
colouring and sets the text plainly: a node per token is thousands of nodes for
a block nobody reads word by word.

`\begin{…}\end{…}` becomes an `<mtable>` — a matrix or an aligned derivation is
the centrepiece of exactly the answers this matters for, and it used to render
as the word "begin" followed by its own letters. Cells are parsed WHOLE: fed one
token at a time, `\frac{a}{b}` inside a matrix loses its arguments.

**The strip is one mark per message, and each mark is exactly its message.**
Three rules in `content/minimap.js` and `content/preview.js`, all from one
screen recording on claude.ai:

- **The panel is told WHICH message, not only where its mark sits.** The strip
  counts what the page renders and the panel counts the archive; they need not
  agree. Asked by position alone, every mark past the archive's end opened its
  last message — the bottom third of the strip all showed one answer.
  `identity()` sends the provider id, the speaker and the opening words
  (`probe`); `resolve()` finds the row by id, else by those words nearest the
  scaled position, else by the position scaled to its own count, so the last
  mark is always the last message.
- **Marks never get closer than `MIN_PITCH` (2.5px).** Past that they cannot be
  told apart or pointed at, so the strip scrolls instead of squeezing: the wheel
  moves the strip, the thread hairline becomes its scrollbar, and it follows the
  reading position until the reader scrolls it. `yToIndex()` and `draw()` use
  the same slot arithmetic, and the mark under the pointer is highlighted.
- **No one-line hover box.** It said less than the panel, covered the page and
  cut its text mid-word. What it said is the canvas's `aria-valuetext` now,
  which is also what the suite reads (B2e, B2f, B2h, B2k, B2l).

**The star answers only on the star.** An invisible `::after` bridge reached
48px to its left, so it lit up and starred the message with the pointer beside
it. The trip from the message is covered by the hide delay in `outline.js`.

The preview panel reads the ARCHIVE, not the DOM — so it is only ever as fresh
as the last flush. `content/indexer.js` bumps `self.LCTArchiveRev` on every write
and the panel re-reads on it; while open it re-checks every 2.5 s, keeping the
reader's scroll position and repainting only on a real change. A press
anywhere outside it closes it (`pointerdown`, capture phase, `composedPath`, never
prevented, so what was pressed still happens); a press on another mark of the
map switches the message instead. An empty panel
keeps asking: a brand-new conversation has nothing archived for a few seconds,
and painting "not archived yet" once and stopping is what made a new chat look
broken until the page was reloaded.

## A deleted chat is a question, asked where the user is

Deletion review is **not** on the Recall page. A yes/no question that costs a
page visit is a question nobody answers.

- The Chrome notification carries **Keep / Delete** as its own buttons
  (`chrome.notifications.onButtonClicked` in `bg.js`).
- `content/deletion-toast.js` shows the same decision in the page the moment the
  worker notices, pushed by `tellTabs()`.
- The popup's "chats deleted on the site" row opens the full list, one Keep and
  one Delete per chat, plus the `deletionPolicy` setting that used to live on
  the Recall page.
- **Delete is instant and reversible.** A delete that waits is one the user
  cannot trust, so the record is dropped at once and a full copy is set aside
  under `lct-deletion-undo-v1` for ten minutes. The undo bar shows five seconds;
  a slow hand still wins. Undo is `importBatch`, never a re-download — the
  provider no longer has it.
- `BG_SWEEP_MS` is 3 h, not 24: a chat deleted on another device stayed
  reachable here for a day before anyone was asked.

## How far back the archive reaches

`settings.historyDays` (0 = everything, the default) floors the listing's
`sinceMs` in `bg/sync.js`. It caps what future passes ASK for and removes
nothing already held. `sweepVanished` takes the same floor: without it,
choosing "last 30 days" would make every older chat look deleted and put the
whole back-catalogue up for deletion in one dialog.

## Claude Code

Sessions live at `claude.ai/code/<id>` and are a different resource from
`chat_conversations` — the chats adapter never saw them.

- There is **no documented endpoint**. The Compliance API that lists them is
  Enterprise-only with its own access key. A guessed private URL is how you ship
  a feature that archives nothing while reporting success, so the `claude-code`
  adapter stays dormant until it has a real one.
- It learns that path from Resource Timing: `content/main.js` reports which
  `/api/…` paths claude.ai already fetched — paths only, no bodies, no queries —
  and `bg/state.js` keeps them. Not a hook; the browser publishes the list.
- Meanwhile `noteCodeSessions()` records sessions straight off the page: every
  one is a `/code/<id>` link.
- `convPath` is `/^\/(chat|code)\//`. It gates every per-chat feature at once,
  which is why no card appeared on a Code link.

## One chat, two ids

A page writes `location.hostname + location.pathname`. The sync writes
`adapter.host + adapter.prefix + convId`. On three hosts those differ for the
same conversation — DeepSeek serves `/a/chat/s/<id>` against a `/chat/` prefix,
Perplexity serves `/search/` and `/thread/`, Grok `/c/` and `/chat/`. So the
archive can hold a chat under one spelling while the reader arrives by the
other. `chatIdCandidates()` resolves both on READ; canonicalising the write is
the real fix and has to migrate what is already stored.

## One Google login, several Gemini accounts

Google serves each signed-in account at `/u/N/app` and redirects an index past
the last one to `/u/0/app` (measured). Only `/u/0` was ever read, so a browser
whose Gemini chats lived on the second account archived none, and the row said
"Gemini changed its API": a conversation asked of the wrong account throws
`shape`, which is what that sentence is rendered from.

- `seatContexts()` asks `/u/1`, `/u/2`… and stops at the first redirect; one
  signed-out index is stepped over, not more. Match the landed prefix on the
  path AFTER the base's own path, or a non-origin base reads every login as one.
- `accounts()` gives the sync one pass per account. The default keeps no
  `account` value, so it keeps the checkpoint it always had and nothing is
  downloaded again; the rest get `google-u-N`. Google renumbers indices by sign-in
  order, so `resolveAnchor()` (oldest chat) finds each account's checkpoint and
  `sweepVanished()` refuses an empty or implausible listing — a renumbering
  deletes nothing.
- `detail()` tries the account that last held the chat, then the default, then
  every other. ONLY `shape` moves on; a rate limit or sign-out is an answer. The
  account is remembered in memory and deliberately NOT on the record: a stored
  `/u/1` points at somebody else after a renumbering.
- `quotaSeats()` keeps the allowance panel on the default account.

## Reinstall

`storage.sync` survives a local wipe; an uninstall takes it too. The durable
anchors are on the issuer, keyed on the email hash: the trial (`trials_id`), the
licence (`owners`), the device list. Signing in is what brings them back.

The archive itself does not survive. `BG_RESTORE_HOLD_MS` (6 h) is how long a
pending restore holds the history rebuild off — after that the pass re-fetches
from the providers regardless, because a user who cannot or will not restore
must not be left with an empty archive. A restore landing later merges.

## Testing

`npm test` runs everything; `npm run test:extension` is the Playwright suite
that drives the real popup and worker. **Node 24+** is required (`node:sqlite`):

```sh
PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH" npm test
```

**The mock providers are six ports, one per provider.** Pacing, the hourly cap
and the 429 cooldown are all per host. Served off one port these six WERE one
host, so the whole suite spent a single provider's budget and the J block ran
against a host that could not be asked for anything — three assertions that
read as product bugs and, before the cap refused fast, a suite that hung.

**Real Google Chrome, installed over CDP.** Chrome removed `--load-extension`
in M137 and its kill switch in M139, so `tools/chrome-real.mjs` spawns the
branded binary itself — never `chromium.launch()`, which adds
`--enable-automation` and its infobar — with `--remote-debugging-port`, its own
`--user-data-dir` and `--enable-unsafe-extension-debugging`, then installs with
CDP `Extensions.loadUnpacked`. Without that flag the call returns an id and
installs nothing. It paints no bar. `test/test-extension.mjs` uses it by
default; `CI` or `LCT_BROWSER=chromium` falls back to bundled Chromium. One
browser instance per run. Close it with CDP `Browser.close`: `browser.close()` on
an attached browser only disconnects. Never drive the Load unpacked dialog with
keystrokes — it types into whatever Chrome window the human has focused.

**A local build is not the store's identity.** Unpacked, the manifest `key`
makes the id `hbejlhhmbhkeaebcgmblchnodeampcgl`; the store strips the key and
assigns `ajpnackhheeafgecocapboccaplcnaje`. Two rejections and a live 403 came
from things registered only for the dev id (issuer origins, the OAuth redirect
URI). `npm run preflight` checks both against the LIVE service for every id in
`server/published-origins.json`; `test/reviewer-run.mjs` rehearses a review
from the packed zip in a clean profile.

`test/chatgpt-turns.html` is the two-message fixture with four `data-message-id`
nodes in it: two ticks is the only right answer. `test/claude-code.html` is the
fixture that proves a tick count: six real turns
buried in six pieces of tool scaffolding, four code blocks, a nested `<pre>` and
an image-only reply. Six is the only right answer. `?drift=1` strips the action
bars and the role markers — the day Claude redesigns — and the count must still
be six, marked approximate. Tests reach a specific adapter through
`LCTAdapters.byId(id)`, and `?lctAdapter=claude` points a real provider adapter
at a fixture page (localhost only, guarded by the host in `detect()`).

`test/real-chrome-check.mjs` and `test/real-chrome-session-ui.mjs` are the
exceptions: they ATTACH over CDP to a Chrome you loaded the extension into by
hand. That is the only way branded Chrome runs this code now.
