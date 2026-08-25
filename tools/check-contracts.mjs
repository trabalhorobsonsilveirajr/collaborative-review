#!/usr/bin/env node
/**
 * check-contracts.mjs — catches documentation that disagrees with code.
 *
 * NOT part of the published skill. This is the publishing harness.
 *
 * WHY THIS EXISTS. An audit found four defects of one shape, and every one of them
 * would have stopped a real user cold while every existing check reported success:
 *
 *   · SETUP told the user to set a secret named DASHBOARD_PASSWORD. The code read
 *     PAINEL_SENHA. Following the documentation produced a 500 error whose message
 *     named a SQL file that did not exist either.
 *   · The watcher loaded 'sincronizar-aprovacoes.ps1'. The file had been renamed to
 *     'sync-approvals.ps1'. The whole approval path was dead, and silently: the
 *     warning only fired if the file existed and failed to load.
 *   · The watcher derived the approvals URL by replacing one old function name with
 *     another old function name. Neither existed any more.
 *   · A reference documented a table called dashboard_config; the SQL created
 *     painel_config.
 *
 * None of these is a syntax error. None breaks a test. Each is a promise the
 * repository makes and does not keep, and the only way to catch them is to read
 * both sides and compare. That is all this does.
 *
 * Exit codes: 0 = agree · 1 = contradiction found · 2 = the checker is broken
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const ROOT = process.argv[2] || ".";
const NUL = String.fromCharCode(0);
const SKILL = join(ROOT, "skills", "collaborative-review");

const problems = [];
const checks = [];

function report(name, ok, detail) {
  checks.push({ name, ok });
  if (!ok) problems.push({ name, detail });
}

function read(rel) {
  const p = join(ROOT, rel);
  try { return readFileSync(p, "utf8"); } catch { return ""; }
}

function trackedFiles() {
  try {
    const out = execFileSync("git", ["-C", ROOT, "ls-files", "-z"], { encoding: "utf8" });
    return out.split(NUL).filter(Boolean);
  } catch { return []; }
}

/* The verifiers live in tools/ now that they are published, which means they show
 * up in the file list and would scan each other — including the self-test cases
 * that exist precisely to look like the defect. A checker that flags another
 * checker's fixtures is not finding anything; it is making noise, and noise is
 * how an alarm gets ignored. */
const HARNESS = /(^|[\/])tools[\/]/;
const files = trackedFiles().filter((f) => !HARNESS.test(f));
const allText = new Map(files.map((f) => [f, read(f)]));

/* ------------------------------------------------------------------ *
 * 1. The secret name: what docs tell you to set vs what code reads.
 * ------------------------------------------------------------------ */
{
  const documented = new Set();
  for (const [, text] of allText) {
    for (const m of text.matchAll(/secrets\s+set\s+([A-Z_][A-Z0-9_]*)/g)) documented.add(m[1]);
  }
  const readByCode = new Set();
  for (const [f, text] of allText) {
    if (!f.includes("edge-functions")) continue;
    for (const m of text.matchAll(/Deno\.env\.get\("([A-Z_][A-Z0-9_]*)"\)/g)) {
      if (!m[1].startsWith("SUPABASE_")) readByCode.add(m[1]);
    }
  }
  const orphanDocs = [...documented].filter((n) => !readByCode.has(n));
  report(
    "documented secrets are the ones the code reads",
    orphanDocs.length === 0,
    orphanDocs.length
      ? `docs tell the user to set ${orphanDocs.join(", ")}, but no function reads that name. ` +
        `The functions read: ${[...readByCode].join(", ") || "(none)"}`
      : ""
  );
}

/* ------------------------------------------------------------------ *
 * 2. Every SQL file named anywhere actually exists.
 * ------------------------------------------------------------------ */
{
  const sqlDir = join(SKILL, "assets", "sql");
  const present = existsSync(sqlDir) ? new Set(readdirSync(sqlDir)) : new Set();
  const missing = new Set();
  for (const [f, text] of allText) {
    for (const m of text.matchAll(/\b(\d{2}-[a-z-]+\.sql)\b/g)) {
      if (!present.has(m[1])) missing.add(`${m[1]} (named in ${f})`);
    }
  }
  report(
    "every SQL file named in docs or code exists",
    missing.size === 0,
    [...missing].join("; ")
  );
}

