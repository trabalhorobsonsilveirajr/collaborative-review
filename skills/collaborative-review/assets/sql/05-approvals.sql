-- ============================================================================
-- 05-approvals.sql — Approvals for structural decisions
-- Skill: collaborative-review
--
-- WHY IT EXISTS: the dashboard has approve and reject buttons per structural
-- item. The owner's verdict travels: dashboard -> the approvals function ->
-- this table -> the watcher -> stamped into the gate file -> the engine
-- applies it. The gate file stays the source of truth; this table is only the
-- courier between a browser and the machine.
--
-- SECURITY: same model as the config table. Row-level security on with no
-- policies means the anonymous role cannot read, write, or discover it.
-- Forging an approval would require the password.
--
-- ============================================================================

create table if not exists public.approvals (
  id             bigint generated always as identity primary key,
  project        text not null check (char_length(project) between 1 and 80),
  material       text not null check (char_length(material) between 1 and 80),
  gate_file   text not null check (
                   gate_file ~ '^[a-z0-9][a-z0-9-]*\.md$'
                   and char_length(gate_file) <= 120
                 ),
  item_number    int not null check (item_number between 1 and 99),
  verdict       text not null check (verdict in ('approved', 'rejected')),
  edited_request text null check (
                   edited_request is null or char_length(edited_request) <= 5000
                 ),
  decision_id     bigint null,          -- id of the type='decision' row in feedbacks (rastreio)
  created_at      timestamptz not null default now(),
  processed_at  timestamptz null      -- the watcher marks this when it stamps the gate
);

alter table public.approvals enable row level security;
-- No policies on purpose: service-role access only.

-- The watcher's hot query: what is still pending for one material
create index if not exists aprovacoes_pendentes_idx
  on public.approvals (project, material)
  where processed_at is null;
