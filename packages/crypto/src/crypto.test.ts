import { describe, it, expect, beforeAll } from "vitest";
import { CryptoAccount, CryptoSession, initCrypto } from "./index.js";

beforeAll(async () => {
  await initCrypto();
});

describe("Olm double ratchet round-trip", () => {
  it("establishes a session and exchanges messages both ways", () => {
    const alice = CryptoAccount.create();
    const bob = CryptoAccount.create();

    // Bob publishes a one-time key; Alice claims it.
    const bobOtks = bob.generateOneTimeKeys(1);
    const [, bobOtk] = Object.entries(bobOtks)[0]!;
    bob.markKeysAsPublished();

    // Alice -> Bob (first message is a type-0 pre-key message).
    const aliceSession = alice.createOutboundSession(
      bob.identityKeys().curve25519,
      bobOtk,
    );
    const m1 = aliceSession.encrypt("hello bob");
    expect(m1.msgType).toBe(0);

    const { session: bobSession, plaintext } = bob.createInboundSession(
      alice.identityKeys().curve25519,
      m1.body,
    );
    expect(plaintext).toBe("hello bob");

    // Bob -> Alice (reply rides the same ratchet).
    const m2 = bobSession.encrypt("hi alice");
    expect(aliceSession.decrypt(m2.msgType, m2.body)).toBe("hi alice");

    // Several more rounds to exercise the ratchet.
    for (let i = 0; i < 5; i++) {
      const out = aliceSession.encrypt(`a${i}`);
      expect(bobSession.decrypt(out.msgType, out.body)).toBe(`a${i}`);
      const back = bobSession.encrypt(`b${i}`);
      expect(aliceSession.decrypt(back.msgType, back.body)).toBe(`b${i}`);
    }
  });

  it("survives pickle/unpickle of account and session", () => {
    const alice = CryptoAccount.create();
    const bob = CryptoAccount.create();
    const [, bobOtk] = Object.entries(bob.generateOneTimeKeys(1))[0]!;

    const aliceSession = alice.createOutboundSession(
      bob.identityKeys().curve25519,
      bobOtk,
    );
    const m1 = aliceSession.encrypt("opening");
    const { session: bobSession, plaintext } = bob.createInboundSession(
      alice.identityKeys().curve25519,
      m1.body,
    );
    expect(plaintext).toBe("opening");

    // Persist Alice's account + session, then restore them from the pickles.
    const pickleKey = "test-pickle-key";
    const restoredAccount = CryptoAccount.unpickle(
      pickleKey,
      alice.pickle(pickleKey),
    );
    const restoredSession = CryptoSession.unpickle(
      pickleKey,
      aliceSession.pickle(pickleKey),
    );
    expect(restoredAccount.identityKeys().curve25519).toBe(
      alice.identityKeys().curve25519,
    );

    // The restored session keeps ratcheting with Bob.
    const m2 = restoredSession.encrypt("after restore");
    expect(bobSession.decrypt(m2.msgType, m2.body)).toBe("after restore");
  });

  it("produces a fallback key", () => {
    const acct = CryptoAccount.create();
    const fb = acct.generateFallbackKey();
    expect(fb).not.toBeNull();
    expect(fb!.key.length).toBeGreaterThan(0);
  });
});
