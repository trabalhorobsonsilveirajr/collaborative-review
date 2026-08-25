import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================================
// Records a pending structural decision from the correction engine.
//
// Called by the engine when it classifies a reviewer's item as STRUCTURAL and
// needs a human to decide. The row it writes appears in the dashboard's
// pending-decisions tab.
//
// Why a service-role function is the ONLY way to write this:
//   The insert policy lets the anonymous role write only comments and
//   conclusions. A reviewer can never fabricate a "decision" row. Type
//   'decision' enters exclusively through here, because this function runs with
//   the service role and bypasses row-level security.
//
// That asymmetry is the point: what a browser can write and what the engine
// can write are deliberately different sets.
//
// Deploy with JWT verification OFF.
// ============================================================================

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function resposta(status: number, responseBody: unknown): Response {
  return new Response(JSON.stringify(responseBody), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

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
      return resposta(500, {
        error_message:
          "Dashboard password is not configured. Set the DASHBOARD_PASSWORD secret " +
          "or run 04-dashboard-config.sql (table painel_config, key 'password') " +
          "See the edge-functions README for setup instructions.",
      });
    }

    const body = await req.json().catch(() => ({}));
    const { password = "", project, material, section, comment } = body as {
      password?: string;
      project?: string;
      material?: string;
      section?: string;
      comment?: string;
    };
    if (password !== expectedPassword) {
      return resposta(401, { error_message: "Incorrect password" });
    }

    // Validation, matching the size limits enforced by the table policy
    const errors: string[] = [];
    const cleanProject = typeof project === "string" ? project.trim() : "";
    const cleanMaterial = typeof material === "string" ? material.trim() : "";
    const cleanComment = typeof comment === "string" ? comment.trim() : "";
    const cleanSection = typeof section === "string" && section.trim().length > 0
      ? section.trim()
      : "Pending decision";

    if (cleanProject.length < 1 || cleanProject.length > 80) {
      errors.push("project: required, 1 to 80 characters");
    }
    if (cleanMaterial.length < 1 || cleanMaterial.length > 80) {
      errors.push("material: required, 1 to 80 characters");
    }
    if (cleanComment.length < 1 || cleanComment.length > 5000) {
      errors.push("comment: required, 1 to 5000 characters");
    }
    if (cleanSection.length > 500) {
      errors.push("section: ate 500 caracteres");
    }
    if (errors.length > 0) {
      return resposta(400, { error_message: "Validation failed: " + errors.join("; ") });
    }

    const { data, error } = await supabase
      .from("feedbacks")
      .insert({
        reviewer_name: "MOTOR",
        section: cleanSection,
        comment: cleanComment,
        project: cleanProject,
        material: cleanMaterial,
        type: "decision",
      })
      .select("id")
      .single();
    if (error) throw error;

    return resposta(200, { ok: true, id: data.id });
  } catch (e) {
    return resposta(500, { error_message: String(e) });
  }
});
