import "dotenv/config";
import { z } from "zod";

const Env = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default("0.0.0.0"),
  PUBLIC_ORIGIN: z.string().default("http://localhost:8080"),
  CORS_ORIGINS: z.string().default(""),
  SESSION_SECRET: z.string().min(16).default("dev-only-insecure-secret-change-me!"),
  DATA_DIR: z.string().default("./data"),
  /** If set, the SQLite database is encrypted at rest with this key. */
  DB_ENCRYPTION_KEY: z.string().default(""),
  MAX_BLOB_BYTES: z.coerce.number().int().positive().default(50 * 1024 * 1024),
  /** Static web build to serve at `/`. Empty disables static serving. */
  WEB_DIST: z.string().default(""),
  NODE_ENV: z.string().default("development"),
  /**
   * Admin half of the dual-key unlock. A hard-locked account can only be
   * reopened with BOTH the user's recovery key and an admin token derived from
   * this secret. Empty disables admin-side unlock (lockdown still engages).
   */
  ADMIN_UNLOCK_SECRET: z.string().default(""),
  /** Shared secret for time-limited coturn TURN credentials (voice/video). */
  TURN_SECRET: z.string().default(""),
  TURN_PUBLIC_HOST: z.string().default(""),
  TURN_REALM: z.string().default(""),
  /** Web Push (VAPID). Generate with server/scripts/gen-vapid.mjs. */
  VAPID_PUBLIC_KEY: z.string().default(""),
  VAPID_PRIVATE_KEY: z.string().default(""),
  VAPID_SUBJECT: z.string().default("mailto:admin@example.com"),
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
  /** Tamper-lockdown thresholds. */
  security: {
    softFailThreshold: 5, // failures before a timed soft lock
    hardFailThreshold: 10, // failures before a dual-key hard lockdown
    failWindowMs: 15 * 60 * 1000,
    softLockBaseMs: 30 * 1000, // doubles with tamper score
  },
};

if (config.isProd && config.SESSION_SECRET.startsWith("dev-only")) {
  throw new Error("Refusing to start in production with the default SESSION_SECRET");
}

export type Config = typeof config;
