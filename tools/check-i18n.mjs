#!/usr/bin/env node
/**
 * check-i18n.mjs - keeps the templates and the dictionaries honest about each other.
 *
 * Four ways this breaks quietly, and the check for each:
 *
 *   1. A template asks for a key no dictionary has  -> the reviewer sees the raw
 *      key ("kit.send") on a button. Caught here as a HARD failure.
 *   2. A dictionary carries a key no template uses  -> dead weight that every
 *      translator has to translate for nothing. Reported as a warning.
 *   3. The base language is missing a key some other language has -> that string
 *      can never fall back. HARD failure.
 *   4. A translation is incomplete                  -> allowed on purpose, but
 *      printed, so nobody has to guess how finished a language is.
 *
 * The verifier tests ITSELF first, against cases it must catch and cases it must
 * ignore, and refuses to run if its own detection is wrong. A verifier that
 * cannot prove it detects is a verifier nobody should trust.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const RAIZ = resolve(process.argv[2] || ".");
const DIR_I18N = join(RAIZ, "skills", "collaborative-review", "assets", "i18n");
const DIR_ASSETS = join(RAIZ, "skills", "collaborative-review", "assets");
const IDIOMA_BASE = "en";

// Two ways a template asks for a string, and both have to be visible here or
// half the interface is unchecked:
//   T("key")                  in script
//   data-i18n="key"           on static markup, filled by a loop at load
// The key is always a plain literal. A computed key ("dash." + name) would be
// invisible to this check, so the templates never build one - and the check
// below catches an attempt to.
const RE_USO = /\bT\(\s*["']([A-Za-z0-9_.]+)["']\s*\)/g;
const RE_ATRIBUTO = /\bdata-i18n(?:-placeholder)?\s*=\s*["']([A-Za-z0-9_.]+)["']/g;
// A key chosen by a conditional - T(cond ? "dash.a" : "dash.b") - is still a
// literal, just not the first thing inside the parentheses. Matching the key
// SHAPE catches those without having to parse JavaScript. The prefix keeps it
// from swallowing unrelated dotted strings like "text/html" or "v1.2".
const RE_FORMATO_CHAVE = /["']((?:kit|dash)\.[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)["']/g;
// T("dash." + algo) - a key assembled at runtime. Nothing can verify it.
const RE_MONTADA = /\bT\(\s*["'][A-Za-z0-9_.]*["']\s*\+/g;

// Only the two EXPLICIT forms. Kept separate so the self-test can hold them to
// a stricter standard than the shape match below, which is permissive by design.
function chavesExplicitas(texto) {
  const achadas = new Set();
  for (const m of texto.matchAll(RE_USO)) achadas.add(m[1]);
  for (const m of texto.matchAll(RE_ATRIBUTO)) achadas.add(m[1]);
  return achadas;
}

// Everything the shape match can see, on top of the explicit forms. Erring
// toward "used" is the safe direction here: the worst case is failing to warn
// about a dead key, never accusing a live one.
function chavesUsadas(texto) {
  const achadas = new Set();
  for (const m of texto.matchAll(RE_USO)) achadas.add(m[1]);
  for (const m of texto.matchAll(RE_ATRIBUTO)) achadas.add(m[1]);
  for (const m of texto.matchAll(RE_FORMATO_CHAVE)) achadas.add(m[1]);
  return achadas;
}

function chavesMontadas(texto) {
  return [...texto.matchAll(RE_MONTADA)].map((m) => m[0]);
}

// --- self-test: prove the detector detects, and does not over-detect ---------
const DEVE_ACHAR = [
  ['T("kit.send")', "kit.send"],
  ["T('kit.send')", "kit.send"],
  ['T( "kit.send" )', "kit.send"],
  ['esc(T("kit.mode")) + "x"', "kit.mode"],
  ["' + T(\"dash.title\") + '", "dash.title"],
  ['<button data-i18n="dash.refresh">Refresh</button>', "dash.refresh"],
  ["<input data-i18n-placeholder='dash.password'>", "dash.password"],
  ['<p class="x" data-i18n="dash.footer">t</p>', "dash.footer"],
  ['T(v === "approved" ? "dash.approvedVerdict" : "dash.rejectedVerdict")', "dash.approvedVerdict"],
  ['T(v === "approved" ? "dash.approvedVerdict" : "dash.rejectedVerdict")', "dash.rejectedVerdict"],
];
const DEVE_IGNORAR = [
  'NOT("kit.send")',        // a different function that ends in T
  'TT("kit.send")',         // ditto
  '<div data-info="dash.send">',  // a different attribute that starts the same
];
// Nothing here is key-shaped, so not even the permissive match may claim them.
const NAO_TEM_FORMATO_DE_CHAVE = [
  'headers: { "content-type": "text/html" }',  // a dotted string that is not a key
  'var v = "1.2.3";',                          // a version number
  'src="audio/recording.webm"',                // a path
  'className = "coment-tag ok"',               // css classes
];
// A key stitched together at runtime cannot be checked by anything, here or in
// an editor. Better to forbid the shape than to ship a key nobody can verify.
const MONTADAS_DEVE_ACHAR = ['T("dash.copy" + "All")', "T('kit.' + nome)"];
const MONTADAS_DEVE_IGNORAR = ['T("dash.copyAll")', 'T("kit.send") + " x"'];
{
  const falhas = [];
  for (const [entrada, esperada] of DEVE_ACHAR) {
    const achadas = chavesUsadas(entrada);
    if (!achadas.has(esperada)) falhas.push(`should have found ${esperada} in: ${entrada}`);
  }
  for (const entrada of DEVE_IGNORAR) {
    if (chavesExplicitas(entrada).size !== 0) falhas.push(`should have found nothing in: ${entrada}`);
  }
  // The shape match must still refuse anything that is not key-shaped, or it
  // would mark every dead key as used and this whole check would go quiet.
  for (const entrada of NAO_TEM_FORMATO_DE_CHAVE) {
    if (chavesUsadas(entrada).size !== 0) falhas.push(`shape match should have ignored: ${entrada}`);
  }
  for (const entrada of MONTADAS_DEVE_ACHAR) {
    if (chavesMontadas(entrada).length === 0) falhas.push(`should have flagged a runtime-built key in: ${entrada}`);
  }
  for (const entrada of MONTADAS_DEVE_IGNORAR) {
    if (chavesMontadas(entrada).length !== 0) falhas.push(`should NOT have flagged: ${entrada}`);
  }
  if (falhas.length) {
    process.stderr.write("check-i18n self-test FAILED, refusing to run:\n");
    for (const f of falhas) process.stderr.write("  - " + f + "\n");
    process.exit(3);
  }
}

// --- load ------------------------------------------------------------------
if (!existsSync(DIR_I18N)) {
  process.stderr.write(`No language folder at ${DIR_I18N}\n`);
  process.exit(2);
}

const idiomas = {};
for (const arq of readdirSync(DIR_I18N).filter((f) => f.endsWith(".json"))) {
  const codigo = arq.replace(/\.json$/, "");
  try {
    idiomas[codigo] = JSON.parse(readFileSync(join(DIR_I18N, arq), "utf8").replace(/^﻿/, ""));
  } catch (e) {
    process.stderr.write(`${arq} is not valid JSON: ${e.message}\n`);
    process.exit(2);
  }
}
if (!idiomas[IDIOMA_BASE]) {
  process.stderr.write(`The base language ${IDIOMA_BASE}.json is missing\n`);
  process.exit(2);
}

const semMeta = (d) => Object.keys(d).filter((k) => !k.startsWith("_"));
const chavesBase = new Set(semMeta(idiomas[IDIOMA_BASE]));

// --- what the templates actually ask for ------------------------------------
const modelos = readdirSync(DIR_ASSETS).filter((f) => f.endsWith(".tmpl.html"));
const usadas = new Map(); // key -> [files]
const montadas = []; // [file, snippet]
for (const arq of modelos) {
  const conteudo = readFileSync(join(DIR_ASSETS, arq), "utf8");
  for (const chave of chavesUsadas(conteudo)) {
    if (!usadas.has(chave)) usadas.set(chave, []);
    usadas.get(chave).push(arq);
  }
  for (const trecho of chavesMontadas(conteudo)) montadas.push([arq, trecho]);
}

// --- the checks -------------------------------------------------------------
const erros = [];
const avisos = [];

for (const [arq, trecho] of montadas) {
  erros.push(`${arq} builds a key at runtime (${trecho.trim()}…) - nothing can verify that key; write it out in full`);
}

for (const [chave, arquivos] of usadas) {
  if (!chavesBase.has(chave)) {
    erros.push(`${chave} is asked for by ${arquivos.join(", ")} but is in no dictionary`);
  }
}

for (const chave of chavesBase) {
  if (!usadas.has(chave)) avisos.push(`${chave} is translated but no template uses it`);
}

for (const [codigo, dic] of Object.entries(idiomas)) {
  if (codigo === IDIOMA_BASE) continue;
  for (const chave of semMeta(dic)) {
    if (!chavesBase.has(chave)) {
      erros.push(`${codigo} has "${chave}", which the base language does not - it can never fall back`);
    }
  }
}

// --- report -----------------------------------------------------------------
const linhas = [];
linhas.push(`languages: ${Object.keys(idiomas).sort().join(", ")}`);
linhas.push(`keys in the base language: ${chavesBase.size}`);
linhas.push(`keys asked for by templates: ${usadas.size}`);
linhas.push("");
for (const codigo of Object.keys(idiomas).sort()) {
  if (codigo === IDIOMA_BASE) continue;
  const tem = new Set(semMeta(idiomas[codigo]));
  const faltando = [...chavesBase].filter((k) => !tem.has(k));
  const pct = chavesBase.size === 0 ? 100 : Math.round(((chavesBase.size - faltando.length) / chavesBase.size) * 100);
  linhas.push(`  ${codigo.padEnd(6)} ${String(pct).padStart(3)}% translated` +
    (faltando.length ? `  (falls back to English for ${faltando.length}: ${faltando.slice(0, 4).join(", ")}${faltando.length > 4 ? "…" : ""})` : ""));
}
process.stdout.write(linhas.join("\n") + "\n");

if (avisos.length) {
  process.stdout.write("\nwarnings:\n");
  for (const a of avisos) process.stdout.write("  - " + a + "\n");
}

if (erros.length) {
  process.stderr.write("\nFAILED:\n");
  for (const e of erros) process.stderr.write("  - " + e + "\n");
  process.exit(1);
}

process.stdout.write("\ni18n: templates and dictionaries agree\n");
