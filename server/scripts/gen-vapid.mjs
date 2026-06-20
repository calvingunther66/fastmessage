/**
 * Generate a VAPID keypair for Web Push (Phase 6). Prints lines you can paste
 * into `.env`. Uses only Node's built-in WebCrypto — no dependencies.
 *
 *   node server/scripts/gen-vapid.mjs
 */
const { subtle } = globalThis.crypto;

const pair = await subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  true,
  ["sign", "verify"],
);

const rawPub = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
const jwkPriv = await subtle.exportKey("jwk", pair.privateKey);

const b64url = (bytes) =>
  Buffer.from(bytes).toString("base64url");

console.log(`VAPID_PUBLIC_KEY=${b64url(rawPub)}`);
console.log(`VAPID_PRIVATE_KEY=${jwkPriv.d}`);
console.log("VAPID_SUBJECT=mailto:you@example.com");
