import http from "node:http";
import { createProxyMiddleware } from "http-proxy-middleware";
import { createApp } from "./app.js";
import { getConfig } from "./config.js";
import { getPool } from "./db.js";
import { runMigrations } from "./migrate.js";

const config = getConfig();
const pool = getPool();
await runMigrations(pool);
await pool.query("SELECT 1");

const app = createApp(pool, config);
const frontendTarget = `http://127.0.0.1:${config.FRONTEND_PORT}`;
app.use(createProxyMiddleware({ target: frontendTarget, changeOrigin: false, ws: true, xfwd: true }));

const server = http.createServer(app);
server.listen(config.APP_PORT, "0.0.0.0", () => {
  process.stdout.write(`[${new Date().toISOString()}] CRM gateway online at http://0.0.0.0:${config.APP_PORT}\n`);
  process.stdout.write(`[${new Date().toISOString()}] Embedded SQLite database ready; frontend proxy target ${frontendTarget}\n`);
});

const shutdown = async (signal: string) => {
  process.stdout.write(`[${new Date().toISOString()}] ${signal} received; stopping CRM...\n`);
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};

process.on("SIGINT", () => { void shutdown("SIGINT"); });
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });

process.on("uncaughtException", (error) => {
  process.stderr.write(`[${new Date().toISOString()}] Uncaught exception: ${error.message}\n`);
  void shutdown("uncaughtException");
});
process.on("unhandledRejection", (error) => {
  process.stderr.write(`[${new Date().toISOString()}] Unhandled rejection: ${error instanceof Error ? error.message : String(error)}\n`);
  void shutdown("unhandledRejection");
});
