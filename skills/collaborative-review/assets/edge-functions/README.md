# Server functions

The four Supabase Edge Functions behind the collaborative review backend. Reading
feedback never happens in the browser: the page can only write. Everything that reads
goes through these, and they require the dashboard password.

| Function | What it does |
|---|---|
| `read-feedback/index.ts` | Returns feedback for the dashboard, optionally filtered by project and material, with signed URLs for audio |
| `clean-orphans/index.ts` | Deletes audio files that have no matching database row |
| `record-decision/index.ts` | Lets the correction engine record a structural item awaiting a human decision |
| `approvals/index.ts` | Carries the owner's verdicts from the dashboard back to the machine running the watcher |

Only `read-feedback` is strictly required. The other three add orphan cleanup and the
structural-decision workflow.

## Deploy order

Getting this out of order produces confusing errors, so:

1. **Apply the schema first.** `read-feedback` selects the scope columns. Deployed before
   the migration, it fails with "column does not exist", which looks like a code bug and
   is not.
2. **Configure the password**, by one of the two paths below. With neither, the functions
   answer 500 to every call. That is deliberate: a read endpoint that works without a
   password would expose every reviewer comment.
3. **Deploy with JWT verification off** (see below).
4. **Smoke test** before considering it done.

## Configuring the password

Two paths. The environment secret wins if both exist.

**Path A, a config table in the database.** Run `assets/sql/04-dashboard-config.sql`,
replacing `{{DASHBOARD_PASSWORD}}` with the real password. The table has row-level
security on and **no policies at all**, so anonymous callers cannot read it or discover
it exists; only the service role, meaning these functions, can see it. The advantage is
that it applies through plain SQL, with no CLI and no dashboard access needed.

**Path B, an environment secret.**

```bash
supabase secrets set DASHBOARD_PASSWORD="<password>" --project-ref <your-ref>
```

Or through the web dashboard, under Edge Functions and then Secrets.

Never commit the password. This README does not contain one, on purpose.

## Deploying

```bash
supabase functions deploy read-feedback   --no-verify-jwt
supabase functions deploy clean-orphans   --no-verify-jwt
supabase functions deploy record-decision --no-verify-jwt
supabase functions deploy approvals       --no-verify-jwt
```

**`--no-verify-jwt` is required and is not a security hole.** These functions
authenticate with the password in the request body, not with a Supabase session. With
verification on, they reject every call before the password is ever read, and the error
does not point at the cause.

After deploying, confirm the flag stuck. If it silently flipped to true, the dashboard,
the watcher, and the engine all stop at once.

## Smoke test

Test the **wrong** password first:

```bash
curl -s -X POST "https://<your-ref>.supabase.co/functions/v1/read-feedback" \
  -H "Content-Type: application/json" -d '{"password":"wrong-on-purpose"}'
```

A 401 is the result you want. A 200 here means the function is protecting nothing, and
you want to discover that before sending a review link to anyone.

Then repeat with the real password and confirm a 200 carrying the expected fields.

## A note on field names

Request and response fields are in Portuguese (`password`, `project`, `material`) because
they are the wire format shared with the page, the database, and the watcher. Renaming
them would break every deployment already running this schema, so they stayed. Everything
a human reads is in English.
