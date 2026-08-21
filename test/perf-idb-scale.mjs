#!/usr/bin/env node
/* Real IndexedDB via Playwright, at real scale — measures what test/idb-fake.mjs
   structurally can't (fake-indexeddb enforces no quotas and isn't the real
   engine): actual latency for recall-search / stats / export against a
   50,000-chat archive. Complements idb-fake.mjs's fast logic-level edge
   cases; this file is about faithful timing, not edge-case coverage.

   PERF_CHAT_COUNT overrides the seed size for a fast local run — a real
   nightly CI run leaves it unset and seeds the true 50,000. Assertions are
   loose (generous upper bounds, not tight budgets): the point is catching a
   real regression (an O(n) scan becoming O(n²), say), not chasing CI-machine
   noise on exact numbers. */
import { join } from "node:path";
import { spawn } from "node:child_process";
import { SCRATCH, reporter, mirrorExtension, launchExtension } from "./security-fixtures.mjs";
import { setEntitlement, seedArchive, wipeArchive } from "./matrix-fixtures.mjs";

const { t, done } = reporter();
const COUNT = process.env.PERF_CHAT_COUNT ? Number(process.env.PERF_CHAT_COUNT) : 50000;
const PORT = 8940;

const { EXT, priv } = mirrorExtension("perf-idb-scale");
const server = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"],
  { cwd: join(EXT, "test"), stdio: "ignore" });
await new Promise((r) => setTimeout(r, 300));

const { ctx, id } = await launchExtension(EXT, join(SCRATCH, "perf-idb-scale-profile"));

async function timed(label, fn) {
  const start = performance.now();
  const result = await fn();
  const ms = performance.now() - start;
  console.log(`  ${label}: ${ms.toFixed(0)}ms`);
  return { result, ms };
}

async function send(msg) {
  const page = await ctx.newPage();
  try {
    await page.goto(`chrome-extension://${id}/popup/popup.html`);
    return await page.evaluate((m) => new Promise((resolve) => {
      chrome.runtime.sendMessage(m, (r) => { void chrome.runtime.lastError; resolve(r); });
    }), msg);
  } finally { await page.close(); }
}

try {
  await setEntitlement(ctx, id, "pro", { priv });
  await wipeArchive(ctx, id);

  console.log(`Seeding ${COUNT.toLocaleString()} chats...`);
  const seed = await timed(`seed ${COUNT.toLocaleString()} chats`, () => seedArchive(ctx, id, COUNT));
  t(`archive seeded without error (${COUNT.toLocaleString()} chats)`, true);
  // Generous: seeding is chunked sendMessage round trips through a real
  // extension, not a raw DB write benchmark — hours would be a real
  // regression, minutes is not what this threshold is trying to catch.
  t("seeding completed in well under 10 minutes", seed.ms < 10 * 60 * 1000, `${(seed.ms / 1000).toFixed(1)}s`);

  const stats = await timed("stats()", () => send({ type: "recall-stats" }));
  t("stats() reports the seeded count", stats.result && stats.result.chats >= COUNT * 0.99, JSON.stringify(stats.result));
  t("stats() returns in well under 5s at this scale", stats.ms < 5000, `${stats.ms.toFixed(0)}ms`);

  const needleIdx = Math.floor(COUNT / 2);
  const search = await timed(`recall-search "Test question ${needleIdx}"`, () =>
    send({ type: "recall-search", q: `Test question ${needleIdx}` }));
  t("recall-search finds a needle in the full archive", search.result && Array.isArray(search.result.results) && search.result.results.length > 0,
    JSON.stringify(search.result && { count: search.result.results?.length, scanned: search.result.scanned }));
  t("recall-search returns in well under 5s at this scale", search.ms < 5000, `${search.ms.toFixed(0)}ms`);

  const archive = await timed("chat-archive export", () => send({ type: "chat-archive" }));
  t("chat-archive completes without error", !archive.result || !archive.result.err, JSON.stringify(archive.result)?.slice(0, 200));
} finally {
  await ctx.close();
  server.kill();
}

done();
