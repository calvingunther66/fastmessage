import type { FastifyReply } from "fastify";
import type { z, ZodTypeAny } from "zod";

/**
 * Parse + validate untrusted input, sending a 400 and returning undefined on
 * failure. Returns the schema's *output* type so zod `.default()`s are applied.
 */
export function parse<S extends ZodTypeAny>(
  schema: S,
  data: unknown,
  reply: FastifyReply,
): z.infer<S> | undefined {
  const result = schema.safeParse(data);
  if (!result.success) {
    reply.code(400).send({
      error: "invalid_request",
      detail: result.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; "),
    });
    return undefined;
  }
  return result.data;
}
