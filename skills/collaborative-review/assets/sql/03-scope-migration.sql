-- ============================================================================
-- 03-scope-migration.sql — SEQUENCE B (migrating a live backend)
-- Skill: collaborative-review
--
-- Additive and non-destructive. Adds project and material as NULLABLE, adds
-- type as NOT NULL defaulting to 'comment', backfills only where NULL, and
-- recreates the insert policy preserving EVERY original check.
--
-- Why nullable here and NOT NULL in sequence A: HTML already published does
-- not send the new columns. Making them required would break inserts from
-- pages that are live right now, mid-review.
--
-- ORDER MATTERS: run this BEFORE redeploying the read function. That function
-- selects the new columns and fails with "column does not exist" if deployed
-- first.
--
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Block 1: new columns (additive; nothing removed or altered)
--   - projeto/material: NULLABLE on purpose; live pages do not send them.
--   - type: NOT NULL com default 'comment'. Com default, o Postgres
--     fills existing rows and inserts that omit the column.
--     'conclusion' is the signal from the finish-review button.
-- ----------------------------------------------------------------------------
alter table public.feedbacks
  add column if not exists project  text,
  add column if not exists material text,
  add column if not exists tipo     text not null default 'comment';

-- ----------------------------------------------------------------------------
-- Block 2: backfill live rows (rows from a review already in progress)
-- Fills scope ONLY where it is NULL. Rows that already carry scope are left
-- untouched, which makes this safe to run more than once.
-- re-run, or a new material) are left untouched.
-- ----------------------------------------------------------------------------
update public.feedbacks
   set project = 'my-project'
 where project is null;

update public.feedbacks
   set material = 'Onboarding Guide'
 where material is null;

-- ----------------------------------------------------------------------------
-- Block 3: recreate the anonymous insert policy (additive)
-- Keeps EVERY original check from the live backend:
--   - reviewer_name: 1 a 120 caracteres
--   - section: 1 a 500 caracteres
--   - comment: up to 5000 characters (may be null)
--   - audio_path: up to 300 characters (may be null)
--   - the "text OR audio" rule: at least one of the two present
--     (orphan prevention stays guaranteed by the database)
-- and ADDS checks for the new columns, accepting NULL, because pages published
-- published HTML does not send project/material and must keep inserting:
--   - project: NULL ou 1 a 80 caracteres
--   - material: NULL ou 1 a 80 caracteres
--   - type: only 'comment' or 'conclusion'
-- ----------------------------------------------------------------------------
drop policy if exists permitir_envio_anonimo on public.feedbacks;

create policy permitir_envio_anonimo
  on public.feedbacks
  for insert
  to anon
  with check (
    char_length(reviewer_name) between 1 and 120
    and char_length(section) between 1 and 500
    and (comment is null or char_length(comment) <= 5000)
    and (audio_path is null or char_length(audio_path) <= 300)
    and (project is null or char_length(project) between 1 and 80)
    and (material is null or char_length(material) between 1 and 80)
    and type in ('comment', 'conclusion')
    and (
      char_length(coalesce(comment, '')) >= 1
      or char_length(coalesce(audio_path, '')) >= 1
    )
  );

-- ----------------------------------------------------------------------------
-- Still NO select policy, on purpose.
-- Reading stays exclusive to the read-feedback server function (service role),
-- que na v3 passa a aceitar filtro {project, material} e a retornar tipo.
-- ----------------------------------------------------------------------------
