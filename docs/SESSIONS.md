# Account sessions — design

Netflix-shape device management for Tvara: the account owner sees every device
signed into their account, selects any number of them, and two clicks later
those devices are signed out. The list is served from the ledger that decides,
every mutation is one transaction, and a signed-out device loses Pro in seconds
while the browser is open.

This document is the plan. §10 is the build order and says what is built.
Everything in §10 is built, the Durable Object included — §4 records why that
decision was reversed. The paragraph below is the original note, kept because
the reasoning it replaced is still the cost being paid:

Everything in §10 was built except the Durable Object, which was considered and
dropped — §4 says why, and what took its place.

---

## 1. What already exists

Reading the current code before designing on top of it:

- `SEAT_LIMIT = 5` is enforced server-side in `claimSeat()`
  (`server/entitlement-worker.js`), against D1 table `seats (key_fp, dev_fp,
  last_seen)`. The primary key is what makes a double-claim a no-op.
- Device identity is a non-extractable ECDSA P-256 keypair in the extension's
  IndexedDB. `dev_fp` is derived from the *proven* public key, never declared
  in the body. A device cannot claim an identity it does not hold.
- `/devices` and `/devices/revoke` exist and are authorised by *holding a seat*
  under that licence.
- Identity is a verified email, held as `sha256(canonical email)` in
  `identities`, with `owners (key_fp, email_fp)` linking accounts to licences.
  The identity token is `LCTID1`, an HMAC token carrying `efp`.
- Entitlement is `LCT2`: ECDSA, 30 day TTL, bound to licence + device, renewed
  at 20 days by a 12-hour background alarm.

## 2. What is missing, precisely

**Termination does not terminate.** `releaseSeat()` deletes the seat row, which
frees a slot. It does not stop the target device: that device still holds a
valid `LCT2` token for up to 30 days, `evaluate()` deliberately never denies on
age, and `needsRefresh()` only calls the issuer with 10 days of token life left.
A "Terminate" click today costs the target roughly nothing.

**The popup shows the wrong list.** `renderDevices()` reads the
`chrome.storage.sync` registry from `lib/dodo.js`, which is scoped to one
browser profile. The authoritative reader `LCTEntitlement.listDevices()` exists
and is never called. A device enrolled in another browser is invisible, and
`terminateSeat()` can only revoke it at the issuer when this browser happens to
have written down its fingerprint.

**Sessions are licence-scoped, not account-scoped.** A licence is not an
account. Trial devices hold no seat at all and appear nowhere. The user-facing
noun has to be "devices on my account".

**Nothing blocks a re-claim.** Even with a working kill, the target's next
`/entitlement` call silently re-claims its seat. Termination must be a state
the server holds, not an event it forgets.

## 3. The three ideas the design rests on

**The ledger is the session table.** "Am I still signed in?" is one indexed
read: does a row exist for my `dev_fp` under this account? No parallel truth to
drift out of sync with the one that decides.

**Withdrawal needs an answer, never a silence.** The codebase already commits
to this — a purchase is withdrawn by an answer, never by an outage. A heartbeat
that times out means keep working. Only a literal `live: false` clears a token.
Every failure path in §7 obeys this.

**Compare timestamps, not flags.** A kill writes `at`. A session re-claimed
afterwards carries `claimed_at > at` and is alive again. No tombstone cleanup,
no resurrection race, and eventually-consistent caches become safe: a stale
cache can only delay a kill, never revive one or invent one.

## 4. Shape

```
extension                    Cloudflare                       authority
─────────                    ──────────                       ─────────
LCT2 token (30d, offline, survives any outage)
  │
  ├─ WebSocket ──────────► AccountDO (per email_fp)  ─writes─► D1
  │   push: kill arrives     · single writer                    sessions
  │   in ~1s, browser open    · holds sockets                   seats
  │                           · bumps version                   session_kills
  ├─ alarm 60m ───────────► POST /session ──► KV mirror ──────► account_state
  │   the guaranteed floor     (heartbeat)     (≤60s stale)     session_ops
  │
  ├─ onStartup / popup open ─► POST /session
  │
  └─ live:false ─► clearToken() + deactivated flag → "Signed out" screen
      network error ─► keep working, retry with backoff
```

