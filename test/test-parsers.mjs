#!/usr/bin/env node
/* Tvara — provider parser suite.
 *
 * The sync adapters live in a service worker, so the browser suites can only
 * reach their parsing through a whole authenticated pass. That is the wrong
 * instrument for the parsers themselves: the edge cases that actually break them
 * are shapes a cooperative mock never sends — a zoneless timestamp, an answer
 * wrapped in a JSON string, a frame whose length marker disagrees with its
 * contents, a sign-in page arriving where JSON was expected.
 *
 * So the functions are lifted straight out of bg.js and exercised directly. No
 * browser, no network, no mock: if one of these fails, a provider's transcript
 * is being archived wrongly, and it says so in under a second.
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { workerSource } from "../tools/worker-source.mjs";

// The whole worker, not just bg.js: these parsers live in bg/providers.js now.
const src = workerSource(join(dirname(fileURLToPath(import.meta.url)), ".."));

/** Lift one top-level function's source out of the worker.
 *
 *  String- and comment-aware on purpose: these functions contain `")]}'"` and a
 *  `"}"` literal, and a plain brace counter reads either as the end of the
 *  function and then fails to parse. */
const grab = (name) => {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) throw new Error("bg.js no longer defines " + name);
  let depth = 0, i = src.indexOf("{", at), quote = "", line = false, block = false;
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (line) { if (c === "\n") line = false; continue; }
    if (block) { if (c === "*" && n === "/") { block = false; i++; } continue; }
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === "/" && n === "/") { line = true; i++; continue; }
    if (c === "/" && n === "*") { block = true; i++; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error("unbalanced braces reading " + name);
};

const NAMES = ["geminiValueEnd", "geminiFrames", "geminiPayloads", "geminiTime", "geminiAt", "geminiText", "geminiTierName",
  "bgHealTries", "quotaWhy", "keysUnder", "fillWhy",
  "pplxTime", "pplxFromTrace", "pplxAnswer", "xaiTime", "chatBranch", "chatgptMsgs", "turnMsgs", "planName", "claudeOrgCtx", "planRank", "bestPlanSeat", "clampText", "planFromAny", "pickAllowanceSeat", "bgHealNext", "narrowsFrom",
  "claudeCodeMsgs", "claudeClean", "grokBranch"];
const {
  geminiFrames, geminiPayloads, geminiTime, geminiAt, geminiText, geminiTierName, pplxTime, pplxFromTrace, pplxAnswer, xaiTime,
  chatgptMsgs, turnMsgs, planName, claudeOrgCtx, bestPlanSeat, planRank, clampText, planFromAny, pickAllowanceSeat, bgHealNext, narrowsFrom,
  quotaWhy, keysUnder, fillWhy, claudeCodeMsgs, claudeClean, grokBranch
} = await import("data:text/javascript," + encodeURIComponent(
  (src.match(/^const CLAUDE_STUB = .*;$/m) || [""])[0] + "\n" +
  NAMES.map(grab).join("\n") + `\nexport {${NAMES.join(",")}};`));

let pass = 0, fail = 0;
const failed = [];
const t = (name, cond, extra = "") => {
  const line = `${name}${cond || !extra ? "" : "  \u2192 " + extra}`;
  cond ? pass++ : (fail++, failed.push(line));
  console.log(`${cond ? "PASS" : "FAIL"}  ${line}`);
};

/* ================= Gemini: batchexecute framing and indices ============ */

/* A faithful reply: )]}' guard, then <len>\n<json>\n frames. Two frames, and a
   non-wrb.fr envelope alongside, which is what Google really sends. */
const envelope = (rpcid, payload) =>
  JSON.stringify([["wrb.fr", rpcid, JSON.stringify(payload), null, null, null, "generic"]]);
const frame = (json) => `${json.length + 2}\n${json}\n`;
const reply = (...jsons) => ")]}'\n" + jsons.map(frame).join("");

const listPayload = [null, null, [
  ["c_aaa", "First chat", 0, null, null, [1750000000, 500000000]],
  ["c_bbb", "Second chat", 1, null, null, [1760000000, 0]]
]];

t("frames parse out of a length-prefixed reply",
  geminiFrames(reply(envelope("MaZiqc", listPayload))).length === 1);
t("the )]}' guard is stripped",
  geminiPayloads(reply(envelope("MaZiqc", listPayload)), "MaZiqc").length === 1);
t("a payload is matched to its own rpc id",
  geminiPayloads(reply(envelope("MaZiqc", listPayload)), "hNvQHb").length === 0);
