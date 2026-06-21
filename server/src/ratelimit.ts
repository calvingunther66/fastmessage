import type { FastifyReply, FastifyRequest } from "fastify";

/**
 * Tiny in-memory sliding-window rate limiter, scoped per IP. Good enough for a
 * single-instance personal server; a multi-instance deployment would back this
 * with a shared store.
 */
export function rateLimit(opts: { windowMs: number; max: number }) {
  const hits = new Map<string, number[]>();
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const ip = req.ip || "unknown";
    const now = Date.now();
    const recent = (hits.get(ip) ?? []).filter((t) => now - t < opts.windowMs);
    recent.push(now);
    hits.set(ip, recent);
    if (recent.length > opts.max) {
      reply.code(429).send({ error: "rate_limited", detail: "too many requests" });
    }
  };
}
