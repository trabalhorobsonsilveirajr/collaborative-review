/**
 * i18n.mjs - the language layer.
 *
 * The repository is in English because that is what carries on GitHub. The
 * INTERFACE is a different question: the person reviewing a page is a client,
 * a colleague, a boss. Making them read English to leave a comment is a tax on
 * the wrong person.
 *
 * So: code and docs in English, interface in the reader's language.
 *
 * Two audiences, detected differently:
 *   - the REVIEWER opens a web page  -> navigator.language decides
 *   - the OWNER runs it on a machine -> the operating system decides
 * Both fall back to English when the language is not available.
 *
 * A translation may be PARTIAL. Missing keys fall back to English key by key,
 * so a half-finished contribution still ships a working interface instead of
 * blank buttons. That is deliberate: it lowers the bar for someone who wants
 * to contribute their language without committing to all 70 strings.
 */

import { readFileSync, readdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const AQUI = dirname(fileURLToPath(import.meta.url));
export const I18N_DIR = join(AQUI, "..", "assets", "i18n");
export const BASE_LANGUAGE = "en";

/** Every language file present, as { code: dictionary }. */
export function loadLanguages(dir = I18N_DIR) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) throw new Error(`No language file in ${dir}`);

  const languages = {};
  for (const arq of files) {
    const code = arq.replace(/\.json$/, "");
    let data;
    try {
      data = JSON.parse(readFileSync(join(dir, arq), "utf8").replace(/^﻿/, ""));
    } catch (e) {
      throw new Error(`${arq} is not valid JSON: ${e.message}`);
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new Error(`${arq} must be a JSON object`);
    }
    languages[code] = data;
  }
  if (!languages[BASE_LANGUAGE]) throw new Error(`The base language ${BASE_LANGUAGE}.json is missing`);
  return languages;
}

/**
 * Which keys each translation is missing, measured against the base.
 * Not an error: a partial translation is allowed. It is reported so nobody has
 * to guess how complete a language is.
 */
export function checkCoverage(languages) {
  const base = Object.keys(languages[BASE_LANGUAGE]).filter((k) => !k.startsWith("_"));
  const report = {};
  for (const [code, dic] of Object.entries(languages)) {
    if (code === BASE_LANGUAGE) continue;
    const missing = base.filter((k) => !(k in dic));
    const extra = Object.keys(dic).filter((k) => !k.startsWith("_") && !base.includes(k));
    report[code] = {
      missing,
      extra,
      coverage: base.length === 0 ? 1 : (base.length - missing.length) / base.length,
    };
  }
  return report;
}

/**
 * Match a requested tag against what exists, the way browsers expect:
 * exact first ("pt-BR"), then the base subtag ("pt" finds "pt-BR"), then English.
 * Case-insensitive, because navigator.language and $env:LANG disagree on case.
 */
export function resolveLanguage(requested, available) {
  if (!requested) return BASE_LANGUAGE;
  const codes = Array.isArray(available) ? available : Object.keys(available);
  const target = String(requested).replace(/_/g, "-").toLowerCase();

  const exact = codes.find((c) => c.toLowerCase() === target);
  if (exact) return exact;

  const root = target.split("-")[0];
  const byRoot = codes.find((c) => c.toLowerCase() === root);
  if (byRoot) return byRoot;

  const byPrefix = codes.find((c) => c.toLowerCase().split("-")[0] === root);
  if (byPrefix) return byPrefix;

  return BASE_LANGUAGE;
}

/**
 * The one marker both templates carry. It is a COMMENT followed by an empty
 * dictionary rather than a brace-delimited name, for two reasons: placeholder
 * substitution must not touch it, and a template whose marker never gets replaced still
 * parses and runs - it just falls back to the English written into the markup.
 */
export const I18N_MARKER = '/*__I18N__*/{"en":{}}';

/**
 * Embeds the dictionaries into a template. Used for the review kit and for the
 * dashboard, so the two can never drift into different embedding rules.
 * Returns the html unchanged, and says so, when there is no marker.
 */
