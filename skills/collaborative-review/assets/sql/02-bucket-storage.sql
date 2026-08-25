-- ============================================================================
-- 02-bucket-storage.sql — SEQUENCE A (brand new project)
-- Skill: collaborative-review
--
-- Creates the PRIVATE storage bucket for reviewer audio and the policy that
-- allows anonymous upload (insert) into that bucket only.
--
-- BUCKET NAME is parameterizable; the default is 'audios-feedback'. To use a
-- different one, change it in ALL THREE places in this file (bucket id,
-- bucket name, and the policy's bucket filter) and use the same name in the
-- kit's BUCKET_AUDIO placeholder.
--
-- Private matters: files in a private bucket cannot be fetched by URL. The
-- dashboard receives short-lived signed URLs minted by the server function.
--
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Block 1 - private bucket, with a size cap and an allowed-format list
--   - public = false: PRIVATE. Nobody fetches audio by public URL;
--     reading goes through the server function with the service role.
--   - file_size_limit = 15728640 (15 MB): the per-file ceiling.
--     Plenty for minutes of compressed audio, and it caps upload abuse.
--   - allowed_mime_types: the formats real browsers actually produce through
--     MediaRecorder (webm/ogg on Chrome and Firefox, mp4/m4a/aac on Safari),
--     plus mpeg and wav for safety. Any other type is refused.
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'audios-feedback',
  'audios-feedback',
  false,
  15728640,
  array[
    'audio/webm',
    'audio/ogg',
    'audio/mp4',
    'audio/mpeg',
    'audio/wav',
    'audio/x-m4a',
    'audio/aac'
  ]
)
on conflict (id) do nothing;

-- ----------------------------------------------------------------------------
-- Block 2: anonymous upload policy, restricted to THIS bucket
-- storage.objects is the storage system's internal table; its row-level
-- security is on by default. This policy lets the anonymous role ONLY
-- create objects, and ONLY inside the audio bucket.
-- No select, update, or delete policy: a reviewer uploads audio and that is
-- all. They cannot read, replace, or delete it (the kit's x-upsert:false
-- reinforces this on the browser side).
-- ----------------------------------------------------------------------------
drop policy if exists upload_audio_anon on storage.objects;

create policy upload_audio_anon
  on storage.objects
  for insert
  to anon
  with check (
    bucket_id = 'audios-feedback'
  );
