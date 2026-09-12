/**
 * Tvara — the static server the browser suites read fixtures from.
 *
 * Replaces `python3 -m http.server`, which sends no Cache-Control: Chrome was
 * then free to reuse a popup.js from the previous run without revalidating, so
 * a suite could pass against the edit before last. Everything here is
 * no-store, which is also why the real-Chrome profile no longer has to be
 * wiped between runs.
 */
import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp",
  ".woff2": "font/woff2", ".map": "application/json"
};

/** Resolves under `root` only — a fixture URL must not be able to read the
    repo's signing keys by climbing out with `..`. */
export function serve(root, port) {
  const server = createServer((req, res) => {
    const rel = normalize(decodeURIComponent(req.url.split("?")[0])).replace(/^(\.\.[/\\])+/, "");
    let file = join(root, rel);
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    try {
      if (statSync(file).isDirectory()) file = join(file, "index.html");
      const size = statSync(file).size;
      res.writeHead(200, {
        "Content-Type": TYPES[extname(file)] || "application/octet-stream",
        "Content-Length": size,
        "Cache-Control": "no-store, max-age=0"
      });
      createReadStream(file).pipe(res);
    } catch {
      res.writeHead(404, { "Cache-Control": "no-store" }).end("not found");
    }
  });
  return new Promise((ok, bad) => {
    server.once("error", bad);
    server.listen(port, "127.0.0.1", () => ok(server));
  });
}
