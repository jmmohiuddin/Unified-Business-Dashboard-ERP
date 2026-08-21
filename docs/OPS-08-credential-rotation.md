# Nexus — Credential Rotation Runbook

**Document** OPS-08 · **Version** 1.0 · **Date** 21 August 2026
**Status** For operation
**Closes** audit finding F-1 · MASTER_AUDIT SEC-002 · roadmap risk R12
**Tool** `scripts/rotate-passwords.mjs` (`npm run rotate:passwords`)

* * *

## 0. Read this part even if you read nothing else

`demo1234` is in the public git history of this repository. It cannot be
un-published. Rewriting history would not help, because anyone who has cloned
the repo already holds it, and the nine account addresses are in the same file.

That produces one standing rule:

> **`demo1234` must be treated as a live, published credential on every
> deployment that has ever been seeded and is reachable from the internet, for
> the entire life of this project.** No later commit changes that. The only
> thing that changes it is running the rotation in §3 against that deployment.

The seed was fixed in wave 1 — `resolveSeedPassword()` in
`packages/db/src/seed/index.ts` refuses to write a password to a non-localhost
target unless `SEED_PASSWORD` is supplied, and refuses the published one
outright. **That fixed the next seed and changed nothing about the database that
was already seeded.** Production has not been rotated. Until §3 has been run
against it, `owner@sumon.test` / `demo1234` signs in as a principal whose role
expands to `["*"]`.

**This runbook is for reachable deployments only.** Do not run it against your
laptop. `scripts/e2e.mjs` and `scripts/security-test.mjs` sign in with
`demo1234` against the local database and will fail if you rotate it. If a local
database is in a bad state, the fix is `npm run db:seed`, not this tool.

* * *

## 1. What the tool does, in one paragraph

For each named account, in **one transaction**: generates a fresh 145-bit
password, hashes it with the same argon2id parameters `verifyPassword` uses
(64 MiB / 3 / 4 / 32), writes the hash, **reads it back out of the database and
verifies the new password against the stored bytes**, revokes every session the
account holds, clears the lockout and its sliding-window counters, and writes an
audit row naming who ran it and how many sessions died. The plaintext is printed
to stdout once and is never written to a file, a log, or the audit trail. If any
account fails at any step, the whole transaction rolls back and no password
changes.

It is a **dry run by default**. The dry run executes every one of those
statements against the real target and then rolls back, so it proves the
mechanism rather than predicting it.

What it does **not** rotate, and you must handle separately if this is an
incident rather than routine hygiene: `AUTH_SECRET`, `CRON_SECRET`,
`BACKUP_ENCRYPTION_KEY`, `PII_ENCRYPTION_KEYS` (see `npm run pii:rotate`), API
tokens in `api_tokens`, and the database role passwords themselves.

* * *

## 2. Before you start

- [ ] You have the **owner** connection string for the target database — the one
      used for migrations (`neondb_owner` on Neon), not `APP_DATABASE_URL`.
      The rotation itself works under either role, and the tool says which one
      it connected as. But `nexus_app` is `NOBYPASSRLS`, so row-level security
      hides `memberships` from it and the `ROLE` / `MFA` columns come back
      blank — which means the "this account will land on the enrolment screen"
      notice in step 6 cannot be produced. The tool warns loudly when that
      happens. Use the owner string.
- [ ] You have a **password manager open** and ready to receive nine entries.
      The passwords are shown once and cannot be recovered.
- [ ] You are in a **real terminal**, not a pipe, a CI job, or `tee`. The tool
      warns if stdout is not a TTY, but it cannot stop you redirecting it — and
      a rotation whose output ends up in `~/rotation.txt` has moved the problem,
      not solved it.
- [ ] Node 22+ and `npm install` has been run in this checkout.
- [ ] You know that everyone holding a session **will be signed out**. Tell them
      first if that matters.

Do **not** put the production URL on the command line — it lands in your shell
history. Read it into a variable instead, and point the tool at the variable:

```bash
read -rs -p "Production DATABASE_URL: " ROTATE_URL && export ROTATE_URL && echo
```

* * *

## 3. The procedure

### Step 1 — Ask the tool what it is pointed at

Run it with no `--host`. It refuses, and tells you the host it found. This is
the safest way to learn the hostname, because it comes from the URL you just
loaded rather than from your memory of it.

```bash
node scripts/rotate-passwords.mjs --url-env ROTATE_URL --all
```

```
✗ --host is required.
  ROTATE_URL currently points at "ep-xxxx-xxxx.ap-southeast-1.aws.neon.tech" (database "neondb").
  Re-run with --host ep-xxxx-xxxx.ap-southeast-1.aws.neon.tech if that is the database you mean to rotate.
```

