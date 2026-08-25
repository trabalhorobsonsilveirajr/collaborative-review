-- ============================================================================
-- 04-dashboard-config.sql — Dashboard password in the database
-- Skill: collaborative-review · sequences A and B
--
-- WHY IT EXISTS: setting an environment secret requires an authenticated CLI
-- or the web dashboard, which automation may not have. This table is the
-- versionable alternative: the server functions read the password from here
-- WHEN the environment secret does not exist. The environment wins if both
-- are present.
--
-- SECURITY: row-level security enabled with NO policies at all means the
-- anonymous role cannot read it, cannot write it, and cannot discover that it
-- exists. Only the service role, meaning the server functions, can see it.
-- Same trust model as the secret.
--
-- USAGE: replace '{{DASHBOARD_PASSWORD}}' with the real password when
-- applying. Idempotent, so running it again just updates the value.
--
-- ============================================================================

create table if not exists public.painel_config (
  config_key text primary key,
  config_value text not null,
  updated_at timestamptz not null default now()
);

alter table public.painel_config enable row level security;
-- No policies on purpose: service-role access only.

insert into public.painel_config (config_key, config_value)
values ('password', '{{DASHBOARD_PASSWORD}}')
on conflict (config_key) do update
  set config_value = excluded.valor,
      updated_at = now();
