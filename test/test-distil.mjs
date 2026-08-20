/**
 * What the handover chooses to carry.
 *
 * The conversation below is the shape this feature exists for: a long working
 * thread where the goal is stated once at the top, the decisions that actually
 * constrain the work happen in the MIDDLE, the code is revised three times, and
 * the last several turns are the part that carries nothing — "that worked",
 * "thanks", "great".
 *
 * The old handover took the opening question and the last six turns, which on
 * this thread is the goal plus six turns of nothing. Every assertion here is
 * about whether the new one does better, and the last one compares them
 * directly rather than taking it on trust.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scope = { self: {} };
new Function("self", readFileSync(join(root, "content", "distil.js"), "utf8"))(scope.self);
const D = scope.self.LCTDistil;

let pass = 0, fail = 0; const failed = [];
const t = (name, cond, detail) => {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; failed.push(`${name}${detail ? "  → " + detail : ""}`); console.log(`FAIL  ${name}${detail ? "  → " + detail : ""}`); }
};

/* ---------- a thread that looks like real work ---------- */
const GOAL = "I need to build a rate limiter for our payments API that survives a restart and works across three worker processes.";
const DECISION_1 = "Actually don't use a fixed window, the burst at the boundary is exactly the failure we hit last month. Use a sliding window instead.";
const DECISION_2 = "We must not add Redis. The whole point is that this runs on one box with no extra services, so the counter has to live in Postgres.";
const DECISION_3 = "Let's go with the token bucket after all, rather than the sliding log, because the memory per key is constant.";

const conv = [];
conv.push({ role: "user", text: GOAL });
conv.push({ role: "assistant", text: "There are three common approaches to rate limiting: fixed window counters, sliding window logs, and token buckets. Each trades memory against precision at the window boundary in a different way, and the right one depends on how strict your limit has to be." });
// filler, the kind of exchange that fills a long thread
for (let i = 0; i < 60; i++) {
  conv.push({ role: "user", text: `Can you show me how the ${i % 2 ? "counter" : "bucket"} behaves when traffic arrives in a burst of ${i + 3} requests?` });
  conv.push({ role: "assistant", text: `With a burst of ${i + 3} requests the limiter admits the first few and rejects the remainder until the window advances. The exact cutoff depends on the refill rate you configure for the bucket.` });
}
conv.push({ role: "user", text: DECISION_1 });
conv.push({ role: "assistant", text: "Understood, a sliding window avoids the boundary burst because it weights the previous window's count by how far into the current one you are." });
conv.push({ role: "assistant", text: "```sql\nCREATE TABLE rate_limit (\n  key TEXT PRIMARY KEY,\n  tokens INTEGER NOT NULL,\n  updated_at TIMESTAMPTZ NOT NULL\n);\n```" });
conv.push({ role: "user", text: DECISION_2 });
for (let i = 0; i < 40; i++) {
  conv.push({ role: "assistant", text: `Postgres can hold the counter with a row per key and an atomic update. Contention on a single hot key is the thing to watch at ${i * 100} requests per second.` });
  conv.push({ role: "user", text: `And what happens at ${i * 100} requests per second on one key?` });
}
conv.push({ role: "user", text: DECISION_3 });
conv.push({ role: "assistant", text: "```sql\nCREATE TABLE rate_limit (\n  key TEXT PRIMARY KEY,\n  tokens NUMERIC NOT NULL,\n  refill_rate NUMERIC NOT NULL,\n  updated_at TIMESTAMPTZ NOT NULL\n);\n```" });
// and the tail: the part the old handover carried, and the only part
for (const s of ["That worked, thanks", "Great", "ok", "Perfect", "yes", "thanks!"]) {
  conv.push({ role: "user", text: s });
}

const out = D.distil(conv, { max: 2600 });
const carried = out.decisions.map((d) => d.text).join("\n");

/* ---------- what it must carry ---------- */
t("the opening goal survives", out.goal === GOAL, out.goal.slice(0, 60));
t("a correction made in the middle is carried",
  carried.includes("sliding window instead"), `${out.decisions.length} turns picked`);
t("a hard constraint is carried", carried.includes("must not add Redis"));
t("the final choice between options is carried", carried.includes("token bucket"));

/* ---------- what it must not ---------- */
t("acknowledgements are dropped", !/^(ok|yes|thanks?|great|perfect)$/im.test(carried));
t("the filler that fills a long thread is not what gets carried",
  (carried.match(/requests per second on one key/g) || []).length <= 1,
  String((carried.match(/requests per second on one key/g) || []).length));

/* ---------- code: the CURRENT state, not the last paste ---------- */
t("code is carried as the newest version of a block, not every version",
  out.code.length === 1, JSON.stringify(out.code.map((c) => c.lang)));
t("…and it is the revised schema, not the first one",
  out.code[0] && out.code[0].body.includes("refill_rate"),
  out.code[0] ? out.code[0].body.slice(0, 40) : "none");

/* ---------- it reaches into the thread, not just the end ---------- */
t("the selection spans the conversation rather than hugging the tail",
  out.covered > 50, `covers ${out.covered}%`);
t("nothing invented: every carried turn is verbatim from the thread",
  out.decisions.every((d) => conv.some((c) => c.text === d.text)));

/* ---------- against what it replaces ---------- */
const oldWay = conv.slice(-6).map((r) => r.text).join("\n");
const decisionsInOld = [DECISION_1, DECISION_2, DECISION_3].filter((d) => oldWay.includes(d)).length;
const decisionsInNew = [DECISION_1, DECISION_2, DECISION_3].filter((d) => carried.includes(d)).length;
t("the old last-six-turns handover carried none of the decisions",
  decisionsInOld === 0, String(decisionsInOld));
t("this one carries all three", decisionsInNew === 3, `${decisionsInNew}/3`);

/* ---------- degenerate input ---------- */
t("an empty conversation does not throw", D.distil([]).total === 0);
t("a one-line conversation still yields its goal",
  D.distil([{ role: "user", text: "fix the login bug please" }]).goal === "fix the login bug please");

console.log(`\n${pass} passed, ${fail} failed`);
if (failed.length) { console.log("\nFailures:"); for (const f of failed) console.log("  " + f); }
process.exit(fail ? 1 : 0);