t("multiple frames are all read",
  geminiPayloads(reply(envelope("MaZiqc", listPayload), envelope("MaZiqc", [null, null, []])),
    "MaZiqc").length === 2);
t("a non-wrb.fr envelope alongside is ignored, not fatal",
  geminiPayloads(")]}'\n" + [envelope("MaZiqc", listPayload),
    JSON.stringify([["di", 42], ["af.httprm", 42, "x", 1]])].map(frame).join(""), "MaZiqc").length === 1);

/* The framing convention is exactly what I could not verify, so prove the scan
   does not depend on it: a wrong length must not lose or desync anything. */
const wrongLen = (json) => `${json.length + 99}\n${json}\n`;
t("a WRONG length marker still parses (the scan ignores the count)",
  geminiPayloads(")]}'\n" + [envelope("MaZiqc", listPayload), envelope("MaZiqc", [null, null, []])]
    .map(wrongLen).join(""), "MaZiqc").length === 2);
t("no length markers at all still parses",
  geminiPayloads(")]}'\n" + envelope("MaZiqc", listPayload), "MaZiqc").length === 1);
t("no )]}' guard still parses",
  geminiPayloads(frame(envelope("MaZiqc", listPayload)), "MaZiqc").length === 1);

/* A bracket inside a message must not be read as closing the frame. */
const ASK = 'What does [1] mean? "quoted" and a } brace';
const REPLY = "Here: [a] and {b} and a \\ backslash";
const trickyRead = [[
  [["", "r_1"], null, [[ASK]], [[["rc_1", [REPLY]]]]]
]];
const readPayloads = geminiPayloads(reply(envelope("hNvQHb", trickyRead)), "hNvQHb");
t("brackets and escapes inside message text do not truncate a frame",
  readPayloads.length === 1, JSON.stringify(readPayloads).slice(0, 120));
t("the user's text is read from turn[2][0][0]",
  geminiAt(geminiAt(readPayloads[0], [0])[0], [2, 0, 0]) === 'What does [1] mean? "quoted" and a } brace',
  JSON.stringify(geminiAt(geminiAt(readPayloads[0], [0])[0], [2, 0, 0])));
t("the model's text is read from turn[3][0][0][1][0]",
  geminiAt(geminiAt(readPayloads[0], [0])[0], [3, 0, 0, 1, 0]) === "Here: [a] and {b} and a \\ backslash");

/* Truncated / hostile input must degrade, never throw. */
for (const [label, input] of [
  ["empty string", ""], ["null", null], ["only the guard", ")]}'"],
  ["a truncated frame", ")]}'\n120\n[[\"wrb.fr\",\"MaZiqc\",\"[[null"],
  ["HTML sign-in page", "<!doctype html><html>signed out</html>"],
  ["a length marker with no json", ")]}'\n55\n"]
]) {
  let threw = false, out = [];
  try { out = geminiPayloads(input, "MaZiqc"); } catch { threw = true; }
  t(`${label} yields no payloads and never throws`, !threw && out.length === 0);
}

/* geminiTime */
t("[seconds, nanos] becomes epoch millis",
  geminiTime([1750000000, 500000000]) === 1750000000500);
t("nanos are optional", geminiTime([1760000000]) === 1760000000000);
t("a missing timestamp is 0", geminiTime(undefined) === 0);
t("a non-array timestamp is 0", geminiTime("2026-01-01") === 0);
t("a zero timestamp is 0, not the epoch", geminiTime([0, 0]) === 0);

/* geminiAt */
t("a positional path reads through nesting", geminiAt([[["x"]]], [0, 0, 0]) === "x");
t("a missing hop is undefined, not a throw", geminiAt([1], [0, 5, 2]) === undefined);
t("a non-array root is undefined", geminiAt("nope", [0]) === undefined);

/* The listing row indices the adapter depends on. */
const rows = geminiAt(geminiPayloads(reply(envelope("MaZiqc", listPayload)), "MaZiqc")[0], [2]);
t("listing rows sit at payload[2]", Array.isArray(rows) && rows.length === 2);
t("row[0] is the cid and row[1] the title",
  rows[0][0] === "c_aaa" && rows[0][1] === "First chat");
t("row[5] is the timestamp", geminiTime(rows[1][5]) === 1760000000000);

/* ================= Perplexity: timestamps and answer spellings ========= */

/* pplxTime */
t("zoneless ISO reads as UTC",
  pplxTime("2026-02-17T08:02:14.816554") === Date.UTC(2026, 1, 17, 8, 2, 14, 816));
t("an explicit Z is left alone",
  pplxTime("2026-02-17T08:02:14.816Z") === Date.UTC(2026, 1, 17, 8, 2, 14, 816));
