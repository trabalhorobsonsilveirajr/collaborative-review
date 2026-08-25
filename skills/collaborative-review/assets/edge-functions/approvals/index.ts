import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================================
// The courier between the dashboard and the watcher, for structural decisions.
//
// Flow: the dashboard records the owner's verdicts (approve or reject per
// item, with the request possibly edited); the watcher lists what is pending,
// stamps the gate files on the machine, and marks them processed. The gate
// file on disk remains the source of truth. This function only carries
// messages.
//
// Contract, a single POST with the action in the body:
//   { password, action: "record", approvals: [...] }   (1 to 50 per call)
//   { password, action: "list",  projeto?, material?, pending_only? }  (read)
//   { password, action: "mark",  ids: [...] }            (1 to 100 per call)
//
// Returns 400 on validation, 401 on a wrong password, 500 on configuration.
//
// SECURITY: forging an approval requires the password. The anonymous insert
// route available to the page cannot reach this table at all.
//
// Deploy with JWT verification OFF.
// ============================================================================

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const GATE_ARQUIVO_RE = /^[a-z0-9][a-z0-9-]*\.md$/;

function resposta(status: number, corpo: unknown): Response {
  return new Response(JSON.stringify(corpo), {
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

    // Password in the order documented above
    let expectedPassword = Deno.env.get("DASHBOARD_APPROVAL_PASSWORD") ?? "";
    if (!expectedPassword) {
      const { data: cfgAp } = await supabase
        .from("painel_config").select("config_value")
        .eq("config_key", "senha_aprovacao").maybeSingle();
      expectedPassword = cfgAp?.config_value ?? "";
    }
    if (!expectedPassword) expectedPassword = Deno.env.get("DASHBOARD_PASSWORD") ?? "";
    if (!expectedPassword) {
      const { data: cfg } = await supabase
        .from("painel_config").select("config_value")
        .eq("config_key", "password").maybeSingle();
      expectedPassword = cfg?.config_value ?? "";
    }
    if (!expectedPassword) {
      return resposta(500, {
        error_message: "Dashboard password is not configured (set the DASHBOARD_PASSWORD secret, " +
          "or the config table). See the edge-functions README for setup.",
      });
    }

    const body = await req.json().catch(() => ({}));
    const { password = "", action = "" } = body as { password?: string; action?: string };
    if (password !== expectedPassword) {
      return resposta(401, { error_message: "Incorrect password" });
    }

    // ------------------------------------------------------------ registrar
    if (action === "record") {
      const lista = (body as { approvals?: unknown }).approvals;
      if (!Array.isArray(lista) || lista.length < 1 || lista.length > 50) {
        return resposta(400, { error_message: "approvals: lista de 1 a 50 itens" });
      }
      const linhas: Record<string, unknown>[] = [];
      for (let i = 0; i < lista.length; i++) {
        const a = lista[i] as Record<string, unknown>;
        const erros: string[] = [];
        const project = typeof a.project === "string" ? a.project.trim() : "";
        const material = typeof a.material === "string" ? a.material.trim() : "";
        const gate = typeof a.gate_file === "string" ? a.gate_file.trim() : "";
        const item = a.item_number;
        const verdict = a.verdict;
        const editado = a.edited_request;
        const decisaoId = a.decision_id;

        if (project.length < 1 || project.length > 80) erros.push("project: 1 a 80");
        if (material.length < 1 || material.length > 80) erros.push("material: 1 a 80");
        if (!GATE_ARQUIVO_RE.test(gate) || gate.length > 120) {
          erros.push("gate_file: must be a bare file name matching [a-z0-9-].md");
        }
        if (!Number.isInteger(item) || (item as number) < 1 || (item as number) > 99) {
          erros.push("item_number: inteiro 1 a 99");
        }
        if (verdict !== "approved" && verdict !== "rejected") {
          erros.push("verdict: 'approved' ou 'rejected'");
        }
        if (editado !== undefined && editado !== null &&
          (typeof editado !== "string" || editado.length > 5000)) {
          erros.push("edited_request: texto ate 5000");
        }
        if (decisaoId !== undefined && decisaoId !== null && !Number.isInteger(decisaoId)) {
          erros.push("decision_id: must be an integer");
        }
        if (erros.length > 0) {
          return resposta(400, { error_message: `item ${i + 1}: ` + erros.join("; ") });
        }
        linhas.push({
          project, material,
          gate_file: gate,
          item_number: item,
          verdict,
          edited_request: typeof editado === "string" && editado.trim().length > 0
            ? editado.trim() : null,
          decision_id: decisaoId ?? null,
        });
      }
      const { data, error } = await supabase
        .from("approvals").insert(linhas).select("id");
      if (error) throw error;
      return resposta(200, { ok: true, ids: (data ?? []).map((r) => r.id) });
    }

    // --------------------------------------------------------------- listar
    if (action === "list") {
      const { project, material } = body as { project?: string; material?: string };
      const apenasPendentes = (body as { pending_only?: boolean }).pending_only ?? true;
      let q = supabase.from("approvals")
        .select("id, project, material, gate_file, item_number, verdict, edited_request, decision_id, created_at, processed_at");
      if (typeof project === "string" && project.trim()) q = q.eq("project", project.trim());
      if (typeof material === "string" && material.trim()) q = q.eq("material", material.trim());
      if (apenasPendentes) {
        q = q.is("processed_at", null).order("id", { ascending: true });
      } else {
        q = q.order("id", { ascending: false }).limit(200);
      }
      const { data, error } = await q;
      if (error) throw error;
      return resposta(200, { ok: true, approvals: data ?? [] });
    }

    // --------------------------------------------------------------- marcar
    if (action === "mark") {
      const ids = (body as { ids?: unknown }).ids;
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 ||
        !ids.every((n) => Number.isInteger(n))) {
        return resposta(400, { error_message: "ids: lista de 1 a 100 inteiros" });
      }
      const { data, error } = await supabase
        .from("approvals")
        .update({ processed_at: new Date().toISOString() })
        .in("id", ids as number[])
        .is("processed_at", null)
        .select("id");
      if (error) throw error;
      return resposta(200, { ok: true, marcadas: (data ?? []).length });
    }

    return resposta(400, { error_message: "action invalida: use registrar, listar ou marcar" });
  } catch (e) {
    return resposta(500, { error_message: String(e) });
  }
});
