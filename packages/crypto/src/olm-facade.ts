/**
 * Typed facade over `@matrix-org/olm`.
 *
 * The package ships an emscripten module whose bundled `index.d.ts` only
 * *exports* `init()` — the `Account`/`Session`/... classes are declared but not
 * exported, and there is no default export. Rather than fight the upstream
 * types, we import the module namespace (which carries the classes at runtime)
 * and describe the small surface we actually use ourselves.
 */
import * as OlmModule from "@matrix-org/olm";

export interface OlmAccount {
  free(): void;
  create(): void;
  identity_keys(): string;
  sign(message: string): string;
  one_time_keys(): string;
  mark_keys_as_published(): void;
  max_number_of_one_time_keys(): number;
  generate_one_time_keys(n: number): void;
  remove_one_time_keys(session: OlmSession): void;
  generate_fallback_key(): void;
  unpublished_fallback_key(): string;
  forget_old_fallback_key(): void;
  pickle(key: string): string;
  unpickle(key: string, pickle: string): void;
}

export interface OlmSession {
  free(): void;
  pickle(key: string): string;
  unpickle(key: string, pickle: string): void;
  create_outbound(
    account: OlmAccount,
    theirIdentityKey: string,
    theirOneTimeKey: string,
  ): void;
  create_inbound(account: OlmAccount, oneTimeKeyMessage: string): void;
  create_inbound_from(
    account: OlmAccount,
    identityKey: string,
    oneTimeKeyMessage: string,
  ): void;
  session_id(): string;
  has_received_message(): boolean;
  matches_inbound(oneTimeKeyMessage: string): boolean;
  matches_inbound_from(identityKey: string, oneTimeKeyMessage: string): boolean;
  encrypt(plaintext: string): { type: 0 | 1; body: string };
  decrypt(messageType: number, message: string): string;
}

export interface OlmUtility {
  free(): void;
  sha256(input: string | Uint8Array): string;
  ed25519_verify(key: string, message: string | Uint8Array, signature: string): void;
}

/** Reserved for Phase 4 (group chats) — Megolm ratchets. */
export interface OlmOutboundGroupSession {
  free(): void;
  pickle(key: string): string;
  unpickle(key: string, pickle: string): void;
  create(): void;
  encrypt(plaintext: string): string;
  session_id(): string;
  session_key(): string;
  message_index(): number;
}

export interface OlmInboundGroupSession {
  free(): void;
  pickle(key: string): string;
  unpickle(key: string, pickle: string): void;
  create(sessionKey: string): string;
  import_session(sessionKey: string): string;
  decrypt(message: string): { message_index: number; plaintext: string };
  session_id(): string;
  first_known_index(): number;
  export_session(messageIndex: number): string;
}

interface OlmStatic {
  init(opts?: { locateFile?: (file: string) => string }): Promise<void>;
  Account: new () => OlmAccount;
  Session: new () => OlmSession;
  Utility: new () => OlmUtility;
  OutboundGroupSession: new () => OlmOutboundGroupSession;
  InboundGroupSession: new () => OlmInboundGroupSession;
}

/**
 * The runtime Olm object; classes live here even though the d.ts hides them.
 * Olm ships as a CommonJS emscripten module, so depending on the bundler the
 * real export lands either on the namespace or under `.default`. Pick whichever
 * actually carries `init`.
 */
const candidate = OlmModule as unknown as { default?: OlmStatic } & OlmStatic;
export const Olm: OlmStatic =
  candidate.default && typeof candidate.default.init === "function"
    ? candidate.default
    : candidate;
