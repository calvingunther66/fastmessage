/**
 * @fastmessage/shared
 *
 * Wire protocol shared between the server and every client. Everything here is
 * transport/metadata only — the *content* of a message lives inside the
 * end-to-end-encrypted `EncryptedEnvelope.body` and is never described here,
 * because the server is never allowed to understand it.
 */
import { z } from "zod";

/** Base path for the backend connector, e.g. https://message.calvingunther.com/app */
export const API_BASE = "/app";
export const API_V1 = `${API_BASE}/v1`;
export const WS_PATH = `${API_BASE}/ws`;

export const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Public key material (only ever PUBLIC keys touch the server)
// ---------------------------------------------------------------------------

/** A single one-time prekey: an id plus its public Curve25519 value. */
export const OneTimeKey = z.object({
  keyId: z.string().min(1),
  key: z.string().min(1),
});
export type OneTimeKey = z.infer<typeof OneTimeKey>;

/** The public identity of a single device. */
export const DevicePublicKeys = z.object({
  deviceId: z.string().min(1),
  displayName: z.string().max(120).optional(),
  /** Curve25519 identity key — used to address/establish Olm sessions. */
  identityKey: z.string().min(1),
  /** Ed25519 signing key — the device fingerprint shown for verification. */
  signingKey: z.string().min(1),
});
export type DevicePublicKeys = z.infer<typeof DevicePublicKeys>;

/** Keys a device uploads when it registers or logs in. */
export const DeviceKeyUpload = DevicePublicKeys.extend({
  /** Map of one-time key id -> public key. */
  oneTimeKeys: z.record(z.string(), z.string()).default({}),
  /** Last-resort fallback key, reused when one-time keys are exhausted. */
  fallbackKey: OneTimeKey.nullable().optional(),
});
export type DeviceKeyUpload = z.infer<typeof DeviceKeyUpload>;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const RegisterRequest = z.object({
  username: z
    .string()
    .min(3)
    .max(32)
    .regex(/^[a-z0-9_.-]+$/i, "letters, digits, _ . - only"),
  password: z.string().min(8).max(512),
  device: DeviceKeyUpload,
});
export type RegisterRequest = z.infer<typeof RegisterRequest>;

export const LoginRequest = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  device: DeviceKeyUpload,
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const AuthResponse = z.object({
  token: z.string(),
  userId: z.string(),
  deviceId: z.string(),
  username: z.string(),
  expiresAt: z.number(),
});
export type AuthResponse = z.infer<typeof AuthResponse>;

// ---------------------------------------------------------------------------
// Key directory
// ---------------------------------------------------------------------------

export const ClaimRequest = z.object({
  targets: z
    .array(z.object({ userId: z.string(), deviceId: z.string() }))
    .min(1)
    .max(100),
});
export type ClaimRequest = z.infer<typeof ClaimRequest>;

/** A prekey bundle for one device — enough to start an Olm session with it. */
export const ClaimedBundle = z.object({
  userId: z.string(),
  deviceId: z.string(),
  identityKey: z.string(),
  signingKey: z.string(),
  /** null if the device has run out of keys entirely. */
  oneTimeKey: OneTimeKey.nullable(),
});
export type ClaimedBundle = z.infer<typeof ClaimedBundle>;

export const ClaimResponse = z.object({ bundles: z.array(ClaimedBundle) });
export type ClaimResponse = z.infer<typeof ClaimResponse>;

export const ReplenishRequest = z.object({
  oneTimeKeys: z.record(z.string(), z.string()).default({}),
  fallbackKey: OneTimeKey.nullable().optional(),
});
export type ReplenishRequest = z.infer<typeof ReplenishRequest>;

export const DeviceListResponse = z.object({
  userId: z.string(),
  devices: z.array(DevicePublicKeys),
});
export type DeviceListResponse = z.infer<typeof DeviceListResponse>;