Cloudflare carries: WAF and the existing `EDGE_RL` binding (per-IP bound, before
the body is read), D1 as the transactional ledger, a Durable Object per account
as the single writer and the push channel, KV as the heartbeat read-cache, Cron
for the sweep, Analytics Engine for the operator view.

**Propagation budget.** In use: up to five minutes — the service worker already
wakes for content-script traffic whenever somebody is using an AI chat, and a
check-in rides along on a five-minute floor. Idle but running: up to an hour, on
the alarm. Closed: the next browser start. Opening the popup checks immediately.
Netflix says "up to 8 hours" for the same feature.

**Why there IS a WebSocket — a reversal.** This section used to argue the
opposite, and the argument is kept below because it is still the honest cost.
What changed is the weighting, not the facts: being signed out with no
explanation reads as a broken extension, and the device it happens to is by
definition the one with no popup open to explain it. A system notification is
the only surface that reaches it, and a notification an hour late is worse than
none. The Durable Object shipped as §4 said it could — one class
(`server/account-do.js`), one binding, one migration, and a ticket issued by the
signed `POST /sessions` because a WebSocket handshake cannot carry a signed
body. SQLite-backed, so it needs no paid plan.

What did NOT change is the rule that made the reversal safe: the socket is an
accelerator and never a channel that decides anything. The DO is told only
AFTER D1 has committed, it holds no state worth losing, and a device that never
connects still dies on its next heartbeat. Every failure mode in §7 stands.
The standing cost is real and accepted: a ~25s ping keeps the service worker
resident, which is what §4 refused.

**The original argument.** The first draft of this document put a Durable
Object per account in this diagram, holding a hibernatable socket so a sign-out
landed in about a second. That is the right answer for a web app and the wrong
one for an MV3 extension: the service worker is killed after 30 seconds idle, so
holding a socket open means pinging it awake forever — a permanently resident
worker on every install, on a machine whose owner installed this extension to
make their browser faster, to shorten one licensing event from five minutes to
one. The activity-driven heartbeat gets most of the interval for no standing
cost. If a second is ever genuinely needed, the DO is a contained addition: one
class, one binding, one migration, and a ticket issued by `POST /sessions`
because a WebSocket handshake cannot carry a signed body.

## 5. Data model

Additions only. `schema.sql` stays `CREATE TABLE IF NOT EXISTS` throughout, so
no `ALTER` that fails on the second deploy — the same reason `identity_emails`
is a separate table rather than a column.

```sql
-- One row per device signed into an account. THE session table.
-- key_fp is null for a trial device: a session is not the same thing as a seat.
--
-- PRIMARY KEY is dev_fp, not (email_fp, dev_fp): one physical device is one
-- session, whichever licence or identity it currently carries, and the popup
-- stores a single `license` record so that is the shape it already has. The
-- limit, stated so it is a decision: a device holding two purchases has one
-- row, naming the licence it last activated.
CREATE TABLE IF NOT EXISTS sessions (
  dev_fp     TEXT    PRIMARY KEY,
  email_fp   TEXT,                -- null until an identity is verified
  key_fp     TEXT,                -- null on a trial device
  created_at INTEGER NOT NULL,
  claimed_at INTEGER NOT NULL,    -- reset on every intentful (re-)activation
  last_seen  INTEGER NOT NULL,
  label_enc  TEXT,                -- AES-GCM under a SIGNING_KEY-derived key
  plat       TEXT,                -- coarse: "macOS · Chrome". Never a full UA.
  geo        TEXT                 -- two-letter country, from request.cf.country
);
CREATE INDEX IF NOT EXISTS sessions_by_email ON sessions (email_fp, last_seen);
CREATE INDEX IF NOT EXISTS sessions_by_key   ON sessions (key_fp);
CREATE INDEX IF NOT EXISTS sessions_by_seen  ON sessions (last_seen);

-- Terminations. The row is what refuses a SILENT re-claim; an intentful
-- re-activation from the popup deletes it. scope is an email_fp or a key_fp,
-- so a licence-scoped kill and an account-scoped kill share one table.
CREATE TABLE IF NOT EXISTS session_kills (
  scope  TEXT    NOT NULL,
  dev_fp TEXT    NOT NULL,
  at     INTEGER NOT NULL,
  by     TEXT    NOT NULL,       -- 'self' | 'owner' | 'refund' | 'sweep'
  PRIMARY KEY (scope, dev_fp)
);
CREATE INDEX IF NOT EXISTS session_kills_by_at ON session_kills (at);

-- Per-account watermark and concurrency counter.
-- epoch   — "sign out everywhere", as one write instead of five.
-- version — bumped on every mutation; the UI sends back the version it saw.
CREATE TABLE IF NOT EXISTS account_state (
  email_fp   TEXT    PRIMARY KEY,
  epoch      INTEGER NOT NULL DEFAULT 0,
  version    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- Idempotency and audit in one table. A retried terminate replays the stored
-- answer instead of killing a second device.
CREATE TABLE IF NOT EXISTS session_ops (
  op_id    TEXT    PRIMARY KEY,
  email_fp TEXT    NOT NULL,
  kind     TEXT    NOT NULL,     -- 'terminate' | 'terminate-all'
  targets  TEXT    NOT NULL,     -- JSON array of dev_fp
  at       INTEGER NOT NULL,
  result   TEXT    NOT NULL      -- JSON answer, replayed verbatim on retry
);
CREATE INDEX IF NOT EXISTS session_ops_by_at ON session_ops (at);
```

