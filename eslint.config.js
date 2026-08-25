import js from "@eslint/js";
import globals from "globals";
import noUnsanitized from "eslint-plugin-no-unsanitized";
import security from "eslint-plugin-security";

const SECURITY_RULES = {
  "no-unsanitized/method": "error",
  "no-unsanitized/property": "error",
  "security/detect-eval-with-expression": "error",
  "security/detect-unsafe-regex": "error",
  // Both browser code (no fs/child_process) and this codebase's object-index
  // style (e.g. PAID[msg.type]) make these two rules pure noise here.
  "security/detect-non-literal-fs-filename": "off",
  "security/detect-object-injection": "off",
};

// The codebase's own established convention: `catch (_) {}` / `catch {}` for
// deliberate, usually comment-explained no-ops, and `_`-prefixed unused
// params. Match the linter to that idiom instead of fighting it.
const BASE_RULES = {
  "no-empty": ["error", { allowEmptyCatch: true }],
  "no-unused-vars": ["error", { args: "after-used", argsIgnorePattern: "^_", caughtErrors: "all", caughtErrorsIgnorePattern: "^_" }],
};

export default [
  js.configs.recommended,
  {
    // Extension runtime: isolated-world content scripts, the service worker,
    // lib/*, popup, diag, and the standalone pages. These have chrome.* access.
    files: [
      "content/**/*.js",
      "!content/inject/**",
      "lib/**/*.js",
      "popup/**/*.js",
      "diag/**/*.js",
      "bg.js",
      "recall-page.js",
      "welcome.js",
    ],
    plugins: { "no-unsanitized": noUnsanitized, security },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      // `module`: a couple of lib/*.js files carry a guarded, harmless
      // `typeof module !== "undefined" && module.exports` UMD-style export
      // for dual browser/Node use — never thrown, just needs the global known.
      globals: { ...globals.browser, chrome: "readonly", self: "writable", module: "readonly", importScripts: "readonly" },
    },
    rules: { ...SECURITY_RULES, ...BASE_RULES },
  },
  {
    // MAIN-world injectors run inside the page's own JS context — no chrome.*
    // there by design; keeping it out of globals catches an accidental
    // chrome.* reference that would silently no-op at runtime instead of
    // throwing where a dev would notice.
    files: ["content/inject/**/*.js"],
    plugins: { "no-unsanitized": noUnsanitized, security },
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "script",
      globals: { ...globals.browser },
    },
    rules: { ...SECURITY_RULES, ...BASE_RULES },
  },
  {
    // Node-side: hand-rolled tests, dev tools, the entitlement worker.
    files: ["test/**/*.mjs", "tools/**/*.mjs", "server/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      ...BASE_RULES,
      // Test fixtures deliberately construct malicious payloads (XSS strings,
      // forged tokens, oversized JSON) to prove the extension rejects them —
      // the same patterns that must stay `error` in shipped code are the
      // entire point of these files.
      "no-unsanitized/method": "off",
      "no-unsanitized/property": "off",
      "security/detect-eval-with-expression": "off",
      "security/detect-non-literal-fs-filename": "off",
      "security/detect-child-process": "off",
      "security/detect-unsafe-regex": "off",
      // page.evaluate()/worker.evaluate() callback bodies run in the browser
      // realm and reference that realm's globals (e.g. bg.js internals) —
      // this file's own static scope can't and shouldn't resolve those.
      "no-undef": "off",
    },
  },
  {
    /* .stryker-tmp is a mutation-testing sandbox: gitignored, so CI never sees
       it, but a stale one on a developer's disk buries `npm run lint` under
       hundreds of errors in generated copies of files that are already linted
       in place. Local and CI have to give the same answer or nobody reads the
       local one. */
    ignores: ["node_modules/", "dist/", ".stryker-tmp/", "test/.work/", "test/.work-*/", "docs/**", "eslint.config.js"],
  },
];
