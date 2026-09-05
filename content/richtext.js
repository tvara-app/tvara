/**
 * Tvara — code and maths rendering for archived message text.
 *
 * Everything here builds nodes with createElement/textContent. No innerHTML on
 * any path that touches message content, and no external library: the extension
 * CSP blocks CDNs, and a highlighter that only works online is not one.
 */
(() => {
  "use strict";

  /* ---------- code ---------- */

  const KEYWORDS = new Set((
    // JS/TS
    "await async break case catch class const continue debugger default delete do else enum export extends " +
    "false finally for from function get if implements import in instanceof interface let new null of private " +
    "protected public return set static super switch this throw true try type typeof undefined var void while yield " +
    // Python / Ruby / shell-ish
    "and as assert def del elif except global is lambda nonlocal not or pass raise with elsif end nil unless until " +
    // C-family / Go / Rust / Java
    "bool byte char do double else float go int impl fn func let long mut pub short struct trait union unsigned " +
    "using namespace template virtual override final match where"
  ).split(" "));

  const SPAN = (cls, text) => {
    const s = document.createElement("span");
    s.className = cls;
    s.textContent = text;
    return s;
  };

  /** Token-colour `text` into `host`. One tokenizer for every language: the
   *  categories that carry meaning at a glance are the same everywhere. */
  function highlight(host, text, lang) {
    const src = String(text || "");
    const hash = /^(py|python|rb|ruby|sh|bash|zsh|yaml|yml|toml|ini|r|jl)$/i.test(String(lang || ""));
    let at = 0, plain = "";
    const flush = () => { if (plain) { host.appendChild(document.createTextNode(plain)); plain = ""; } };
    const push = (cls, s) => { flush(); host.appendChild(SPAN(cls, s)); };

    while (at < src.length) {
      const c = src[at], next = src[at + 1];

      // comments
      if ((c === "/" && next === "/") || (hash && c === "#") || (c === "-" && next === "-" && hash)) {
        const end = src.indexOf("\n", at);
        push("lct-tok-com", src.slice(at, end < 0 ? src.length : end));
        at = end < 0 ? src.length : end;
        continue;
      }
      if (c === "/" && next === "*") {
        const end = src.indexOf("*/", at + 2);
        push("lct-tok-com", src.slice(at, end < 0 ? src.length : end + 2));
        at = end < 0 ? src.length : end + 2;
        continue;
      }
      // strings, escape-aware
      if (c === '"' || c === "'" || c === "`") {
        let i = at + 1;
        while (i < src.length && src[i] !== c) { if (src[i] === "\\") i++; i++; }
        push("lct-tok-str", src.slice(at, Math.min(i + 1, src.length)));
        at = i + 1;
        continue;
      }
      // numbers
      if (c >= "0" && c <= "9") {
        let i = at;
        while (i < src.length && /[0-9a-fx._]/i.test(src[i])) i++;
        push("lct-tok-num", src.slice(at, i));
        at = i;
        continue;
      }
      // words
      if (/[A-Za-z_$]/.test(c)) {
        let i = at;
        while (i < src.length && /[\w$]/.test(src[i])) i++;
        const word = src.slice(at, i);
        if (KEYWORDS.has(word)) push("lct-tok-kw", word);
        else if (src[i] === "(") push("lct-tok-fn", word);
        else plain += word;
        at = i;
        continue;
      }
      plain += c;
      at++;
    }
    flush();
  }

  /* A run of lines that is code but was pasted without fences — the common case
     in a chat, and the reason a message could arrive as forty one-line
     paragraphs. Structural signals only; prose about code must not match. */
  // Weak: plausible inside a block. Strong: could not be prose.
  const CODEY = /[;{}]\s*$|^\s*(?:import|export|const|let|var|function|def|class|public|private|package|#include)\b|^\s{2,}\S|=>|::|\)\s*\{|\w+\.\w+\(/;
  const STRONG = /[;{}]\s*$|=>|::|^\s*(?:import|export|const|let|var|function|def|class|#include)\b|\w+\.\w+\(/;

  function looksLikeCode(line) {
    const t = String(line || "");
    if (!t.trim() || t.trim().length > 400) return false;
    return CODEY.test(t);
  }

  /* A block needs one line that prose could not produce. Without this, "for
     example" and "class of problems" turned paragraphs into code. */
  const strongCode = (line) => STRONG.test(String(line || ""));

  /** <pre><code> with the language stamped and the body coloured. */
  function codeBlock(host, text, lang) {
    const pre = document.createElement("pre");
    pre.className = "lct-code";
    const code = document.createElement("code");
    if (lang) { code.dataset.lctLang = String(lang).slice(0, 24); pre.dataset.lctLang = code.dataset.lctLang; }
    /* Colour costs a pass over every character and a node per token. On a
       whole-file answer that is thousands of nodes for a block nobody reads
       word by word, so past a point the text goes in plain. */
    if (text.length > 20000) code.textContent = text;
    else highlight(code, text, lang);
    pre.appendChild(code);
    host.appendChild(pre);
    return pre;
  }

  /* ---------- maths ---------- */

  const GREEK = {
    alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", zeta: "ζ", eta: "η", theta: "θ",
    iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ",
    tau: "τ", upsilon: "υ", phi: "φ", chi: "χ", psi: "ψ", omega: "ω",
    Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω"
  };
  const OPS = {
    times: "×", cdot: "⋅", div: "÷", pm: "±", mp: "∓", leq: "≤", le: "≤", geq: "≥", ge: "≥",
    neq: "≠", ne: "≠", approx: "≈", equiv: "≡", sim: "∼", propto: "∝", infty: "∞",
    sum: "∑", prod: "∏", int: "∫", partial: "∂", nabla: "∇", forall: "∀", exists: "∃",
    in: "∈", notin: "∉", subset: "⊂", subseteq: "⊆", cup: "∪", cap: "∩", emptyset: "∅",
    rightarrow: "→", to: "→", leftarrow: "←", Rightarrow: "⇒", leftrightarrow: "↔", mapsto: "↦",
    ldots: "…", cdots: "⋯", angle: "∠", perp: "⊥", parallel: "∥", degree: "°", sqrt: "√",
    /* The ones a transformer answer is made of, and none of them were here:
       an unknown command renders as its own name, so "QK^\\top" came out as
       "QK^top" and "\\odot" as the word. */
    top: "⊤", odot: "⊙", oplus: "⊕", otimes: "⊗", circ: "∘", ast: "∗", star: "⋆",
    langle: "⟨", rangle: "⟩", lVert: "‖", rVert: "‖", "|": "∣", ll: "≪", gg: "≫",
    subseteqq: "⊆", supset: "⊃", setminus: "∖", exp: "exp", log: "log", min: "min", max: "max"
  };
  // Letter styles. \mathbb{R} is the real numbers, not the word "mathbbR".
  const VARIANTS = {
    mathbb: "double-struck", mathcal: "script", mathfrak: "fraktur",
    mathsf: "sans-serif", mathtt: "monospace", mathit: "italic",
    boldsymbol: "bold", bm: "bold"
  };
  // Spacing commands: real in TeX, meaningless as glyphs.
  const SPACERS = /^(,|;|!|:|quad|qquad|\s|thinspace|medspace|thickspace|\\)$/;
  const MATHML = "http://www.w3.org/1998/Math/MathML";
  const mel = (name) => document.createElementNS(MATHML, name);
  const leaf = (name, text) => { const e = mel(name); e.textContent = text; return e; };

  function tokenize(tex) {
    const out = [];
    const src = String(tex || "");
    for (let i = 0; i < src.length;) {
      const c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === "\\") {
        const m = /^\\([A-Za-z]+|.)/.exec(src.slice(i));
        if (!m) { i++; continue; }
        out.push({ t: "cmd", v: m[1] });
        i += m[0].length;
        continue;
      }
      if (c === "{" || c === "}" || c === "^" || c === "_") { out.push({ t: c }); i++; continue; }
      if (c >= "0" && c <= "9") {
        let j = i;
        while (j < src.length && ((src[j] >= "0" && src[j] <= "9") || src[j] === ".")) j++;
        out.push({ t: "num", v: src.slice(i, j) });
        i = j;
        continue;
      }
      if (/[A-Za-z]/.test(c)) { out.push({ t: "id", v: c }); i++; continue; }
      out.push({ t: "op", v: c });
      i++;
    }
    return out;
  }

  /* Recursive descent over the subset that actually turns up in a chat:
     fractions, roots, powers, indices, greek and the common operators.
     Anything unrecognised is emitted verbatim rather than dropped. */
  function parse(tokens, stopAtBrace) {
    const row = mel("mrow");
    while (tokens.length) {
      const tok = tokens.shift();
      if (tok.t === "}") { if (stopAtBrace) return row; continue; }
      let node = null;
      if (tok.t === "{") node = parse(tokens, true);
      else if (tok.t === "num") node = leaf("mn", tok.v);
      else if (tok.t === "id") node = leaf("mi", tok.v);
      else if (tok.t === "op") node = leaf("mo", tok.v);
      else if (tok.t === "cmd") {
        const name = tok.v;
        if (name === "frac" || name === "dfrac" || name === "tfrac") {
          const f = mel("mfrac");
          f.append(argOf(tokens), argOf(tokens));
          node = f;
        } else if (name === "sqrt") {
          const s = mel("msqrt");
          s.append(argOf(tokens));
          node = s;
        } else if (GREEK[name]) node = leaf("mi", GREEK[name]);
        else if (OPS[name]) node = leaf("mo", OPS[name]);
        else if (/^(left|right)$/.test(name)) { const d = tokens.shift(); node = leaf("mo", (d && d.v) || ""); }
        else if (/^(text|mathrm|mathbf|operatorname)$/.test(name)) node = wrapText(tokens);
        else if (VARIANTS[name]) {
          /* mathvariant styles a TOKEN, not a row: set on the <mrow> a braced
             argument produces, Chrome ignores it and \mathbb{R} renders as an
             ordinary R. Reach the single letter inside when there is one. */
          const arg = argOf(tokens);
          const only = arg.childNodes.length === 1 ? arg.firstChild : null;
          node = only && only.setAttribute ? only : arg;
          if (node.setAttribute) node.setAttribute("mathvariant", VARIANTS[name]);
        } else if (name === "begin") {
          node = environment(tokens, envName(tokens));
        } else if (name === "end") {
          envName(tokens);                 // consume the name; the row is done
          continue;
        } else if (SPACERS.test(name)) node = leaf("mspace", "");
        else node = leaf("mi", name);
      }
      if (!node) continue;
      // powers and indices bind to whatever came last
      while (tokens.length && (tokens[0].t === "^" || tokens[0].t === "_")) {
        const kind = tokens.shift().t;
        const script = mel(kind === "^" ? "msup" : "msub");
        script.append(node, argOf(tokens));
        node = script;
      }
      row.appendChild(node);
    }
    return row;
  }

  function argOf(tokens) {
    if (!tokens.length) return mel("mrow");
    if (tokens[0].t === "{") { tokens.shift(); return parse(tokens, true); }
    const tok = tokens.shift();
    if (tok.t === "num") return leaf("mn", tok.v);
    if (tok.t === "cmd") return GREEK[tok.v] ? leaf("mi", GREEK[tok.v]) : leaf("mi", OPS[tok.v] || tok.v);
    return leaf("mi", tok.v || "");
  }

  /** The name inside \begin{…} / \end{…}, consumed. */
  function envName(tokens) {
    if (!tokens.length || tokens[0].t !== "{") return "";
    tokens.shift();
    let name = "";
    while (tokens.length) {
      const t = tokens.shift();
      if (t.t === "}") break;
      name += t.v || "";
    }
    return name.replace(/\*$/, "").toLowerCase();
  }

  const FENCES = {
    bmatrix: ["[", "]"], pmatrix: ["(", ")"], vmatrix: ["|", "|"],
    Bmatrix: ["{", "}"], cases: ["{", ""]
  };

  /**
   * \begin{env} … \end{env} → an <mtable>.
   *
   * A long answer's centrepiece is usually the one construct the old parser
   * could not read at all: an aligned derivation or a matrix came out as the
   * word "begin" followed by its own letters. Rows split on \\, cells on &,
   * and a matrix keeps its brackets.
   */
  function environment(tokens, name) {
    /* Take the environment's own tokens first. A cell has to be parsed WHOLE:
       fed one token at a time, \\frac{a}{b} inside a matrix loses its arguments
       to the loop and comes out as a bare fraction bar. */
    const body = [];
    let depth = 0;
    while (tokens.length) {
      const tok = tokens.shift();
      if (tok.t === "cmd" && tok.v === "begin") depth++;
      if (tok.t === "cmd" && tok.v === "end") {
        if (depth === 0) { envName(tokens); break; }
        depth--;
      }
      body.push(tok);
    }

    const rows = [[[]]];                 // rows → cells → tokens
    let d = 0;
    for (const tok of body) {
      if (tok.t === "cmd" && tok.v === "begin") d++;
      else if (tok.t === "cmd" && tok.v === "end") d--;
      const cells = rows[rows.length - 1];
      if (d === 0 && tok.t === "cmd" && tok.v === "\\") { rows.push([[]]); continue; }
      if (d === 0 && tok.t === "op" && tok.v === "&") { cells.push([]); continue; }
      cells[cells.length - 1].push(tok);
    }

    const table = mel("mtable");
    for (const cells of rows) {
      if (cells.length === 1 && !cells[0].length) continue;      // a trailing \\
      const tr = mel("mtr");
      for (const cell of cells) {
        const td = mel("mtd");
        td.appendChild(parse(cell.slice(), false));
        tr.appendChild(td);
      }
      table.appendChild(tr);
    }

    const fence = FENCES[name];
    if (!fence) return table;
    const wrap = mel("mrow");
    if (fence[0]) wrap.appendChild(leaf("mo", fence[0]));
    wrap.appendChild(table);
    if (fence[1]) wrap.appendChild(leaf("mo", fence[1]));
    return wrap;
  }

  function wrapText(tokens) {
    const parts = [];
    if (tokens.length && tokens[0].t === "{") {
      tokens.shift();
      let depth = 1;
      while (tokens.length && depth > 0) {
        const t = tokens.shift();
        if (t.t === "{") depth++;
        else if (t.t === "}") { if (--depth === 0) break; }
        else parts.push(t.v || t.t);
      }
    }
    return leaf("mtext", parts.join(""));
  }

  /** LaTeX → MathML. Falls back to a monospace span, never to nothing. */
  function math(host, tex, display) {
    let node;
    try {
      const m = mel("math");
      if (display) m.setAttribute("display", "block");
      m.appendChild(parse(tokenize(tex)));
      node = m;
    } catch (_) {
      node = SPAN("lct-math-raw", String(tex || ""));
    }
    if (display) {
      const wrap = document.createElement("div");
      wrap.className = "lct-math-block";
      wrap.appendChild(node);
      host.appendChild(wrap);
    } else {
      host.appendChild(node);
    }
    return node;
  }

  /* Inline $…$ and \(…\) split out of a line. Returns [{text}|{tex}] parts. */
  const INLINE_MATH = /\\\((.+?)\\\)|(?<![\\$])\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/g;

  function splitInlineMath(text) {
    const src = String(text || "");
    const out = [];
    let at = 0, m;
    INLINE_MATH.lastIndex = 0;
    while ((m = INLINE_MATH.exec(src))) {
      if (m.index > at) out.push({ text: src.slice(at, m.index) });
      out.push({ tex: m[1] !== undefined ? m[1] : m[2] });
      at = m.index + m[0].length;
    }
    if (at < src.length) out.push({ text: src.slice(at) });
    return out;
  }

  /* ---------- reading a formula back OUT of the page ----------
   *
   * A rendered formula is not text. KaTeX writes the MathML and the visual
   * glyphs side by side, so textContent returns both and a clean
   * "Attention(Q,K,V) = softmax(QKᵀ/√dₖ)V" comes back as a smear of doubled
   * symbols. MathJax's SVG output is worse: textContent is EMPTY, so a display
   * equation is not mangled, it is silently gone — which is what a transformer
   * answer looked like in the archive, every equation missing and the prose
   * around them intact.
   *
   * Both renderers keep the source they were given. Take that, put it back in
   * $…$ so it survives storage as the LaTeX it was, and every reader — the
   * preview, search, export — gets a formula it can render again.
   */
  /* The model thinking out loud is not the message. Every host renders it
     inside the turn — Gemini's "Formulating the Transformer Components",
     ChatGPT's reasoning summary, DeepSeek's "Thought for 12 seconds" — so it
     lands in front of the answer in every snippet and every archived copy, and
     on a fallback selector it can even draw a tick of its own. Attributes and
     element names only: nothing here reads the visible words, because what a
     block SAYS is not what it IS. */
  /* Thinking, and only thinking. Narrow on purpose: this list is also allowed
     to drop a whole TURN, and a host that named its turn wrapper
     "reasoning-turn" would empty the map. `.ds-think-content` is DeepSeek's,
     and it is the one hook on that host that is not a per-deploy hash. */
  const THINK_SEL = [
    "model-thoughts",
    '[data-test-id*="thought" i]', '[data-testid*="thought" i]',
    '[data-testid*="thinking" i]', '[data-testid*="reasoning" i]',
    '[class*="thinking" i]', '[class*="reasoning" i]', '[class*="thoughts" i]',
    '[class*="ds-think" i]',
    '[aria-label^="Thinking" i]', '[aria-label^="Thoughts" i]',
    '[aria-label^="Show thinking" i]'
  ].join(",");

  /* …and everything else in a turn that nobody typed: the copy button, the
     retry button, the action bar under an answer, the code block's own toolbar.
     Broader than THINK_SEL and used ONLY on text, where the worst case is a
     word less rather than a message less. */
  const SKIP_SEL = THINK_SEL + "," + [
    "button", '[role="button"]',
    '[role="group"][aria-label*="action" i]',
    ".ds-icon-button", ".ds-atom-button", ".ds-icon",
    '[class*="banner-wrap" i]',
    '[aria-label*="copy" i]', '[aria-label*="regenerate" i]', '[aria-label*="retry" i]'
  ].join(",");

  const MATH_SEL = ".katex, .katex-display, mjx-container, math, [data-latex], [data-tex]";
  const DISPLAY_SEL = ".katex-display, mjx-container[display=\"true\"], math[display=\"block\"]";

  /** The LaTeX a rendered node was built from, or "" if it kept none. */
  function mathSource(el) {
    if (!el || !el.querySelector) return "";
    const attr = el.getAttribute && (el.getAttribute("data-latex") || el.getAttribute("data-tex"));
    if (attr) return String(attr).trim();
    // KaTeX and MathJax's assistive MathML both carry the original TeX here.
    const ann = el.querySelector('annotation[encoding="application/x-tex"], annotation[encoding="TeX"]');
    if (ann && ann.textContent.trim()) return ann.textContent.trim();
    // MathJax v2 left the source in a script tag beside the render.
    const script = el.querySelector('script[type^="math/tex"]');
    if (script && script.textContent.trim()) return script.textContent.trim();
    const label = el.getAttribute && el.getAttribute("aria-label");
    if (label && label.trim()) return label.trim();
    /* No source kept. The MathML text is not LaTeX, but it is the symbols in
       reading order, which beats an empty line where an equation was. */
    const mml = el.matches && el.matches("math") ? el : el.querySelector("math");
    return mml ? (mml.textContent || "").replace(/\s+/g, " ").trim() : "";
  }

  const isDisplayMath = (el) => {
    try { return !!(el.matches && el.matches(DISPLAY_SEL)); } catch { return false; }
  };

  /**
   * An element's text, with every formula written back as LaTeX.
   *
   * Walks rather than reading textContent, because the whole point is to stop
   * at a math container and take its source instead of its rendering.
   */
  /* ---------- a drawn diagram ----------
   *
   * Mermaid, Graphviz, PlantUML and friends render to an inline <svg>, and
   * walking one returns its node labels welded together — "StartLoad dataDone"
   * — which is the KaTeX problem again in another costume. Every one of them
   * was given SOURCE, and the hosts that keep it keep it in the same few
   * places. Take that; failing which, say a diagram is here rather than
   * spilling its labels into the middle of a sentence.
   */
  const DIAGRAM_SEL = '.mermaid, [class*="mermaid" i], [data-diagram], [data-diagram-source]';

  /** Is this <svg> a drawing, or a 16px icon? Structure only. */
  function svgIsDiagram(el) {
    try {
      if (el.querySelector("text, tspan, foreignObject")) return true;
      if (el.childElementCount >= 6) return true;
      const w = Number(el.getAttribute("width")) || 0;
      const h = Number(el.getAttribute("height")) || 0;
      return w >= 120 || h >= 120;
    } catch { return false; }
  }

  /** The source a diagram was drawn from, and what language it is in. */
  function diagramSource(el) {
    const attr = el.getAttribute && (el.getAttribute("data-diagram-source")
      || el.getAttribute("data-source") || el.getAttribute("data-code")
      || el.getAttribute("data-mermaid"));
    if (attr && String(attr).trim()) return { source: String(attr).trim(), kind: "mermaid" };
    /* The block that was replaced, still in the DOM behind a Code/Diagram
       toggle — which is how ChatGPT and Claude both ship it. */
    const box = el.closest && el.closest('figure, [class*="code" i], [class*="diagram" i]');
    const pre = box && box.querySelector("pre");
    if (pre && (pre.textContent || "").trim()) {
      return {
        source: (pre.textContent || "").replace(/\s+$/, ""),
        kind: codeLang(pre) || "mermaid",
        node: pre                       // so the walk writes it once, not twice
      };
    }
    return null;
  }

  /** The language a highlighter left on a code block, if it left one. */
  // Class names that say "this is code", not which language it is.
  const NOT_A_LANG = new Set(["hljs", "code", "pre", "highlight", "language", "lang",
    "block", "codeblock", "code-block", "prettyprint", "linenums", "shiki", "prism",
    "line-numbers", "token", "content", "text"]);

  function codeLang(pre) {
    const holder = (pre.querySelector && pre.querySelector("code")) || pre;
    const from = (holder.getAttribute && (holder.getAttribute("data-language")
      || holder.getAttribute("data-lang") || holder.getAttribute("lang"))) || "";
    if (from) return String(from).toLowerCase().slice(0, 20);
    const cls = String((holder.className && holder.className.baseVal) || holder.className || "");
    const m = /(?:language|lang|highlight)[-_]([A-Za-z0-9+#]+)/.exec(cls);
    if (m) return m[1].toLowerCase();
    /* highlight.js writes the bare name beside its own marker — "hljs python",
       "hljs language-none". Any class that is not one of its bookkeeping words
       is the language, and a wrong guess here costs a colour, not a word. */
    if (/\bhljs\b/.test(cls)) {
      for (const one of cls.split(/\s+/)) {
        const name = one.toLowerCase();
        if (name && !NOT_A_LANG.has(name) && /^[a-z0-9+#]{1,20}$/.test(name)) return name;
      }
    }
    /* DeepSeek names the language in the block's own toolbar rather than on the
       element. One word, from a strip that holds nothing else — the buttons
       beside it are skipped everywhere text is read. */
    /* …or the strip above the block, which is where the hosts that do not mark
       the element put it: DeepSeek's banner, Gemini's decoration bar. */
    const box = pre.closest && pre.closest('[class*="code-block" i], [class*="code-container" i], figure');
    const banner = box && box.querySelector(
      '[class*="banner" i], [class*="decoration" i], [class*="header" i], [class*="toolbar" i]');
    if (!banner) return "";
    /* The toolbar's OWN text, not its children's: the Copy button sits in the
       same strip, and reading the strip whole named the language "rustcopy". */
    let label = "";
    for (const n of banner.childNodes) if (n.nodeType === 3) label += n.nodeValue;
    const word = /^\s*([A-Za-z0-9+#]{1,20})/.exec(label);
    return word ? word[1].toLowerCase() : "";
  }

  /** A code block, fenced, so it survives storage AS code. */
  function fencedCode(pre) {
    const code = (pre.textContent || "").replace(/\s+$/, "");
    if (!code.trim()) return "";
    return "\n```" + codeLang(pre) + "\n" + code + "\n```\n";
  }

  function textWithMath(root) {
    if (!root) return "";
    /* The block itself. extractText() hands each <pre> here on its own, and
       walking its children finds no <pre> to fence — so a hundred lines of
       Python reached the archive as bare prose and came back out of it as
       prose: no fence, no colour, wrapped at whatever width. */
    if (root.tagName === "PRE") return fencedCode(root).trim();
    const out = [];
    /* Code is held out of the tidy-up below: collapsing runs of spaces is right
       for prose and wrong for a Python block, where the indentation IS the
       program. Parked under a marker no page text contains, put back last. */
    const parked = [];
    const MARK = "\uE000";        // private use area: no page text carries it
    const park = (text) => MARK + (parked.push(text) - 1) + MARK;
    /* A rendered diagram and the <pre> it was drawn from are BOTH in the DOM
       when the host keeps a Code/Diagram toggle. Whichever the walk reaches
       first emits the source; the other must not emit it a second time. */
    const emitted = new Set();
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === 3) { out.push(child.nodeValue); continue; }
        if (child.nodeType !== 1) continue;
        // The visual half of a KaTeX render is marked hidden from screen
        // readers precisely because the MathML beside it says the same thing.
        if (child.getAttribute && child.getAttribute("aria-hidden") === "true" &&
            child.closest && child.closest(MATH_SEL)) continue;
        let isMath;
        try { isMath = !!(child.matches && child.matches(MATH_SEL)); } catch { isMath = false; }
        if (isMath) {
          const tex = mathSource(child);
          if (tex) out.push(isDisplayMath(child) ? `\n$$${tex}$$\n` : ` $${tex}$ `);
          continue;
        }
        /* A drawing, not a paragraph. Checked before PRE, because a rendered
           mermaid block is a <svg> sitting where the <pre> used to be. */
        const tag = String(child.tagName || "").toUpperCase();
        let drawn;
        try {
          drawn = (tag === "SVG" && svgIsDiagram(child)) ||
            !!(child.matches && child.matches(DIAGRAM_SEL));
        } catch { drawn = false; }
        if (drawn) {
          const found = diagramSource(child);
          if (!found) { out.push("\n![diagram]()\n"); continue; }
          if (found.node && emitted.has(found.node)) continue;   // already written out
          if (found.node) emitted.add(found.node);
          out.push(park("\n```" + (found.kind || "") + "\n" + found.source + "\n```\n"));
          continue;
        }
        if (child.tagName === "PRE") {
          if (emitted.has(child)) continue;
          emitted.add(child);
          const fenced = fencedCode(child);
          if (fenced) out.push(park(fenced));
          continue;
        }
        // A picture IS the message often enough to be worth keeping as one.
        if (child.tagName === "IMG") {
          const alt = (child.getAttribute("alt") || "").trim();
          // srcset only, no src: a responsive image, and the first candidate is
          // an address like any other. Without this the picture read as absent.
          const src = child.getAttribute("src")
            || String(child.getAttribute("srcset") || "").split(",")[0].trim().split(/\s+/)[0]
            || "";
          // A data: URI can be a megabyte of base64. Keep the fact, not the file.
          out.push(`\n![${alt || "image"}](${/^data:/.test(src) && src.length > 512 ? "" : src})\n`);
          continue;
        }
        let skip;
        /* Chrome, unless it is holding a picture. These hosts wrap an image in
           a button — <button aria-label="Open image: shot.png"><img …> — so a
           blanket skip of buttons throws the message away with its own toolbar.
           An icon button holds an <svg>, never an <img>. */
        try {
          skip = !!(child.matches && child.matches(SKIP_SEL)) &&
            !(child.querySelector && child.querySelector("img"));
        } catch { skip = false; }
        if (skip) continue;
        walk(child);
      }
    };
    try { walk(root); } catch { return (root.textContent || "").trim(); }
    return out.join("")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .replace(/\uE000(\d+)\uE000/g, (_, i) => parked[Number(i)] || "");
  }

  self.LCTRichText = {
    highlight, codeBlock, looksLikeCode, strongCode, math, splitInlineMath,
    mathSource, textWithMath, fencedCode, codeLang, diagramSource, svgIsDiagram,
    MATH_SEL, DISPLAY_SEL, SKIP_SEL, THINK_SEL, DIAGRAM_SEL
  };
})();
