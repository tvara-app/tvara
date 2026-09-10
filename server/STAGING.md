# Staging environment

Create a separate D1 database, KV namespace, Durable Object namespace, Dodo test-mode product and webhook, Google OAuth client, Worker secrets, rate-limit namespace, Analytics Engine dataset, and alert routing. Do not reuse production resources or credentials.

Copy `wrangler.staging.example.toml` to an untracked `wrangler.staging.toml`, replace every placeholder, and configure both published extension origins. Keep `ALLOW_FIREFOX="0"` for this launch.

Deploy with:

```sh
./server/deploy.sh <chrome-store-id> <edge-store-id> --config wrangler.staging.toml --test
```

Before promotion, run Dodo test purchases and refunds, OAuth callback and CORS rejection checks, migration repeatability, secret-missing checks, a Time Travel restore rehearsal, and load tests at ten times the trusted-tester peak.
