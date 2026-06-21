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

// Add a device to an existing account with a one-time link code (no password).
export const LinkStartResponse = z.object({
  code: z.string(),
  expiresAt: z.number(),
});
export type LinkStartResponse = z.infer<typeof LinkStartResponse>;

export const LinkClaimRequest = z.object({
  code: z.string().min(4).max(32),
  device: DeviceKeyUpload,
});
export type LinkClaimRequest = z.infer<typeof LinkClaimRequest>;

export const AuthResponse = z.object({
  token: z.string(),
  userId: z.string(),
  deviceId: z.string(),
  username: z.string(),
  expiresAt: z.number(),
  /** One-time recovery key, returned on registration only. Half of the dual
   * key needed to reopen a hard-locked account — show once, store safely. */
  recoveryKey: z.string().optional(),
});
export type AuthResponse = z.infer<typeof AuthResponse>;

// ---------------------------------------------------------------------------
// Tamper-lockdown
// ---------------------------------------------------------------------------

export const UnlockRequest = z.object({
  username: z.string(),
  recoveryKey: z.string(),
  adminToken: z.string(),
});
export type UnlockRequest = z.infer<typeof UnlockRequest>;

export const LockStatusResponse = z.object({
  locked: z.boolean(),
  level: z.number(),
  retryAfter: z.number().optional(),
});
export type LockStatusResponse = z.infer<typeof LockStatusResponse>;

// ---------------------------------------------------------------------------
// Voice/video calls (WebRTC). Media runs over a real UDP channel via coturn;
// signaling is relayed E2E-encrypted through the normal message pipe below.
// ---------------------------------------------------------------------------

export const IceServer = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  username: z.string().optional(),
  credential: z.string().optional(),
});
export type IceServer = z.infer<typeof IceServer>;

export const TurnResponse = z.object({
  iceServers: z.array(IceServer),
  ttl: z.number(),
});
export type TurnResponse = z.infer<typeof TurnResponse>;

// ---------------------------------------------------------------------------
// Web Push (content-free wake notifications)
// ---------------------------------------------------------------------------

export const PushSubscribeRequest = z.object({
  subscription: z.object({
    endpoint: z.string(),
    keys: z.object({ p256dh: z.string(), auth: z.string() }),
  }),
});
export type PushSubscribeRequest = z.infer<typeof PushSubscribeRequest>;

export const VapidResponse = z.object({ publicKey: z.string() });
export type VapidResponse = z.infer<typeof VapidResponse>;

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
 * Ciphertext as produced by the ratchet. The server treats `body` as an opaque
 * blob; only the recipient device can decrypt it. The decrypted plaintext is
 * itself a JSON `MessageContent` the server never sees.
 *
 * "olm" = 1:1 / device-to-device Double Ratchet. "megolm" = group ratchet,
 * which additionally carries the group + session id so the recipient can pick
 * the right inbound group session.
 */
export const OlmEnvelope = z.object({
  v: z.literal(PROTOCOL_VERSION),
  alg: z.literal("olm"),
  /** Olm message type: 0 = pre-key (session-establishing), 1 = normal. */
  msgType: z.union([z.literal(0), z.literal(1)]),
  body: z.string(),
  /** Sender device's Curve25519 identity key — to match/create a session. */
  senderIdentityKey: z.string(),
});
export type OlmEnvelope = z.infer<typeof OlmEnvelope>;

export const MegolmEnvelope = z.object({
  v: z.literal(PROTOCOL_VERSION),
  alg: z.literal("megolm"),
  body: z.string(),
  senderIdentityKey: z.string(),
  groupId: z.string(),
  sessionId: z.string(),
});
export type MegolmEnvelope = z.infer<typeof MegolmEnvelope>;

export const EncryptedEnvelope = z.discriminatedUnion("alg", [
  OlmEnvelope,
  MegolmEnvelope,
]);
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
  | { kind: "typing"; active: boolean }
  // Control message: shares a Megolm group session key over a 1:1 Olm session.
  | {
      kind: "room-key";
      groupId: string;
      sessionId: string;
      sessionKey: string;
    }
  // WebRTC call signaling — E2E-encrypted, relayed device-to-device.
  | { kind: "call-offer"; callId: string; sdp: string; video: boolean; sentAt: number }
  | { kind: "call-answer"; callId: string; sdp: string }
  | { kind: "call-ice"; callId: string; candidate: string }
  | { kind: "call-hangup"; callId: string; reason?: string }
  // Multi-device: a copy of a message we sent, mirrored to our own other
  // devices so they stay in sync. `to` is the conversation (peer) it belongs to.
  | { kind: "carbon"; to: string; inner: MessageContent };

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
// Groups (membership is server-side metadata; message content stays E2E)
// ---------------------------------------------------------------------------

export const GroupRole = z.enum(["admin", "member"]);
export type GroupRole = z.infer<typeof GroupRole>;

export const GroupMember = z.object({
  userId: z.string(),
  username: z.string(),
  role: GroupRole,
});
export type GroupMember = z.infer<typeof GroupMember>;

export const GroupInfo = z.object({
  groupId: z.string(),
  name: z.string(),
  createdBy: z.string(),
  createdAt: z.number(),
  members: z.array(GroupMember),
});
export type GroupInfo = z.infer<typeof GroupInfo>;

export const CreateGroupRequest = z.object({
  name: z.string().min(1).max(100),
  memberUserIds: z.array(z.string()).max(500).default([]),
});
export type CreateGroupRequest = z.infer<typeof CreateGroupRequest>;

export const AddMemberRequest = z.object({ userId: z.string() });
export type AddMemberRequest = z.infer<typeof AddMemberRequest>;

export const GroupListResponse = z.object({ groups: z.array(GroupInfo) });
export type GroupListResponse = z.infer<typeof GroupListResponse>;

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
