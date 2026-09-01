/**
 * Tvara — AccountDO: the live half of the device screen.
 *
 * One instance per account (`idFromName(email_fp)`), holding one WebSocket per
 * signed-in device. When a person signs a device out from somewhere else, the
 * Worker commits the kill to D1 and then tells this object, which pushes the
 * news down the socket belonging to that device. The device raises a toast and
 * drops its token in about a second instead of waiting out an alarm.
 *
 * WHY THIS EXISTS AT ALL. docs/SESSIONS.md §4 designed this object and then
 * dropped it: an MV3 service worker is killed 30 seconds after it goes idle, so
 * holding a socket open means pinging it awake forever — a permanently resident
 * worker on every install, to shorten one licensing event. That cost is now
 * accepted deliberately; §4 records the reversal. Everything that made the
 * decision reversible held: the socket is an ACCELERATOR and never the only
 * channel, so a device that cannot reach this object still dies on its next
 * heartbeat, and this object deciding nothing is what makes that safe.
 *
 * It is not a ledger and must never become one. D1 owns who is signed in;
 * `killTargets()` commits before anything here is called. This object holds no
 * state that would be wrong to lose — every socket can drop, the object can be
 * evicted, and the only cost is that a sign-out takes the alarm's interval
 * again. Nothing here is asked whether a device is entitled.
 *
 * Nothing here authenticates either. The Worker verifies a short-lived ticket
 * BEFORE the upgrade and passes the proven fingerprints in as headers, so this
 * object never sees a signature, a licence key or an address — which is also
 * why a socket can be accepted at all: a WebSocket handshake cannot carry the
 * signed body every other route on this Worker is protected by.
 */

/* Hibernation, not a held reference. `acceptWebSocket` lets the runtime evict
   this object while its sockets stay open — a hundred idle devices then cost
   nothing between sign-outs, which is the difference between this being free
   and this being a bill. The device fingerprint rides as the socket's TAG so it
   survives that eviction; an instance field would not. */
export class AccountDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    /* The Worker announcing a commit that already happened. Internal: this
       object is not routable from outside, so there is nothing to authenticate
       here beyond the shape of the body. */
    if (url.pathname === "/announce") {
      let body = null;
      try { body = await request.json(); } catch { /* malformed */ }
      if (!body) return new Response("bad body", { status: 400 });
      this.announce(body);
      return new Response("ok");
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    /* Proven by the Worker, never read from the query string. A device can only
       ever be told about ITS OWN kill, so a tag that could be chosen would be a
       way to watch a stranger's account. */
    const devFp = String(request.headers.get("x-dev-fp") || "");
    if (!/^[a-f0-9]{32}$/.test(devFp)) return new Response("bad device", { status: 400 });

    const pair = new WebSocketPair();
    this.state.acceptWebSocket(pair[1], [devFp]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /**
   * Push what just happened.
   *
   * Two different messages, deliberately. The device that was signed out is
   * told `killed` and nothing else needs to reach it — its socket is closed
   * immediately afterwards, because a signed-out device has no business holding
   * a channel open on this account. Every OTHER device is told `changed`, which
   * says only "the list you are looking at has moved"; it carries no
   * fingerprints, so a device learns nothing about its siblings it could not
   * already ask /sessions for.
   */
  announce(body) {
    const killed = new Set(Array.isArray(body.killed) ? body.killed.map(String) : []);
    const version = Number(body.version) || 0;
    const reason = String(body.reason || "terminated").slice(0, 32);
    for (const ws of this.state.getWebSockets()) {
      let tag = "";
      try { tag = (this.state.getTags(ws) || [])[0] || ""; } catch { /* evicted mid-loop */ }
      const mine = killed.has(tag);
      try {
        ws.send(JSON.stringify(mine
          ? { type: "killed", reason, version }
          : { type: "changed", version }));
      } catch { continue; }          // already gone; the close handler cleans up
      /* 4001 is ours: a normal close would be retried by the client's backoff,
         and reconnecting a device that was just signed out is a loop. */
      if (mine) { try { ws.close(4001, "signed out"); } catch { /* already closed */ } }
    }
  }

  /* The client pings to stay alive — an MV3 worker dies at 30 seconds of
     silence and WebSocket traffic is what resets that timer. Answering is the
     entire contract; nothing a client sends is ever acted on. */
  webSocketMessage(ws, message) {
    if (typeof message === "string" && message === "ping") {
      try { ws.send('{"type":"pong"}'); } catch { /* closing */ }
    }
  }

  webSocketError(ws) {
    try { ws.close(1011, "error"); } catch { /* already closed */ }
  }

  webSocketClose(ws, code, reason, wasClean) {
    void code; void reason; void wasClean;
    try { ws.close(); } catch { /* already closed */ }
  }
}