t("an explicit offset is honoured, not double-stamped",
  pplxTime("2026-02-17T08:02:14+05:30") === Date.UTC(2026, 1, 17, 2, 32, 14));
t("a +0530 offset without a colon is honoured too",
  pplxTime("2026-02-17T08:02:14+0530") === Date.UTC(2026, 1, 17, 2, 32, 14));
t("empty is 0", pplxTime("") === 0);
t("null is 0", pplxTime(null) === 0);
t("garbage is 0, never NaN", pplxTime("not a date") === 0);

/* pplxAnswer */
t("plain text wins", pplxAnswer({ text: "hello" }) === "hello");
/* Perplexity's FOURTH shape, and the one that reached the archive as a wall of
   JSON: `text` is sometimes the whole reasoning trace, with the real answer in
   the last step and encoded a second time inside it. */
const trace = JSON.stringify([
  { step_type: "INITIAL_QUERY", content: { query: "black bmw top view" } },
  { step_type: "SEARCH_RESULTS", content: { web_results: [{ name: "x", url: "https://e.g" }] } },
  { step_type: "FINAL", content: { answer: JSON.stringify({ answer: "Here is the prompt.", chunks: [] }) } }
]);
t("a reasoning trace yields the FINAL answer, not the trace",
  pplxAnswer({ text: trace }) === "Here is the prompt.", pplxAnswer({ text: trace }).slice(0, 40));
t("…and never the search results that led to it",
  !/web_results|step_type|https:/.test(pplxAnswer({ text: trace })));
t("a singly-encoded FINAL answer works too",
  pplxFromTrace(JSON.stringify([{ step_type: "FINAL", content: { answer: "plain answer" } }])) === "plain answer");
t("anything that is not a step array is left alone", pplxFromTrace("just prose") === "");
t("a JSON body with no answer does not become the message",
  pplxAnswer({ text: JSON.stringify([{ step_type: "SEARCH_WEB", content: {} }]) }) === "");
t("JSON-encoded answer is unwrapped",
  pplxAnswer({ answer: JSON.stringify({ answer: "hello" }) }) === "hello");
t("the raw wrapper is NEVER returned",
  !pplxAnswer({ answer: '{"answer":"hi"}' }).includes('{"answer"'));
t("text beats answer when both are present",
  pplxAnswer({ text: "plain", answer: JSON.stringify({ answer: "wrapped" }) }) === "plain");
t("a schematized block is read when text and answer are absent",
  pplxAnswer({ blocks: [
    { intended_usage: "web_results", web_result_block: {} },
    { intended_usage: "ask_text", markdown_block: { answer: "from block" } }
  ] }) === "from block");
t("an unparseable answer string falls through to blocks, not to itself",
  pplxAnswer({ answer: "{not json", blocks: [
    { intended_usage: "ask_text", markdown_block: { answer: "recovered" } }
  ] }) === "recovered");
t("an unparseable answer with no blocks yields empty, not the raw string",
  pplxAnswer({ answer: "{not json" }) === "");
t("an answer wrapper with no .answer key yields empty",
  pplxAnswer({ answer: JSON.stringify({ other: "x" }) }) === "");
t("whitespace-only text is not treated as an answer",
  pplxAnswer({ text: "   ", answer: JSON.stringify({ answer: "real" }) }) === "real");
t("nothing at all is empty", pplxAnswer({}) === "");
t("blocks that are not an array never throw", pplxAnswer({ blocks: "nope" }) === "");

/* ---------- Grok timestamps ---------- */
t("G an ISO timestamp becomes epoch millis",
  xaiTime("2026-03-01T00:00:00.000Z") === Date.UTC(2026, 2, 1));
t("G epoch seconds are scaled up", xaiTime(1750000000) === 1750000000000);
t("G epoch millis are left alone", xaiTime(1750000000000) === 1750000000000);
t("G empty is 0", xaiTime("") === 0);
t("G null is 0", xaiTime(null) === 0);
t("G garbage is 0, never NaN", xaiTime("whenever") === 0);
t("G a negative number is 0", xaiTime(-5) === 0);

/* =============== Which plan the account is actually on =============== */

/* Every provider spells its tiers differently and renames them without notice.
   Matching on substrings is what keeps a renamed tier from reading as Free —
   the one wrong answer that looks like a real one. */
