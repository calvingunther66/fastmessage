/**
 * @fastmessage/crypto
 *
 * Thin, testable wrappers around the Olm Double Ratchet. This is the only place
 * that touches private key material, and it runs exclusively on the client.
 * The server never imports this package.
 *
 * 1:1 / device-to-device messaging uses Olm (X3DH-style key agreement + Double
 * Ratchet: forward secrecy + post-compromise security). Group chats (Phase 4)
 * will layer Megolm on top using the same accounts; the facade already exposes
 * the group-session classes.
 */
import {
  Olm,
  type OlmAccount,
  type OlmInboundGroupSession,
  type OlmOutboundGroupSession,
  type OlmSession,
} from "./olm-facade.js";
import type { OneTimeKey } from "@fastmessage/shared";

export type { OneTimeKey } from "@fastmessage/shared";

let initPromise: Promise<void> | null = null;

/**
 * Initialise the Olm runtime exactly once. In the browser pass `locateFile` so
 * the bundler-emitted `olm.wasm` URL can be found; in Node the default works.
 */
export function initCrypto(opts?: {
  locateFile?: (file: string) => string;
}): Promise<void> {
  if (!initPromise) initPromise = Olm.init(opts);
  return initPromise;
}

export interface IdentityKeys {
  /** Curve25519 — addresses Olm sessions. */
  curve25519: string;
  /** Ed25519 — the device fingerprint shown for safety-number verification. */
  ed25519: string;
}

/** Wraps an Olm account: the long-lived device identity + prekeys. */
export class CryptoAccount {
  private constructor(private readonly acct: OlmAccount) {}

  static create(): CryptoAccount {
    const a = new Olm.Account();
    a.create();
    return new CryptoAccount(a);
  }

  static unpickle(pickleKey: string, pickled: string): CryptoAccount {
    const a = new Olm.Account();
    a.unpickle(pickleKey, pickled);
    return new CryptoAccount(a);
  }

  /** Serialise the account (incl. private keys) encrypted under `pickleKey`. */
  pickle(pickleKey: string): string {
    return this.acct.pickle(pickleKey);
  }

  identityKeys(): IdentityKeys {
    return JSON.parse(this.acct.identity_keys()) as IdentityKeys;
  }

  /** Sign a message with the device's Ed25519 key. */
  sign(message: string): string {
    return this.acct.sign(message);
  }

  maxOneTimeKeys(): number {
    return this.acct.max_number_of_one_time_keys();
  }

  /**
   * Generate `count` new one-time keys and return all currently-unpublished
   * ones as `{ keyId: publicKey }`. Call {@link markKeysAsPublished} once the
   * server has accepted them.
   */
  generateOneTimeKeys(count: number): Record<string, string> {
    this.acct.generate_one_time_keys(count);
    const parsed = JSON.parse(this.acct.one_time_keys()) as {
      curve25519: Record<string, string>;
    };
    return parsed.curve25519 ?? {};
  }

  markKeysAsPublished(): void {
    this.acct.mark_keys_as_published();
  }

  /** Generate / rotate the last-resort fallback key. */
  generateFallbackKey(): OneTimeKey | null {
    this.acct.generate_fallback_key();
    const parsed = JSON.parse(this.acct.unpublished_fallback_key()) as {
      curve25519: Record<string, string>;
    };
    const entries = Object.entries(parsed.curve25519 ?? {});
    if (entries.length === 0) return null;
    const [keyId, key] = entries[0]!;
    return { keyId, key };
  }

  /** Establish an outbound session to a device from its claimed prekey bundle. */
  createOutboundSession(
    theirIdentityKey: string,
    theirOneTimeKey: string,
  ): CryptoSession {
    const s = new Olm.Session();
    s.create_outbound(this.acct, theirIdentityKey, theirOneTimeKey);
    return new CryptoSession(s);
  }

  /**
   * Establish an inbound session from a received pre-key (type 0) message and
   * return the first decrypted plaintext. Consumes the one-time key so it can
   * never be reused.
   */
  createInboundSession(
    theirIdentityKey: string,
    type0Body: string,
  ): { session: CryptoSession; plaintext: string } {
    const s = new Olm.Session();
    s.create_inbound_from(this.acct, theirIdentityKey, type0Body);
    this.acct.remove_one_time_keys(s);
    const plaintext = s.decrypt(0, type0Body);
    return { session: new CryptoSession(s), plaintext };
  }

  free(): void {
    this.acct.free();
  }
}

/** Wraps a single Olm session (one ratchet with one peer device). */
export class CryptoSession {
  constructor(private readonly s: OlmSession) {}

