#!/usr/bin/env node
/**
 * demo.mjs — the whole thing running on your machine, with no account anywhere.
 *
 * WHY THIS EXISTS. The setup asks for a Supabase project, four SQL files, a CLI,
 * four function deploys and a scheduled task before you see anything at all. An
 * audit put the consequence plainly: most people who look at this project decide
 * whether to keep going in the first three minutes, and in those three minutes
 * they have seen nothing work.
 *
 * So this stands up a throwaway backend in memory, injects the real review kit
 * into a real page, serves both, and lets you use the actual product. No account,
 * no SQL, no deploy, nothing written outside a temporary folder.
 *
 * What it does NOT do: the correction engine. That needs Claude Code, a scheduled
 * task and Windows, and pretending otherwise here would be the kind of promise
 * this project keeps getting wrong. You can see the gate work on its own with:
 *
 *   node skills/collaborative-review/scripts/gate.mjs selftest
 *
 * Usage:  node skills/collaborative-review/scripts/demo.mjs [--port 8787] [--keep]
 */

import { createServer } from "node:http";
import { injectLanguages } from "./i18n.mjs";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL = resolve(HERE, "..");

const args = process.argv.slice(2);
const arg = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i === -1 ? d : args[i + 1];
};
const PORT = Number.parseInt(arg("port", "8787"), 10);
const KEEP = args.includes("--keep");
const PASSWORD = "demo";

/* ------------------------------------------------------------------ *
 * A page to review. Deliberately ordinary: a few sections, a nav menu
 * that links to them, and a footer — the shape that broke earlier
 * versions of the gate, so the demo exercises the real thing.
 * ------------------------------------------------------------------ */

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Onboarding Guide — demo</title>
<style>
  body{font:16px/1.6 system-ui,sans-serif;max-width:760px;margin:0 auto;padding:2rem 1.25rem;color:#1a1a1a}
  .topbar{border-bottom:1px solid #e5e5e5;padding-bottom:1rem;margin-bottom:2rem}
  .topbar h1{margin:0;font-size:1.4rem}
  nav{margin:1rem 0 2rem}
  nav a{margin-right:1rem;color:#2a78d6}
  .step{border:1px solid #e5e5e5;border-radius:10px;padding:1.25rem;margin-bottom:1.5rem}
  .step h3{margin:0 0 .5rem;font-size:1.1rem}
  footer{margin-top:3rem;padding-top:1rem;border-top:1px solid #e5e5e5;color:#666;font-size:.9rem}
</style>
</head>
<body>
<div class="topbar"><h1>Onboarding Guide</h1></div>

<nav>
  <a href="#step-1">Create your account</a>
  <a href="#step-2">Add your details</a>
  <a href="#step-3">Upload a photo</a>
</nav>

<section class="step" id="step-1">
  <h3>Create your account</h3>
  <div class="step-body">Enter your email and choose a sign-up code. You will use this
  code every time you come back, so write it somewhere safe.</div>
</section>

<section class="step" id="step-2">
  <h3>Add your details</h3>
  <div class="step-body">Fill in your name, address and phone number. Everything here
  can be changed later from your profile.</div>
</section>

<section class="step" id="step-3">
  <h3>Upload a photo</h3>
  <div class="step-body">Take a photo in good light, holding the camera steady. If it
  comes out blurry, tap retake.</div>
</section>

<footer>Demo page. Nothing here is real, and nothing leaves your machine.</footer>
</body>
</html>
`;

/* ------------------------------------------------------------------ *
 * The throwaway backend: the same shape the real one returns, kept in
 * memory. It exists so the kit you are looking at is the REAL kit,
 * doing its real requests, rather than a mock-up of it.
 * ------------------------------------------------------------------ */

const feedback = [];
let nextId = 1;

function readBody(req) {
  return new Promise((ok) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      try { ok(JSON.parse(raw || "{}")); } catch { ok({}); }
    });
  });
}

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

/* ------------------------------------------------------------------ */

const work = mkdtempSync(join(tmpdir(), "collab-review-demo-"));
const pagePath = join(work, "guide.html");
writeFileSync(pagePath, PAGE, "utf8");

const config = {
  SUPABASE_URL: `http://localhost:${PORT}`,
  SUPABASE_ANON_KEY: "demo-anon-key",
  PROJECT: "demo-project",
  MATERIAL: "Onboarding Guide",
  SECTION_SELECTOR: ".step",
  SECTION_TITLE_SELECTOR: "h3",
  SECTION_BODY_SELECTOR: ".step-body",
  NAME_BAR_ANCHOR: ".topbar",
  SECTION_LABEL: "Step ",
  BUCKET_AUDIO: "audio-feedback",
};
const configPath = join(work, "demo-config.json");
writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");

console.log("Setting up a throwaway copy — nothing outside this folder is touched.");
console.log(`  ${work}\n`);

try {
  execFileSync(process.execPath, [
    join(HERE, "build-kit.mjs"),
    "--kit", join(SKILL, "assets", "review-kit.tmpl.html"),
    "--config", configPath,
    "--target", pagePath,
  ], { stdio: "pipe" });
} catch (e) {
  console.error("Could not inject the review kit:\n");
  console.error(String(e.stdout || "") + String(e.stderr || ""));
  process.exit(1);
}

/* The dashboard, pointed at this throwaway backend. */
const dashboardTmpl = readFileSync(join(SKILL, "assets", "dashboard.tmpl.html"), "utf8");
const dashboardComUrl = dashboardTmpl.split("{{EDGE_FN_URL}}")
  .join(`http://localhost:${PORT}/functions/v1/read-feedback`);
/* Same embedding the review kit gets, from the same function, so the dashboard
   and the kit can never end up on different sets of dictionaries. */
const { html: dashboard, idiomas: dashboardLanguages } = injectLanguages(dashboardComUrl);
const dashboardPath = join(work, "dashboard.html");
writeFileSync(dashboardPath, dashboard, "utf8");

const manifestPath = join(work, "guide.sections.json");
const manifest = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, "utf8"))
  : null;

/* ------------------------------------------------------------------ */

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    });
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  /* the kit posts feedback straight to the table, as it does for real */
  if (req.method === "POST" && url.pathname.startsWith("/rest/v1/")) {
    const body = await readBody(req);
    const rows = Array.isArray(body) ? body : [body];
    for (const r of rows) {
      feedback.unshift({ id: nextId++, created_at: new Date().toISOString(), ...r });
      const who = r.reviewer_name || "someone";
      const what = r.type === "conclusion" ? "finished their review" : `commented on ${r.section}`;
      console.log(`  ← ${who} ${what}`);
    }
    return json(res, 201, rows);
  }

  /* the dashboard reads through the server function */
  if (req.method === "POST" && url.pathname.includes("read-feedback")) {
    const body = await readBody(req);
    if (body.password !== PASSWORD) return json(res, 401, { error_message: "Incorrect password" });
    return json(res, 200, { feedbacks: feedback });
  }
  if (req.method === "POST" && url.pathname.includes("approvals")) {
    const body = await readBody(req);
    if (body.password !== PASSWORD) return json(res, 401, { error_message: "Incorrect password" });
    return json(res, 200, { approvals: [] });
  }

  /* static files */
  const file = url.pathname === "/" ? "/guide.html" : url.pathname;
  const target = join(work, file.replace(/^\/+/, ""));
  if (!target.startsWith(work) || !existsSync(target)) {
    res.writeHead(404).end("not found");
    return;
  }
  const type = target.endsWith(".json") ? "application/json" : "text/html; charset=utf-8";
  res.writeHead(200, { "Content-Type": type });
  res.end(readFileSync(target));
});