t("plan: Anthropic's current tier string", planName("default_claude_max_20x") === "Max (20x)");
t("plan: the 5x tier is not the 20x tier", planName("claude_max_5x") === "Max (5x)");
t("plan: a Pro tier", planName("default_claude_pro") === "Pro");
t("plan: OpenAI's Plus is not Pro", planName("chatgptplusplan") === "Plus");
t("plan: …and OpenAI's Pro is", planName("chatgptproplan") === "Pro");
t("plan: a free account says so", planName("chatgptfreeplan") === "Free");
t("plan: a team is a team, whatever it is called",
  planName("chatgptteamplan") === "Team" && planName("raven") === "Team");
/* OpenAI writes a tier as one word, so a short tier is only reachable once the
   product word and the "plan" suffix come off. Go read as no plan at all, and
   Pro Lite read as Pro — the tier above it, at twice the price. */
t("plan: OpenAI's Go tier is named, not dropped", planName("chatgptgoplan") === "Go");
t("plan: …and so is a bare plan_type", planName("go") === "Go");
t("plan: Pro Lite is not Pro", planName("chatgptprolite") === "Pro Lite");
t("plan: …and Pro is still Pro", planName("chatgptpro") === "Pro" && planName("chatgptproplan") === "Pro");
t("plan: 'go' inside a word is not a tier",
  planName("google") === "" && planName("cargo") === "" && planName("django") === "");
/* Gemini is archived from the RPC, not the DOM, so THINK_SEL cannot reach it.
   A thinking model writes its working into the same text list as the answer,
   ahead of it — and taking element 0 stored "Drafting the Formulas… Writing the
   Final Response:" as though it were the reply, with the reply itself never
   archived at all. Structure only: the working comes before the answer, never
   after it. */
t("gemini: the answer is taken, not the working before it",
  geminiText([["Drafting the formulas. Writing the final response:"], ["The answer is 42."]]) ===
  "The answer is 42.");
t("gemini: one entry is the answer, unchanged",
  geminiText([["Only this."]]) === "Only this.");
t("gemini: a bare string is still an answer", geminiText("plain") === "plain");
t("gemini: empty entries are not the answer",
  geminiText([["The answer."], [""], ["   "]]) === "The answer.");
t("gemini: nothing is nothing, never a guess",
  geminiText([]) === "" && geminiText(null) === "" && geminiText([[""]]) === "");
/* One login owns several Claude organisations and they all report the same
   tier, so choosing a seat by plan alone was a coin toss settled by whichever
   the API listed first — usually the personal org nobody uses, reporting 100%
   left while the site said a quarter of the week was gone. */
{
  const unused = { acct: "a", windows: [{ pctLeft: 100 }] };
  const real = { acct: "b", windows: [{ pctLeft: 76 }, { pctLeft: 39 }] };
  t("seat: the allowance being SPENT is the subscription's",
    pickAllowanceSeat([unused, real]) === real);
  t("seat: …whichever order the provider listed them in",
    pickAllowanceSeat([real, unused]) === real);
  t("seat: one seat is the seat", pickAllowanceSeat([unused]) === unused);
  t("seat: nothing read is nothing chosen",
    pickAllowanceSeat([]) === undefined && pickAllowanceSeat(null) === undefined);
  t("seat: seats with no share keep the first, rather than guessing",
    pickAllowanceSeat([{ acct: "a", windows: [{ remaining: 3 }] },
      { acct: "b", windows: [{ remaining: 9 }] }]).acct === "a");
}
/* Gemini states a plan in exactly one place: the tier code at the head of the
   usage RPC payload. There is no REST endpoint to read one from. */
t("gemini: the tier code names the plan",
  geminiTierName(1) === "Free" && geminiTierName(2) === "Pro" &&
  geminiTierName(4) === "Plus" && geminiTierName(3) === "Ultra" && geminiTierName(6) === "Ultra");
t("gemini: an unknown code names nothing, never a guess",
  geminiTierName(99) === "" && geminiTierName(null) === "" && geminiTierName(undefined) === "");
t("plan: Ultra is above Pro, not a kind of it",
  planName("ultra") === "Ultra" && planRank("Ultra") > planRank("Pro"));
t("plan: nothing said is not 'Free'", planName("") === "" && planName(null) === "");

/* The org list is where Claude states this, and `capabilities` alone called a
   Max account Pro and an org that lists neither a paying account Free. */
t("claude: the tier on the org decides",
  claudeOrgCtx({ uuid: "o", capabilities: ["chat"], rate_limit_tier: "default_claude_pro" }).plan === "Pro");
t("claude: Max keeps its multiplier",
  claudeOrgCtx({ uuid: "o", capabilities: ["chat", "claude_max"], rate_limit_tier: "default_claude_max_20x" }).plan === "Max (20x)");
t("claude: capabilities still answer when no tier is sent",
  claudeOrgCtx({ uuid: "o", capabilities: ["chat", "claude_pro"] }).plan === "Pro");
