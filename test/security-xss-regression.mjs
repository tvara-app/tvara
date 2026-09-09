#!/usr/bin/env node
/* Regression lock for the innerHTML audit: 9 sites across the codebase were
   verified by hand to assign only static markup, never chat/archive/storage
   text, to innerHTML. eslint-plugin-no-unsanitized (see eslint.config.js)
   is the primary, ongoing defense — it flags ANY non-literal innerHTML RHS,
   including these already-verified-safe ones, which is why each site below
   also carries an eslint-disable-next-line comment. That comment only stops
   future lint errors AT that line; it says nothing about whether the
   constant it references stays static. This file is the independent check:
   it re-reads each site's actual RHS (and, for a bare-identifier RHS, the
   named constant's own definition) and fails if a `${` interpolation of a
   variable ever appears — the one thing that would turn "static markup"
   into a real sink. No browser needed; pure source inspection. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

let pass = 0, fail = 0;
const failed = [];
const t = (name, cond, extra = "") => {
  const line = `${name}${cond || !extra ? "" : "  → " + extra}`;
  cond ? pass++ : (fail++, failed.push(line));
  console.log(`${cond ? "PASS" : "FAIL"}  ${line}`);
};

// Sites verified static by hand. `pattern` locates the assignment robustly
// against line drift (this repo is edited daily) rather than pinning line
// numbers. `historyLoaderLiteral` etc. are exact-string sites with nothing
// to trace; the rest assign a backtick template or a same-file constant.
const SITES = [
  { file: "content/preview.js", pattern: /panel\.innerHTML\s*=/ },
  { file: "content/search.js", pattern: /bar\.innerHTML\s*=/ },
  { file: "content/outline.js", pattern: /starBtn\.innerHTML\s*=/ },
  { file: "content/outline.js", pattern: /panel\.innerHTML\s*=/ },
  { file: "content/minimap.js", pattern: /root\.innerHTML\s*=/ },
  { file: "content/history-loader.js", pattern: /pill\.innerHTML\s*=/ },
  { file: "content/main.js", pattern: /bar\.innerHTML\s*=/ },
  { file: "diag/quota.js", pattern: /\$\("out"\)\.innerHTML\s*=/ },
  { file: "content/indexer.js", pattern: /icon\.innerHTML\s*=/ },
];

// From the `=` after a matched site, capture the RHS up to its real end:
// a backtick template (balanced, unescaped backtick closes it), a chain of
// quoted-string literals joined by `+`, or a bare identifier ending at `;`.
function captureRhs(src, eqIndex) {
  let i = eqIndex + 1;
  while (/\s/.test(src[i])) i++;
  if (src[i] === "`") {
    let j = i + 1;
    while (j < src.length && !(src[j] === "`" && src[j - 1] !== "\\")) j++;
    return { kind: "template", text: src.slice(i, j + 1) };
  }
  if (src[i] === "'" || src[i] === '"') {
    const q = src[i];
    let j = i, parts = [];
    for (;;) {
      let k = j + 1;
      while (k < src.length && !(src[k] === q && src[k - 1] !== "\\")) k++;
      parts.push(src.slice(j, k + 1));
      let m = k + 1;
      while (/\s/.test(src[m])) m++;
      if (src[m] === "+") {
        let n = m + 1;
        while (/\s/.test(src[n])) n++;
        if (src[n] === "'" || src[n] === '"') { j = n; continue; }
      }
      return { kind: "string-concat", text: parts.join(" + ") };
    }
  }
  // Bare identifier (e.g. SEARCH_ICON) up to the statement-ending `;`.
  let j = i;
  while (j < src.length && src[j] !== ";") j++;
  return { kind: "identifier", text: src.slice(i, j).trim() };
}

// Does this file define `name` as a same-file constant, and if so, does
// THAT definition contain a `${` interpolation?
function definitionHasInterpolation(src, name) {
  const re = new RegExp(`\\b(?:const|let)\\s+${name}\\s*=([\\s\\S]{0,4000}?);`, "m");
  const m = re.exec(src);
  if (!m) return { found: false, unsafe: false };
  return { found: true, unsafe: m[1].includes("${") };
}

for (const { file, pattern } of SITES) {
  const path = join(ROOT, file);
  const src = readFileSync(path, "utf8"); // utf8, not shell text tools — this
  // codebase has at least one file (content/indexer.js, a NUL-byte separator
  // used deliberately as a dedupe key delimiter) that shell `grep` silently
  // treats as binary and skips; Node's fs handles embedded \0 in a string
  // fine, so reading here rather than shelling out avoids that trap.
  const m = pattern.exec(src);
  if (!m) { t(`${file}: known innerHTML site still present`, false, `pattern not found — line drifted or was removed; update SITES`); continue; }
  const eq = src.indexOf("=", m.index + m[0].length - 1);
  const rhs = captureRhs(src, eq);

  if (rhs.kind === "identifier") {
    const def = definitionHasInterpolation(src, rhs.text);
    t(`${file}: ${rhs.text} is a same-file constant`, def.found, `couldn't find "const/let ${rhs.text} ="`);
    t(`${file}: ${rhs.text}'s definition has no \${} interpolation`, def.found && !def.unsafe);
  } else {
    t(`${file}: innerHTML RHS (${rhs.kind}) has no \${} interpolation`, !rhs.text.includes("${"), rhs.text.slice(0, 80));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log("\nFAILED:"); failed.forEach((l) => console.log("  " + l)); }
process.exitCode = fail ? 1 : 0;
