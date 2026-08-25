#!/usr/bin/env node
/**
 * check-wire-format.mjs — proves the four pieces agree on the names that cross
 * between them.
 *
 * NOT part of the published skill. This is the publishing harness.
 *
 * WHY THIS EXISTS. The database, the review kit, the dashboard, the watcher, the
 * sync module and the engine protocol all name the same fields. When two of them
 * disagree, nothing errors: a query returns nothing, a stamp never lands, a status
 * never matches, and the feature is quietly dead. Two audits found exactly that,
 * twice, and neither the 45-case suite nor the 21-case suite could see it — because
 * test fixtures are written alongside the code and inherit the same mistake.
 *
 * A passing test suite says the code agrees with itself. This says the code agrees
 * with the SCHEMA, which is the only definition that can arbitrate.
 *
 * The schema is the authority. Everything else is compared against it.
 *
 * Exit codes: 0 = agree · 1 = disagreement · 2 = the checker itself is broken
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.argv[2] || ".";
const SKILL = join(ROOT, "skills", "collaborative-review");
const SQL = join(SKILL, "assets", "sql");

const problems = [];
const notes = [];

function read(p) {
  try { return readFileSync(p, "utf8"); } catch { return null; }
}

/* ------------------------------------------------------------------ *
 * 1. The schema: what columns actually exist.
 * ------------------------------------------------------------------ */

function columnsFromSchema() {
  const tables = new Map();
  if (!existsSync(SQL)) return tables;
  for (const f of readdirSync(SQL).filter((n) => n.endsWith(".sql"))) {
    const text = read(join(SQL, f)) || "";
    const re = /create table if not exists\s+public\.(\w+)\s*\(([\s\S]*?)\n\s*\);/gi;
    let m;
    while ((m = re.exec(text))) {
      const [, table, body] = m;
      const cols = new Set(tables.get(table) || []);
      for (const line of body.split("\n")) {
        const c = line.match(/^\s{2,}(\w+)\s+(text|int|bigint|boolean|timestamptz|uuid|jsonb)\b/i);
        if (c) cols.add(c[1]);
      }
      tables.set(table, cols);
    }
    /* Columns added by a later migration count too. */
    for (const a of text.matchAll(/alter table\s+public\.(\w+)\s+add column if not exists\s+(\w+)/gi)) {
      const cols = new Set(tables.get(a[1]) || []);
      cols.add(a[2]);
      tables.set(a[1], cols);
    }
  }
  return tables;
}

/* ------------------------------------------------------------------ *
 * 2. What each piece USES.
 * ------------------------------------------------------------------ */