t("claude: a workspace is a Team",
  claudeOrgCtx({ uuid: "o", capabilities: ["chat"], raven_type: "standard" }).plan === "Team");
t("claude: and a free org is Free",
  claudeOrgCtx({ uuid: "o", capabilities: ["chat"] }).plan === "Free");

/* Grok, DeepSeek and Gemini state a tier somewhere in a body the probe already
   reads, under a name nobody documents. Scanning for a plan-shaped key is safe
   because planName() refuses what it does not recognise. */
t("any: a tier named anywhere is found",
  planFromAny({ data: { user: { subscription_tier: "pro" } } }, 0) === "Pro");
t("any: …however deep, and whatever the key is called",
  planFromAny({ a: { b: { c: { membership: "claude_max_20x" } } } }, 0) === "Max (20x)");
t("any: a key that is not a plan is not a plan",
  planFromAny({ tier: "b2", plan_id: "x9" }, 0) === "");
t("any: nothing at all is not 'Free'", planFromAny(null, 0) === "" && planFromAny({}, 0) === "");

/* One login, several organisations, ONE subscription. Polling each org stored
   each as its own account: the panel showed "Claude Pro" twice, and the row that
   won was whichever answered last — usually the unused org, at 100% left. */
t("seat: the org holding the plan is the one to report",
  bestPlanSeat([{ plan: "Free" }, { plan: "Max (20x)" }, { plan: "Free" }]).plan === "Max (20x)");
t("seat: Team outranks Pro, Max outranks Team",
  bestPlanSeat([{ plan: "Pro" }, { plan: "Team" }]).plan === "Team" &&
  bestPlanSeat([{ plan: "Team" }, { plan: "Max (5x)" }]).plan === "Max (5x)");
t("seat: all the same means the first one",
  bestPlanSeat([{ plan: "Free", uuid: "a" }, { plan: "Free", uuid: "b" }]).uuid === "a");
t("seat: an unknown plan never outranks a known one",
  bestPlanSeat([{ plan: "Pro" }, { plan: "wat" }]).plan === "Pro");
t("seat: nothing at all does not throw", bestPlanSeat([]) === undefined && bestPlanSeat(null) === undefined);

/* ============ Ultra-long code, cut without cutting a fence ============ */

