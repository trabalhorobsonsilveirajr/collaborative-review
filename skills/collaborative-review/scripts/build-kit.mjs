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
import { loadLanguages, checkCoverage, serializeForPage, I18N_MARKER } from "./i18n.mjs";
import { resolve } from "node:path";

// Accepted placeholder form: {{UPPERCASE_WITH_UNDERSCORES}}
const RE_PLACEHOLDER = /\{\{([A-Za-z0-9_]+)\}\}/g;

function fail(message, code = 1) {
  console.error(`✗ ${message}`);
  process.exit(code);
}
function warn(message) {
  console.warn(`⚠ ${message}`);
}

// ---------------------------------------------------------------------------
// 1. Argumentos
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
function readArg(nome) {
  const i = args.indexOf(`--${nome}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

const kitPath = readArg("kit");
const configPath = readArg("config");
const targetPath = readArg("target");

if (!kitPath || !configPath || !targetPath) {
  fail("Usage: node build-kit.mjs --kit <template.html> --config <config.json> --target <page.html>");
}
for (const [label, path] of [["--kit", kitPath], ["--config", configPath], ["--target", targetPath]]) {
  if (!existsSync(path)) fail(`File for ${label} not found: ${resolve(path)}`);
}

// ---------------------------------------------------------------------------
// 2. Template: levantar os placeholders exigidos
// ---------------------------------------------------------------------------
const template = readFileSync(kitPath, "utf8");
const placeholders = new Set();
for (const m of template.matchAll(RE_PLACEHOLDER)) placeholders.add(m[1]);

if (placeholders.size === 0) {
  warn("The template has no {{...}} placeholders. Check that --kit really points at the template.");
}

// ---------------------------------------------------------------------------
// 3. Config: check it covers EVERY placeholder, with safe values
// ---------------------------------------------------------------------------
let config;
try {
  // Strips the byte-order mark Windows sometimes writes at the start of a file
  config = JSON.parse(readFileSync(configPath, "utf8").replace(/^﻿/, ""));
} catch (e) {
  fail(`Config is not valid JSON: ${e.message}`, 2);
}
if (typeof config !== "object" || config === null || Array.isArray(config)) {
  fail("Config precisa ser um objeto JSON ({ \"PLACEHOLDER\": \"value\", ... }).", 2);
}

const missing = [...placeholders].filter((p) => !(p in config)).sort();
if (missing.length > 0) {
  fail(
    `Incomplete config: the template needs ${placeholders.size} placeholder(s), and ${missing.length} are missing:
` +
    missing.map((p) => `  - ${p}`).join("\n"),
    2
  );
}

// Os valores entram dentro de strings JS com aspas duplas no kit; caracteres
// dangerous characters would break the injected script, or open an escape.
const invalid = [];
for (const p of placeholders) {
  const v = config[p];
  if (typeof v !== "string" || v.trim() === "") {
    invalid.push(`${p}: must be a non-empty string`);
    continue;
  }
  if (/["\\\n\r]/.test(v)) invalid.push(`${p}: cannot contain a double quote, backslash, or line break (it would break the kit script)`);
  if (/<\/script/i.test(v)) invalid.push(`${p}: cannot contain "</script" (it would close the kit block early)`);
}
if (invalid.length > 0) {
  fail(`Config has invalid value(s):
` + invalid.map((x) => `  - ${x}`).join("\n"), 2);
}

const unusedInConfig = Object.keys(config).filter((k) => !placeholders.has(k)).sort();
if (unusedInConfig.length > 0) {
  warn(`Keys in the config the template never uses (ignored): ${unusedInConfig.join(", ")}`);
}

// ---------------------------------------------------------------------------
// 4. Target: idempotence and injection point
// ---------------------------------------------------------------------------
const html = readFileSync(targetPath, "utf8");

if (html.includes("REVIEW KIT")) {
  fail(
    'The target already contains "REVIEW KIT"; not injecting again. To re-inject, ' +
    "To re-inject, restore the .pre-kit.html backup or remove the current block first.",
    3
  );
}

// lastIndexOf finds the REAL </body>, the last one in the file, even if the
// string appears earlier inside some script.
const idxBody = html.toLowerCase().lastIndexOf("</body>");
if (idxBody === -1) {
  fail("The target has no </body>, so there is nowhere to inject the kit.", 4);
}

// ---------------------------------------------------------------------------
// 5. Backup antes de mexer
// ---------------------------------------------------------------------------
const backupBase = targetPath.replace(/\.html?$/i, "");
let backupPath = `${backupBase}.pre-kit.html`;
if (existsSync(backupPath)) {
  // Never overwrite an existing backup silently: fall back to a timestamped name
  const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  backupPath = `${backupBase}.pre-kit-${ts}.html`;
  warn(`The default backup already existed, so this one goes to: ${backupPath}`);
}
copyFileSync(targetPath, backupPath);

// ---------------------------------------------------------------------------
// 6. Substitute placeholders and confirm none survived
// ---------------------------------------------------------------------------
let block = template;
for (const p of placeholders) {
  block = block.split(`{{${p}}}`).join(config[p]);
}

// The dictionaries are embedded rather than fetched, so the reviewed page needs
// no extra request and keeps working offline and from a file:// path. The marker
// is a comment rather than a brace-delimited name, so it survives step 6
// untouched and the config never has to carry a value it did not write.
if (block.includes(I18N_MARKER)) {
  let languages;
  try {
    languages = loadLanguages();
  } catch (e) {
    fail(`Could not load the languages: ${e.message}`, 2);
  }
  const coverage = checkCoverage(languages);
  for (const [code, info] of Object.entries(coverage)) {
    if (info.coverage < 1) {
      warn(`${code} is ${Math.round(info.coverage * 100)}% translated; the rest falls back to English`);
    }
  }
  block = block.split(I18N_MARKER).join(serializeForPage(languages));
  const codes = Object.keys(languages).sort().join(", ");
  warn(`Languages embedded in the kit: ${codes}. The reviewer's browser picks one; anything else gets English.`);
} else {
  warn("The template has no language marker. The kit will show the English text baked into it.");
}

// Safety net: if ANYTHING placeholder-shaped survived, stop rather than ship
// (including odd forms like {{ WITH SPACES }}), abort rather than ship it.
const leftovers = block.match(/\{\{[^}]*\}\}/g);
if (leftovers) {
  fail(`A placeholder survived substitution in the final block: ${[...new Set(leftovers)].join(", ")}`, 2);
}