**The verdict rule**, evaluated entirely from server state — the client supplies
no timestamp it could lie about:

```
alive  ⇔  a seats row exists for (key_fp, dev_fp)
      AND claimed_at >= account_state.epoch
      AND NOT EXISTS (session_kills row with at > claimed_at)
```

The seat is first on purpose. It makes today's `/devices/revoke` immediately
effective without a single kill row being written, and it means a re-activation
needs no cleanup: the seat comes back, so the device comes back. The kill rows
are for the account-scoped route, which signs out devices without going through
a per-licence seat, and they are enforced already so that route is a pure
addition rather than a second place to get this wrong.

**Backfill.** `seats` rows predate `sessions`. On first read for an account,
import every seat under every licence in `owners` for that `email_fp`, exactly
as `seatRows()` already imports the pre-D1 KV ledger. Without the import the
feature launches showing an empty device list to every existing customer.

## 6. Consistency — the "perfectly synced" part

Five mechanisms, each closing a different way the view and the ledger drift
apart.

**One writer per account.** A Durable Object keyed on `email_fp` owns every
mutation for that account. Two popups clicking terminate at the same moment are
serialized by the platform rather than by hope. The DO also holds the live
sockets, so the same object that commits the change announces it.

Dropped, and the routes never needed it: `ifVersion` plus a single D1 batch is
already a correct lost-update guard, so the DO only ever bought instant push and
strict serialisation, not correctness. See §4 for why the push was not worth an
always-resident service worker.

**One transaction per click.** A termination is a `db.batch([...])`: delete the
session rows, delete the matching seat rows, insert the kill rows, bump
`version`. D1 runs a batch as a transaction, so the cascade can never
half-apply and leave a device with a seat but no session.

**Optimistic concurrency.** Every list response carries `version`. Every mutation
sends `ifVersion`. A mismatch is answered `412` together with the current list —
`412` and not `409`, because `409` already means "nonce replayed" on every route
here and one status cannot carry two verdicts — and the UI re-renders and asks
again — so nobody terminates a row that stopped
being what they were looking at.

**Idempotency keys.** The client mints `op_id` per user action. The DO records
it in `session_ops` inside the same batch and replays the stored `result` for a
repeat. A retry after a timeout is free; without this, a flaky connection kills
two devices when the user asked to kill one.

**Read-your-writes.** Reads that follow a write in the same session go through
the DO, which has just committed them. For reads that do not (the heartbeat),
use D1's Sessions API — thread the `bookmark` from the write response into the
next read — or accept the KV mirror's ≤60s staleness, which by §3 can only ever
delay a kill.

