import { createHash, randomBytes } from 'node:crypto';
import postgres from 'postgres';
const sql = postgres('postgresql://nexus:nexus@127.0.0.1:5432/nexus', { max: 1 });
const email = process.argv[2] ?? 'owner@sumon.test';
const [u] = await sql`SELECT u.id, m.tenant_id FROM users u JOIN memberships m ON m.user_id=u.id WHERE u.email=${email} LIMIT 1`;
const token = randomBytes(32).toString('base64url');
await sql`INSERT INTO sessions (id, user_id, token_hash, active_tenant_id, expires_at)
          VALUES (gen_random_uuid(), ${u.id}, ${createHash('sha256').update(token).digest('hex')},
                  ${u.tenant_id}, now() + interval '1 day')`;
console.log(token);
await sql.end();
