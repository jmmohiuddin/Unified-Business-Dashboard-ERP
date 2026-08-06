/**
 * Generate production key material.
 *
 *   npm run keygen
 *
 * Prints the three secrets the app refuses to start without in production.
 * Deliberately a separate command rather than auto-generation at boot: a key
 * the application invents for itself is a key nobody has backed up, and losing
 * it makes every encrypted identity document permanently unreadable.
 */
import { randomBytes } from "node:crypto";

const authSecret = randomBytes(48).toString("base64");
const piiKey = randomBytes(32).toString("base64");
const indexKey = randomBytes(32).toString("base64");

console.log(`
# ── Generated ${new Date().toISOString()} ─────────────────────────────
# Store these in your secret manager. They are NOT recoverable.
# Losing PII_ENCRYPTION_KEYS makes every encrypted identity document
# permanently unreadable — back it up before you deploy.

AUTH_SECRET=${authSecret}
PII_ENCRYPTION_KEYS={"1":"${piiKey}"}
PII_ACTIVE_KEY_ID=1
PII_INDEX_KEY=${indexKey}

# To rotate later: add a key "2", set PII_ACTIVE_KEY_ID=2, keep "1" in the
# keyring until \`npm run pii:rotate\` reports zero remaining rows.
`);
