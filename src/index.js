import "dotenv/config";
import http from "node:http";
import { createLogger } from "./lib/logger.js";
import {
  startBillingSettlePoller,
  stopBillingSettlePoller,
} from "./billing-settle-poller.js";

const log = createLogger("billing-poller");

/**
 * Health HTTP opcional. Local: não usa PORT do .env da API (evita EADDRINUSE:4000).
 * Railway: usa PORT injectado. Override: BILLING_POLLER_HEALTH_PORT=4100
 */
function resolveHealthPort() {
  const explicit = Number(process.env.BILLING_POLLER_HEALTH_PORT);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;

  const onRailway =
    process.env.RAILWAY_ENVIRONMENT ||
    process.env.RAILWAY_PROJECT_ID ||
    process.env.RAILWAY_SERVICE_ID;
  if (onRailway) {
    const railwayPort = Number(process.env.PORT);
    if (Number.isFinite(railwayPort) && railwayPort > 0) return railwayPort;
  }
  return 0;
}

function startHealthServer() {
  const port = resolveHealthPort();
  if (!port) return null;
  const server = http.createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, process: "billing-poller" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.listen(port, () => {
    log.info("Healthcheck HTTP do poller", { port, path: "/health" });
  });
  return server;
}

/** @type {import('node:http').Server | null} */
let healthServer = null;

function shutdown(signal) {
  log.info("Encerrando billing poller", { signal });
  stopBillingSettlePoller();
  if (healthServer) {
    healthServer.close(() => process.exit(0));
  } else {
    process.exit(0);
  }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

healthServer = startHealthServer();
startBillingSettlePoller();
