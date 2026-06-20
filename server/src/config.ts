import "dotenv/config";
import { z } from "zod";

const Env = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default("0.0.0.0"),
  PUBLIC_ORIGIN: z.string().default("http://localhost:8080"),
  CORS_ORIGINS: z.string().default(""),
  SESSION_SECRET: z.string().min(16).default("dev-only-insecure-secret-change-me!"),
  DATA_DIR: z.string().default("./data"),
  MAX_BLOB_BYTES: z.coerce.number().int().positive().default(50 * 1024 * 1024),
  /** Static web build to serve at `/`. Empty disables static serving. */
  WEB_DIST: z.string().default(""),
  NODE_ENV: z.string().default("development"),
});

const env = Env.parse(process.env);

export const config = {
  ...env,
  isProd: env.NODE_ENV === "production",
  corsOrigins: env.CORS_ORIGINS.split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  /** Session token lifetime: 90 days. */
  tokenTtlMs: 90 * 24 * 60 * 60 * 1000,
};

if (config.isProd && config.SESSION_SECRET.startsWith("dev-only")) {
  throw new Error("Refusing to start in production with the default SESSION_SECRET");
}

export type Config = typeof config;
