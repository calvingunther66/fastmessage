import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { blobDir } from "../db.js";
import { authFromRequest } from "../tokens.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Encrypted-attachment store. The bytes uploaded here are ciphertext: the file
 * is encrypted on the client with a key that travels only inside the E2E
 * message. The server stores and serves the opaque blob and never sees the key.
 */
export async function blobRoutes(app: FastifyInstance) {
  app.post("/blobs", async (req, reply) => {
    const auth = authFromRequest(req);
    if (!auth) return reply.code(401).send({ error: "unauthorized" });

    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send({ error: "empty_body" });
    }
    const blobId = randomUUID();
    await writeFile(join(blobDir, blobId), body);
    return reply.code(201).send({ blobId, size: body.length });
  });

  app.get("/blobs/:id", async (req, reply) => {
    const auth = authFromRequest(req);
    if (!auth) return reply.code(401).send({ error: "unauthorized" });

    const { id } = req.params as { id: string };
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: "bad_id" });

    const path = join(blobDir, id);
    try {
      await stat(path);
    } catch {
      return reply.code(404).send({ error: "not_found" });
    }
    reply.header("content-type", "application/octet-stream");
    reply.header("cache-control", "private, max-age=31536000, immutable");
    return reply.send(createReadStream(path));
  });
}
