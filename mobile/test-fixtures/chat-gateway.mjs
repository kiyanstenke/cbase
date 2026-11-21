// Entry point of the UI-test fixture gateway: port, server, router order, 404, shutdown. The routes live in chat-gateway/ (map in the README there).
import http from "node:http";
import { routesSettings } from "./chat-gateway/routes-settings.mjs";
import { routesUsage } from "./chat-gateway/routes-usage.mjs";
import { routesScheduled } from "./chat-gateway/routes-scheduled.mjs";
import { routesFixture } from "./chat-gateway/routes-fixture.mjs";
import { routesWorkspace } from "./chat-gateway/routes-workspace.mjs";
import { routesRun } from "./chat-gateway/routes-run.mjs";
import { routesGit } from "./chat-gateway/routes-git.mjs";
import { routesDevtools } from "./chat-gateway/routes-devtools.mjs";
import { routesChat } from "./chat-gateway/routes-chat.mjs";
import { NEXT, json, clearRun, chatStreams, globalStreams } from "./chat-gateway/state.mjs";

const port = Number(process.argv[2] || 17718);
// Default: local only. For test runs ON THE DEVICE (fixture reachable over the LAN)
// start with CBASE_FIXTURE_HOST=0.0.0.0.
const host = process.env.CBASE_FIXTURE_HOST || "127.0.0.1";

// Order matters, first match wins: the startsWith(git/) catch-all sits behind its siblings in
// routes-git, and the two /api/chats/<id> catch-alls in routes-chat stay the LAST checks.
const ROUTERS = [
  routesSettings,
  routesUsage,
  routesScheduled, // before routes-chat: the job chats live under /api/chats/<id>
  routesFixture,
  routesWorkspace,
  routesRun,
  routesGit,
  routesDevtools,
  routesChat,
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
  const path = url.pathname;
  const method = req.method || "GET";

  try {
    const ctx = { req, res, url, path, method };
    for (const r of ROUTERS) if ((await r(ctx)) !== NEXT) return;

    return json(res, 404, { error: `fixture route not found: ${method} ${path}` });
  } catch (error) {
    return json(res, 500, { error: String(error?.stack || error) });
  }
});

server.listen(port, host, () => {
  process.stdout.write(`CBASE_MOBILE_FIXTURE_READY ${port}\n`);
});

function shutdown() {
  clearRun();
  for (const response of [...chatStreams, ...globalStreams]) {
    try {
      response.end();
    } catch {}
  }
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