**Cache invalidation.** The KV mirror `live:{email_fp}` holds
`{v: version, e: epoch, d: {dev_fp: claimed_at}}` and is rewritten after every
committed batch. A heartbeat reading a stale mirror answers `live: true` for at
most 60 more seconds; the socket push has usually already killed the device by
then, and the alarm floor catches it regardless.

## 7. Failure modes, and the answer to each

- D1 unavailable → `503` → client keeps Pro. Never `live: false`.
- KV unavailable → fall through to D1. Never a verdict on its own.
- Durable Object unavailable → mutations answer `503`, the UI says "Nothing
  changed", heartbeats still work off KV/D1. Degraded, not wrong.
- WebSocket unavailable, blocked by a proxy, or asleep → the hourly alarm is the
  floor. The socket is an accelerator and never the only channel.
- Client offline at termination time → it dies on its next heartbeat. The kill
  row keeps it dead until someone re-activates it deliberately.
- Partial batch → impossible; it is one transaction.
- Duplicate submit → `op_id` replays the first answer.
- Stale UI → `ifVersion` rejects it with the fresh list attached.
- Issuer entirely unreachable for weeks → every device keeps working. This is
  the promise in the README and the store listing, and it outranks the feature.

## 8. Security rules

**Managing the list requires the account, not the licence key.** Listing or
terminating anything other than yourself needs a valid `LCTID1` identity token
*and* a device proof. The identity token binds the actor to the account; the
device proof stops a stolen token being replayed from anywhere else. This is the
same bar Netflix sets by asking for the password.

**A device may always sign itself out** with device proof alone. Locking a
self-release behind a sign-in would strand anyone selling a laptop.

**A licence-key holder who is not the account owner can terminate nobody but
itself.** Without this rule, anyone who found a key in a forum post could kick
the buyer off all five devices — griefing that costs the attacker nothing and
the owner everything, with no way to tell which of the two is real.

**"Sign out of all devices" requires a fresh identity.** Accept the identity
token only when `iat` is within `IDENTITY_FRESH_MS = 15 * 60e3`; otherwise
answer `401 reauth` and make the popup re-verify by OTP or Google. A 400-day
token found in storage must not be a fleet-wide kill switch.

**Kills block silent re-claims.** `claimSeat()` refuses a `dev_fp` carrying a
live kill row unless the request declares `intent: "activate"`, which deletes
the row and resets `claimed_at`.

`intent` ships UNSIGNED, which is a change from the first draft of this
document and the better trade. The request has already proved which device it
is, so the only party who can set the flag for a device is that device; a
patched client could set it always, and a patched client could always skip the
gate entirely — the ladder in the worker names that. Signing it would have
meant `PROTOCOL` 4 and a `426` for every installed client, over a flag that
buys nothing against an attacker we do not already have.

**Rate limits.** `/session` needs its own bucket: five devices heartbeating
would exhaust the existing `RL_MAX = 20` per key per hour on the first day. Use
roughly 200/hour/key for heartbeats and 20/hour/account for mutations, with
`EDGE_RL` staying the hard per-IP bound underneath.

**Data minimisation.** `label` is client-supplied, capped at 40 characters,
encrypted at rest, and rendered with `textContent` — it is untrusted input from
another device. `plat` is a coarse family string, never a full user agent. `geo`
is a two-letter country derived server-side from `request.cf.country`, so it
cannot be spoofed by the client and cannot be finer than a country. No IP is
ever stored. The current `/devices` route refuses all of this deliberately
because it answers to whoever holds the key; the new route answers only to a
verified account owner, which is what makes the extra columns defensible. If
that trade is unwanted, drop `geo` and ship the rest — nothing depends on it.

**Audit.** `session_ops` is the log: who terminated what, when. Retained 90
days, swept by the existing cron.

**Still not defended, and it never can be:** a user patching their own copy of
`lib/entitlement.js`. The ladder in the worker header says so already. This
system defends the server and the seat economy, not the client binary.

## 9. Interfaces

All routes keep the existing envelope: `{v, device_pub, nonce, ts, sig}` plus
route-specific signed fields.