export function injectLanguages(html, languages = null) {
  if (!html.includes(I18N_MARKER)) return { html, injected: false, languages: [] };
  const dictionaries = languages || loadLanguages();
  return {
    html: html.split(I18N_MARKER).join(serializeForPage(dictionaries)),
    injected: true,
    languages: Object.keys(dictionaries).sort(),
  };
}

/** The dictionaries as a JS literal, ready to embed in the injected block. */
export function serializeForPage(languages) {
  const trimmed = {};
  for (const [code, dic] of Object.entries(languages)) {
    const withoutMeta = {};
    for (const [k, v] of Object.entries(dic)) if (!k.startsWith("_")) withoutMeta[k] = v;
    // The one piece of _meta that the page needs: how this language writes its
    // OWN name, for the selector. Keeping it here means adding a language is
    // still just adding a file, with nothing to edit in the dashboard.
    if (dic._meta && typeof dic._meta.language === "string") withoutMeta._name = dic._meta.language;
    trimmed[code] = withoutMeta;
  }
  // </script> inside a JSON string would close the block early. Escaping the
  // slash is invisible to JSON.parse and to anyone reading the value.
  // Built from a char code so no editor, shell, or copy-paste can eat the
  // backslash and silently turn this guard into a no-op (it did, once).
  const BACKSLASH = String.fromCharCode(92);
  return JSON.stringify(trimmed).split("</").join("<" + BACKSLASH + "/");
}

/** The language the operating system is running in, for command-line tools. */
export function systemLanguage(env = process.env) {
  const raw = env.COLLAB_REVIEW_LANG || env.LC_ALL || env.LC_MESSAGES || env.LANG || env.LANGUAGE;
  if (raw) return String(raw).split(/[.:@]/)[0].replace(/_/g, "-");
  // Windows does not set LANG. PowerShell reads the culture and passes it in
  // through COLLAB_REVIEW_LANG; without that we stay on the base language.
  return BASE_LANGUAGE;
}

// ---------------------------------------------------------------------------
// Self-test. Every case states what it proves, and half of them prove the
// module REFUSES something. A check that only ever says yes is decoration.
// ---------------------------------------------------------------------------