function usedInServerFunctions() {
  const dir = join(SKILL, "assets", "edge-functions");
  const used = new Map(); // name -> where
  if (!existsSync(dir)) return used;
  for (const fn of readdirSync(dir)) {
    const p = join(dir, fn, "index.ts");
    const text = read(p);
    if (!text) continue;
    const where = `edge-functions/${fn}`;
    /* .select("a, b, c") and .select('a, b') */
    for (const m of text.matchAll(/\.select\(\s*["'`]([^"'`]+)["'`]/g)) {
      for (const raw of m[1].split(",")) {
        const name = raw.trim().split(/[\s(]/)[0];
        if (/^\w+$/.test(name) && name !== "*") used.set(name, where);
      }
    }
    /* .eq("col", …) .order("col") .is("col", …) */
    for (const m of text.matchAll(/\.(?:eq|neq|is|order|gte|lte|in)\(\s*["'](\w+)["']/g)) {
      used.set(m[1], where);
    }
    /* object literals inserted: { col: value } inside .insert(...) */
    for (const m of text.matchAll(/\.insert\(\s*(\{[\s\S]{0,400}?\})/g)) {
      for (const k of m[1].matchAll(/(\w+)\s*:/g)) used.set(k[1], where);
    }
  }
  return used;
}

function usedInPowerShell() {
  const dir = join(SKILL, "scripts");
  const used = new Map();
  if (!existsSync(dir)) return used;
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".ps1"))) {
    const text = read(join(dir, f)) || "";
    const where = `scripts/${f}`;
    /* $obj.field — only fields that look like schema names (snake_case or known) */
    for (const m of text.matchAll(/\$\w+\.(\w+)/g)) {
      if (/_/.test(m[1]) || SCHEMA_WORDS.has(m[1])) used.set(m[1], where);
    }
    /* -Property field / Sort-Object field */
    for (const m of text.matchAll(/(?:-Property|Sort-Object)\s+(\w+)/g)) {
      if (/_/.test(m[1]) || SCHEMA_WORDS.has(m[1])) used.set(m[1], where);
    }
  }
  return used;
}

function usedInBrowser() {
  const used = new Map();
  for (const [f, where] of [
    ["assets/review-kit.tmpl.html", "review kit"],
    ["assets/dashboard.tmpl.html", "dashboard"],
  ]) {
    const text = read(join(SKILL, f)) || "";
    /* f.field access */
    for (const m of text.matchAll(/\b(?:f|obj|r|it|registro|d|ap)\.(\w+)/g)) {
      if (/_/.test(m[1]) || SCHEMA_WORDS.has(m[1])) used.set(m[1], where);
    }
  }
  return used;
}

/* THE CONVENTION THIS RELIES ON, and why it exists:
 *
 *   snake_case  = the wire format. A name that crosses between pieces.
 *   camelCase   = internal. Lives inside one script and crosses nothing.
 *
 * That makes the distinction MECHANICAL. Without it, this checker needs a list of
 * forgiven names, and every name added to such a list is a place it stops looking.
 * A checker with a growing exception list is a checker on its way to blind.
 *
 * Single-word schema names have no underscore to recognise them by, so those are
 * listed below. Anything with an underscore is picked up automatically. */
const SCHEMA_WORDS = new Set([
  "password", "section", "comment", "project", "material", "type", "verdict",
  "proposal", "transcript", "rationale", "id",
]);

/* ------------------------------------------------------------------ *
 * 3. Compare.
 * ------------------------------------------------------------------ */

const schema = columnsFromSchema();
const allColumns = new Set();
for (const cols of schema.values()) for (const c of cols) allColumns.add(c);

/* Names produced by the code that are NOT columns: either a typo, or a leftover
 * from an incomplete rename. Both are silent failures in production. */
const NOT_COLUMNS_OK = new Set([
  "id", "action", "error_message", "pending_only", "approvals", "signed_url",
  "audio_url", "name", "path", "length", "message", "count", "Count", "Name",
  "FullName", "Group", "Exception", "Message", "Value", "Key", "Length",
]);

function compare(label, used) {
  const strays = [];
  for (const [name, where] of used) {
    if (allColumns.has(name)) continue;
    if (NOT_COLUMNS_OK.has(name)) continue;
    strays.push(`${name} (used in ${where})`);
  }
  if (strays.length) {
    problems.push({
      what: `${label} uses names the schema does not define`,
      detail: strays.join("; "),
    });
  }
  notes.push(`  ${strays.length === 0 ? "ok  " : "FAIL"}  ${label}`);
}

if (allColumns.size === 0) {
  console.error("CHECKER IS BROKEN: found no columns in the schema at all.");
  console.error(`Looked in: ${SQL}`);
  console.error("Refusing to report agreement when there is nothing to compare against.");
  process.exit(2);
}

/* Self-test: the comparison must be able to fail. */
{
  const fake = new Map([["definitely_not_a_column", "selftest"]]);
  const before = problems.length;
  compare("selftest", fake);
  if (problems.length === before) {
    console.error("CHECKER IS BROKEN: it cannot detect a name absent from the schema.");
    process.exit(2);
  }
  problems.pop();
  notes.pop();
}

console.log("wire format (schema is the authority)\n");
console.log(`  schema defines ${allColumns.size} column(s) across ${schema.size} table(s):`);
for (const [t, cols] of schema) console.log(`    ${t}: ${[...cols].join(", ")}`);
console.log("");

/* ------------------------------------------------------------------ *
 * The materials registry is a wire format too, and a nastier one: it has no
 * schema to arbitrate. The watcher reads keys from a JSON file the user writes
 * by hand, following a table in SETUP.md. When those three drift apart, the
 * watcher simply never matches the material, and SETUP itself teaches that
 * "silence IS the healthy state" — so the symptom of the failure is identical
 * to the symptom of health. An audit found exactly that.
 * ------------------------------------------------------------------ */
{
  const exampleRaw = read(join(SKILL, "scripts", "materials-registry.example.json"));
  const watcher = read(join(SKILL, "scripts", "watcher.tmpl.ps1")) || "";
  const setup = read(join(ROOT, "SETUP.md")) || "";

  if (!exampleRaw) {
    problems.push({
      what: "materials registry example is missing",
      detail: "the watcher reads a registry the user writes by hand; without an example, the keys are guesswork",
    });
    notes.push("  FAIL  materials registry");
  } else {
    let example = {};
    try { example = JSON.parse(exampleRaw); } catch (e) {
      problems.push({ what: "materials registry example is not valid JSON", detail: e.message });
    }
    const first = Array.isArray(example) ? (example[0] || {}) : example;
    const exampleKeys = Object.keys(first);

    /* what the watcher actually reads off a registry entry */
    const readByWatcher = new Set();
    for (const m of watcher.matchAll(/\$m\.(\w+)/g)) readByWatcher.add(m[1]);

    const strays = [];
    for (const k of readByWatcher) {
      if (!exampleKeys.includes(k)) {
        strays.push(`watcher reads "${k}", which the example registry does not have`);
      }
    }
    for (const k of exampleKeys) {
      if (!setup.includes("`" + k + "`")) {
        strays.push(`example has "${k}", which SETUP never documents`);
      }
    }
    if (strays.length) {
      problems.push({ what: "materials registry keys disagree", detail: strays.join("; ") });
    }
    notes.push(`  ${strays.length === 0 ? "ok  " : "FAIL"}  materials registry`);
  }
}

/* ------------------------------------------------------------------ *
 * THE REQUEST CONTRACT — and why this checker was blind to it.
 *
 * The first version of this file arbitrated everything against the database
 * schema, on the reasoning that the schema is the only definition that cannot
 * argue back. That reasoning was right and the scope was wrong.
 *
 * Request body fields are ALSO a contract, between the browser and the server
 * function, and they have no schema. `password` and `action` are not columns of
 * anything. So when a rename moved the dashboard to `password` and left the
 * functions reading `senha`, this checker printed AGREED while every request
 * returned 401 and the product was dead.
 *
 * A checker that arbitrates only what is easy to arbitrate reports agreement
 * about the half it can see. That is the same failure it exists to catch.
 *
 * Here the two sides arbitrate each other: what the browser SENDS must be what
 * the function READS.
 * ------------------------------------------------------------------ */
{
  const dashboard = read(join(SKILL, "assets", "dashboard.tmpl.html")) || "";
  const kit = read(join(SKILL, "assets", "review-kit.tmpl.html")) || "";
  const browser = dashboard + "\n" + kit;

  /* What the browser puts in a request body. */
  const sent = new Map(); // field -> where
  for (const [src, label] of [[dashboard, "dashboard"], [kit, "review kit"]]) {
    for (const m of src.matchAll(/JSON\.stringify\(\s*\{([^}]*)\}/g)) {
      for (const k of m[1].matchAll(/(?:^|[,{\s])([a-z_][\w]*)\s*:/g)) {
        sent.set(k[1], label);
      }
    }
  }

  /* What each server function destructures out of the body. */
  const readByFn = new Map(); // field -> function
  const fnDir = join(SKILL, "assets", "edge-functions");
  if (existsSync(fnDir)) {
    for (const fn of readdirSync(fnDir)) {
      const text = read(join(fnDir, fn, "index.ts"));
      if (!text) continue;
      for (const m of text.matchAll(/const\s*\{([^}]*)\}\s*=\s*body/g)) {
        for (const k of m[1].matchAll(/(?:^|[,\s])([a-z_][\w]*)/g)) {
          readByFn.set(k[1], fn);
        }
      }
    }
  }

  /* Not every function is called by a page. `record-decision` is called by the
   * ENGINE, following the protocol, and the protocol is prose. That contract
   * cannot be arbitrated by reading two pieces of code, so this checker does not
   * pretend otherwise: it requires the protocol to NAME the fields, and reports
   * the contract as documented rather than as verified. Claiming to have checked
   * something unverifiable is the failure this whole file exists to prevent. */
  const protocol = read(join(SKILL, "assets", "engine-protocol.tmpl.md")) || "";
  const ENGINE_CALLED = new Set(["record-decision"]);

  const strays = [];
  const undocumented = [];
  for (const [field, fn] of readByFn) {
    if (sent.has(field)) continue;
    if (ENGINE_CALLED.has(fn)) {
      /* the protocol must at least name it, or nobody can implement the caller */
      /* includes(), not a regex: in a template literal a backslash-b is the
       * backspace character, not a word boundary, and the check silently
       * matched nothing. A checker that always fires is as useless as one
       * that never does. */
      if (!protocol.includes("`" + field + "`")) {
        undocumented.push(`${fn} reads "${field}", sent by the engine, and the protocol never names it`);
      }
      continue;
    }
    strays.push(
      `${fn} reads "${field}" from the request body, but no page ever sends it. ` +
      `That field arrives undefined on every call`
    );
  }
  if (undocumented.length) {
    problems.push({
      what: "an engine-called function reads fields the protocol never documents",
      detail: undocumented.join("; ") +
        ". The engine is told what to send by the protocol; a field only the code knows " +
        "about is a contract nobody can follow.",
    });
  }

  /* Both sets being empty means the extraction failed, not that they agree. A
   * checker must never report agreement about nothing. */
  if (sent.size === 0 || readByFn.size === 0) {
    problems.push({
      what: "request contract could not be read",
      detail: `found ${sent.size} field(s) sent and ${readByFn.size} field(s) read. ` +
        `With nothing to compare, this cannot report agreement.`,
    });
    notes.push("  FAIL  request contract (nothing extracted)");
  } else if (strays.length) {
    problems.push({ what: "the browser and the server functions disagree", detail: strays.join("; ") });
    notes.push("  FAIL  request contract");
  } else {
    notes.push(`  ok    request contract (${sent.size} sent, ${readByFn.size} read)`);
  }
}

compare("server functions", usedInServerFunctions());
compare("watcher and sync", usedInPowerShell());
compare("review kit and dashboard", usedInBrowser());

console.log(notes.join("\n"));
console.log("");

if (problems.length) {
  console.log(`DISAGREEMENT: ${problems.length}\n`);
  for (const p of problems) {
    console.log(`  ${p.what}`);
    console.log(`      ${p.detail}\n`);
  }
  console.log("A name that no column defines fails silently in production: the query");
  console.log("returns nothing, and no error is raised. Fix before shipping.");
  process.exit(1);
}

console.log("AGREED — every field name the code uses is defined by the schema.");
process.exit(0);
