import { createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { TurnResponse } from "@fastmessage/shared";
import { config } from "../config.js";
import { authFromRequest } from "../tokens.js";

const STUN_FALLBACK = "stun:stun.l.google.com:19302";

/**
 * Issues short-lived ICE/TURN credentials for WebRTC calls using coturn's
 * `use-auth-secret` REST scheme: username = "<expiry>:<userId>", credential =
 * base64(HMAC-SHA1(TURN_SECRET, username)). The TURN URLs include a UDP
 * transport so media (DTLS-SRTP) flows over a real UDP channel, with a TCP
 * fallback for restrictive networks. The server never sees call media.
 */
export async function turnRoutes(app: FastifyInstance) {
  app.get("/turn", async (req, reply) => {
    const auth = authFromRequest(req);
    if (!auth) return reply.code(401).send({ error: "unauthorized" });

    if (!config.TURN_SECRET || !config.TURN_PUBLIC_HOST) {
      // No TURN configured: hand back a public STUN server so direct P2P
      // (which is UDP) can still work when both peers are reachable.
      const res: TurnResponse = { iceServers: [{ urls: STUN_FALLBACK }], ttl: 0 };
      return reply.send(res);
    }

    const ttl = 3600;
    const username = `${Math.floor(Date.now() / 1000) + ttl}:${auth.userId}`;
    const credential = createHmac("sha1", config.TURN_SECRET)
      .update(username)
      .digest("base64");
    const host = config.TURN_PUBLIC_HOST;

    const res: TurnResponse = {
      iceServers: [
        { urls: `stun:${host}:3478` },
        {
          urls: [
            `turn:${host}:3478?transport=udp`,
            `turn:${host}:3478?transport=tcp`,
          ],
          username,
          credential,
        },
      ],
      ttl,
    };
    return reply.send(res);
  });
}