Field names below are the ones the worker actually parses — **snake_case on the
wire**. `lib/entitlement.js` accepts camelCase from its callers and converts, so
a client written straight from an older draft of this section fails silently
rather than loudly: `ifVersion` arrives as `undefined`, the 412 stale-screen
guard never fires, and `keepSelf: false` — meant to sign this device out too —
is read as `keep_self === undefined`, which defaults to keeping it. A 200 comes
back saying the terminate worked while the device that asked stays signed in.

- `POST /sessions` — identity token + device proof. Returns
  `{version, limit, devices: [{device, label, plat, geo, lastSeen, createdAt,
  self, pro}]}`, newest activity first. `pro` is a boolean (the seat holds a
  licence key); there is no `kind` string and no `bookmark`.
- `POST /sessions/terminate` — `{targets: [dev_fp], op_id, if_version}`.
  **Multi-device by construction**: the array is the feature. One transaction,
  one version bump. Returns the new version and the fresh list.
- `POST /sessions/terminate-all` — `{op_id, if_version, keep_self}`. Sets
  `epoch = now`, cascades every seat, requires a fresh identity. `keep_self`
  defaults to true — only an explicit `false` cuts the calling device.
- `POST /session` — the heartbeat. Device proof and a licence key; the identity
  token is optional and only widens which kills apply. Returns
  `{live, reason}` — `reason` is `terminated`, `signed-out` or `revoked` — and
  `503` on any infrastructure failure, never `live: false`.
There is no `GET /sessions/watch`. It was designed alongside the Durable Object
and dropped with it (§6): `grep -rn "WebSocketPair\|DurableObject" server/`
returns nothing. Termination reaches a device on its next heartbeat, which is
what §7's timing budget is about.

The old `/devices` and `/devices/revoke` stay, unchanged, for one release: an
extension in the store today still calls them.

## 10. Build order

1. ~~**Schema.**~~ **Done.** §5 appended to `server/schema.sql`; it applies
   twice cleanly, which is the property `deploy.sh` depends on.
2. ~~**Session helpers.**~~ **Done.** `touchSession()`, `sessionRow()` with the
   seat adoption, `killedAt()`, `accountEpoch()`, `sessionVerdict()` and the KV
   mirror. `claimSeat`, `releaseSeat` and `evictOldestSeat` now delete the
   session alongside the seat, in one transaction, and drop the mirror.
   `killSessions()` arrives with the routes in step 5.
3. ~~**`POST /session`.**~~ **Done.** Own rate-limit bucket (`RL_SESSION_MAX`,
   200/hour/key — sharing `RL_MAX` would have let five devices exhaust the
   budget for the call that tells them they are signed in), mirror-first, D1
   fallback, 503 on error.
4. **`AccountDO`** — **dropped.** See §4: an always-open WebSocket means an
   always-resident MV3 service worker. Replaced by an activity-driven heartbeat
   with a five-minute floor, which costs nothing and covers the case that
   matters.
5. ~~**`/sessions`, `/sessions/terminate`, `/sessions/terminate-all`.**~~
   **Done**, against D1 directly. Identity-gated, `op_id` idempotency written
   inside the kill transaction, `ifVersion` answered with `412` and the fresh
   list, `terminate-all` gated on a 15-minute-old identity.
6. ~~**Kill enforcement.**~~ **Done.** `claimSeat()` refuses a killed device,
   `/entitlement` answers `403 signed out` — distinct from the device-limit
   `422`, because the two want opposite instructions from the popup — and an
   explicit Activate clears the tombstone. No protocol bump.
7. **Client** — `heartbeat()` **done**: on `live: false` it clears the token and
   writes `lct-signed-out-v1`, and `attempt()` refuses to re-mint while that
   marker is set unless the caller forces (which activation already does).
   `listSessions()` and `terminateSessions()` arrive with step 9.
8. **Background** — the 60-minute alarm, the `onStartup` heartbeat and the
   popup-open heartbeat are **done**. The socket (connect on startup, jittered
   reconnect, ping under 30 seconds so the MV3 service worker stays alive)
   lands with step 4.
9. ~~**Popup.**~~ **Done.** Multi-select rows, `Sign out (N)` and `Sign out of
   all devices`, both behind a confirm. Falls back to the old registry screen
   when there is no verified identity, and says that is what it is showing.
