# Setup

The skill needs somewhere to store reviewer feedback and audio. That has to be your own
Supabase project, so this step cannot be skipped. Budget about fifteen minutes.

Nothing here costs money. The free tier is enough for real use.

> **Before you start, one thing that decides how far you can go.**
>
> Steps 1 to 4 (the backend, the review kit, the dashboard) work on any operating
> system. Step 5, the watcher that applies corrections unattended, is a PowerShell
> script scheduled through Windows Task Scheduler and runs on **Windows only**.
>
> On macOS or Linux you can collect feedback normally and apply the corrections by
> hand. You cannot run the automatic loop yet. Better to know now than after the
> backend is provisioned.

## 1. Create the project

Sign up at [supabase.com](https://supabase.com), create a project, and keep these two
values from **Project Settings → API**:

| Value | Where it goes |
|---|---|
| Project URL (`https://xxxx.supabase.co`) | The kit config, as `SUPABASE_URL` |
| `anon` public key | The kit config, as `SUPABASE_ANON_KEY` |

The `anon` key is public by design. It identifies the project, it does not grant access.
What protects your data is the security policy in step 2, which lets anonymous visitors
write and never read.

## 2. Create the schema

Open **SQL Editor** in the Supabase dashboard and run these three files, in order, from
`skills/collaborative-review/assets/sql/`:

| File | What it creates |
|---|---|
| `01-table-rls.sql` | The `feedbacks` table, the insert-only policy for anonymous visitors, and the table privilege that policy depends on |
| `02-bucket-storage.sql` | A private storage bucket for reviewer audio, capped at 15 MB with an allowlist of audio types |
| `04-dashboard-config.sql` | The config table holding the dashboard password |

All three are idempotent. Running them twice does no harm.

Before running `04`, replace `{{DASHBOARD_PASSWORD}}` with the password you want. It
protects reading the feedback, so treat it like any other password: not a word, not
reused, and not committed anywhere.

If you also want the approval buttons for structural decisions, run `05-approvals.sql`.

### The failure everyone hits

If a reviewer submits and gets `permission denied for table feedbacks`, the security
policy is fine and the table privilege is missing. Postgres checks two separate layers:
the grant decides whether the role may touch the table at all, and the policy decides
which rows it may write. `01-table-rls.sql` now grants it explicitly, so this should not
happen. If you set the table up before that fix existed, run:

```sql
grant insert on public.feedbacks to anon;
```

## 3. Deploy the server functions

Reading feedback never happens in the browser. It goes through server functions that
require the password. Deploy them from
`skills/collaborative-review/assets/edge-functions/`:

```bash
supabase functions deploy read-feedback   --no-verify-jwt
supabase functions deploy clean-orphans   --no-verify-jwt
supabase functions deploy record-decision --no-verify-jwt
supabase functions deploy approvals       --no-verify-jwt
```

`--no-verify-jwt` is required and is not a security hole: these functions authenticate
with the password in the request body, not with a Supabase session. Without the flag,
they reject every call before your password is ever checked.

Only `read-feedback` is strictly required. The other three add orphan cleanup and the
structural-decision workflow.

### Smoke test before trusting it

```bash
curl -s -X POST "https://YOUR_PROJECT_REF.supabase.co/functions/v1/read-feedback" \
  -H "Content-Type: application/json" -d '{"password":"wrong-on-purpose"}'
```

You want a 401 here. A function that answers 200 to a wrong password is not protecting
anything, and it is better to find that out now than after you send the link out.

Then repeat with the real password and confirm you get a 200.

## 4. Verify the gate

```bash
node skills/collaborative-review/scripts/gate.mjs selftest
```

Expect twelve passes and zero failures. If anything fails, do not use the skill on real
work until it is fixed. The gate is what makes automatic correction safe; an unverified
gate is just an agent editing your files with extra steps.

## 5. Optional: voice transcription

Reviewers can leave voice notes without any of this, and you can listen to them in the
dashboard. Transcription only matters if you want the correction engine to act on spoken
feedback automatically.

Put an API key for your transcription provider in a `.env` file outside version control,
and point `assets/transcribe-feedback.tmpl.py` at it. The template ships configured for a
Whisper-compatible endpoint.

## 6. The watcher, for the unattended loop (Windows only)

Everything above collects feedback. This step is what makes corrections apply on
their own, and it is the part that only runs on Windows. Skip it on macOS or Linux:
you can still read the dashboard and ask the agent to apply the corrections by hand.

**What the watcher does.** Every ten to fifteen minutes it asks the backend whether
any reviewer clicked "I finished my review". When one did, it wakes the agent with
the correction protocol, and stays out of the way otherwise. It never kills a
process, and when it has nothing to do it writes nothing to the log.

### 6.1 Create the machine's copy

The watcher ships as a template with six placeholders. Instantiate it ONCE PER
MACHINE, not per project: one watcher serves every material in the registry.

Copy `skills/collaborative-review/scripts/watcher.tmpl.ps1` to a working folder,
name it `collaborative-review-watcher.ps1`, and copy `sync-approvals.ps1` next to it
(the watcher loads it from its own folder). **Keep "collaborative-review" in the file
name**: the watcher recognises its own running instance by that string, and renaming
it breaks the check that stops two copies running at once.

Replace the six placeholders:

| Placeholder | What to put there |
|---|---|
| `{{REGISTRY_PATH}}` | Full path to your `materials-registry.json` (see 6.2) |
| `{{EDGE_FN_URL}}` | The full read-feedback function URL, the same one the dashboard uses |
| `{{PASSWORD_PATH}}` | Full path to a text file holding ONLY the dashboard password |
| `{{PROTOCOL_PATH}}` | Full path to your instantiated copy of `engine-protocol.tmpl.md` |
| `{{CLAUDE_ALLOWED_TOOLS}}` | The pre-approved tool list for the headless run (see 6.3) |
| `{{LOG_PATH}}` | Where the watcher writes its log |

The password goes in a FILE, never inline. A password on a command line is visible
to every other process on the machine.

### 6.2 The materials registry

A JSON file listing what the watcher should watch. Start from
`skills/collaborative-review/scripts/materials-registry.example.json`:

| Key | Meaning |
|---|---|
| `project` / `material` | The scope pair, exactly as configured in the review kit |
| `projectFolder` | Full path to the project folder on this machine |
| `htmlFile` | The HTML file the corrections are applied to |
| `publishCommand` | Optional. A command run after a successful batch, to republish |
| `branch` | The git branch corrections are committed to. **Required**: the watcher refuses an entry without it, so it never applies a correction to a branch you did not name |

These keys are the wire format shared with the sync module and the engine. They
match the column names in the database, and renaming one means changing every
piece that reads it, in the same commit.

### 6.3 The tool list, and what it means

The headless run needs its permissions pre-approved, or it hangs forever waiting for
a prompt nobody will answer. **Grant the narrowest set that works.** This list is the
real boundary of what the agent can do on your machine, and reviewer comments reach
the agent as text, so treat it as a security decision rather than a configuration
detail. If you set `publishCommand`, the list has to include command execution, and
that widens the boundary considerably. Start without it.

### 6.4 Schedule it

Register a scheduled task that runs the script every 10 to 15 minutes, with:

- **start when available**, so a missed run is recovered after the machine sleeps
- **do not stop on idle end**, or it dies mid-correction
- **ignore new instances**, so runs never overlap
- **allowed to run on battery**
- **an execution time limit of 30 to 60 minutes** — this is what kills a hung run;
  any lock it leaves behind is cleaned on the next tick
- **run whether the user is logged on or not**

### 6.5 Confirm it is alive

Run the script once by hand. With an empty registry it logs a single line and exits.
With a material registered and no new conclusions, it writes nothing at all: silence
IS the healthy state. If it logs on every tick, something is wrong, and a watcher
that talks constantly is one you stop reading.

## Done

Install the skill and try it on a throwaway page first:

```
open test.html for review
```

Submit a comment as if you were a reviewer, watch it land in the dashboard, then click
"I finished my review" and watch the gate run. Seeing it refuse something once is worth
more than reading any of this.