/* A cut inside a fenced block leaves an opening ``` with nothing closing it,
   and every reader downstream then renders the REST of the conversation as
   code. And a message that is mostly code gets more room than a paragraph
   does: "here is the file" is exactly the answer people come back for. */
{
  const long = "```python\n" + "x = 1\n".repeat(4000);      // ~24k, one open fence
  const cut = clampText(long, 16000);
  t("code: an over-long block is cut, but not left open",
    cut.length < long.length && (cut.match(/```/g) || []).length % 2 === 0, String(cut.length));
  t("code: …and it keeps far more than a paragraph would", cut.length > 8000, String(cut.length));
  const prose = "word ".repeat(2000);
  t("code: prose keeps the smaller bound", clampText(prose, 4000).length <= 4000);
  t("code: anything inside the bound is untouched", clampText("hello", 4000) === "hello");
}

/* ============== ChatGPT: what the transcript counts as a turn ============== */

/* A real two-message conversation as the mapping actually ships it: the answer
   arrives with a reasoning summary and a browsing block beside it, both authored
   "assistant", both addressed to "all", both empty of text parts. Counting them
   is what drew four ticks on a chat with two messages — and since the extra
   ticks land inside the answer, they read as parts of one long response. */
const node = (id, parent, message) => [id, { id, parent, children: [], message }];
const gptConv = {
  current_node: "e",
  mapping: Object.fromEntries([
    node("root", null, null),
    node("a", "root", { id: "a", author: { role: "user" }, recipient: "all",
      content: { content_type: "text", parts: ["can i get any tld with parts of the word extension"] },
      create_time: 1 }),
    node("b", "a", { id: "b", author: { role: "assistant" }, recipient: "all",
      content: { content_type: "thoughts", thoughts: [{ summary: "Considering TLDs", content: "…" }] },
      create_time: 2 }),
    node("c", "b", { id: "c", author: { role: "assistant" }, recipient: "all",
      content: { content_type: "tether_browsing_display", result: "iana.org" }, create_time: 3 }),
    node("d", "c", { id: "d", author: { role: "assistant" }, recipient: "browser",
      content: { content_type: "code", text: "search('tld')" }, create_time: 4 }),
    node("e", "d", { id: "e", author: { role: "assistant" }, recipient: "all",
      content: { content_type: "text", parts: ["Unfortunately .ex isn't a public TLD."] },
      create_time: 5 })
  ])
};
const gptMsgs = chatgptMsgs(gptConv);
t("GPT two messages are two messages, not four", gptMsgs.length === 2, `got ${gptMsgs.length}`);
t("GPT the pair is one each way",
  gptMsgs[0].r === "user" && gptMsgs[1].r === "assistant",
  gptMsgs.map((m) => m.r).join(","));

/* …and a turn that IS a picture is still a turn: empty text, a part that is not
   a string. Dropping it would shift every position after it. */
const gptMedia = chatgptMsgs({
  current_node: "y",
  mapping: Object.fromEntries([
    node("x", null, { id: "x", author: { role: "user" }, recipient: "all",
      content: { content_type: "text", parts: ["look at this"] }, create_time: 1 }),
    node("y", "x", { id: "y", author: { role: "assistant" }, recipient: "all",
      content: { content_type: "multimodal_text", parts: [{ content_type: "image_asset_pointer" }] },
      create_time: 2 })
  ])
});
t("GPT an image-only turn survives, and says why it is empty",
  gptMedia.length === 2 && gptMedia[1].t === "" && gptMedia[1].m === 1,
  JSON.stringify(gptMedia));

/* The same judgement on the way back OUT, for records written before the fetch
   made it: an empty message with no media flag is a placeholder, not a turn. */
t("read drops a stored placeholder",
  turnMsgs([{ t: "hi" }, { t: "" }, { t: "there" }]).length === 2);
t("read keeps a stored picture",
  turnMsgs([{ t: "hi" }, { t: "", m: 1 }]).length === 2);
t("read leaves a clean record's own array alone",
  (() => { const a = [{ t: "hi" }, { t: "yes" }]; return turnMsgs(a) === a; })());


/* ---------- the worker's own restart ----------
   A dead worker reloads the extension to rebuild its registration. The bound is
   the whole safety of that: unrecorded or mis-keyed, it is an extension that
   restarts itself forever. */
t("heal reloads a worker that lost its modules", bgHealNext(null, "1.0.0", false) === "reload");
t("heal reloads a second time", bgHealNext({ version: "1.0.0", tries: 1 }, "1.0.0", false) === "reload");
t("heal stops at the bound", bgHealNext({ version: "1.0.0", tries: 2 }, "1.0.0", false) === "stop");
t("heal stays stopped past the bound", bgHealNext({ version: "1.0.0", tries: 9 }, "1.0.0", false) === "stop");
// A new build is a new chance: the record is keyed by version, not by install.
t("heal tries again after an upgrade", bgHealNext({ version: "0.9.0", tries: 2 }, "1.0.0", false) === "reload");
// And a healthy start is what clears it, or the next real failure is unhealable.
t("heal clears a spent record on a healthy start",
  bgHealNext({ version: "1.0.0", tries: 2 }, "1.0.0", true) === "clear");
t("heal writes nothing when there is nothing to clear",
  bgHealNext(null, "1.0.0", true) === "");

/* An UNPACKED build's files move all day and its version never changes, so a
   bound keyed on version alone spent itself once and the worker could never
   heal again — the dead extension this exists to end, made permanent by its
   own guard. Observed exactly that way: fifteen modules failing, every file
   present and readable, and a banner that had stopped trying. The bound is on
   the RATE now: two attempts, then a pause, then a fresh episode. */
const NOW = 1_700_000_000_000;
const COOL = 30 * 60 * 1000;
t("heal stops while the two attempts are still recent",
  bgHealNext({ version: "1.0.0", tries: 2, at: NOW - 60_000 }, "1.0.0", false, NOW) === "stop");
t("heal tries again once the pause has passed, on the SAME version",
  bgHealNext({ version: "1.0.0", tries: 2, at: NOW - COOL - 1 }, "1.0.0", false, NOW) === "reload");
t("…and the counter starts over, so the new episode gets two of its own",
  bgHealNext({ version: "1.0.0", tries: 9, at: NOW - COOL - 1 }, "1.0.0", false, NOW) === "reload");
/* The whole safety of this is that a fresh episode cannot begin immediately:
   without the pause it is an extension that restarts itself forever. */
t("heal cannot spin: one second before the pause ends it is still stopped",
  bgHealNext({ version: "1.0.0", tries: 2, at: NOW - COOL + 1000 }, "1.0.0", false, NOW) === "stop");
t("a record with no timestamp is treated as this episode, not a free retry",
  bgHealNext({ version: "1.0.0", tries: 2 }, "1.0.0", false, NOW) === "stop");

/* ---------- searching as you type ----------
   Adding characters can only narrow an AND search over substrings, so a query
   that extends the last one is answered from the last one's results instead of
   from the whole archive. Saying "yes" wrongly here loses search results
   silently, which is the one failure this project must not have. */
const prev = (words) => ({ words, ids: [], scanned: 1, seq: 0 });
t("narrowing: a word being typed out", narrowsFrom(prev(["atten"]), ["attention"]) === true);
t("narrowing: the same query again", narrowsFrom(prev(["atten"]), ["atten"]) === true);
t("narrowing: a second word added", narrowsFrom(prev(["atten"]), ["atten", "layer"]) === true);
t("narrowing: a word typed out AND another added",
  narrowsFrom(prev(["atten"]), ["attention", "la"]) === true);
// Every one of these can WIDEN the answer, so every one goes back to the archive.
t("widening: a character deleted", narrowsFrom(prev(["attention"]), ["attentio"]) === false);
t("widening: the word replaced", narrowsFrom(prev(["attention"]), ["retrieval"]) === false);
t("widening: a word removed", narrowsFrom(prev(["atten", "layer"]), ["atten"]) === false);
t("widening: an EARLIER word edited", narrowsFrom(prev(["atten", "layer"]), ["atte", "layer"]) === false);
t("widening: the words reordered", narrowsFrom(prev(["atten", "layer"]), ["layer", "atten"]) === false);
t("nothing to narrow from", narrowsFrom(null, ["atten"]) === false);
t("nothing to narrow from, empty", narrowsFrom(prev([]), ["atten"]) === false);

/* ---------- why a provider could not be read ----------
   Only `auth` is a statement about the SESSION. Every other failure reaching
   the panel as "not signed in" is the wrong answer that looks like a real one —
   it sends somebody to sign in to an account they are already signed into. */
t("a 401 is a signed-out session", quotaWhy("auth") === "not signed in");
t("a bot challenge is not a verdict about the session",
  quotaWhy("challenge") === "blocked by the provider");
t("a rate limit is not a signed-out session", quotaWhy("rate") === "rate-limited");
t("a network failure is not a signed-out session",
  quotaWhy("net") === "could not reach the provider");
t("an unnamed failure is not a signed-out session either",
  quotaWhy("") === "could not reach the provider" && quotaWhy(undefined) === "could not reach the provider");
t("no failure kind ever reads as signed out but auth",
  ["challenge", "rate", "net", "gone", "cancelled", "", null, undefined]
    .every((k) => quotaWhy(k) !== "not signed in"));

/* ---------- a remover only ever removes what its prefix owns ----------
   Both quota removers deleted every key their read returned, and the read asked
   for the learned-endpoint report alongside the prefix — so a successful poll
   wiped the report, every later poll re-probed every candidate, and on a build
   with no storage.local.getKeys() the read is get(null): one 401 would have
   taken the whole store. */
const store = {
  "quota:claude|a": 1, "quota:claude|b": 2, "quota:chatgpt|a": 3,
  "lct-quota-probe-v1": 4, "settings": 5
};
t("only keys under the prefix are removable",
  JSON.stringify(keysUnder(store, "quota:claude|")) === JSON.stringify(["quota:claude|a", "quota:claude|b"]));
t("the learned-endpoint report is never removable",
  !keysUnder(store, "quota:claude|").includes("lct-quota-probe-v1"));
t("a whole-store read cannot widen a prefix removal",
  keysUnder(store, "quota:").length === 3 && !keysUnder(store, "quota:").includes("settings"));
t("an empty read removes nothing", keysUnder(null, "quota:").length === 0);

/* ---------- why the text fetch stopped on one provider ----------
   Six providers download at once, so a refusal is about ONE of them — and only
   `auth` is about the session. Every failure used to be written as "signed
   out", and the popup then appended "Sign in, then tap to continue" to it. */
const gpt = { id: "chatgpt", label: "ChatGPT", host: "chatgpt.com" };
t("fetch: a 401 says to sign in, and says it once",
  fillWhy(gpt, "auth") === "ChatGPT: not signed in. Sign in, then tap to continue.");
t("fetch: a rate limit is not a signed-out session",
  fillWhy(gpt, "rate") === "Archive updates will continue automatically.");
t("fetch: a bot challenge names the remedy that works",
  fillWhy(gpt, "challenge") === "ChatGPT blocked the fetch. Open chatgpt.com in a tab.");
t("fetch: an unreachable provider is not a signed-out session",
  fillWhy(gpt, "net") === "Archive updates will continue automatically.");
t("fetch: no failure kind but auth ever says to sign in",
  ["rate", "challenge", "net", "gone", "", null, undefined]
    .every((k) => !/sign in/i.test(fillWhy(gpt, k))));
t("fetch: every sentence carries its own remedy, so nothing is appended to it",
  ["auth", "rate", "challenge", "net"].every((k) => /\.$/.test(fillWhy(gpt, k))));
t("fetch: a transport pause stops that provider before it can amplify failures",
  /kind === "rate" \|\| kind === "net" \|\| kind === "shape"/.test(src));


/* Claude Code, read from the event stream claude.ai itself loads. Shapes are the
   live site's (2026-09-18): newest first, one assistant event per model call. */
{
  let seq = 100;
  const ev = (payload) => ({ event_id: "e" + seq, sequence_num: String(seq--), payload });
  const user = (content, extra = {}) => ev({ type: "user", uuid: "u" + seq, message: { role: "user", content }, parent_tool_use_id: null, ...extra });
  const asst = (content, extra = {}) => ev({ type: "assistant", uuid: "a" + seq, message: { role: "assistant", content }, parent_tool_use_id: null, ...extra });
  const desc = [
    asst([{ type: "text", text: "Second answer." }]),
    user([{ type: "tool_result", tool_use_id: "t2", content: "ok" }]),
    user("[Request interrupted by user]", { origin: { kind: "human" } }),
    user("<command-name>/compact</command-name><command-args>keep tests</command-args>", { origin: { kind: "human" } }),
    ev({ type: "system", uuid: "s1" }),
    asst([{ type: "text", text: "and the rest of it." }]),
    asst([{ type: "tool_use", id: "t1", name: "Bash", input: {} }]),
    asst([{ type: "text", text: "Sub-agent chatter" }], { parent_tool_use_id: "t0" }),
    asst([{ type: "text", text: "First answer," }]),
    user("<task-notification>done</task-notification>", { origin: { kind: "task-notification" } }),
    user([{ type: "text", text: "Switch mode." }], { isSynthetic: true }),
    user([{ type: "text", text: "Fix the map.<system-reminder>injected</system-reminder>" }], { origin: { kind: "human" } }),
  ];
  const got = claudeCodeMsgs(desc).map((m) => m.r[0] + ":" + m.t);
  t("claude code: prompts and answers only, oldest first",
    got.join(" | ") === "u:Fix the map. | a:First answer,\n\nand the rest of it. | u:/compact keep tests | a:Second answer.",
    got.join(" | "));
  t("claude code: every message keeps the provider's id", claudeCodeMsgs(desc).every((m) => m.i));
  t("claude code: an empty or foreign stream is no messages", claudeCodeMsgs(null).length === 0 && claudeCodeMsgs([{}]).length === 0);
}
{
  const stub = "This block is not supported on your current device yet.";
  t("claude text: a tool placeholder is cut, with the label line it opened with",
    claudeClean("```\nmacOS 27 bugs\n" + stub + "\n```\n\nIf none of that") === "If none of that");
  t("claude text: a real code block is left alone",
    claudeClean("run\n```js\nconst a = 1;\n```\nend") === "run\n```js\nconst a = 1;\n```\nend");
  t("claude text: the sr-only turn label a page capture read is dropped",
    claudeClean("You said: hello there") === "hello there" && claudeClean("Claude responded: hi") === "hi");
}

/* Grok lists every node it ever made. Shape from the live API (2026-09-18):
   an edited prompt and a regenerated answer each hang off the turn they replaced. */
{
  const nodes = [
    { responseId: "u1", sender: "human" },
    { responseId: "a1", sender: "ASSISTANT", parentResponseId: "u1" },
    { responseId: "u2", sender: "human", parentResponseId: "a1" },
    { responseId: "u2b", sender: "human", parentResponseId: "a1" },          // the prompt, edited
    { responseId: "a2", sender: "ASSISTANT", parentResponseId: "u2" },
    { responseId: "a2b", sender: "ASSISTANT", parentResponseId: "u2b" },     // its answer
    { responseId: "a2c", sender: "ASSISTANT", parentResponseId: "u2b" },     // regenerated: the one on screen
  ];
  t("grok: the branch on screen, not every edit and regeneration", grokBranch(nodes).join(",") === "u1,a1,u2b,a2c", grokBranch(nodes).join(","));
  t("grok: nodes that do not chain are kept whole rather than guessed at",
    grokBranch([{ responseId: "x", parentResponseId: "gone" }, { responseId: "y", parentResponseId: "x" }]).join(",") === "x,y");
}

if (failed.length) {
  console.log("\nfailed:");
  for (const line of failed) console.log("  " + line);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
