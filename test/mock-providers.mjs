/* A scripted stand-in for the sync providers.
 *
 * The multi-account rules are all about WHO answered a request, and no real
 * account can express "and now the same browser is a different person" on
 * demand. So the providers are scripted: /__control swaps the signed-in
 * account, edits a chat list, or signs a platform out, and the next pass sees
 * exactly that.
 *
 * Shapes are the real ones — ChatGPT's mapping/current_node branch, Claude's
 * organisation list, DeepSeek's data.list envelope — because the adapters parse
 * them for real and a mock that agreed only in spirit would test nothing. */
import { createServer } from "node:http";

export function startProviders(port = 8931) {
  /* Each platform: which account is signed in, and what each account holds.
     `chats` are [{ id, title, createdAt, updatedAt, msgs:[{r,t}] }]. */
  const state = {
    chatgpt: { signedIn: true, current: "", accounts: {} },
    claude:  { signedIn: true, orgs: [] },
    deepseek:{ signedIn: true, current: "", accounts: {} },
    grok:    { signedIn: false, current: "", accounts: {} },
    perplexity: { signedIn: false, current: "", accounts: {} },
    gemini:  { signedIn: false, current: "", pinned: [], accounts: {} }
  };

  const calls = [];           // every path served, for "did it re-download?" assertions
  const json = (res, body, status = 200) => {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "cache-control": "no-store"
    });
    res.end(text);
  };
  const deny = (res) => json(res, { error: "unauthorized" }, 401);

  /** First page or later? The adapters probe `offset=` and `page=` spellings;
   *  both are honoured so the paging prober settles instead of degrading. */
  const firstPage = (q) => {
    const offset = q.get("offset");
    const page = q.get("page");
    if (offset !== null) return Number(offset) === 0;
    if (page !== null) return Number(page) === 0 || Number(page) === 1;
    return true;
  };

  const chatsOf = (platform, account) => {
    const holder = state[platform].accounts[account];
    return (holder && holder.chats) || [];
  };

  /* ChatGPT hands the whole conversation back as a node map, and the adapter
     walks current_node up the parent chain. Build a real chain. */
  const chatgptConv = (chat) => {
    const mapping = {};
    let parent = null, last = null;
    (chat.msgs || []).forEach((m, i) => {
      const nid = `${chat.id}-n${i}`;
      mapping[nid] = {
        id: nid, parent, children: [],
        message: {
          id: nid, author: { role: m.r }, content: { parts: [m.t] },
          create_time: Math.floor((chat.createdAt || Date.now()) / 1000) + i
        }
      };
      if (parent) mapping[parent].children.push(nid);
      parent = nid; last = nid;
    });
    return {
      title: chat.title,
      create_time: (chat.createdAt || Date.now()) / 1000,
      update_time: (chat.updatedAt || Date.now()) / 1000,
      current_node: last, mapping
    };
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const q = url.searchParams;
    const parts = url.pathname.split("/").filter(Boolean);
    const platform = parts[0];
    const path = "/" + parts.slice(1).join("/");
    calls.push(url.pathname + url.search);

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "*"
      });
      return res.end();
    }

    if (url.pathname === "/__control") {
      let body = "";
      req.on("data", (c) => { body += c; });
      return req.on("end", () => {
        try {
          const patch = JSON.parse(body || "{}");
          for (const [key, value] of Object.entries(patch)) state[key] = { ...state[key], ...value };
          json(res, { ok: true, state });
        } catch (error) { json(res, { ok: false, error: String(error) }, 400); }
      });
    }
    if (url.pathname === "/__calls") { const out = calls.slice(); calls.length = 0; return json(res, { calls: out }); }

    /* ---------- ChatGPT ---------- */
    if (platform === "chatgpt") {
      if (!state.chatgpt.signedIn) return deny(res);
      if (path === "/api/auth/session") {
        const id = state.chatgpt.current;
        const who = state.chatgpt.accounts[id];
        if (!who) return json(res, {}, 200);           // signed out looks like an empty session
        return json(res, { accessToken: "tok-" + id, user: { id, email: who.email || "" } });
      }
      if (path === "/backend-api/conversations") {
        const all = chatsOf("chatgpt", state.chatgpt.current)
          .slice().sort((a, b) => b.updatedAt - a.updatedAt);
        const offset = Number(q.get("offset") || 0);
        const limit = Number(q.get("limit") || 100);
        const items = all.slice(offset, offset + limit).map((c) => ({
          id: c.id, title: c.title,
          create_time: new Date(c.createdAt).toISOString(),
          update_time: new Date(c.updatedAt).toISOString()
        }));
        return json(res, { items, total: all.length });
      }
      if (path.startsWith("/backend-api/conversation/")) {
        const id = path.slice("/backend-api/conversation/".length);
        const chat = chatsOf("chatgpt", state.chatgpt.current).find((c) => c.id === id);
        if (!chat) return json(res, { error: "not found" }, 404);
        return json(res, chatgptConv(chat));
      }
      return json(res, { error: "no route" }, 404);
    }

    /* ---------- Claude ---------- */
    if (platform === "claude") {
      if (!state.claude.signedIn) return deny(res);
      if (path === "/api/organizations") {
        return json(res, state.claude.orgs.map((o) => ({
          uuid: o.uuid, name: o.name, capabilities: o.capabilities || []
        })));
      }
      const listMatch = path.match(/^\/api\/organizations\/([^/]+)\/chat_conversations$/);
      if (listMatch) {
        const org = state.claude.orgs.find((o) => o.uuid === listMatch[1]);
        if (!org) return json(res, { error: "no org" }, 404);
        if (!firstPage(q)) return json(res, []);
        return json(res, (org.chats || []).slice().sort((a, b) => b.updatedAt - a.updatedAt).map((c) => ({
          uuid: c.id, name: c.title,
          created_at: new Date(c.createdAt).toISOString(),
          updated_at: new Date(c.updatedAt).toISOString()
        })));
      }
      const detailMatch = path.match(/^\/api\/organizations\/([^/]+)\/chat_conversations\/([^/]+)$/);
      if (detailMatch) {
        const org = state.claude.orgs.find((o) => o.uuid === detailMatch[1]);
        const chat = org && (org.chats || []).find((c) => c.id === detailMatch[2]);
        if (!chat) return json(res, { error: "not found" }, 404);
        return json(res, {
          chat_messages: (chat.msgs || []).map((m, i) => ({
            sender: m.r === "user" ? "human" : "assistant",
            text: m.t,
            created_at: new Date((chat.createdAt || Date.now()) + i * 1000).toISOString()
          }))
        });
      }
      return json(res, { error: "no route" }, 404);
    }

    /* ---------- DeepSeek (names no account: the anchor path) ---------- */
    if (platform === "deepseek") {
      if (!state.deepseek.signedIn) return deny(res);
      if (path === "/api/v0/chat/list") {
        if (!firstPage(q)) return json(res, { data: { list: [] } });
        const all = chatsOf("deepseek", state.deepseek.current)
          .slice().sort((a, b) => b.updatedAt - a.updatedAt);
        return json(res, { data: { list: all.map((c) => ({
          id: c.id, title: c.title,
          created_at: new Date(c.createdAt).toISOString(),
          updated_at: new Date(c.updatedAt).toISOString()
        })) } });
      }
      if (path.startsWith("/api/v0/chat/history/")) {
        const id = path.slice("/api/v0/chat/history/".length);
        const chat = chatsOf("deepseek", state.deepseek.current).find((c) => c.id === id);
        if (!chat) return json(res, { error: "not found" }, 404);
        return json(res, { data: { messages: (chat.msgs || []).map((m) => ({ role: m.r, content: m.t })) } });
      }
      return json(res, { error: "no route" }, 404);
    }

    /* ---------- Perplexity ----------
       Three shapes the adapter has to get exactly right, so the mock speaks
       all three: the listing is a BARE array (not an envelope), it pages by an
       offset in the POST BODY rather than the query string, and the answer
       text hides in one of two fields — `text` plain, or `answer` as a
       JSON-ENCODED string. Chats alternate between the two spellings, because
       reading the encoded one raw archives `{"answer":"…"}` as the message and
       nothing else in the suite would notice. Timestamps are deliberately
       naive ISO with no zone, which is what Perplexity really sends. */
    if (platform === "perplexity") {
      if (!state.perplexity.signedIn) return deny(res);
      const naive = (ms) => new Date(ms).toISOString().replace(/Z$/, "");
      if (path === "/api/auth/session") {
        const id = state.perplexity.current;
        const who = state.perplexity.accounts[id];
        if (!who) return json(res, {}, 200);           // signed out looks like an empty session
        return json(res, { expires: naive(Date.now() + 86400000), user: { id, email: who.email || "" } });
      }
      if (path === "/rest/thread/list_ask_threads") {
        if (req.method !== "POST") return json(res, { error: "method" }, 400);
        let body = "";
        req.on("data", (c) => { body += c; });
        return req.on("end", () => {
          let offset = 0, limit = 50;
          try {
            const parsed = JSON.parse(body || "{}");
            offset = Number(parsed.offset) || 0;
            limit = Number(parsed.limit) || 50;
          } catch { /* an unparseable body is the adapter's bug to surface */ }
          const all = chatsOf("perplexity", state.perplexity.current)
            .slice().sort((a, b) => b.updatedAt - a.updatedAt);
          json(res, all.slice(offset, offset + limit).map((c) => ({
            slug: c.id, uuid: "u-" + c.id, title: c.title,
            last_query_datetime: naive(c.updatedAt),
            total_threads: all.length
          })));
        });
      }
      if (path.startsWith("/rest/thread/")) {
        const slug = decodeURIComponent(path.slice("/rest/thread/".length));
        const chats = chatsOf("perplexity", state.perplexity.current);
        const chat = chats.find((c) => c.id === slug);
        // NOT a 404 — Perplexity purges threads after ~3 months and says so
        // with a 400. `expired` lets a test aim that at one specific thread.
        const purged = (state.perplexity.expired || []).includes(slug);
        if (!chat || purged) return json(res, { error: purged ? "ENTRY_EXPIRED" : "ENTRY_DELETED" }, 400);
        const encoded = chats.indexOf(chat) % 2 === 1;
        const entries = [];
        // One entry is a whole turn, so the user/assistant pairs collapse.
        for (let i = 0; i < (chat.msgs || []).length; i += 2) {
          const ask = chat.msgs[i], reply = chat.msgs[i + 1];
          const entry = {
            query_str: ask ? ask.t : "",
            updated_datetime: naive((chat.createdAt || Date.now()) + i * 1000)
          };
          if (reply) {
            if (encoded) entry.answer = JSON.stringify({ answer: reply.t });
            else entry.text = reply.t;
          }
          entries.push(entry);
        }
        return json(res, {
          status: "success", entries, has_next_page: false, next_cursor: null,
          thread_metadata: { thread_uuid: "u-" + chat.id, thread_title: chat.title }
        });
      }
      return json(res, { error: "no route" }, 404);
    }

    /* ---------- Gemini ----------
       Speaks batchexecute for real: the app shell carries the SNlM0e/cfb2h/
       FdrFJe tokens in its HTML, and the RPC replies are `)]}'`-guarded,
       length-prefixed frames whose payloads are JSON inside a JSON string and
       addressed by index.

       Two properties are the point. Conversations are split across a PINNED and
       an UNPINNED shelf and one call returns only one of them, so an adapter
       that asks once archives half an account — and, worse, reports that half as
       a complete listing, which invites the sweep to delete the rest. And turns
       come back NEWEST-FIRST, so an adapter that trusts arrival order writes
       every conversation backwards. */
    if (platform === "gemini") {
      if (!state.gemini.signedIn) return deny(res);
      if (path === "/app") {
        const id = state.gemini.current;
        const who = state.gemini.accounts[id];
        res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
        if (!who) return res.end("<!doctype html><html><body>signed out</body></html>");
        return res.end(`<!doctype html><html><script>window.WIZ_global_data={` +
          `"SNlM0e":"at-${id}","cfb2h":"boq_bard_${id}","FdrFJe":"-sid-${id}"};</script></html>`);
      }
      if (path === "/_/BardChatUi/data/batchexecute") {
        if (req.method !== "POST") return json(res, { error: "method" }, 400);
        const rpcid = q.get("rpcids") || "";
        let body = "";
        req.on("data", (c) => { body += c; });
        return req.on("end", () => {
          const form = new URLSearchParams(body);
          // The token is what makes a batchexecute POST legitimate; without it
          // Google answers 400, so the mock does too.
          if (!form.get("at")) return json(res, { error: "missing at" }, 400);
          let payload = null;
          try { payload = JSON.parse(JSON.parse(form.get("f.req"))[0][0][1]); }
          catch { return json(res, { error: "bad f.req" }, 400); }

          const chats = chatsOf("gemini", state.gemini.current);
          const pinnedIds = state.gemini.pinned || [];
          let out;
          if (rpcid === "MaZiqc") {
            const wantPinned = !!(Array.isArray(payload[2]) && payload[2][0]);
            const shelf = chats
              .filter((c) => pinnedIds.includes(c.id) === wantPinned)
              .slice().sort((a, b) => b.updatedAt - a.updatedAt);
            out = [null, null, shelf.map((c) => [
              // `blankIds` models the field moving: rows still arrive, but the
              // adapter can name none of them. That must be reported, not
              // rendered as an account with no conversations in it.
              state.gemini.blankIds ? "" : c.id,
              c.title, wantPinned ? 1 : 0, null, null,
              [Math.floor(c.updatedAt / 1000), 0]
            ])];
          } else if (rpcid === "hNvQHb") {
            const chat = chats.find((c) => c.id === payload[0]);
            if (!chat) return json(res, { error: "not found" }, 404);
            const turns = [];
            for (let i = 0; i < (chat.msgs || []).length; i += 2) {
              const ask = chat.msgs[i], reply = chat.msgs[i + 1];
              turns.push([
                ["", `r_${chat.id}_${i}`], null,
                [[ask ? ask.t : ""]],
                reply ? [[[`rc_${chat.id}_${i}`, [reply.t]]]] : null
              ]);
            }
            out = [turns.reverse()];   // newest turn first, as Gemini answers
          } else {
            return json(res, { error: "unknown rpc" }, 400);
          }

          const envelope = JSON.stringify([["wrb.fr", rpcid, JSON.stringify(out),
            null, null, null, "generic"]]);
          const text = ")]}'\n" + `${envelope.length + 2}\n${envelope}\n`;
          res.writeHead(200, {
            "content-type": "application/json+protobuf", "cache-control": "no-store"
          });
          return res.end(text);
        });
      }
      return json(res, { error: "no route" }, 404);
    }

    /* ---------- Grok ----------
       Two things here are the whole point of the fixture. Every field is
       camelCase and ONLY camelCase — conversationId, createTime, modifyTime —
       because an adapter reading `id`/`created_at` gets a listing of nameless
       metas, which walkScheme discards wholesale while reporting no error.
       And a conversation's messages are not in the conversation: they take a
       response-node call for the ids and a batched load-responses call for the
       bodies. load-responses answers in REVERSE order, on purpose, so an
       adapter that trusts arrival order archives the conversation backwards. */
    if (platform === "grok") {
      if (!state.grok.signedIn) return deny(res);
      const iso = (ms) => new Date(ms).toISOString();
      if (path === "/rest/app-chat/conversations") {
        if (!firstPage(q)) return json(res, { conversations: [] });
        const all = chatsOf("grok", state.grok.current)
          .slice().sort((a, b) => b.updatedAt - a.updatedAt);
        // `rename` models the thing that actually happens to an undocumented
        // endpoint: the fields get new names. Nothing the adapter knows to look
        // for is present, so it must say so rather than infer an empty account.
        return json(res, { conversations: all.map((c) => (state.grok.rename ? {
          convId: c.id, heading: c.title, madeAt: iso(c.createdAt), changedAt: iso(c.updatedAt)
        } : {
          conversationId: c.id, title: c.title,
          createTime: iso(c.createdAt), modifyTime: iso(c.updatedAt)
        })) });
      }
      const nodeMatch = path.match(/^\/rest\/app-chat\/conversations\/([^/]+)\/response-node$/);
      if (nodeMatch) {
        const chat = chatsOf("grok", state.grok.current).find((c) => c.id === decodeURIComponent(nodeMatch[1]));
        if (!chat) return json(res, { error: "not found" }, 404);
        return json(res, { responseNodes: (chat.msgs || []).map((_, i) => ({ responseId: `${chat.id}-r${i}` })) });
      }
      const loadMatch = path.match(/^\/rest\/app-chat\/conversations\/([^/]+)\/load-responses$/);
      if (loadMatch) {
        if (req.method !== "POST") return json(res, { error: "method" }, 400);
        const chat = chatsOf("grok", state.grok.current).find((c) => c.id === decodeURIComponent(loadMatch[1]));
        if (!chat) return json(res, { error: "not found" }, 404);
        let body = "";
        req.on("data", (c) => { body += c; });
        return req.on("end", () => {
          let want = [];
          try { want = JSON.parse(body || "{}").responseIds || []; } catch { /* adapter's bug to surface */ }
          const responses = want.map((rid) => {
            const i = Number(String(rid).split("-r").pop());
            const m = (chat.msgs || [])[i];
            return m ? {
              responseId: rid, sender: m.r === "user" ? "human" : "assistant",
              message: m.t, createTime: iso((chat.createdAt || Date.now()) + i * 1000)
            } : null;
          }).filter(Boolean).reverse();
          json(res, { responses });
        });
      }
      return json(res, { error: "no route" }, 404);
    }
    return json(res, { error: "no platform" }, 404);
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve({
      port,
      close: () => new Promise((done) => server.close(done)),
      async control(patch) {
        const r = await fetch(`http://127.0.0.1:${port}/__control`, {
          method: "POST", body: JSON.stringify(patch)
        });
        return r.json();
      },
      async calls() {
        const r = await fetch(`http://127.0.0.1:${port}/__calls`);
        return (await r.json()).calls;
      }
    }));
  });
}

/** Chats with the shape the mock expects, so a test can say "four chats". */
export function makeChats(prefix, count, baseAt = Date.UTC(2026, 0, 1)) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i + 1}`,
    title: `${prefix} chat ${i + 1}`,
    createdAt: baseAt + i * 86400000,
    updatedAt: baseAt + i * 86400000 + 3600000,
    msgs: [
      { r: "user", t: `Question ${i + 1} from ${prefix}. Keep it long enough to be a real message.` },
      { r: "assistant", t: `Answer ${i + 1} for ${prefix}. Also long enough to be archived properly.` }
    ]
  }));
}
