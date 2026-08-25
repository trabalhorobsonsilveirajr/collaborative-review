#!/usr/bin/env node
/**
 * build-kit.mjs — injects the parameterized REVIEW KIT into a target HTML file.
 *
 * Usage:
 *   node build-kit.mjs --kit <template.html> --config <config.json> --target <page.html>
 *
 * What it does, in order:
 *   1. Reads the kit template and collects EVERY {{PLACEHOLDER}} in it.
 *   2. Requires the config to supply all of them. Missing any, it fails listing
 *      exactly which, because a half-configured kit is worse than none.
 *   3. REFUSES if the target already contains the kit. Injecting twice would
 *      nest two recorders on every section.
 *   4. Backs up the target BEFORE touching anything.
 *   5. Substitutes and injects the block immediately before </body>.
 *   6. Writes atomically (temp file plus rename), so an interrupted run cannot
 *      leave a half-written page, and reports what it did.
 *
 * Plain Node, no external dependencies.
 *
 * Exit codes:
 *   0 = success
 *   1 = usage error or file not found
 *   2 = incomplete config or invalid value
 *   3 = target already contains the kit
 *   4 = target has no </body>, nowhere to inject
 */

import { readFileSync, writeFileSync, existsSync, copyFileSync, renameSync } from "node:fs";
import { buildManifest } from "./section-manifest.mjs";
import { carregarIdiomas, conferirCobertura, serializarParaKit, MARCADOR_I18N } from "./i18n.mjs";
import { resolve } from "node:path";

// Accepted placeholder form: {{UPPERCASE_WITH_UNDERSCORES}}
const RE_PLACEHOLDER = /\{\{([A-Za-z0-9_]+)\}\}/g;

function falhar(mensagem, codigo = 1) {
  console.error(`✗ ${mensagem}`);
  process.exit(codigo);
}
function avisar(mensagem) {
  console.warn(`⚠ ${mensagem}`);
}

// ---------------------------------------------------------------------------
// 1. Argumentos
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
function lerArg(nome) {
  const i = args.indexOf(`--${nome}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

const caminhoKit = lerArg("kit");
const caminhoConfig = lerArg("config");
const targetPath = lerArg("target");

if (!caminhoKit || !caminhoConfig || !targetPath) {
  falhar("Usage: node build-kit.mjs --kit <template.html> --config <config.json> --target <page.html>");
}
for (const [rotulo, caminho] of [["--kit", caminhoKit], ["--config", caminhoConfig], ["--target", targetPath]]) {
  if (!existsSync(caminho)) falhar(`File for ${rotulo} not found: ${resolve(caminho)}`);
}

// ---------------------------------------------------------------------------
// 2. Template: levantar os placeholders exigidos
// ---------------------------------------------------------------------------
const template = readFileSync(caminhoKit, "utf8");
const placeholders = new Set();
for (const m of template.matchAll(RE_PLACEHOLDER)) placeholders.add(m[1]);

if (placeholders.size === 0) {
  avisar("The template has no {{...}} placeholders. Check that --kit really points at the template.");
}

// ---------------------------------------------------------------------------
// 3. Config: check it covers EVERY placeholder, with safe values
// ---------------------------------------------------------------------------
let config;
try {
  // Strips the byte-order mark Windows sometimes writes at the start of a file
  config = JSON.parse(readFileSync(caminhoConfig, "utf8").replace(/^﻿/, ""));
} catch (e) {
  falhar(`Config is not valid JSON: ${e.message}`, 2);
}
if (typeof config !== "object" || config === null || Array.isArray(config)) {
  falhar("Config precisa ser um objeto JSON ({ \"PLACEHOLDER\": \"valor\", ... }).", 2);
}

const missing = [...placeholders].filter((p) => !(p in config)).sort();
if (missing.length > 0) {
  falhar(
    `Incomplete config: the template needs ${placeholders.size} placeholder(s), and ${missing.length} are missing:
` +
    missing.map((p) => `  - ${p}`).join("\n"),
    2
  );
}

// Os valores entram dentro de strings JS com aspas duplas no kit; caracteres
// dangerous characters would break the injected script, or open an escape.
const invalidos = [];
for (const p of placeholders) {
  const v = config[p];
  if (typeof v !== "string" || v.trim() === "") {
    invalidos.push(`${p}: must be a non-empty string`);
    continue;
  }
  if (/["\\\n\r]/.test(v)) invalidos.push(`${p}: cannot contain a double quote, backslash, or line break (it would break the kit script)`);
  if (/<\/script/i.test(v)) invalidos.push(`${p}: cannot contain "</script" (it would close the kit block early)`);
}
if (invalidos.length > 0) {
  falhar(`Config has invalid value(s):
` + invalidos.map((x) => `  - ${x}`).join("\n"), 2);
}

const sobrandoNoConfig = Object.keys(config).filter((k) => !placeholders.has(k)).sort();
if (sobrandoNoConfig.length > 0) {
  avisar(`Keys in the config the template never uses (ignored): ${sobrandoNoConfig.join(", ")}`);
}

// ---------------------------------------------------------------------------
// 4. Target: idempotence and injection point
// ---------------------------------------------------------------------------
const html = readFileSync(targetPath, "utf8");

if (html.includes("REVIEW KIT")) {
  falhar(
    'The target already contains "REVIEW KIT"; not injecting again. To re-inject, ' +
    "To re-inject, restore the .pre-kit.html backup or remove the current block first.",
    3
  );
}

// lastIndexOf finds the REAL </body>, the last one in the file, even if the
// string appears earlier inside some script.
const idxBody = html.toLowerCase().lastIndexOf("</body>");
if (idxBody === -1) {
  falhar("The target has no </body>, so there is nowhere to inject the kit.", 4);
}

// ---------------------------------------------------------------------------
// 5. Backup antes de mexer
// ---------------------------------------------------------------------------
const baseBackup = targetPath.replace(/\.html?$/i, "");
let caminhoBackup = `${baseBackup}.pre-kit.html`;
if (existsSync(caminhoBackup)) {
  // Never overwrite an existing backup silently: fall back to a timestamped name
  const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  caminhoBackup = `${baseBackup}.pre-kit-${ts}.html`;
  avisar(`The default backup already existed, so this one goes to: ${caminhoBackup}`);
}
copyFileSync(targetPath, caminhoBackup);

// ---------------------------------------------------------------------------
// 6. Substitute placeholders and confirm none survived
// ---------------------------------------------------------------------------
let bloco = template;
for (const p of placeholders) {
  bloco = bloco.split(`{{${p}}}`).join(config[p]);
}

// The dictionaries are embedded rather than fetched, so the reviewed page needs
// no extra request and keeps working offline and from a file:// path. The marker
// is a comment rather than a brace-delimited name, so it survives step 6
// untouched and the config never has to carry a value it did not write.
if (bloco.includes(MARCADOR_I18N)) {
  let idiomas;
  try {
    idiomas = carregarIdiomas();
  } catch (e) {
    falhar(`Could not load the languages: ${e.message}`, 2);
  }
  const coverage = conferirCobertura(idiomas);
  for (const [codigo, info] of Object.entries(coverage)) {
    if (info.coverage < 1) {
      avisar(`${codigo} is ${Math.round(info.coverage * 100)}% translated; the rest falls back to English`);
    }
  }
  bloco = bloco.split(MARCADOR_I18N).join(serializarParaKit(idiomas));
  const codigos = Object.keys(idiomas).sort().join(", ");
  avisar(`Languages embedded in the kit: ${codigos}. The reviewer's browser picks one; anything else gets English.`);
} else {
  avisar("The template has no language marker. The kit will show the English text baked into it.");
}

// Safety net: if ANYTHING placeholder-shaped survived, stop rather than ship
// (including odd forms like {{ WITH SPACES }}), abort rather than ship it.
const sobras = bloco.match(/\{\{[^}]*\}\}/g);
if (sobras) {
  falhar(`A placeholder survived substitution in the final block: ${[...new Set(sobras)].join(", ")}`, 2);
}

