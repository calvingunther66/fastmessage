import { initCrypto } from "@fastmessage/crypto";
// Vite emits the wasm as a hashed asset and gives us its URL.
import olmWasmUrl from "@matrix-org/olm/olm.wasm?url";

let promise: Promise<void> | null = null;

/** Initialise Olm in the browser, pointing it at the bundled wasm. */
export function ensureCrypto(): Promise<void> {
  if (!promise) promise = initCrypto({ locateFile: () => olmWasmUrl });
  return promise;
}
