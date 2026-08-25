-- ============================================================================
-- 01-table-rls.sql — SEQUENCE A (brand new project)
-- Skill: collaborative-review
--
-- Creates public.feedbacks with the full scope (project + material + type NOT
-- NULL), grants the anonymous role permission to insert, and adds the
-- row-level security policy that allows ONLY anonymous inserts, with size
-- validation on every field.
--
-- Do NOT use this file on a backend that already has the table. There the
-- correct path is 03-scope-migration.sql (sequence B). This one is for a new
-- backend only.
--
-- Column names are in Portuguese because they are the wire format shared with
-- the page, the server functions, and the watcher. Renaming them would break
-- every deployment already running this schema.
--
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Block 1 - the feedbacks table
-- Each row is ONE reviewer submission: text comment and/or audio, tied to a
-- section of the material. The scope (project, material) keeps materials in
-- the same backend separate, so nothing bleeds between projects.
-- ----------------------------------------------------------------------------
create table if not exists public.feedbacks (
  id          bigint generated always as identity primary key,
  reviewer_name        text not null,                        -- reviewer name (e.g. "Sam Rivera")
  section       text not null,                        -- section commented on (plain name)
  comment  text,                                 -- feedback text (optional when audio exists)
  audio_path  text,                                 -- path to the audio file in the bucket
  user_agent  text,                                 -- the reviewer's browser (tiebreaker de identidade)
  project     text not null,                        -- escopo: qual projeto (ex: "my-project")
  material    text not null,                        -- escopo: qual material (e.g. "Onboarding Guide")
  type        text not null default 'comment',   -- 'comment' | 'conclusion' (finish button)
  created_at  timestamptz not null default now()    -- orders the engine's queue
);

-- ----------------------------------------------------------------------------
-- Block 2 - turn row-level security on
-- With row-level security on and NO select policy, the anonymous public can
-- only do what the policy below allows, which is insert. Reading happens through
-- the read-feedback server function instead, which holds the service role key.
-- This is deliberate: a reviewer writes, and never reads what anyone else wrote.
-- ----------------------------------------------------------------------------
alter table public.feedbacks enable row level security;

-- ----------------------------------------------------------------------------
-- Block 3: anonymous insert policy, with validation
-- Each check stops abuse at the database itself. The reviewer's browser holds
-- public and anonymous, so this is the last line of defense):
--   - reviewer_name: 1 a 120 caracteres
--   - section: 1 a 500 caracteres
--   - comment: up to 5000 characters (may be null)
--   - audio_path: up to 300 characters (may be null)
--   - projeto and material: 1 to 80 characters (required in sequence A)
--   - type: only 'comment' or 'conclusion'
--   - the "text OR audio" rule: at least one of the two must be present
--     (orphan prevention: the kit validates BEFORE uploading; the database
--     guarantees an empty row cannot get in at all)
-- ----------------------------------------------------------------------------
-- ----------------------------------------------------------------------------
-- TABLE PRIVILEGE (not the same thing as the policy below).
--
-- Postgres checks two independent layers on every write: the GRANT decides
-- whether the role may touch the table at all, and the row-level policy decides
-- which rows it may write. A policy without a grant fails with
-- "permission denied for table feedbacks", which reads like a policy bug and
-- costs an afternoon to diagnose.
--
-- Supabase usually grants this by default, but not in every project, and the
-- failure only shows up when a real reviewer tries to submit. Granting it
-- explicitly is idempotent and removes the guesswork.
-- ----------------------------------------------------------------------------
grant insert on public.feedbacks to anon;

-- NOTE: no sequence grant here, on purpose.
--
-- An earlier version of this file granted usage and select on ALL sequences in the
-- schema to the anonymous role. That was both unnecessary and too wide: the id
-- column above is `generated always as identity`, which needs no sequence
-- permission from the inserting role, and the grant reached every sequence in the
-- schema, including those of unrelated applications sharing the same project.
-- In a file whose whole argument is least privilege, that was the easiest
-- contradiction for a reviewer to find.

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
    and char_length(project) between 1 and 80
    and char_length(material) between 1 and 80
    and type in ('comment', 'conclusion')
    and (
      char_length(coalesce(comment, '')) >= 1
      or char_length(coalesce(audio_path, '')) >= 1
    )
  );

-- ----------------------------------------------------------------------------
-- NO select policy, on purpose.
-- Do not create a read policy for anon: the dashboard and the correction engine
-- read through the server function with the service role. A SELECT policy here
-- would expose every reviewer's feedback to anyone holding the link.
-- ----------------------------------------------------------------------------