/* ------------------------------------------------------------------ *
 * 3. Every server function named in a URL matches a real function folder.
 * ------------------------------------------------------------------ */
{
  const fnDir = join(SKILL, "assets", "edge-functions");
  const present = existsSync(fnDir)
    ? new Set(readdirSync(fnDir).filter((d) => !d.includes(".")))
    : new Set();
  const named = new Map();
  for (const [f, text] of allText) {
    for (const m of text.matchAll(/functions\/v1\/([a-z][a-z0-9-]*)/g)) {
      if (!present.has(m[1])) named.set(m[1], f);
    }
    for (const m of text.matchAll(/-replace\s+'([a-z-]+)',\s*'([a-z-]+)'/g)) {
      for (const name of [m[1], m[2]]) if (!present.has(name)) named.set(name, f);
    }
    for (const m of text.matchAll(/\.replace\("([a-z-]+)",\s*"([a-z-]+)"\)/g)) {
      for (const name of [m[1], m[2]]) if (!present.has(name)) named.set(name, f);
    }
  }
  report(
    "every server function named in a URL exists",
    named.size === 0,
    [...named].map(([n, f]) => `"${n}" named in ${f}, but no such function folder`).join("; ")
  );
}

/* ------------------------------------------------------------------ *
 * 4. Scripts only dot-source / require files that exist.
 * ------------------------------------------------------------------ */
{
  const missing = [];
  for (const [f, text] of allText) {
    if (!f.endsWith(".ps1")) continue;
    for (const m of text.matchAll(/Join-Path\s+\$PSScriptRoot\s+'([^']+)'/g)) {
      const target = join(ROOT, f, "..", m[1]);
      if (!existsSync(target)) missing.push(`${f} loads '${m[1]}', which does not exist`);
    }
  }
  report("scripts load files that exist", missing.length === 0, missing.join("; "));
}

/* ------------------------------------------------------------------ *
 * 5. Table names documented match the tables the SQL creates.
 * ------------------------------------------------------------------ */
{
  const created = new Set();
  for (const [f, text] of allText) {
    if (!f.includes("/sql/")) continue;
    for (const m of text.matchAll(/create table if not exists\s+public\.(\w+)/gi)) created.add(m[1]);
  }
  const missing = new Set();
  for (const [f, text] of allText) {
    if (f.includes("/sql/")) continue;
    for (const m of text.matchAll(/\bpublic\.(\w+)\b/g)) {
      if (!created.has(m[1])) missing.add(`public.${m[1]} (named in ${f})`);
    }
  }
  report(
    "tables named in docs are the tables the SQL creates",
    missing.size === 0,
    [...missing].join("; ")
  );
}

/* ------------------------------------------------------------------ *
 * 6. Ledger status values: the protocol tells the engine what to write,
 *    the watcher decides what counts as handled. If they use different
 *    vocabularies, the same conclusion is re-processed on every tick,
 *    forever, and nothing ever reports an error.
 * ------------------------------------------------------------------ */
{
  const protocol = read("skills/collaborative-review/assets/engine-protocol.tmpl.md");
  const watcher = read("skills/collaborative-review/scripts/watcher.tmpl.ps1");
  const watcherStatuses = new Set();
  for (const m of watcher.matchAll(/@\(\s*((?:'[a-z-]+'\s*,?\s*)+)\)/g)) {
    for (const s of m[1].matchAll(/'([a-z-]+)'/g)) watcherStatuses.add(s[1]);
  }
  const protocolStatuses = new Set();
  for (const m of protocol.matchAll(/`(pending|processing|applied|error|awaiting-[a-z-]+|aplicado|processando|pendente|erro|aguardando-[a-z-]+)`/g)) {
    protocolStatuses.add(m[1]);
  }
  const shared = [...protocolStatuses].filter((s) => watcherStatuses.has(s));
  const bothPresent = protocolStatuses.size > 0 && watcherStatuses.size > 0;
  report(
    "the protocol and the watcher speak the same ledger vocabulary",
    !bothPresent || shared.length > 0,
    bothPresent && shared.length === 0
      ? `the protocol tells the engine to write [${[...protocolStatuses].join(", ")}] ` +
        `but the watcher only recognises [${[...watcherStatuses].join(", ")}]. ` +
        `No status would ever match, so the same conclusion reruns every tick.`
      : ""
  );
}