export const UserLookupResponse = z.object({
  userId: z.string(),
  username: z.string(),
});
export type UserLookupResponse = z.infer<typeof UserLookupResponse>;

// ---------------------------------------------------------------------------
// The encrypted envelope (this is the ONLY message payload the server stores)
// ---------------------------------------------------------------------------

/**
 * Ciphertext as produced by the Double Ratchet. The server treats `body` as an
 * opaque blob; only the recipient device can decrypt it. The decrypted plaintext
 * is itself a JSON `MessageContent` the server never sees.
 */
export const EncryptedEnvelope = z.object({
  v: z.literal(PROTOCOL_VERSION),
  /** "olm" for 1:1 / device-to-device. "megolm" reserved for group chats. */
  alg: z.enum(["olm", "megolm"]),
  /** Olm message type: 0 = pre-key (session-establishing), 1 = normal. */
  msgType: z.union([z.literal(0), z.literal(1)]),
  /** Base64 ciphertext. */
  body: z.string(),
  /** Sender device's Curve25519 identity key — needed to match/create a session. */
  senderIdentityKey: z.string(),
});
export type EncryptedEnvelope = z.infer<typeof EncryptedEnvelope>;

/**
 * The plaintext shape that lives *inside* an EncryptedEnvelope after decryption.
 * Defined here so clients agree on it; the server never parses this.
 */
export type MessageContent =
  | { kind: "text"; body: string; sentAt: number; msgId: string }
  | {
      kind: "attachment";
      name: string;
      mime: string;
      size: number;
      blobId: string;
      key: string; // base64 file key — only visible to participants
      nonce: string;
      hash: string;
      sentAt: number;
      msgId: string;
    }
  | { kind: "receipt"; msgIds: string[]; state: "delivered" | "read" }
  | { kind: "typing"; active: boolean };

// ---------------------------------------------------------------------------
// REST: send (fallback when WS is down) + mailbox drain
// ---------------------------------------------------------------------------

export const OutgoingEnvelope = z.object({
  toUserId: z.string(),
  toDeviceId: z.string(),
  clientMsgId: z.string(),
  envelope: EncryptedEnvelope,
});
export type OutgoingEnvelope = z.infer<typeof OutgoingEnvelope>;

export const SendRequest = z.object({
  messages: z.array(OutgoingEnvelope).min(1).max(500),
});
export type SendRequest = z.infer<typeof SendRequest>;

export const StoredMessage = z.object({
  id: z.string(),
  fromUserId: z.string(),
  fromDeviceId: z.string(),
  envelope: EncryptedEnvelope,
  sentAt: z.number(),
});
export type StoredMessage = z.infer<typeof StoredMessage>;

export const MailboxResponse = z.object({ messages: z.array(StoredMessage) });
export type MailboxResponse = z.infer<typeof MailboxResponse>;

// ---------------------------------------------------------------------------
// WebSocket frames
// ---------------------------------------------------------------------------

/** Client -> server frames. */
export const ClientFrame = z.discriminatedUnion("t", [
  z.object({ t: z.literal("ping") }),
  z.object({ t: z.literal("send"), message: OutgoingEnvelope }),
  z.object({ t: z.literal("ack"), ids: z.array(z.string()).min(1) }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

/** Server -> client frames. */
export const ServerFrame = z.discriminatedUnion("t", [
  z.object({ t: z.literal("pong") }),
  z.object({ t: z.literal("ready"), userId: z.string(), deviceId: z.string() }),
  z.object({ t: z.literal("message"), message: StoredMessage }),
  z.object({ t: z.literal("sent"), clientMsgId: z.string(), id: z.string() }),
  z.object({ t: z.literal("error"), code: z.string(), detail: z.string().optional() }),
]);
export type ServerFrame = z.infer<typeof ServerFrame>;

export const ErrorResponse = z.object({
  error: z.string(),
  detail: z.string().optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;
