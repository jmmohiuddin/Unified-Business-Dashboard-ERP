/**
 * Mint a signed-in cookie header for poking at the app by hand.
 *
 *   node scripts/mksession.mjs [email] > /tmp/jar
 *   curl -s http://localhost:3100/ -H "cookie: $(cat /tmp/jar)"
 *
 * A row in `sessions` is no longer enough on its own. proxy.ts requires every
 * session cookie to arrive alongside a `nexus_auth_level` marker it can verify
 * offline, and treats an unmarked session as pre-policy or forged — it deletes
 * the cookie and bounces the caller to /login. That is deliberate: a thirty-day
 * session cookie must not outlive a change to who is allowed to hold one. So
 * this script has to mint the marker too, in the exact format setAuthLevel()
 * writes in apps/web/src/lib/mfa.ts, or what it prints is useless.
 *
 * It issues `full`, which means it bypasses the MFA enrolment gate. That is
 * fine for a local debugging aid and would be indefensible anywhere else, which
 * is why it needs the deployment's AUTH_SECRET to produce a marker the server
 * will accept — without the signing key this prints nothing usable.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import postgres from 'postgres';

const AUTH_SECRET = process.env.AUTH_SECRET;
if (!AUTH_SECRET) {
  console.error('AUTH_SECRET must be set — the assurance marker is signed with it.');
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL ?? 'postgresql://nexus:nexus@127.0.0.1:5432/nexus', { max: 1 });
const email = process.argv[2] ?? 'owner@sumon.test';
const [u] = await sql`SELECT u.id, m.tenant_id FROM users u JOIN memberships m ON m.user_id=u.id WHERE u.email=${email} LIMIT 1`;
if (!u) {
  console.error(`No membership for ${email}.`);
  await sql.end();
  process.exit(1);
}
const token = randomBytes(32).toString('base64url');
const tokenHash = createHash('sha256').update(token).digest('hex');
await sql`INSERT INTO sessions (id, user_id, token_hash, active_tenant_id, expires_at)
          VALUES (gen_random_uuid(), ${u.id}, ${tokenHash},
                  ${u.tenant_id}, now() + interval '1 day')`;

// `<level>.<expiresAtMs>.<HMAC-SHA256 over level, expiry and the token digest>`.
// Bound to the digest rather than the raw token because the raw token is never
// stored, and because a marker earned by one session must not be pairable with
// another one's cookie.
const expiresAt = Date.now() + 86_400_000;
const mac = createHmac('sha256', AUTH_SECRET)
  .update(`full.${expiresAt}.${tokenHash}`)
  .digest('base64url');

console.log(`nexus_session=${token}; nexus_auth_level=full.${expiresAt}.${mac}`);
await sql.end();
