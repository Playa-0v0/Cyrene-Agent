import { createServer, type Server } from "node:http";

export function startHealthServer(port: number, status: () => Record<string, unknown>): Server {
  return createServer((request, response) => {
    if (request.url !== "/health") {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: false }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ ok: true, ...status() }));
  }).listen(port, "127.0.0.1");
}


