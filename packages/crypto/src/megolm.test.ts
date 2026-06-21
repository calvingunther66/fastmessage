import { beforeAll, describe, expect, it } from "vitest";
import { GroupInboundSession, GroupSession, initCrypto } from "./index.js";

beforeAll(async () => {
  await initCrypto();
});

describe("Megolm group ratchet", () => {
  it("encrypts once and any member with the key can decrypt", () => {
    const outbound = GroupSession.create();
    const key = outbound.sessionKey();

    // Two members import the same distributed key.
    const bob = GroupInboundSession.create(key);
    const carol = GroupInboundSession.create(key);

    const ct = outbound.encrypt(JSON.stringify({ kind: "text", body: "hi all" }));
    expect(JSON.parse(bob.decrypt(ct).plaintext).body).toBe("hi all");
    expect(JSON.parse(carol.decrypt(ct).plaintext).body).toBe("hi all");
  });

  it("advances the message index per message", () => {
    const outbound = GroupSession.create();
    const inbound = GroupInboundSession.create(outbound.sessionKey());
    const first = inbound.decrypt(outbound.encrypt("a"));
    const second = inbound.decrypt(outbound.encrypt("b"));
    expect(second.messageIndex).toBe(first.messageIndex + 1);
  });

  it("survives pickle/unpickle of both sides", () => {
    const pickleKey = "k";
    const outbound = GroupSession.create();
    const inbound = GroupInboundSession.create(outbound.sessionKey());

    const out2 = GroupSession.unpickle(pickleKey, outbound.pickle(pickleKey));
    const in2 = GroupInboundSession.unpickle(pickleKey, inbound.pickle(pickleKey));

    const ct = out2.encrypt("persisted");
    expect(in2.decrypt(ct).plaintext).toBe("persisted");
  });
});