/* ------------------------------------------------------------------ *
 * 6b. The gate file's front matter. The protocol tells the engine what to
 *     write; the sync module and the watcher decide what they recognise. This
 *     drifted twice: once on the field names, once on the VALUES, and both
 *     times silently. A gate written per the protocol was simply never seen,
 *     and the owner's decision vanished with no error anywhere.
 * ------------------------------------------------------------------ */
{
  const protocol = read("skills/collaborative-review/assets/engine-protocol.tmpl.md");
  const sync = read("skills/collaborative-review/scripts/sync-approvals.ps1");
  const watcher = read("skills/collaborative-review/scripts/watcher.tmpl.ps1");

  /* what the protocol shows the engine writing */
  const documented = new Set();
  for (const m of protocol.matchAll(/^\s*status:\s*(\w[\w-]*)/gm)) documented.add(m[1]);

  /* what the code searches for and writes back */
  const recognised = new Set();
  for (const src of [sync, watcher]) {
    /* Tolerant on purpose: the search patterns in PowerShell are regex strings
     * full of escapes, and a strict match here would quietly capture nothing and
     * report a contradiction that does not exist. */
    for (const m of src.matchAll(/status.{0,40}?\?([a-z][\w-]*)/g)) {
      recognised.add(m[1]);
    }
    for (const m of src.matchAll(/\$1(\w[\w-]*)"/g)) recognised.add(m[1]);
  }

  const bothPresent = documented.size > 0 && recognised.size > 0;
  const orphans = [...documented].filter((v) => !recognised.has(v));
  report(
    "the gate front matter the protocol documents is what the code recognises",
    !bothPresent || orphans.length === 0,
    bothPresent && orphans.length
      ? `the protocol shows the engine writing status: ${orphans.join(", ")}, but the ` +
        `code only recognises [${[...recognised].join(", ")}]. A gate written as documented ` +
        `would never be seen, and nothing would report an error.`
      : ""
  );
}

/* ------------------------------------------------------------------ *
 * 7. Claims the README makes about files that must be present.
 * ------------------------------------------------------------------ */
{
  const readme = read("README.md");
  const bad = [];
  if (/leak scanner/i.test(readme)) {
    const shipped = files.some((f) => f.includes("check-no-leaks"));
    if (!shipped) {
      bad.push("README offers the leak scanner as evidence a reader can run, but it is not in the repository");
    }
  }
  report("README only offers evidence a reader can actually run", bad.length === 0, bad.join("; "));
}

/* ------------------------------------------------------------------ *
 * 8. Platform honesty: if anything shipped requires PowerShell or Windows,
 *    the README has to say so before the reader invests an hour.
 * ------------------------------------------------------------------ */
{
  const windowsOnly = files.filter((f) => f.endsWith(".ps1"));
  const readme = read("README.md");
  const setup = read("SETUP.md");
  const declared = /windows/i.test(readme) || /powershell/i.test(readme);
  report(
    "platform requirements are declared where a reader sees them first",
    windowsOnly.length === 0 || declared,
    windowsOnly.length && !declared
      ? `${windowsOnly.length} shipped file(s) require PowerShell, and neither "Windows" nor ` +
        `"PowerShell" appears in the README. A reader on another OS invests the whole backend ` +
        `setup before discovering the engine cannot run.`
      : ""
  );
  const setupDeclared = /windows/i.test(setup) || /powershell/i.test(setup);
  report(
    "SETUP declares the platform too",
    windowsOnly.length === 0 || setupDeclared,
    windowsOnly.length && !setupDeclared ? "SETUP.md never mentions PowerShell or Windows" : ""
  );
}

/* ------------------------------------------------------------------ *
 * 9. Absolute claims about language. A sentence like "everything a human
 *    reads is in English" is checkable, so it gets checked.
 * ------------------------------------------------------------------ */
{
  const claims = [];
  for (const [f, text] of allText) {
    if (/(everything|all)[^.\n]{0,40}(a human reads|human-readable)[^.\n]{0,30}in English/i.test(text)) {
      claims.push(f);
    }
  }
  report(
    "no unverifiable absolute claim about language",
    claims.length === 0,
    claims.length
      ? `${claims.join(", ")} claims everything a human reads is in English. Either prove it with ` +
        `check-artifacts.mjs and keep it, or soften the sentence. An absolute claim that is one ` +
        `counter-example away from false costs more credibility than it buys.`
      : ""
  );
}

/* ------------------------------------------------------------------ *
 * 10. Gate file labels: the sync module SEARCHES for a label and WRITES
 *     another. If those two drift apart, the search finds nothing, the
 *     stamp never lands, and every test that does not exercise that exact
 *     path still passes. This happened: the script looked for the label in
 *     one language and wrote it in another, after a translation pass
 *     touched one line and not the other.
 * ------------------------------------------------------------------ */
{
  const sync = read("skills/collaborative-review/scripts/sync-approvals.ps1");
  const protocol = read("skills/collaborative-review/assets/engine-protocol.tmpl.md");
  const searched = [...sync.matchAll(/-match\s+'\^\\*\\*([A-Za-z][A-Za-z ]+)/g)].map((m) => m[1].trim());
  const undocumented = searched.filter((label) => !protocol.includes(label));
  report(
    "gate labels the sync module searches for are documented in the protocol",
    undocumented.length === 0,
    undocumented.length
      ? `sync-approvals.ps1 searches for the gate label(s) [${undocumented.join(", ")}], ` +
        `which the protocol never defines. The engine writes that file, so a label only ` +
        `the script knows about is a contract nobody can follow.`
      : ""
  );
}

/* ------------------------------------------------------------------ *
 * self-test: the checker must be able to FAIL, or it proves nothing.
 * ------------------------------------------------------------------ */
{
  const fakeDocs = 'run: supabase secrets set MADE_UP_NAME="x"';
  const fakeCode = 'Deno.env.get("SOMETHING_ELSE")';
  const documented = [...fakeDocs.matchAll(/secrets\s+set\s+([A-Z_][A-Z0-9_]*)/g)].map((m) => m[1]);
  const readByCode = [...fakeCode.matchAll(/Deno\.env\.get\("([A-Z_][A-Z0-9_]*)"\)/g)].map((m) => m[1]);
  const wouldCatch = documented.some((n) => !readByCode.includes(n));
  if (!wouldCatch) {
    console.error("self-test FAIL: the secret-name comparison cannot detect a mismatch.");
    process.exit(2);
  }
  const agree = ["SAME_NAME"].some((n) => !["SAME_NAME"].includes(n));
  if (agree) {
    console.error("self-test FAIL: the secret-name comparison reports a mismatch when names agree.");
    process.exit(2);
  }
}

/* ---------------- output ---------------- */

console.log("contract checks (documentation vs code)\n");
for (const c of checks) {
  console.log(`  ${c.ok ? "ok  " : "FAIL"}  ${c.name}`);
}
console.log("");

if (problems.length) {
  console.log(`CONTRADICTIONS: ${problems.length}\n`);
  for (const p of problems) {
    console.log(`  ${p.name}`);
    console.log(`      ${p.detail}\n`);
  }
  console.log("Documentation that contradicts the code is worse than no documentation:");
  console.log("it sends the reader down a path that cannot work, and costs their trust.");
  process.exit(1);
}

console.log("AGREED — documentation and code say the same thing.");
process.exit(0);
