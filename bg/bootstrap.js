/**
 * Tvara background worker — first run: installing is the go signal.
 *
 * Split out of bg.js. Loaded by bg.js via importScripts (Chrome) or listed
 * as a background script by tools/pack.mjs (Firefox). Either way this shares
 * ONE global scope with the rest of the worker: what is declared here is
 * callable from every other module, exactly as when this was one file.
 */
"use strict";

/* Installing IS the go signal. Nothing below waits for a chat site to be
   opened or for a button to be pressed: the allowance readings, the plan on
   each account and the archive all start from here, because an extension whose
   panel is empty until the user stumbles onto the right tab reads as broken.
   Readings first — they land in seconds and they are what the popup draws;
   the archive pass takes minutes and owns its own resume. */
const BG_BOOTSTRAP = "lct-bootstrap-v1";
let bootstrapRunning = null;

async function firstRunBootstrap(reason) {
  // wake() runs as the worker starts and onInstalled follows just behind it.
  // They must share one pass, or a fresh profile can launch two archive scans.
  if (bootstrapRunning) return bootstrapRunning;
  const run = (async () => {
    let ran = false;
    let ranVersion = "";
    try {
      const held = (await chrome.storage.local.get(BG_BOOTSTRAP))[BG_BOOTSTRAP];
      ran = !!(held && held.at);
      ranVersion = String((held && held.version) || "");
    } catch { /* storage unavailable — treat as never run */ }
    let version = "";
    try { version = String(chrome.runtime.getManifest().version || ""); } catch { /* no manifest */ }

    /* An install overrides the flag — a reinstall wipes storage anyway, and an
       upgrade from a build without this must still get it. But pressing Reload
       on an unpacked extension is ALSO reported as an install, and storage
       survives it, so every reload started the whole sweep again: the panel
       went back to "Capturing 35 of 498" on a browser that already held them.
       The version is what tells the two apart. Still runs when the archive is
       empty, so a first pass that failed is not left stuck. */
    if (ran && reason !== "install") return { status: "already" };
    if (ran && reason === "install" && version && ranVersion === version) {
      let holds;
      try { holds = (await stats()).chats || 0; } catch { holds = 0; }
      if (holds > 0) return { status: "already" };
    }
    try { await chrome.storage.local.set({ [BG_BOOTSTRAP]: { at: Date.now(), reason, version } }); }
    catch { /* dead context */ }

    /* The allowance dial and archive are independent. Waiting for an
       unauthenticated provider to time out before starting the archive made a
       newly installed extension look empty for far too long. Both begin now;
       each writes progress as soon as it has a result. */
    const [quota, archive] = await Promise.allSettled([
      quotaSweep("install"),
      autoSyncEnabled().then((enabled) => enabled
        ? autoSyncTick({ skipQuota: true })
        : { status: "disabled" })
    ]);
    return { status: "done", quota: quota.status, archive: archive.status };
  })();
  bootstrapRunning = run;
  try { return await run; }
  finally { if (bootstrapRunning === run) bootstrapRunning = null; }
}
