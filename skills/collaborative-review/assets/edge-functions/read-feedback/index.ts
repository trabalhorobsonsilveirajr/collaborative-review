import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================================
// Reads feedback for the dashboard. Internal use.
//
// Password resolution, in order:
//   1. The DASHBOARD_PASSWORD environment secret, if set.
//   2. Otherwise the dashboard_config table, key 'password', which has no read
//      policy and is therefore invisible to anonymous callers.
//   Neither configured returns 500 with an explanatory message rather than
//   failing open. A read endpoint that answers without a password would expose
//   every reviewer comment in the project.
//
// Optional filtering by { project, material } in the request body. Without
// them it returns everything, which keeps older dashboards working.
//
// Audio arrives as a signed URL valid for two hours, generated per request.
// The bucket is private, so there is no other way to play it back, and a
// leaked dashboard response goes stale on its own.
//
// Deploy with JWT verification OFF: this function authenticates with the
// password in the body, not with a Supabase session. With verification on, it
// rejects every call before the password is ever read.
// ============================================================================

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Password: the environment secret wins; without it, read the config
    // table (service role; anonymous callers cannot see it: no select policy).
    let expectedPassword = Deno.env.get("DASHBOARD_PASSWORD") ?? "";
    if (!expectedPassword) {
      const { data: cfg } = await supabase
        .from("painel_config")
        .select("config_value")
        .eq("config_key", "password")
        .maybeSingle();
      expectedPassword = cfg?.config_value ?? "";
    }
    if (!expectedPassword) {
      return new Response(
        JSON.stringify({
          error_message:
            "Dashboard password is not configured. Set the DASHBOARD_PASSWORD secret " +
            "or run 04-dashboard-config.sql (table painel_config, key 'password') " +
            "See the edge-functions README for setup instructions.",
        }),
        { status: 500, headers: { ...cors, "Content-Type": "application/json" } },
      );
    }

    const body = await req.json().catch(() => ({}));
    const { password = "", project, material } = body as {
      password?: string;
      project?: string;
      material?: string;
    };
    if (password !== expectedPassword) {
      return new Response(JSON.stringify({ error_message: "Incorrect password" }), {
        status: 401,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // Also selects type, project and material (added by the scope migration)
    let query = supabase
      .from("feedbacks")
      .select(
        "id, reviewer_name, section, comment, audio_path, created_at, type, project, material",
      )
      .order("created_at", { ascending: false });

    // Optional scope filter. Older dashboards do not send these fields, so
    // an absent filter returns everything, the same result v2 gave. The three
    // extra fields ride along; a v1 dashboard simply ignores them.
    if (typeof project === "string" && project.length > 0) {
      query = query.eq("project", project);
    }
    if (typeof material === "string" && material.length > 0) {
      query = query.eq("material", material);
    }

    const { data, error } = await query;
    if (error) throw error;
    const feedbacks = data ?? [];

    // Gera link temporario (assinado, 2h) para cada audio
    for (const f of feedbacks) {
      if (f.audio_path) {
        const { data: signed } = await supabase.storage
          .from("audios-feedback")
          .createSignedUrl(f.audio_path, 7200);
        (f as Record<string, unknown>).audio_url = signed?.signedUrl ?? null;
      }
    }

    return new Response(JSON.stringify({ feedbacks }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error_message: String(e) }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