**Stop and check that host and database name are the ones you mean.** This is
the moment where rotating the wrong database gets caught. Everything after this
point assumes you have.

### Step 2 — Dry run

```bash
node scripts/rotate-passwords.mjs \
  --url-env ROTATE_URL \
  --host ep-xxxx-xxxx.ap-southeast-1.aws.neon.tech \
  --all
```

Read the whole output before continuing. Check:

- the banner names the host, database and connecting role you expect;
- the account list is the accounts you expect, and the count is right;
- every line shows `password verified against stored hash`;
- it ends with `DRY RUN — transaction rolled back. Nothing changed.`

If any account reports a read-back failure, **do not proceed to step 3** —
the argon2id parameters in the script have drifted from
`apps/web/src/lib/crypto.ts` and a real run would brick that account. Fix the
drift first.

The `LIVE SESSIONS` column tells you how many people are about to be signed out.

### Step 3 — Commit

Same command, plus `--commit` **with the hostname typed again**. The repetition
is the confirmation; there is no interactive prompt.

```bash
node scripts/rotate-passwords.mjs \
  --url-env ROTATE_URL \
  --host ep-xxxx-xxxx.ap-southeast-1.aws.neon.tech \
  --all \
  --commit ep-xxxx-xxxx.ap-southeast-1.aws.neon.tech
```

### Step 4 — Capture, immediately

The output ends with a `NEW CREDENTIALS` block, one entry per account. **Put
every one of them into the password manager before you touch anything else.**
Do not switch windows, do not scroll away, do not "come back to it".

Record, per account: the email address, the password, and the role. The role
matters for step 6.

When they are all saved, **clear the scrollback** (`clear && printf '\033[3J'`
on most terminals) and unset the URL:

```bash
unset ROTATE_URL
```

### Step 5 — Verify each account signs in

For every rotated account, in a fresh private browsing window:

| | Expected |
|---|---|
| Old password `demo1234` | **Rejected.** If it is accepted, the rotation did not commit — go to §5. |
| New password | Accepted. |
| Where you land | `/` for most roles. **`/settings/security?mfa=required` for owner, general manager and accountant** — see step 6. |
| A browser that was already signed in | Bounced to `/login` on the next request. Its session was revoked. |

If an account was locked out before the rotation, it is not any more — the tool
clears `locked_until`, `failed_login_count` and the sliding-window
`login:fail:` / `login:lock:` keys, exactly as a successful sign-in does. A
rotated account that still refuses the new password is a real failure, not a
leftover lockout; go to §5.

### Step 6 — MFA enrolment (owner, general manager, accountant)

**This is expected behaviour and not a broken login.** Since wave 1, MFA is
required *by role*, not merely offered. `owner`, `general_manager`, `accountant`
and `super_admin` that have no second factor enrolled get a **restricted
`mfa_setup` session** on sign-in: the password was correct, but the session can
reach only the enrolment page, and `apps/web/src/proxy.ts` sends every other
path back to it.

So the first sign-in after rotation, for those three accounts, looks like this:

1. Enter the new password.
2. Land on `/settings/security?mfa=required` — not the dashboard.
3. Scan the QR code into an authenticator app, confirm a code.
4. **Save the ten recovery codes.** They are shown once, like the password.
5. The session upgrades to `full`; everything is reachable.

If the owner reports "the new password does not work, it just keeps sending me
to a settings page" — that is this, working correctly. Nothing is wrong.

The tool prints the affected accounts under an `MFA — expected behaviour` heading
so this is visible at rotation time rather than discovered at 9am.

### Step 7 — Close it out

- [ ] All accounts verified per step 5.
- [ ] MFA enrolled for the three required roles, recovery codes stored.
- [ ] The audit trail shows one `user.password_rotate` row per account:

```sql
SELECT at, actor_label, entity_id, diff->>'email', diff->>'sessionsRevoked'
  FROM audit_log
 WHERE action = 'user.password_rotate'
 ORDER BY at DESC;
```

