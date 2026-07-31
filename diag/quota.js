/**
 * Long Chat Toolkit — allowance accuracy page.
 *
 * The instrument that makes the popup's percentages falsifiable. It runs a live
 * probe of every provider, shows the figure we would draw, names the field and
 * the arithmetic behind it, and takes the number the provider's own UI is
 * showing so the two can be compared on screen.
 *
 * It exists because the old usage panel could not be checked. It counted DOM
 * nodes against a hardcoded ceiling, and there was no way for a user to tell
 * whether the number meant anything — so it drifted for months looking fine.
 * Anything we display about someone's allowance should be traceable to a source
 * they can go and look at themselves; this is where they look.
 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const LABELS = {
    chatgpt: "ChatGPT", claude: "Claude", gemini: "Gemini",
    deepseek: "DeepSeek", grok: "Grok", perplexity: "Perplexity"
  };
  const COLORS = {
    chatgpt: "#19b884", claude: "#e0805c", gemini: "#4a8ef6",
    deepseek: "#7b82fd", grok: "#dcdce4", perplexity: "#1fadc6"
  };

  // Where a disagreement stops being rounding and starts being a bug. Providers
  // round their own displays, and a couple of tokens land between our read and
  // the user's glance, so 1pp is noise. Past 5pp we are reading the wrong field
  // and should say so plainly rather than call it close.
  const MATCH_PP = 1;
  const NEAR_PP = 5;

  let lastReport = null;

  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (reply) => {
          void chrome.runtime.lastError;
          resolve(reply || null);
        });
      } catch (_) { resolve(null); }
    });
  }

  function agoLabel(at) {
    if (!at) return "never";
    const secs = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (secs < 45) return "just now";
    if (secs < 5400) return `${Math.round(secs / 60)} min ago`;
    const hrs = secs / 3600;
    if (hrs < 36) return `${Math.round(hrs)} h ago`;
    return `${Math.round(hrs / 24)} d ago`;
  }

  function timeLabel(at) {
    if (!at) return "";
    const d = new Date(at);
    return Number.isFinite(d.getTime()) ? d.toLocaleString() : "";
  }

  /** One provider's card. */
  function card(entry) {
    const node = $("tpl-platform").content.cloneNode(true);
    const root = node.querySelector(".card");
    const id = entry.id;

    root.querySelector(".name").textContent = LABELS[id] || id;
    root.querySelector(".dot").style.color = COLORS[id] || "#888";

    const shown = entry.shown || null;
    const probe = entry.probe || {};
    const hits = (probe.working || []).length;

    /* The verdict states which of three situations this provider is in, and the
       middle one is the one that used to get faked. "Publishes nothing" is a
       real answer: Gemini has no readable allowance endpoint and Google states
       no message ceiling, so there is nothing to show and we say so. */
    const verdict = root.querySelector(".verdict");
    if (shown && shown.pctLeft !== null && shown.pctLeft !== undefined) {
      verdict.textContent = "reporting";
      verdict.className = "verdict good";
    } else if (probe.error || probe.note === "not signed in or provider unreachable") {
      verdict.textContent = "not signed in";
      verdict.className = "verdict none";
    } else if (!hits) {
      verdict.textContent = "publishes nothing readable";
      verdict.className = "verdict none";
    } else {
      verdict.textContent = "endpoint found, no figure yet";
      verdict.className = "verdict none";
    }

    const pct = root.querySelector(".pct");
    const pctCap = root.querySelector(".pct-cap");
    if (shown && shown.pctLeft !== null && shown.pctLeft !== undefined) {
      pct.textContent = shown.pctLeft + "%";
    } else {
      pct.textContent = "—";
      pct.classList.add("muted");
      pctCap.textContent = "nothing reported";
    }

    const basis = root.querySelector(".basis");
    const reset = root.querySelector(".reset");
    const age = root.querySelector(".age");
    if (shown) {
      const parts = [];
      if (shown.basis) parts.push(`derived as ${shown.basis}`);
      if (shown.remaining !== null && shown.remaining !== undefined
          && shown.limit !== null && shown.limit !== undefined) {
        parts.push(`provider figure ${shown.remaining} of ${shown.limit}`);
      }
      if (shown.unit) parts.push(`metered in ${shown.unit}s`);
      basis.textContent = parts.join(" · ");
      basis.classList.add("mono");
      reset.textContent = shown.resetAt
        ? `window resets ${timeLabel(shown.resetAt)}`
        : "no reset time reported";
      age.textContent = `read ${agoLabel(shown.observedAt || (entry.stored && entry.stored.observedAt))}`
        + (shown.source ? ` · ${shown.source === "observed" ? "from the site's own response" : "asked the provider directly"}` : "");
    } else {
      basis.textContent = probe.error
        ? `provider said: ${probe.error}`
        : (probe.note || "no allowance field found in any response");
      reset.textContent = "";
      age.textContent = "";
    }

    /* The comparison. This is the only number on the page we did not read
       ourselves, which is exactly why it is here: it is the check on everything
       else. */
    const claim = root.querySelector(".claim");
    const delta = root.querySelector(".delta");
    const compare = () => {
      const ours = shown && shown.pctLeft !== null && shown.pctLeft !== undefined ? shown.pctLeft : null;
      const theirs = claim.value === "" ? null : Number(claim.value);
      if (theirs === null || !Number.isFinite(theirs)) {
        delta.textContent = "";
        delta.className = "delta";
        return;
      }
      if (ours === null) {
        delta.textContent = `We show nothing for ${LABELS[id] || id}, and the site says ${theirs}%. `
          + "That means the provider does publish it somewhere we are not reading — worth reporting.";
        delta.className = "delta off";
        return;
      }
      const gap = Math.abs(ours - theirs);
      if (gap <= MATCH_PP) {
        delta.textContent = `Match — we show ${ours}%, the site says ${theirs}%.`;
        delta.className = "delta match";
      } else if (gap <= NEAR_PP) {
        delta.textContent = `Close — ${gap}pp apart (${ours}% vs ${theirs}%). `
          + "Within rounding if the site rounds coarsely, but worth a second look.";
        delta.className = "delta near";
      } else {
        delta.textContent = `Disagreement — ${gap}pp apart (we show ${ours}%, the site says ${theirs}%). `
          + "We are reading the wrong field. Copy the report and the endpoint list below.";
        delta.className = "delta off";
      }
      lastReport = lastReport || {};
      lastReport[id] = { ...(lastReport[id] || {}), ours, theirs, gap };
    };
    root.querySelector(".check").addEventListener("click", compare);
    claim.addEventListener("keydown", (e) => { if (e.key === "Enter") compare(); });

    /* Every candidate endpoint and what it returned. This is what turns "the
       number is wrong" into a fixable report: the shape is right there. */
    const list = root.querySelector(".ep-list");
    const endpoints = probe.endpoints || [];
    root.querySelector(".ep-count").textContent = endpoints.length
      ? `${endpoints.length} endpoint${endpoints.length === 1 ? "" : "s"} checked · ${hits} carrying an allowance`
      : "no candidate endpoints for this provider — observation only";

    for (const ep of endpoints) {
      const box = document.createElement("div");
      box.className = "ep";
      const top = document.createElement("div");
      top.className = "ep-top";
      const path = document.createElement("span");
      path.className = "ep-path";
      path.textContent = (ep.method && ep.method !== "GET" ? ep.method + " " : "") + ep.path;
      const tag = document.createElement("span");
      const found = (ep.windows || []).length;
      if (ep.skipped) { tag.className = "ep-tag miss"; tag.textContent = ep.skipped; }
      else if (ep.error) { tag.className = "ep-tag err"; tag.textContent = ep.error; }
      else if (!ep.ok) { tag.className = "ep-tag err"; tag.textContent = "HTTP " + (ep.status || "?"); }
      else if (found) { tag.className = "ep-tag hit"; tag.textContent = `${found} window${found === 1 ? "" : "s"}`; }
      else { tag.className = "ep-tag miss"; tag.textContent = "no allowance field"; }
      top.append(path, tag);
      box.append(top);

      if (ep.sample) {
        const pre = document.createElement("pre");
        // Response text never reaches here — lib/quota.js replaces every string
        // long enough to be prose with its length before this is stored.
        pre.textContent = JSON.stringify(ep.sample, null, 2);
        box.append(pre);
      }
      list.append(box);
    }

    return node;
  }

  async function run() {
    const btn = $("run");
    btn.disabled = true;
    $("status").textContent = "Asking each provider…";
    $("out").innerHTML = "";

    const report = await send({ type: "quota-diagnose" });
    btn.disabled = false;

    if (!report || !report.platforms) {
      $("status").textContent = "";
      $("out").innerHTML = "<p class=\"empty\">The extension worker did not answer. "
        + "Reload the extension and try again.</p>";
      return;
    }

    lastReport = { at: report.at };
    const frag = document.createDocumentFragment();
    for (const entry of report.platforms) frag.append(card(entry));
    $("out").replaceChildren(frag);

    const reporting = report.platforms.filter(
      (p) => p.shown && p.shown.pctLeft !== null && p.shown.pctLeft !== undefined).length;
    $("status").textContent =
      `${reporting} of ${report.platforms.length} providers published an allowance.`;
    lastReport.raw = report;
  }

  /** A paste-able report. Same redacted samples the page shows — no chat text,
   *  no tokens, no URLs with query strings. */
  function copy() {
    if (!lastReport || !lastReport.raw) {
      $("status").textContent = "Run a check first.";
      return;
    }
    const lines = ["Long Chat Toolkit — allowance accuracy report",
      "generated " + new Date().toLocaleString(), ""];
    for (const p of lastReport.raw.platforms) {
      const shown = p.shown;
      const mine = shown && shown.pctLeft !== null && shown.pctLeft !== undefined
        ? shown.pctLeft + "%" : "nothing reported";
      lines.push(`## ${LABELS[p.id] || p.id}`);
      lines.push(`  we show:      ${mine}`);
      if (lastReport[p.id] && lastReport[p.id].theirs !== undefined) {
        lines.push(`  site says:    ${lastReport[p.id].theirs}%  (gap ${lastReport[p.id].gap}pp)`);
      }
      if (shown) {
        lines.push(`  basis:        ${shown.basis || "—"}`);
        lines.push(`  reset:        ${shown.resetAt ? timeLabel(shown.resetAt) : "—"}`);
        lines.push(`  source:       ${shown.source || "—"}`);
      }
      for (const ep of (p.probe && p.probe.endpoints) || []) {
        const state = ep.skipped ? ep.skipped
          : ep.error ? ep.error
          : !ep.ok ? "HTTP " + (ep.status || "?")
          : `${(ep.windows || []).length} window(s)`;
        lines.push(`  ${(ep.method && ep.method !== "GET" ? ep.method + " " : "")}${ep.path} → ${state}`);
        if (ep.sample && (ep.windows || []).length) {
          lines.push("    " + JSON.stringify(ep.sample).slice(0, 600));
        }
      }
      lines.push("");
    }
    const text = lines.join("\n");
    navigator.clipboard.writeText(text).then(
      () => { $("status").textContent = "Report copied."; },
      () => { $("status").textContent = "Could not reach the clipboard."; }
    );
  }

  $("run").addEventListener("click", run);
  $("copy").addEventListener("click", copy);
})();
