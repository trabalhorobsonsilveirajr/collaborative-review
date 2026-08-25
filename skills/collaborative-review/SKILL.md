---
name: collaborative-review
description: >
  Use when someone wants to collect feedback on an HTML page or landing page, open a
  document for review, add comment or voice fields to a material, send something out
  for client review, publish a review link, ask about a review kit, or apply the
  corrections reviewers asked for.
license: MIT
compatibility: >
  Collecting feedback works on any operating system and needs Node 18+ and a Supabase
  project. The unattended correction loop additionally needs Windows 10/11 with
  PowerShell 7 and Task Scheduler. Voice transcription is optional and needs Python 3.
allowed-tools: Read, Write, Edit, Bash, Grep, Glob
metadata:
  version: "2.0"
---

# Skill: collaborative-review

> **This skill is a guide that Claude follows.** When it is triggered, read this file
> completely and run Phases 0 through 6 below, stopping at every gate marked STOP. The
> details live in `references/`. Read the reference for the phase you are in, not all of
> them at once.

## What it does, in three lines

It turns any HTML page into a reviewable document: comment fields plus voice recording
attached to each section. Reviewers work through the published link. When a reviewer
finishes, an automatic cycle applies the small corrections by itself and routes anything
structural to the owner for a decision.

## Non-negotiable laws

These govern every phase. Each one exists because breaking it costs more than following
it.

1. **Never inject the kit before the owner has approved the draft.** External review is
   for polishing approved content, not for outsourcing the owner's taste. Opening an
   unapproved draft produces feedback about things that were already going to change.

2. **Never regress the kit's three invariants.** Orphan prevention (validate before
   upload), the recorder's state machine (double-click lock), and `@media print` hiding
   the whole kit. Each one came from a real production bug. Details in
   `references/review-kit-template.md`.

3. **Version control is required in the target project.** Without it there is no cheap
   way to undo an automatic correction. If the project has no repository, initialize one
   in Phase 0 before touching anything else, with a `.gitignore` that covers credentials.

4. **When in doubt, the change is STRUCTURAL and the engine stops.** The bias is
   deliberate: asking the owner costs minutes, while applying a wrong fix costs a
   client-facing material and the owner's trust.

5. **Never touch a material with a live review in progress without verifying first.** A
   database migration, a redeploy, or an edit while a reviewer is working requires a
   smoke test beforehand and proof that nothing breaks.

6. **The gate never blocks the loop, and never lowers its bar either.** If a correction
   cannot pass the gate, it is not promoted and the owner is told why. The loop moves on
   to the next batch instead of stalling, but a batch that failed stays failed.

## How does the material get in?

| Scenario | Signal | How to enter |
|---|---|---|
| (a) Alongside creation | The page is being built right now and review was requested up front | Run Phases 2 through 4. The Phase 1 gate is already satisfied by the creation flow's own sign-off |
| (b) Existing HTML | The material already exists, made by hand or by another tool | Run all phases, 0 through 6, starting with target detection and an explicit approval gate |

The kit is identical in both. What differs is who already approved the draft, and how
much context (project, material, selectors) is already in hand.

---

## The flow: Phases 0 to 6

| Phase | Name | Gate | Output |
|---|---|---|---|
| 0 | Detect target and scenario | none | Target HTML, selectors, project, material, version control confirmed |
| 1 | Approval gate | STOP: law 1 | Green light |
| 2 | Build and inject the kit | STOP: preview over HTTP | HTML with the kit and three invariants verified |
| 3 | Backend (A/B/C) | STOP: confirm new vs migrate vs reuse | Project and material scope live |
| 4 | Publish, register, verify | STOP: end-to-end test | Live URL plus registry entry |
| 5 | Activate the correction engine | none | Watcher covers the material, loop is on |
| 6 | Close the final version | STOP: final approval | Kit disabled, clean redeploy, orphans cleaned |

### Phase 0: detect target and scenario

1. Identify the scenario from the table above. In scenario (a), project and material are
   already known, so skip to item 4.

2. Locate the target HTML and define `project` (the project folder name) and `material`
   (a human-readable name for the piece). These two values are the scope key across the
   entire system: the database, the dashboard, and the engine. Getting them wrong mixes
   different projects together.

3. Determine the kit selectors by inspecting the HTML: `SECTION_SELECTOR`,
   `SECTION_TITLE_SELECTOR`, `SECTION_BODY_SELECTOR`, `NAME_BAR_ANCHOR`, `SECTION_LABEL`.
   Follow the validation checklist in `references/review-kit-template.md`, which uses an
   exact section count. A wrong selector puts a comment box on a decorative card, or
   leaves a real section without one.

4. Check version control in the project folder. No repository means `git init`, a
   `.gitignore` covering credentials and secrets, and a baseline commit before touching
   any file (law 3).

### Phase 1: approval gate (STOP)

- Scenario (a): the creation flow's own sign-off is the approval. Do not ask again.
- Scenario (b): ask the owner explicitly whether the content is approved to open to
  reviewers. Proceed only on a clear yes.

The gate exists because the kit publishes the material for other people to comment on.

### Phase 2: build and inject the kit (STOP)

1. Assemble the config JSON with the ten placeholders. A filled example lives in
   `assets/example-config.json`, and each field is explained in
   `references/review-kit-template.md`.

2. Run the injector:

   ```bash
   node scripts/build-kit.mjs --kit assets/review-kit.tmpl.html --config <config.json> --target <page.html>
   ```

   It validates the whole config, backs up the target, refuses re-injection, and writes
   atomically.

3. Serve over local HTTP, never `file://`. Browsers block `file://`, so nobody, human or
   agent, can actually see the rendered page.