  static unpickle(pickleKey: string, pickled: string): CryptoSession {
    const s = new Olm.Session();
    s.unpickle(pickleKey, pickled);
    return new CryptoSession(s);
  }

  pickle(pickleKey: string): string {
    return this.s.pickle(pickleKey);
  }

  id(): string {
    return this.s.session_id();
  }

  /** True if a type-0 message belongs to this session (avoids dup sessions). */
  matchesInbound(type0Body: string): boolean {
    return this.s.matches_inbound(type0Body);
  }

  encrypt(plaintext: string): { msgType: 0 | 1; body: string } {
    const r = this.s.encrypt(plaintext);
    return { msgType: r.type, body: r.body };
  }

  decrypt(msgType: 0 | 1, body: string): string {
    return this.s.decrypt(msgType, body);
  }

  free(): void {
    this.s.free();
  }
}

// ---------------------------------------------------------------------------
// Megolm group ratchet (group chats)
//
// The sender keeps ONE outbound group session per group and encrypts every
// message with it. The session key is distributed to each member device over a
// 1:1 Olm session (a "room-key" control message). Each recipient imports it as
// an inbound group session to decrypt. Rotate (make a new outbound session) on
// membership change so removed members can't read future messages.
// ---------------------------------------------------------------------------

/** Outbound Megolm session — the sender's group ratchet. */
export class GroupSession {
  constructor(private readonly s: OlmOutboundGroupSession) {}

  static create(): GroupSession {
    const s = new Olm.OutboundGroupSession();
    s.create();
    return new GroupSession(s);
  }
  static unpickle(pickleKey: string, pickled: string): GroupSession {
    const s = new Olm.OutboundGroupSession();
    s.unpickle(pickleKey, pickled);
    return new GroupSession(s);
  }
  pickle(pickleKey: string): string {
    return this.s.pickle(pickleKey);
  }
  sessionId(): string {
    return this.s.session_id();
  }
  /** The secret key to hand to members (only ever over a 1:1 Olm session). */
  sessionKey(): string {
    return this.s.session_key();
  }
  messageIndex(): number {
    return this.s.message_index();
  }
  encrypt(plaintext: string): string {
    return this.s.encrypt(plaintext);
  }
  free(): void {
    this.s.free();
  }
}

/** Inbound Megolm session — a recipient's view of someone's group ratchet. */
export class GroupInboundSession {
  constructor(private readonly s: OlmInboundGroupSession) {}

  static create(sessionKey: string): GroupInboundSession {
    const s = new Olm.InboundGroupSession();
    s.create(sessionKey);
    return new GroupInboundSession(s);
  }
  static unpickle(pickleKey: string, pickled: string): GroupInboundSession {
    const s = new Olm.InboundGroupSession();
    s.unpickle(pickleKey, pickled);
    return new GroupInboundSession(s);
  }
  pickle(pickleKey: string): string {
    return this.s.pickle(pickleKey);
  }
  sessionId(): string {
    return this.s.session_id();
  }
  decrypt(message: string): { plaintext: string; messageIndex: number } {
    const r = this.s.decrypt(message);
    return { plaintext: r.plaintext, messageIndex: r.message_index };
  }
  free(): void {
    this.s.free();
  }
}

// ---------------------------------------------------------------------------
// Small cross-platform helpers (browser + Node)
// ---------------------------------------------------------------------------

/** Cryptographically-random bytes, base64url-encoded. Good for ids / secrets. */
export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  cryptoObj().getRandomValues(buf);
  return base64UrlEncode(buf);
}

/** A random pickle key used to encrypt the Olm account/session at rest. */
export function randomPickleKey(): string {
  return randomToken(32);
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  // btoa is a global in both browsers and Node >= 16.
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Format an Ed25519 fingerprint into readable groups for verification UIs. */
export function formatFingerprint(ed25519: string): string {
  return (ed25519.match(/.{1,4}/g) ?? []).join(" ");
}

/**
 * A deterministic "safety number" for two device signing keys. Both sides
 * compute the same value (keys are sorted first), so comparing it out-of-band
 * detects a man-in-the-middle. 60 digits, grouped in fives.
 */
export function safetyNumber(signingKeyA: string, signingKeyB: string): string {
  const [a, b] = [signingKeyA, signingKeyB].sort();
  const util = new Olm.Utility();
  const hashB64 = util.sha256(`${a}|${b}`);
  util.free();
  const bin = atob(hashB64);
  let digits = "";
  for (let i = 0; i < 30; i++) digits += (bin.charCodeAt(i) % 100).toString().padStart(2, "0");
  return (digits.match(/.{1,5}/g) ?? []).join(" ");
}

function cryptoObj(): Crypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c) throw new Error("WebCrypto unavailable in this environment");
  return c;
}
