# Issuer architecture

## Scope

The entitlement issuer is a Cloudflare Worker control plane. Local extension features must not depend on it. A signed, unexpired local entitlement remains usable while the issuer is unavailable.

## Availability contract

| Operation | D1 unavailable behavior |
| --- | --- |
| Local speed, navigation, archive, export, backup | Continues locally. |
| Existing signed entitlement | Continues until its signed expiry. |
| Session check | Returns retryable unavailable; never signs a device out by inference. |
| Trial, identity, checkout, claim, restore, seats, revocation, nonce, webhook | Fails closed with a retryable response. |
| Payment webhook | Returns non-2xx until the idempotency and ledger writes commit. |

D1 is authoritative for nonces, orders, identity, trials, seats, session termination, ownership, revocations, and webhook receipts. KV and Durable Objects are non-authoritative accelerators only. The Durable Object live channel is limited to paid users and can be shed before core issuer routes.

## Limits and deadlines

- Request body limit: 8 KiB.
- Dodo and Google-dependent calls: 8-second upstream timeout and 10-second end-to-end budget.
- Checkout: D1 reservation before Dodo, atomic per-device open-order cap, device and IP quota, Dodo idempotency key.
- Retryable responses include `Retry-After`; clients use bounded exponential backoff with jitter.
- No route uses unbounded retries.

## SLOs

- Local extension functions: no server-availability dependency.
- Issuer control plane: at least 99.9% monthly availability.
- Normal issuer route p95: at most 500 ms, excluding upstream calls.
- Upstream-dependent route deadline: at most 10 seconds.

## Observability and privacy

Analytics Engine receives only route class, status/outcome class, and latency bucket. Worker head sampling is 1%. Never log chat text, URLs, licence keys, raw email, device public keys, identity tokens, or device fingerprints.

Required alerts: issuer availability, p95 latency, 5xx rate, D1 errors and rows read/written, Durable Object connections, Dodo and Google timeouts, rate-limit denials, and spend. Budget alerts at 50%, 80%, and 95%; the 95% action disables nonessential sockets and diagnostics before any core path.

## Recovery

Maintain separate staging and production D1, KV, Durable Object, Dodo, OAuth, secrets, rate-limit namespace, and alert routing. Never run tests against production credentials or data.

Confirm the production D1 plan supports Time Travel. Rehearse restores against staging first; restoration is destructive. Retain encrypted recovery exports longer than the selected Time Travel window when required by recovery objectives.