4. Verify in the preview: the name bar is in place, there is exactly one comment block
   per section (check the count), the recorder opens and resists double clicks, printing
   is clean, and the "I finished my review" button appears exactly once at the end.

5. STOP: show the preview to the owner and wait for approval.

### Phase 3: backend (STOP)

STOP: confirm which situation applies before running any SQL. Touching a live database
without confirming violates law 5.

| Situation | Sequence | What to run |
|---|---|---|
| Brand new project (no table yet) | A | `01-table-rls.sql` + `02-bucket-storage.sql` + `04-dashboard-config.sql` + deploy the Edge Functions |
| Backend exists but has no scope columns | B | `03-scope-migration.sql` (additive, with backfill) + `04-dashboard-config.sql` + redeploy `read-feedback` |
| Backend already scoped, new material arriving | C | No SQL. Use the new scope in the kit and register the material |

Step by step for each sequence, both password paths, and the mandatory warnings are in
`references/provision-backend.md`. **Most people setting this up for the first time are
in situation A.** The table shape and what lives where is in
`references/backend-supabase.md`.

The rule of this phase: always finish with a smoke test of `read-feedback`, confirming
200 with the right password and 401 with a wrong one, before declaring the backend ready.

### Phase 4: publish, register, verify (STOP)

1. Publish the HTML with the kit. If the hosting platform has access protection enabled,
   turn it off for this link, or reviewers cannot open it.

2. Instantiate the dashboard if there is not one yet, from `assets/dashboard.tmpl.html`.
   Its only placeholder is `{{EDGE_FN_URL}}`. One dashboard serves every material in the
   backend, filtered by project and material.

3. Register the material in your materials registry file (template:
   `scripts/materials-registry.example.json`): project folder, HTML file, publish
   command, branch. Without this entry the watcher does not know where to apply
   corrections.

4. STOP: test end to end on the published URL, not the local preview. Submit a name, one
   test comment, and one short audio clip. Confirm both appear in the dashboard, with the
   audio playable through a signed URL. Then delete the test rows and the test audio.
   Only call this phase done with that test green.

5. Hand the URL to the owner to pass along to reviewers.

### Phase 5: activate the correction engine

1. Confirm the machine's watcher exists and is scheduled. It is instantiated from
   `scripts/watcher.tmpl.ps1`, one per machine rather than one per project. Exact flags
   and reasoning are in `references/correction-engine.md`.

2. The watcher reads the materials registry. A material registered in Phase 4 is a
   material covered. There is no extra per-material step.

3. Confirm the engine's prerequisites: the state folder is created on first run, the
   `record-decision` function is deployed (it carries the structural-decision notice to
   the dashboard), and the headless run has its tool permissions pre-allowed. A headless
   run without them stalls waiting for a permission nobody is watching.

### Phase 6: close the final version (STOP)

1. STOP: final approval from the owner on the corrected material.
2. Switch the kit's `REVIEW_MODE` flag from true to false. With false the kit renders
   nothing, so the page comes out clean without surgery on the HTML.
3. Clean redeploy, then confirm on the live URL that the fields are gone and printing is
   clean.
4. Run the `clean-orphans` function to remove audio files with no matching database row.
5. Final commit, and update the project's own documentation.

---

## The correction engine

The automatic cycle that runs after the skill has activated a material. Full detail in
`references/correction-engine.md`, and the quality gate that guards it in
`references/quality-gate.md`.

1. **Signal**: the reviewer clicks "I finished my review", which inserts a row of type
   `conclusion`.

2. **Watcher**: on a schedule, it compares conclusions from the Edge Function against a
   local ledger. A new conclusion takes a lock and invokes the engine. Multiple reviewers
   are always processed serially, first in first out.

3. **Engine**: for one conclusion, it compiles and transcribes that reviewer's feedback,
   deduplicates against what was already applied, classifies each item as pointwise or
   structural (when in doubt, structural, per law 4), sends the pointwise batch through
   the quality gate, records what was applied, writes structural items out for the owner
   to decide, commits, republishes, and releases the lock.

4. **The gate**: every pointwise batch is prepared in an isolated copy, checked
   mechanically for staying in its lane, and judged by independent critics who must be
   unanimous. Anything short of that is not promoted. This is the part that makes
   automatic correction safe to leave running, and it is described in full in
   `references/quality-gate.md`.

## What this skill does NOT do

- It does **not** inject the kit without prior approval of the draft (law 1).
- It does **not** read feedback in the browser. Anonymous visitors can only insert, which
  is enforced by row-level security. Reading always goes through an Edge Function with a
  password. The public key in the HTML is public by design; the security policy is what
  protects the data.
- It does **not** commit secrets. The dashboard password lives in config or a secret, the
  transcription API key lives outside version control, and the versioned SQL carries only
  a placeholder.
- It does **not** mix projects. Every insert, filter, and correction carries project and
  material. A material with no registry entry is never touched by the engine.
- It does **not** apply a structural change without the owner (law 4).
- It does **not** republish the final material without approval. Phase 6 has an explicit
  gate. What the engine republishes on its own is only the review URL, which is a
  work-in-progress artifact and revertible through version control.
- It does **not** promote a correction its critics rejected. The gate refuses, says why,
  and leaves the live file untouched.

## Setup for first-time users

Read `SETUP.md` in the repository root. The short version:

1. Create a Supabase project (the free tier is enough).
2. Run situation A from `references/provision-backend.md`.
3. Deploy the four Edge Functions with `verify_jwt=false`.
4. Verify the gate before trusting it: `node scripts/gate.mjs selftest`.

## Changelog

| Version | What changed |
|---|---|
| 2.0 | First public release. Portable quality gate with mechanical scope checking, unanimous critics, and a self-test; generic backend provisioning; no host-specific dependencies |
| 1.0 | Internal release: parameterized kit, scoped backend, automatic correction engine |
