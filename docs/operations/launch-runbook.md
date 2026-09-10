# Launch checklist and incident runbook

## Release gates

- Node 24.11+ CI is green for tests, lint, package, and preflight.
- Package inspection passes for the exact upload zip.
- Chrome Web Store and Edge Add-ons production IDs exist, are configured as the only issuer origins, and their OAuth redirects are registered.
- Staging smoke tests cover both production origins, OAuth callback, CORS rejection, Dodo test purchase/refund, D1 migration repeatability, restore rehearsal, and missing secrets.
- Production configuration has separate resources from staging, required secrets, 1% log sampling, Analytics Engine, alert routing, and budget alerts at 50/80/95.
- Privacy policy, terms, onboarding, guide, README, Store listing, dashboard declaration, screenshots, and release behavior agree.
- Native reviewers approve each non-English Store locale before it is enabled.
- Rollback target and owner are identified; live alerts are receiving data.

## Deployment

1. Build immutable CI artifacts with Node 24.11+.
2. Deploy staging and run smoke tests against that exact URL.
3. Deploy the Worker with the exact production configuration and run the same smoke tests.
4. Observe a canary cohort and alerts before promotion.
5. Roll back Worker code or configuration first if needed. Do not restore D1 in place without an incident decision and a rehearsed recovery point.

## Rollout

Release to 25 trusted testers, then 100, then public Chrome only after seven stable days. Publish Edge after the Chrome cohort meets the same reliability and support threshold. Ask testers for browser, OS, provider, and chat-size feedback; do not reward installations or ratings.

## Incidents

| Incident | Immediate action | User-safe status |
| --- | --- | --- |
| D1 outage | Stop issuer mutations and return retryable unavailable; preserve unexpired locally signed entitlements. | “Account changes are temporarily unavailable. Your local features remain available.” |
| Dodo outage | Stop checkout creation and webhook settlement; keep reservations bounded. | “Purchases are temporarily unavailable. Please try again later.” |
| Google OAuth failure | Stop sign-in flows; leave free features and existing entitlements intact. | “Google sign-in is temporarily unavailable. Free features continue to work.” |
| Bad deploy | Roll back Worker code/config, verify smoke tests, preserve evidence. | “We are restoring service.” |
| Provider DOM drift | Disable only the affected adapter and create a compatibility issue. | “This provider feature is temporarily unavailable while we update compatibility.” |
| Unexpected spend | At 95%, disable sockets and diagnostics, tighten nonessential quotas, investigate before impacting core paths. | “Some nonessential online features are temporarily limited.” |

For every incident: name an owner, capture aggregate evidence only, review privacy impact and retention, publish the user-safe status, and complete a post-incident review before reopening the changed path.
