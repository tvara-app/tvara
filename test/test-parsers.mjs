#!/usr/bin/env node
/* Long Chat Toolkit — provider parser suite.
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
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "bg.js"), "utf8");

/** Lift one top-level function's source out of bg.js.
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

const NAMES = ["geminiValueEnd", "geminiFrames", "geminiPayloads", "geminiTime", "geminiAt",
  "pplxTime", "pplxAnswer", "xaiTime"];
const {
  geminiFrames, geminiPayloads, geminiTime, geminiAt, pplxTime, pplxAnswer, xaiTime
} = await import("data:text/javascript," + encodeURIComponent(
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

if (failed.length) {
  console.log("\nfailed:");
  for (const line of failed) console.log("  " + line);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