server.listen(PORT, () => {
  const line = "─".repeat(64);
  console.log(line);
  console.log("  The review kit, running for real. No account, no SQL, no deploy.");
  console.log(line);
  console.log("");
  console.log(`  The page a reviewer gets   http://localhost:${PORT}/`);
  console.log(`  The dashboard you get      http://localhost:${PORT}/dashboard.html`);
  console.log(`  Dashboard password         ${PASSWORD}`);
  console.log("");
  console.log("  Try this, in order:");
  console.log("    1. Open the page, type a name, and comment on one section. Send.");
  console.log("    2. Watch this terminal — the comment arrives here.");
  console.log("    3. Open the dashboard, sign in, and read what you wrote.");
  console.log("");
  if (manifest) {
    console.log(`  While injecting the kit, ${manifest.sections.length} sections were marked and recorded:`);
    console.log(`    ${manifest.sections.map((s) => s.id).join(", ")}`);
    console.log("  That list is what the quality gate treats as the boundary. It is");
    console.log("  established here, once, so the agent that edits later cannot widen it.");
    console.log("");
  }
  console.log("  The correction engine is NOT part of this demo: it needs Claude Code,");
  console.log("  a scheduled task and Windows. To see the gate itself refuse an edit that");
  console.log("  strayed outside its lane, run:");
  console.log("    node skills/collaborative-review/scripts/gate.mjs selftest");
  console.log("");
  console.log("  Ctrl+C to stop." + (KEEP ? ` Files kept at ${work}` : " The folder is removed on exit."));
  console.log("");
});

function bye() {
  server.close();
  if (!KEEP) {
    rmSync(work, { recursive: true, force: true });
    console.log("\nDemo stopped. The temporary folder was removed.");
  } else {
    console.log(`\nDemo stopped. Files kept at ${work}`);
  }
  process.exit(0);
}
process.on("SIGINT", bye);
process.on("SIGTERM", bye);