const CASES = [
  // --- resolveLanguage: matching the way a browser expects -------------------
  ["exact tag wins", () => resolveLanguage("pt-BR", ["en", "pt-BR", "es"]) === "pt-BR"],
  ["base subtag finds the regional file", () => resolveLanguage("pt", ["en", "pt-BR"]) === "pt-BR"],
  ["underscore form is accepted", () => resolveLanguage("pt_BR", ["en", "pt-BR"]) === "pt-BR"],
  ["case is ignored", () => resolveLanguage("PT-br", ["en", "pt-BR"]) === "pt-BR"],
  ["regional variant falls to its base", () => resolveLanguage("es-MX", ["en", "es"]) === "es"],
  ["unknown language falls back to English", () => resolveLanguage("de-DE", ["en", "es"]) === "en"],
  ["empty request falls back to English", () => resolveLanguage("", ["en", "es"]) === "en"],
  ["undefined request falls back to English", () => resolveLanguage(undefined, ["en"]) === "en"],
  ["a dictionary object works as the list", () => resolveLanguage("es", { en: {}, es: {} }) === "es"],
  ["exact beats prefix when both exist", () => resolveLanguage("pt", ["en", "pt", "pt-BR"]) === "pt"],

  // --- loadLanguages: refusing broken input -------------------------------
  ["real language folder loads", () => Object.keys(loadLanguages()).includes("en")],
  ["every shipped language has the same key count as the base", () => {
    const i = loadLanguages();
    const base = Object.keys(i.en).filter((k) => !k.startsWith("_")).length;
    return Object.entries(i).every(([, d]) => Object.keys(d).filter((k) => !k.startsWith("_")).length === base);
  }],
  ["a folder with no base language is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "i18n-"));
    writeFileSync(join(dir, "es.json"), '{"a":"b"}');
    try { loadLanguages(dir); return false; } catch (e) { return /base language/.test(e.message); }
  }],
  ["a malformed JSON file is refused, naming the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "i18n-"));
    writeFileSync(join(dir, "en.json"), "{ not json");
    try { loadLanguages(dir); return false; } catch (e) { return e.message.includes("en.json"); }
  }],
  ["a JSON array is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "i18n-"));
    writeFileSync(join(dir, "en.json"), "[1,2,3]");
    try { loadLanguages(dir); return false; } catch (e) { return /must be a JSON object/.test(e.message); }
  }],
  ["an empty folder is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "i18n-"));
    try { loadLanguages(dir); return false; } catch (e) { return /No language file/.test(e.message); }
  }],

  // --- checkCoverage: measuring, not judging ----------------------------
  ["a partial translation is measured, not rejected", () => {
    const r = checkCoverage({ en: { a: "1", b: "2", c: "3" }, xx: { a: "1" } });
    return Math.abs(r.xx.coverage - 1 / 3) < 1e-9 && r.xx.missing.join() === "b,c";
  }],
  ["a key that exists nowhere in the base is reported as extra", () => {
    const r = checkCoverage({ en: { a: "1" }, xx: { a: "1", z: "9" } });
    return r.xx.extra.join() === "z";
  }],
  ["_meta is not counted as a translatable key", () => {
    const r = checkCoverage({ en: { _meta: {}, a: "1" }, xx: { a: "1" } });
    return r.xx.coverage === 1 && r.xx.extra.length === 0;
  }],
  ["the shipped languages are all complete", () => {
    const r = checkCoverage(loadLanguages());
    return Object.values(r).every((v) => v.coverage === 1);
  }],

  // --- serializeForPage: safe to embed in a <script> -----------------------
  ["_meta is stripped before embedding", () => !serializeForPage(loadLanguages()).includes("_meta")],
  ["the embedded literal parses back", () => {
    const s = serializeForPage(loadLanguages());
    // The browser's JSON parser accepts the escaped slash as-is; Node's does
    // too, so this reads the literal exactly the way the injected page will.
    return JSON.parse(s).en["kit.send"] === "Send";
  }],
  ["a closing script tag inside a value is escaped", () => {
    const s = serializeForPage({ en: { a: "x</script>y" } });
    const escaped = "<" + String.fromCharCode(92) + "/script";
    return !s.includes("</script") && s.includes(escaped);
  }],
  ["the escaped value still reads back as the original text", () => {
    const s = serializeForPage({ en: { a: "x</script>y" } });
    return JSON.parse(s).en.a === "x</script>y";
  }],

  // --- systemLanguage: reading the environment -----------------------------
  ["the explicit override wins over everything", () => systemLanguage({ COLLAB_REVIEW_LANG: "fr", LANG: "pt_BR.UTF-8" }) === "fr"],
  ["a POSIX locale is trimmed to the tag", () => systemLanguage({ LANG: "pt_BR.UTF-8" }) === "pt-BR"],
  ["LC_ALL outranks LANG", () => systemLanguage({ LC_ALL: "es_ES.UTF-8", LANG: "en_US" }) === "es-ES"],
  ["an empty environment falls back to English", () => systemLanguage({}) === BASE_LANGUAGE],
];

const isMain = process.argv[1] && process.argv[1].endsWith("i18n.mjs");
if (isMain && process.argv[2] === "selftest") {
  let failures = 0;
  for (const [name, check] of CASES) {
    let ok = false, error = "";
    try { ok = check() === true; } catch (e) { error = " -> threw: " + e.message; }
    if (!ok) failures++;
    process.stdout.write(`${ok ? "  ok  " : "  FAIL"} ${name}${error}\n`);
  }
  process.stdout.write(`\ni18n: ${CASES.length - failures}/${CASES.length} passed\n`);
  process.exit(failures === 0 ? 0 : 1);
}