// Kit invariants (a light check; the real gate is Phase 2 of the skill):
if (!/@media\s+print/i.test(bloco)) {
  avisar("INVARIANT: the block has no print rules. The kit must disappear when printing. Check the template.");
}
if (!bloco.includes("REVIEW_MODE")) {
  avisar("The block has no REVIEW_MODE switch. Check the template.");
}

// ---------------------------------------------------------------------------
// 7. Inject immediately before </body> and write atomically
// ---------------------------------------------------------------------------
/* Mark the reviewable sections and record what they are, BEFORE injecting the
 * kit. This list is what the quality gate will treat as the boundary, and it has
 * to be established by something other than the agent the gate contains: an audit
 * defeated an earlier version in four commands by simply declaring different
 * markers on the command line.
 *
 * If the sections cannot be established confidently, this aborts. Injecting the
 * kit without a manifest would leave a page that collects feedback and a gate
 * with no boundary to enforce, which is the worst of both. */
const marcado = buildManifest(html, config.SECTION_SELECTOR, {
  material: config.MATERIAL || "",
  project: config.PROJECT || "",
});
if (!marcado.ok) {
  falhar(
    "Could not establish the reviewable sections, so nothing was written.\n" +
    "  " + marcado.why + "\n" +
    "  The gate needs a list of sections it can trust. Without one it would have\n" +
    "  no boundary to enforce, and a gate with no boundary guarantees nothing.",
    2
  );
}
const htmlMarcado = marcado.html;
const idxBodyMarcado = htmlMarcado.lastIndexOf("</body>");

const separadorFinal = bloco.endsWith("\n") ? "" : "\n";
const resultado = htmlMarcado.slice(0, idxBodyMarcado) + bloco + separadorFinal +
  htmlMarcado.slice(idxBodyMarcado);

const tmp = `${targetPath}.tmp-kit`;
writeFileSync(tmp, resultado, "utf8");
renameSync(tmp, targetPath); // atomic: the target is either fully old or fully new

const caminhoManifesto = targetPath.replace(/\.html?$/i, "") + ".sections.json";
writeFileSync(caminhoManifesto, JSON.stringify(marcado.manifest, null, 2), "utf8");

// ---------------------------------------------------------------------------
// 8. Report
// ---------------------------------------------------------------------------
const nomes = [...placeholders].sort();
console.log("Review kit injected successfully.");
console.log(`  Template : ${resolve(caminhoKit)}`);
console.log(`  Target   : ${resolve(targetPath)}`);
console.log(`  Backup   : ${resolve(caminhoBackup)}`);
console.log(`  Placeholders replaced (${nomes.length}): ${nomes.join(", ")}`);
console.log(`  Block of ${bloco.split("\n").length} lines injected right before </body>.`);
console.log(`  Sections marked (${marcado.manifest.sections.length}): ${caminhoManifesto}`);
console.log("  Next: serve the target over local HTTP and check the three invariants.");