// Kit invariants (a light check; the real gate is Phase 2 of the skill):
if (!/@media\s+print/i.test(block)) {
  warn("INVARIANT: the block has no print rules. The kit must disappear when printing. Check the template.");
}
if (!block.includes("REVIEW_MODE")) {
  warn("The block has no REVIEW_MODE switch. Check the template.");
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
const marked = buildManifest(html, config.SECTION_SELECTOR, {
  material: config.MATERIAL || "",
  project: config.PROJECT || "",
});
if (!marked.ok) {
  fail(
    "Could not establish the reviewable sections, so nothing was written.\n" +
    "  " + marked.why + "\n" +
    "  The gate needs a list of sections it can trust. Without one it would have\n" +
    "  no boundary to enforce, and a gate with no boundary guarantees nothing.",
    2
  );
}
const markedHtml = marked.html;
const markedBodyIndex = markedHtml.lastIndexOf("</body>");

const finalSeparator = block.endsWith("\n") ? "" : "\n";
const result = markedHtml.slice(0, markedBodyIndex) + block + finalSeparator +
  markedHtml.slice(markedBodyIndex);

const tmp = `${targetPath}.tmp-kit`;
writeFileSync(tmp, result, "utf8");
renameSync(tmp, targetPath); // atomic: the target is either fully old or fully new

const manifestPath = targetPath.replace(/\.html?$/i, "") + ".sections.json";
writeFileSync(manifestPath, JSON.stringify(marked.manifest, null, 2), "utf8");

// ---------------------------------------------------------------------------
// 8. Report
// ---------------------------------------------------------------------------
const names = [...placeholders].sort();
console.log("Review kit injected successfully.");
console.log(`  Template : ${resolve(kitPath)}`);
console.log(`  Target   : ${resolve(targetPath)}`);
console.log(`  Backup   : ${resolve(backupPath)}`);
console.log(`  Placeholders replaced (${names.length}): ${names.join(", ")}`);
console.log(`  Block of ${block.split("\n").length} lines injected right before </body>.`);
console.log(`  Sections marked (${marked.manifest.sections.length}): ${manifestPath}`);
console.log("  Next: serve the target over local HTTP and check the three invariants.");
