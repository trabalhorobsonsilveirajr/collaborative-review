#!/usr/bin/env node
/**
 * check-placeholders.mjs — proves the templates, the example config, and the
 * documentation agree on placeholder names.
 *
 * Why this exists: a placeholder the template expects but the config never supplies is
 * a failure at install time, in someone else's project, with an error that points at the
 * wrong thing. A documented name that does not match the template is worse, because the
 * person following the guide does everything right and it still fails.
 *
 * Neither shows up in any test that exercises the code, because nothing here is code.
 * So it gets its own check.
 *
 * Exit codes: 0 = consistent · 1 = mismatch
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLACEHOLDER = /\{\{([A-Z_][A-Z0-9_]*)\}\}/g;

function read(p) { return readFileSync(join(SKILL, p), "utf8"); }

function placeholdersIn(text) {
  return new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]));
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(md|html|ps1|mjs|py|json|ts|sql)$/i.test(e)) out.push(full);
  }
  return out;
}

const problems = [];

/* 1. Every placeholder the kit template needs must exist in the example config. */
const kitNeeds = placeholdersIn(read("assets/review-kit.tmpl.html"));
const configHas = new Set(
  Object.keys(JSON.parse(read("assets/example-config.json")))
    .filter((k) => !k.startsWith("_"))
);

for (const name of kitNeeds) {
  if (!configHas.has(name)) {
    problems.push(`kit template needs {{${name}}}, but the example config does not supply it`);
  }
}
for (const name of configHas) {
  if (!kitNeeds.has(name)) {
    problems.push(`example config supplies ${name}, but the kit template never uses it`);
  }
}

/* 2. Every placeholder the engine protocol expects must be filled by the watcher.
 *    A protocol asking for a value nobody provides fails at runtime, headless, where
 *    nobody sees the error. */
const protocolNeeds = placeholdersIn(read("assets/engine-protocol.tmpl.md"));
const watcherFills = placeholdersIn(read("scripts/watcher.tmpl.ps1"));

for (const name of protocolNeeds) {
  if (!watcherFills.has(name)) {
    problems.push(`engine protocol expects {{${name}}}, but the watcher never fills it`);
  }
}

/* 3. Nothing may still carry a Portuguese placeholder name, since the documentation
 *    promises English ones. */
const LEGACY = ["SELETOR_SECOES", "SELETOR_TITULO_SECAO", "SELETOR_CORPO_SECAO",
  "ANCORA_BARRA_NOME", "ROTULO_SECAO", "PROJETO", "SENHA_PATH", "PROTOCOLO_PATH",
  "REGISTRO_PATH", "SENHA_PAINEL"];

for (const file of walk(SKILL)) {
  const text = readFileSync(file, "utf8");
  for (const old of LEGACY) {
    if (text.includes(`{{${old}}}`)) {
      problems.push(`${relative(SKILL, file)} still uses the old name {{${old}}}`);
    }
  }
}

console.log("placeholder consistency");
console.log(`  kit template   : ${kitNeeds.size} placeholders`);
console.log(`  example config : ${configHas.size} keys`);
console.log(`  engine protocol: ${protocolNeeds.size} placeholders`);

if (problems.length) {
  console.log(`\nMISMATCHES: ${problems.length}\n`);
  for (const p of problems) console.log(`  · ${p}`);
  console.log("\nFix these before shipping. They fail at install time, not at test time.");
  process.exit(1);
}

console.log("\nCONSISTENT — templates, config, and protocol agree.");
process.exit(0);
