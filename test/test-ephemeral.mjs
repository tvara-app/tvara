#!/usr/bin/env node
/* Temporary/private/signed-out conversations, and the length-scaled handover.
 *
 * Both run in a bare sandbox with a fake `location` and fake message elements,
 * because both are pure given those: ephemeral() decides whether a chat is
 * archived at all, and compose()'s budget decides how much of a long thread
 * survives the trip. Neither should need a browser to prove.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const ROOT = join(import.meta.dirname, "..");

let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name); }
};
const eq = (name, a, b) => ok(name + (a === b ? "" : `  (got ${a}, want ${b})`), a === b);

/* ---------- sandbox ---------- */

const location = { hostname: "chatgpt.com", pathname: "/", search: "" };
const sandbox = {
  self: {}, location, console, JSON, Math, Date, WeakMap, Set, Map,
  document: {
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener: () => {}, createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, append() {}, appendChild() {}, addEventListener() {}, querySelector: () => null }),
    documentElement: { appendChild: () => {} }
  },
  addEventListener: () => {},
  removeEventListener: () => {},
  getComputedStyle: () => ({ visibility: "visible" }),
  setTimeout: () => 0,
  clearTimeout: () => {}
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, "content", "adapters.js"), "utf8"), sandbox);

const { ephemeral } = sandbox.self.LCTAdapters;

/* A message element, with or without a provider id. */
const el = (text, id) => ({
  hasAttribute: (k) => k === "data-message-id" && !!id,
  getAttribute: (k) => (k === "data-message-id" ? (id || null) : null),
  querySelector: () => null,
  textContent: text,
  id: ""
});

const chatgpt = { id: "chatgpt", convPath: /^\/c\//, stableKey: sandbox.self.LCTAdapters.stableKey };
const two = [el("how do I center a div", "m1"), el("use flexbox", "m2")];

/* ---------- ephemeral() ---------- */

location.pathname = "/c/abc123";
eq("a saved conversation is not ephemeral", ephemeral(chatgpt, two), null);

location.pathname = "/";
ok("a chat on the landing path is ephemeral", !!ephemeral(chatgpt, two));

eq("a landing page with no conversation is not ephemeral",
  ephemeral(chatgpt, [el("Sign up free", "x")]), null);
eq("no messages at all is not ephemeral", ephemeral(chatgpt, []), null);

/* The id is the whole point: every temporary chat shares one URL, so an id
   built from the URL would let them overwrite each other in the archive. */
const first = ephemeral(chatgpt, two).id;
eq("the id is stable across ticks", ephemeral(chatgpt, two).id, first);
ok("a different opening turn gets a different id",
  ephemeral(chatgpt, [el("something else entirely", "m9"), two[1]]).id !== first);
ok("the id is not just the URL", first !== location.hostname + location.pathname);
ok("the id is scoped to the host", first.startsWith("chatgpt.com/"));

/* Falling back to text when the host assigns no message ids — Claude, Grok,
   DeepSeek and Perplexity all land here. */
const noIds = [el("first turn text"), el("second turn text")];
ok("an id is still derived with no provider ids", !!ephemeral(chatgpt, noIds));
ok("…and it differs from another opening turn",
  ephemeral(chatgpt, noIds).id !== ephemeral(chatgpt, [el("different"), noIds[1]]).id);

/* Structural detection, so a host we have never seen still works. The query
   flag only confirms. */
location.search = "";
eq("no query flag is not required", ephemeral(chatgpt, two).flagged, false);
location.search = "?temporary-chat=true";
eq("a temporary-chat flag is reported", ephemeral(chatgpt, two).flagged, true);
location.search = "";

eq("an adapter with no convPath is never ephemeral",
  ephemeral({ id: "x", stableKey: () => "" }, two), null);
eq("the synthetic test page is never ephemeral",
  ephemeral({ id: "synthetic", convPath: /x/, stableKey: () => "" }, two), null);

/* ---------- the length-scaled handover ---------- */

sandbox.self.LCTAdapters = { ...sandbox.self.LCTAdapters, detect: () => chatgpt };
sandbox.self.LCTExporter = { elementToText: (e) => e.textContent };
vm.runInContext(readFileSync(join(ROOT, "content", "carry.js"), "utf8"), sandbox);
const { compose } = sandbox.self.LCTCarry;

/* Past the 6000-char floor even after each turn is clipped to TURN_CHARS (900),
   so the budget decides how much survives rather than the content running out.
   10 turns x 900 = 9000, which fits under the 12000 ceiling. */
const turn = (i) => ({ role: i % 2 ? "assistant" : "user", text: "T" + i + " " + "x".repeat(1200) });
const parts = (total) => ({
  goal: "the original question " + "g".repeat(900),
  starred: [], decisions: [], code: "",
  recent: Array.from({ length: 10 }, (_, i) => turn(i)),
  total
});

const short = compose(parts(10)).length;
const long = compose(parts(400)).length;

ok("a short chat stays at the 6000-char floor", short <= 6000);
ok("a long chat is allowed more than the floor", long > 6000);
ok("…and is still bounded", long <= 12000);
ok("longer chats never carry less than shorter ones", long >= short);

/* A missing total must not be read as "length 0" and shrink the budget. */
const noTotal = compose({ ...parts(400), total: undefined }).length;
ok("an absent total falls back to the floor, not to zero", noTotal > 0 && noTotal <= 6000);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
