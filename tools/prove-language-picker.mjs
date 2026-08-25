#!/usr/bin/env node
/**
 * prove-language-picker.mjs - proves the language switch on a REAL injected page.
 *
 * Not a reimplementation of the logic: this builds a page through the actual
 * build-kit, cuts the language block out of the RESULT, and runs that code
 * against fake browsers. If someone changes how the picker works, this reads
 * the change rather than agreeing with a copy that no longer matches.
 *
 * Runs with no server and no network, so it belongs in CI.
 */

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(process.argv[2] || join(AQUI, ".."));
const SKILL = join(RAIZ, "skills", "collaborative-review");

const trabalho = mkdtempSync(join(tmpdir(), "prove-lang-"));
let falhas = 0;
const relatar = (ok, texto) => {
  if (!ok) falhas++;
  process.stdout.write(`${ok ? "  ok  " : "  FAIL"} ${texto}\n`);
};

try {
  /* A minimal page with the two sections build-kit requires. */
  const alvo = join(trabalho, "page.html");
  writeFileSync(alvo,
    "<html><body><main>" +
    '<section class="sec"><h2>One</h2><p>first</p></section>' +
    '<section class="sec"><h2>Two</h2><p>second</p></section>' +
    "</main></body></html>", "utf8");

  const config = join(trabalho, "config.json");
  writeFileSync(config, JSON.stringify({
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_ANON_KEY: "test-key",
    PROJECT: "proof",
    MATERIAL: "Proof page",
    SECTION_SELECTOR: "section.sec",
    SECTION_TITLE_SELECTOR: "h2",
    SECTION_BODY_SELECTOR: "p",
    NAME_BAR_ANCHOR: "main",
    SECTION_LABEL: "Step ",
    BUCKET_AUDIO: "audio",
  }), "utf8");

  execFileSync(process.execPath, [
    join(SKILL, "scripts", "build-kit.mjs"),
    "--kit", join(SKILL, "assets", "review-kit.tmpl.html"),
    "--config", config,
    "--target", alvo,
  ], { stdio: "pipe" });

  const pagina = readFileSync(alvo, "utf8");

  /* Cut out the language block exactly as it was written into the page. */
  const inicio = pagina.indexOf("var I18N = ");
  const fim = pagina.indexOf('try{ document.documentElement.setAttribute("data-review-lang"');
  if (inicio < 0 || fim < 0) {
    process.stderr.write("Could not find the language block in the built page.\n");
    process.exit(2);
  }
  const codigoReal = pagina.slice(inicio, fim);

  const montar = (idiomaNavegador) =>
    new Function("navigator", codigoReal + "\n return { T: T, IDIOMA: IDIOMA };")({ language: idiomaNavegador });

  /* The dictionaries really made it into the page, not just the marker. */
  relatar(!pagina.includes('/*__I18N__*/'), "the language marker was replaced, not shipped as-is");
  relatar(pagina.includes('"kit.send"'), "the dictionaries are embedded in the page");

  const CASOS = [
    ["pt-BR", "pt-BR", "a Brazilian browser"],
    ["pt", "pt-BR", "generic Portuguese finds the regional file"],
    ["PT-br", "pt-BR", "casing is ignored"],
    ["es-MX", "es", "Mexican Spanish falls back to Spanish"],
    ["fr-CA", "fr", "Canadian French falls back to French"],
    ["en-US", "en", "American English"],
    ["de-DE", "en", "a language with no file gets English"],
    ["ja", "en", "another one"],
    ["", "en", "a browser reporting nothing gets English"],
  ];
  for (const [navegador, esperado, descricao] of CASOS) {
    const { IDIOMA } = montar(navegador);
    relatar(IDIOMA === esperado, `${String(navegador || "(empty)").padEnd(7)} -> ${IDIOMA.padEnd(6)} ${descricao}`);
  }

  /* Same key, genuinely different words: proof it is translating, not just
   * picking a code and returning English regardless. */
  const enviarPt = montar("pt-BR").T("kit.send");
  const enviarEn = montar("en-US").T("kit.send");
  const enviarFr = montar("fr-CA").T("kit.send");
  relatar(enviarPt !== enviarEn && enviarFr !== enviarEn,
    `the same key returns different words per language ("${enviarEn}" / "${enviarPt}" / "${enviarFr}")`);

  /* Every key a template asks for must resolve to something in every language,
   * or a reviewer somewhere reads a raw key on a button. */
  const chaves = [...new Set([...pagina.matchAll(/\bT\(\s*"([A-Za-z0-9_.]+)"\s*\)/g)].map((m) => m[1]))];
  relatar(chaves.length > 20, `the page asks for ${chaves.length} keys`);
  for (const idioma of ["en", "pt-BR", "es", "fr"]) {
    const { T } = montar(idioma);
    const vazias = chaves.filter((k) => {
      const v = T(k);
      return typeof v !== "string" || v.length === 0 || v === k;
    });
    relatar(vazias.length === 0,
      `${idioma.padEnd(6)} resolves all ${chaves.length} keys` + (vazias.length ? ` (missing: ${vazias.join(", ")})` : ""));
  }

  /* The stored value must NOT follow the language, or the same section would
   * land in the database under a different name per reviewer. */
  relatar(pagina.includes('makeBlock("General comments", "general"'),
    "the section value written to the database stays in English");

  process.stdout.write(`\nlanguage picker: ${falhas === 0 ? "all checks passed" : falhas + " FAILED"}\n`);
} finally {
  try { rmSync(trabalho, { recursive: true, force: true }); } catch {}
}

process.exit(falhas === 0 ? 0 : 1);
