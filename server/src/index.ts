import { existsSync } from "node:fs";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { API_BASE, API_V1 } from "@fastmessage/shared";
import { config } from "./config.js";
import "./db.js"; // opens the database and ensures the schema exists
import { authRoutes } from "./routes/auth.js";
import { blobRoutes } from "./routes/blobs.js";
import { groupRoutes } from "./routes/groups.js";
import { keyRoutes } from "./routes/keys.js";
import { messageRoutes } from "./routes/messages.js";
import { registerWebSocket } from "./ws.js";

const app = Fastify({
  logger: { level: config.isProd ? "info" : "debug" },
  bodyLimit: config.MAX_BLOB_BYTES,
  trustProxy: true, // we sit behind Cloudflare's tunnel
});

await app.register(cors, {
  origin: config.corsOrigins.length > 0 ? config.corsOrigins : true,
  credentials: true,
});
await app.register(websocket);

// Accept raw binary uploads (encrypted attachment ciphertext) as a Buffer.
app.addContentTypeParser(
  "application/octet-stream",
  { parseAs: "buffer" },
  (_req, body, done) => done(null, body),
);

// All REST endpoints live under /app/v1 — the "backend connector".
await app.register(
  async (api) => {
    api.get("/healthz", async () => ({
      ok: true,
      service: "fastmessage",
      time: Date.now(),
    }));
    await authRoutes(api);
    await keyRoutes(api);
    await messageRoutes(api);
    await groupRoutes(api);
    await blobRoutes(api);
  },
  { prefix: API_V1 },
);

// Realtime WebSocket at /app/ws.
registerWebSocket(app);

// Serve the built PWA at / when a build is present (production image).
if (config.WEB_DIST && existsSync(config.WEB_DIST)) {
  await app.register(fastifyStatic, { root: config.WEB_DIST, prefix: "/" });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === "GET" && !req.url.startsWith(API_BASE)) {
      return reply.sendFile("index.html"); // SPA fallback
    }
    return reply.code(404).send({ error: "not_found" });
  });
}

try {
  await app.listen({ port: config.PORT, host: config.HOST });
  app.log.info(`FastMessage server listening on ${config.HOST}:${config.PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