- [ ] Update `docs/MASTER_PROJECT_STATE.md` §6 and §3 ("Four things three waves
      of work did NOT change"), `docs/MASTER_AUDIT.md` SEC-002 and
      `docs/03-roadmap.md` R12 to say rotated, with the date. Those documents
      currently assert the opposite, and an untrue "known live state" table is
      worse than no table.
- [ ] Scrollback cleared, `ROTATE_URL` unset, no file anywhere contains a
      password.

* * *

## 4. Rotating a single account

Same tool, `--account` instead of `--all`. Repeatable, or comma-separated.

```bash
node scripts/rotate-passwords.mjs --url-env ROTATE_URL \
  --host <host> --account owner@sumon.test
```

If any named address does not exist on that database, **the whole run is
refused** and nothing is rotated — including the addresses that did match. A
typo that rotates eight of nine accounts and reports success is exactly the
failure this refuses to produce.

Accounts with no password set (invited, never accepted) are **skipped** and
listed as such. Giving one a working password would create a login that did not
previously exist. `--include-passwordless` overrides this if that is genuinely
what you want.

* * *

## 5. If it goes wrong

### "Target mismatch — refusing to touch anything"

The hostname you typed and the hostname in the URL disagree. Nothing was read
and nothing was written. Work out which of the two is wrong before re-running —
this message is the control working, not an obstacle to route around.

### The run failed partway through

**It cannot half-apply.** Every account in a run shares one transaction. A
failure at any point — a read-back verification, a lost connection, a
constraint — rolls back all of it: no password changed, no session was revoked,
no audit row was written. The tool exits non-zero and says so.

So the recovery is simply: fix the cause, run the dry run again, confirm it is
clean, and commit again. There is no partial state to reconcile.

The one thing to check before re-running is the audit log. If there are
`user.password_rotate` rows from the failed attempt, the transaction did commit
and the failure was after it — treat the run as **successful** and go to the next
section instead.

### It committed but you lost the output

This is the realistic half-state, and it is not recoverable by reading anything:
the database holds only the argon2id hash and the plaintext exists nowhere.
Those accounts now have passwords nobody knows.

Fix: **run the rotation again for exactly those accounts** with `--account`, and
capture the output this time. There is no penalty for rotating twice, and the
audit trail will show both runs.

### An account still accepts `demo1234` afterwards

The run did not commit against the database you are testing. Two usual causes:
you ran the dry run and read its output as success (it says
`DRY RUN — transaction rolled back` at the end), or the URL pointed at a
different database from the one the site uses. Check `--url-env` against the
deployment's actual `APP_DATABASE_URL`/`DATABASE_URL` in Vercel, then repeat §3.

### Someone is locked out after rotation

Rotation clears lockouts, so a lockout after rotation is a *new* one — eight
failed attempts inside fifteen minutes, most likely the person typing the old
password from memory or a browser autofilling it. It expires on its own
(15 minutes, doubling on repeats, capped at an hour). Clear the saved password
in their browser before trying again.

* * *

## 6. Standing recommendations

1. **Rotate before real data enters the system**, not after. This is on the
   OPS-07 Phase 0 gate for a reason. Every day the deployment runs with the
   published password is a day the whole gate is decorative.
2. **Rotate again after any seed against a reachable target**, even a correct
   one with `SEED_PASSWORD`. A seeded password is known to whoever ran the seed
   and is typically sitting in a shell history or a CI secret.
3. **`demo1234` is never safe again** on anything reachable. Not after a fix, not
   in a preview deployment, not in staging. Vercel preview deployments currently
   share the production database, so a preview is production for this purpose.
4. **Rotate on personnel change.** Anyone who has held the owner or accountant
   credential and leaves means a rotation, same day.
5. **The tool is the record.** Rotations are auditable because they go through
   this script. A password changed with a hand-written `UPDATE users SET
   password_hash = ...` leaves no audit row, does not revoke sessions, and is
   how an account ends up bricked with the wrong argon2 parameters.

* * *

## 7. Command reference

```
node scripts/rotate-passwords.mjs [options]
npm run rotate:passwords -- [options]

  --host <hostname>        Required. The host you believe the URL points at.
                           Mismatch is fatal before anything is read.
  --all                    Every account that currently has a password.
  --account <email>        One account; repeatable or comma-separated.
                           Mutually exclusive with --all.
  --commit <hostname>      Write. The hostname must be repeated and match.
                           Omit for a dry run — the default.
  --url-env <VAR>          Env var holding the connection string.
                           Default DATABASE_URL.
  --operator <label>       Recorded in the audit row.
                           Default <user>@<machine>.
  --include-passwordless   Also rotate accounts with no password today.
  --help
```

* * *

## 8. Related

- `docs/04-security.md` §Seed credentials — the policy this implements
- `docs/OPS-07-golive-runbook.md` §1.4 — the Phase 0 security gate
- `packages/db/src/seed/index.ts` `resolveSeedPassword()` — the seed-side gate
- `apps/web/src/lib/crypto.ts` — the argon2id parameters that must match
- `apps/web/src/lib/mfa.ts`, `apps/web/src/proxy.ts` — the `mfa_setup` state
- `npm run pii:rotate` — PII encryption key rotation, a different problem
