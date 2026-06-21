/**
 * Print the admin half of the dual-key unlock for a given user id.
 *
 *   ADMIN_UNLOCK_SECRET=... node server/scripts/admin-unlock-token.mjs <userId>
 *
 * Hand the resulting token to the locked-out user (or enter it together): the
 * account only reopens when this admin token AND the user's recovery key are
 * presented to POST /app/v1/lockdown/unlock.
 */
import { createHmac } from "node:crypto";

const secret = process.env.ADMIN_UNLOCK_SECRET;
const userId = process.argv[2];

if (!secret) {
  console.error("Set ADMIN_UNLOCK_SECRET in the environment.");
  process.exit(1);
}
if (!userId) {
  console.error("Usage: node admin-unlock-token.mjs <userId>");
  process.exit(1);
}

const token = createHmac("sha256", secret).update(`unlock:${userId}`).digest("hex");
console.log(token);
