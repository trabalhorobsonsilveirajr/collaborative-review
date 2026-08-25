# Provisioning the backend (Phase 3)

Three possible sequences, chosen by the material's situation. The SQL files live in
`assets/sql/` and are all idempotent, so running one twice does no harm. The server
functions live in `assets/edge-functions/`, with deploy order in the README there.

## Decision table

| Situation | Sequence | What to run |
|---|---|---|
| Brand new project (new Supabase project, or no table yet) | A | `01-table-rls.sql` + `02-bucket-storage.sql` + `04-dashboard-config.sql` + deploy the functions |
| A backend already exists but has no scope columns (no project / material / type) | B | `03-scope-migration.sql` + `04-dashboard-config.sql` + redeploy `read-feedback` and `clean-orphans` |
| Backend already scoped, a new material arriving | C | No SQL. Use the new scope in the kit and register the material |

**If you are setting this up for the first time, you are in situation A.** Sequences B
and C exist for backends that predate the scope columns, or for adding another material
to a backend that already works.

## Sequence A: new from scratch

1. `01-table-rls.sql` creates `feedbacks` with the full scope. Here `project` and
   `material` are NOT NULL, because there is no legacy HTML to preserve. It also grants
   the anonymous role permission to insert, which the policy alone does not do.

2. `02-bucket-storage.sql` creates a private bucket for audio, capped at 15 MB with an
   allowlist of audio types, plus an upload-only policy scoped to that bucket. The bucket
   name is parameterizable: change it in all three places in the SQL and in the
   `BUCKET_AUDIO` placeholder of the kit.

3. `04-dashboard-config.sql` creates the config table holding the dashboard password.
   Replace `{{DASHBOARD_PASSWORD}}` with the real password when applying, and never
   commit it.

4. Deploy `read-feedback` and `clean-orphans` with `verify_jwt=false`. If the material
   will use the correction engine, deploy `record-decision` as well, with the same flag.
   For the approval buttons, also run `05-approvals.sql` and deploy `approvals`.

## Sequence B: migrating a live backend

1. `03-scope-migration.sql` is additive and non-destructive. It adds `project` and
   `material` as NULLABLE, adds `type` as NOT NULL defaulting to `comment`, backfills
   only where NULL, and recreates the policy preserving every original check. HTML
   already published that does not send the new columns keeps inserting fine.

2. `04-dashboard-config.sql` puts the password in the database, if it is not there yet.

3. Redeploy `read-feedback`, which selects the new columns. Deploying it **before** the
   migration fails with "column does not exist", so the order matters. Then
   `clean-orphans`.

## Dashboard password: two paths

The environment secret wins if both exist.

| | Path A: config table | Path B: environment secret |
|---|---|---|
| How to apply | `04-dashboard-config.sql`, through the SQL editor | `supabase secrets set DASHBOARD_PASSWORD="<password>"` |
| Priority | Fallback, used when the secret does not exist | Wins over the table when set |
| Automation | Fully applicable through SQL, versionable | Requires the CLI or the dashboard |
| Security | Row-level security on with no policies at all: anonymous cannot read it or know it exists. Only the service role sees it | Equivalent trust model |

Path A exists because setting a secret requires an interactive session that automation
may not have. Never commit the password itself; the versioned SQL carries only a
placeholder.

## Mandatory checks

- **Always smoke test after applying any sequence**, before calling it done:

  ```bash
  curl -s -X POST "<EDGE_FN_URL>/read-feedback" \
    -H "Content-Type: application/json" -d '{"password":"<password>"}'
  ```

  The right password must return 200 with the feedback rows, including the `type`,
  `project`, and `material` fields. **A wrong password must return 401.** Test the wrong
  password first: a function that answers 200 to a bad password is not protecting
  anything, and you want to learn that before sending the link out.

  On sequence B, also insert one test row in the old format, without project or material,
  confirm it still goes in, and remove it.

- **Never migrate during a live review without verifying.** The sequence B migration is
  harmless to already-published HTML because the new columns are nullable, but the smoke
  test comes before any HTML deploy, and a material under review is not redeployed until
  the review closes.

- **After deploying, confirm `verify_jwt` is still false on every function.** If it
  flipped to true, the dashboard, the watcher, and the engine all stop immediately, and
  the error they return does not obviously point at this.

## When an insert fails with "permission denied"

The policy is not the problem. Postgres checks the table grant and the row policy
separately, and a policy without a grant produces exactly this error. `01-table-rls.sql`
grants it explicitly, but if your table was created before that:

```sql
grant insert on public.feedbacks to anon;
```