10. ~~**Sweep.**~~ **Done** — sessions and kills at 400 days, ops at 90.
11. **Operator view** — Analytics Engine `writeDataPoint` on claim, kill and
    dead-heartbeat. Feed the existing `observeSharing()` signal in rather than
    building a second one.

## 11. The screen

```
Devices                                    3 of 5
─────────────────────────────────────────────────
[ ] MacBook Pro · macOS · Chrome · IN      This device
    Active now
[✓] Work desktop · Windows · Edge · IN
    Last active 2 days ago
[✓] Ana's laptop · macOS · Firefox · DE
    Last active 3 weeks ago
─────────────────────────────────────────────────
   Sign out (2)              Sign out of all devices
```

Two clicks, both paths:

- Select rows, click **Sign out (2)**, confirm. That is the whole interaction —
  selection is not a click that costs anything, and the confirm is the second.
- Click **Sign out of all devices**, confirm. Re-verify first when the identity
  token is older than 15 minutes.

States the UI must have, because each one is a lie if it is missing: `Signing
out…` on the selected rows while the call is in flight; the authoritative list
re-rendered from the response, never patched locally; `409` silently refetches
and re-asks; a network failure says *"Nothing changed, so try again when you're
back online"*, which is true, unlike a generic error. A device that has been
signed out shows a "Signed out" screen with an Activate button, not a broken
Pro screen.

## 12. Cost

Heartbeats are 120 requests per account per day on the hourly alarm, plus one
per five minutes of actual use. The KV mirror absorbs the repeats: a live answer
is cached for 60 seconds and every path that removes a seat drops the key, so
the common case never reaches D1. D1 writes are one batch per user action, and
`last_seen` moves at most once every 30 minutes per device. No Durable Objects,
so nothing here needs the paid plan.

## 13. How it was tested

Three layers, and the third found a bug the first two could not.

- `test/test-worker.mjs` — 207 assertions against the real worker module with a
  SQLite-backed D1 double and a stubbed Dodo.
- A five-device run against `wrangler dev` — the real workerd runtime and a real
  local D1. This is what caught `terminate-all` signing out the device that
  pressed it: the epoch moves to now, the verdict is `claimed_at >= epoch`, and
  the survivor's claim was older than the sweep it had just ordered. The fake
  never caught it because no unit test kept a device with an old claim.
- The popup itself, driven over CDP in a running Chrome with the extension
  loaded unpacked and the issuer pointed at the local worker. This caught the
  list re-rendering on every checkbox tick, which detaches the element under the
  cursor and breaks a keyboard pass down the list.

## 13.1 Tests

- `test/test-worker.mjs` — list, multi-target terminate, terminate-all,
  `if_version` conflict, `op_id` replay, backfill from `seats`, cascade leaves no
  orphaned seat ("screen: their seats are released with them"). These landed in
  the existing worker suite rather than a file of their own: they need the same
  SQLite-backed D1 double and signed-body helpers, and a second harness built to
  share them is a second harness to keep in step.
- `test/test-worker.mjs` — heartbeat live and dead, kill blocks silent re-claim,
  `intent=activate` clears it, D1 down answers 503 and never `live:false`.
- `test/test-worker.mjs` — a key holder without the account cannot terminate a
  peer (`:1446`); a stale identity token cannot terminate-all (`:1535`). Same
  reason as above: these read as security tests, but they need the D1 double, so
  they live with it rather than in `security-entitlement-gate.mjs`.
- `server/session-smoke.mjs` — the deployed routes, adversarially, against a
  real issuer. Eight refusals; run with `npm run smoke:sessions`. Read its
  header before trusting a green run — it holds no seat, so it can prove the
  refusals and not the grant.

**Not covered, and worth being honest about it.** `test/fuzz-worker.mjs` targets
`/entitlement` only, so `body.targets` — the one attacker-supplied *array* in
the whole issuer — has no fuzz coverage. `test/test-device-proof.mjs` has no
session cases either. Neither gap is dangerous today (both routes sit behind the
device proof and the identity gate), but this list previously claimed both were
covered, which is the state that stops anyone adding them.
