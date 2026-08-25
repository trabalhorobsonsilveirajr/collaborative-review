import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================================
// Deletes files from the audio bucket that have no matching row in the
// feedbacks table, meaning orphaned audio.
//
// Orphans happen when an upload succeeds and the database insert then fails.
// The kit validates before uploading precisely to make this rare, but a
// dropped connection between the two steps still produces one.
//
// Same password resolution as the read function: environment secret first,
// config table as fallback, 500 if neither is configured.
//
// It compares in the safe direction: it lists what is in the bucket, checks
// each file against the table, and deletes only what has no row. A file it
// cannot confirm is a file it leaves alone.
//
// Deploy with JWT verification OFF.
// ============================================================================

Deno.serve(async (req: Request) => {
  const cors = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(url, key);

  // Password: the DASHBOARD_PASSWORD secret wins; without it, the config table
  // (service role; anonymous callers cannot see it: no select policy).
  let expectedPassword = Deno.env.get("DASHBOARD_PASSWORD") ?? "";
  if (!expectedPassword) {
    const { data: cfg } = await sb
      .from("painel_config")
      .select("config_value")
      .eq("config_key", "password")
      .maybeSingle();
    expectedPassword = cfg?.config_value ?? "";
  }
  if (!expectedPassword) {
    return new Response(
      JSON.stringify({
        error:
          "Dashboard password is not configured. Set the DASHBOARD_PASSWORD secret " +
          "or run 04-dashboard-config.sql (table painel_config, key 'password') " +
          "See the edge-functions README for setup instructions.",
      }),
      { status: 500, headers: cors },
    );
  }

  let body: any = {};
  try { body = await req.json(); } catch (_) { /* ignore */ }
  if (body?.password !== expectedPassword) {
    return new Response(JSON.stringify({ error: "password" }), { status: 401, headers: cors });
  }
  const { data: files, error: e1 } = await sb.storage.from("audios-feedback").list("", { limit: 1000 });
  if (e1) return new Response(JSON.stringify({ error: e1.message }), { status: 500, headers: cors });
  const { data: rows, error: e2 } = await sb.from("feedbacks").select("audio_path").not("audio_path", "is", null);
  if (e2) return new Response(JSON.stringify({ error: e2.message }), { status: 500, headers: cors });
  const usados = new Set((rows || []).map((r: any) => r.audio_path));
  const orfaos = (files || []).map((f: any) => f.name).filter((n: string) => !usados.has(n));
  let apagados: string[] = [];
  if (orfaos.length > 0) {
    const { error: e3 } = await sb.storage.from("audios-feedback").remove(orfaos);
    if (e3) return new Response(JSON.stringify({ error: e3.message, orfaos }), { status: 500, headers: cors });
    apagados = orfaos;
  }
  return new Response(JSON.stringify({ total_arquivos: (files || []).length, orfaos_apagados: apagados.length, nomes: apagados }), { headers: cors });
});
