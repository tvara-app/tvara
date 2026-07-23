# Lint Radar (lite) — v0.4 spec

Warning badges on AI-generated code blocks, computed locally. No parsers, no
network, no per-language linters — only checks that are cheap and **never
wrong**. A false positive here costs more trust than the feature earns.

## Why this feature
Users copy AI code that crashes on paste: placeholder keys, invalid JSON,
unbalanced brackets. Nobody flags this in-page today. It fits our wedge
(toolkit for AI chats), our privacy brand (zero network), and demos in one
screenshot.

## Checks (v0.4 ships exactly these three)

1. **Placeholder detector** — regex over the block text:
   `YOUR_..._HERE`, `<your-...>`, `xxx-xxx`, `sk-...` dummies, `TODO:`/`FIXME:`
   in assignments, `example.com` credentials, `changeme`, `<API_KEY>`.
   Badge: `⚠ placeholder on line N — replace before running`.
2. **JSON validity** — only when the block is fenced/labeled `json` or parses
   as starting with `{`/`[`: run `JSON.parse`; on failure, report the parser's
   position mapped to a line. Badge: `⚠ invalid JSON — line N`.
   (`JSON.parse` is native: zero cost, zero false positives.)
3. **Bracket balance** — count `()[]{}` outside strings/comments with a tiny
   scanner (~40 lines, language-agnostic). ONLY report when the imbalance is
   provable (e.g. closes-before-open, or unclosed at end). Badge:
   `⚠ unbalanced brackets — { opened line N never closes`.

Explicitly NOT in scope (would need real parsers → weight + false positives):
unused imports, undefined variables, type errors, package existence (needs
network — rejected for this product).

## UX

- Small amber badge row at the TOP of the code block (next to the language
  label), one line per finding, max 3 shown ("+2 more" expands).
- Zero findings → zero UI. Silence is the default; no green "all clear"
  (an "all clear" we can't guarantee is a lie).
- Click a finding → highlights the offending line inside the block.
- Toggle in the popup: "Code warnings" — ON by default (it's why people
  install), one click off.
- Gating: same as other tools (free platforms free, Pro/trial elsewhere).

## Implementation notes

- New file `content/lint.js`, registered after `outline.js` in the manifest.
- Hook the engine's existing message-update callback; scan only `pre` blocks
  in NEW/changed messages (keep a WeakSet of scanned nodes + text hash).
- Skip blocks > 20 KB (pathological pastes; scanning cost > value).
- Badges live inside our `lct-` namespace, styles in `styles.css`, textContent
  only — same security rules as the rest of the UI.
- Tests: extend `test/test-extension.mjs` — one fixture block per check
  (positive + clean negative), plus "no badge on the extension's own UI".

## Store copy (add when it ships)
"Catches AI slip-ups before you paste them: placeholder API keys, broken
JSON, unclosed brackets — flagged right on the code block, all on-device."
