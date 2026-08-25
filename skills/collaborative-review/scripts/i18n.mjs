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
export const DIR_I18N = join(AQUI, "..", "assets", "i18n");
export const IDIOMA_BASE = "en";

/** Every language file present, as { code: dictionary }. */
export function carregarIdiomas(dir = DIR_I18N) {
  const arquivos = readdirSync(dir).filter((f) => f.endsWith(".json"));
  if (arquivos.length === 0) throw new Error(`No language file in ${dir}`);

  const idiomas = {};
  for (const arq of arquivos) {
    const codigo = arq.replace(/\.json$/, "");
    let dados;
    try {
      dados = JSON.parse(readFileSync(join(dir, arq), "utf8").replace(/^﻿/, ""));
    } catch (e) {
      throw new Error(`${arq} is not valid JSON: ${e.message}`);
    }
    if (typeof dados !== "object" || dados === null || Array.isArray(dados)) {
      throw new Error(`${arq} must be a JSON object`);
    }
    idiomas[codigo] = dados;
  }
  if (!idiomas[IDIOMA_BASE]) throw new Error(`The base language ${IDIOMA_BASE}.json is missing`);
  return idiomas;
}

/**
 * Which keys each translation is missing, measured against the base.
 * Not an error: a partial translation is allowed. It is reported so nobody has
 * to guess how complete a language is.
 */
export function conferirCobertura(idiomas) {
  const base = Object.keys(idiomas[IDIOMA_BASE]).filter((k) => !k.startsWith("_"));
  const relatorio = {};
  for (const [codigo, dic] of Object.entries(idiomas)) {
    if (codigo === IDIOMA_BASE) continue;
    const missing = base.filter((k) => !(k in dic));
    const extra = Object.keys(dic).filter((k) => !k.startsWith("_") && !base.includes(k));
    relatorio[codigo] = {
      missing,
      extra,
      coverage: base.length === 0 ? 1 : (base.length - missing.length) / base.length,
    };
  }
  return relatorio;
}

/**
 * Match a requested tag against what exists, the way browsers expect:
 * exact first ("pt-BR"), then the base subtag ("pt" finds "pt-BR"), then English.
 * Case-insensitive, because navigator.language and $env:LANG disagree on case.
 */
export function resolverIdioma(pedido, disponiveis) {
  if (!pedido) return IDIOMA_BASE;
  const codigos = Array.isArray(disponiveis) ? disponiveis : Object.keys(disponiveis);
  const alvo = String(pedido).replace(/_/g, "-").toLowerCase();

  const exato = codigos.find((c) => c.toLowerCase() === alvo);
  if (exato) return exato;

  const raiz = alvo.split("-")[0];
  const porRaiz = codigos.find((c) => c.toLowerCase() === raiz);
  if (porRaiz) return porRaiz;

  const porPrefixo = codigos.find((c) => c.toLowerCase().split("-")[0] === raiz);
  if (porPrefixo) return porPrefixo;

  return IDIOMA_BASE;
}

/**
 * The one marker both templates carry. It is a COMMENT followed by an empty
 * dictionary rather than a brace-delimited name, for two reasons: placeholder
 * substitution must not touch it, and a template whose marker never gets replaced still
 * parses and runs - it just falls back to the English written into the markup.
 */
export const MARCADOR_I18N = '/*__I18N__*/{"en":{}}';

/**
 * Embeds the dictionaries into a template. Used for the review kit and for the
 * dashboard, so the two can never drift into different embedding rules.
 * Returns the html unchanged, and says so, when there is no marker.
 */
export function injetarIdiomas(html, idiomas = null) {
  if (!html.includes(MARCADOR_I18N)) return { html, injected: false, idiomas: [] };
  const dicionarios = idiomas || carregarIdiomas();
  return {
    html: html.split(MARCADOR_I18N).join(serializarParaKit(dicionarios)),
    injected: true,
    idiomas: Object.keys(dicionarios).sort(),
  };
}

/** The dictionaries as a JS literal, ready to embed in the injected block. */
export function serializarParaKit(idiomas) {
  const enxuto = {};
  for (const [codigo, dic] of Object.entries(idiomas)) {
    const semMeta = {};
    for (const [k, v] of Object.entries(dic)) if (!k.startsWith("_")) semMeta[k] = v;
    // The one piece of _meta that the page needs: how this language writes its
    // OWN name, for the selector. Keeping it here means adding a language is
    // still just adding a file, with nothing to edit in the dashboard.
    if (dic._meta && typeof dic._meta.language === "string") semMeta._name = dic._meta.language;
    enxuto[codigo] = semMeta;
  }
  // </script> inside a JSON string would close the block early. Escaping the
  // slash is invisible to JSON.parse and to anyone reading the value.
  // Built from a char code so no editor, shell, or copy-paste can eat the
  // backslash and silently turn this guard into a no-op (it did, once).
  const BARRA_INVERTIDA = String.fromCharCode(92);
  return JSON.stringify(enxuto).split("</").join("<" + BARRA_INVERTIDA + "/");
}

/** The language the operating system is running in, for command-line tools. */
export function idiomaDoSistema(env = process.env) {
  const bruto = env.COLLAB_REVIEW_LANG || env.LC_ALL || env.LC_MESSAGES || env.LANG || env.LANGUAGE;
  if (bruto) return String(bruto).split(/[.:@]/)[0].replace(/_/g, "-");
  // Windows does not set LANG. PowerShell reads the culture and passes it in
  // through COLLAB_REVIEW_LANG; without that we stay on the base language.
  return IDIOMA_BASE;
}

// ---------------------------------------------------------------------------
// Self-test. Every case states what it proves, and half of them prove the
// module REFUSES something. A check that only ever says yes is decoration.
// ---------------------------------------------------------------------------

const CASOS = [
  // --- resolverIdioma: matching the way a browser expects -------------------
  ["exact tag wins", () => resolverIdioma("pt-BR", ["en", "pt-BR", "es"]) === "pt-BR"],
  ["base subtag finds the regional file", () => resolverIdioma("pt", ["en", "pt-BR"]) === "pt-BR"],
  ["underscore form is accepted", () => resolverIdioma("pt_BR", ["en", "pt-BR"]) === "pt-BR"],
  ["case is ignored", () => resolverIdioma("PT-br", ["en", "pt-BR"]) === "pt-BR"],
  ["regional variant falls to its base", () => resolverIdioma("es-MX", ["en", "es"]) === "es"],
  ["unknown language falls back to English", () => resolverIdioma("de-DE", ["en", "es"]) === "en"],
  ["empty request falls back to English", () => resolverIdioma("", ["en", "es"]) === "en"],
  ["undefined request falls back to English", () => resolverIdioma(undefined, ["en"]) === "en"],
  ["a dictionary object works as the list", () => resolverIdioma("es", { en: {}, es: {} }) === "es"],
  ["exact beats prefix when both exist", () => resolverIdioma("pt", ["en", "pt", "pt-BR"]) === "pt"],

  // --- carregarIdiomas: refusing broken input -------------------------------
  ["real language folder loads", () => Object.keys(carregarIdiomas()).includes("en")],
  ["every shipped language has the same key count as the base", () => {
    const i = carregarIdiomas();
    const base = Object.keys(i.en).filter((k) => !k.startsWith("_")).length;
    return Object.entries(i).every(([, d]) => Object.keys(d).filter((k) => !k.startsWith("_")).length === base);
  }],
  ["a folder with no base language is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "i18n-"));
    writeFileSync(join(dir, "es.json"), '{"a":"b"}');
    try { carregarIdiomas(dir); return false; } catch (e) { return /base language/.test(e.message); }
  }],
  ["a malformed JSON file is refused, naming the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "i18n-"));
    writeFileSync(join(dir, "en.json"), "{ not json");
    try { carregarIdiomas(dir); return false; } catch (e) { return e.message.includes("en.json"); }
  }],
  ["a JSON array is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "i18n-"));
    writeFileSync(join(dir, "en.json"), "[1,2,3]");
    try { carregarIdiomas(dir); return false; } catch (e) { return /must be a JSON object/.test(e.message); }
  }],
  ["an empty folder is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "i18n-"));
    try { carregarIdiomas(dir); return false; } catch (e) { return /No language file/.test(e.message); }
  }],

  // --- conferirCobertura: measuring, not judging ----------------------------
  ["a partial translation is measured, not rejected", () => {
    const r = conferirCobertura({ en: { a: "1", b: "2", c: "3" }, xx: { a: "1" } });
    return Math.abs(r.xx.coverage - 1 / 3) < 1e-9 && r.xx.missing.join() === "b,c";
  }],
  ["a key that exists nowhere in the base is reported as extra", () => {
    const r = conferirCobertura({ en: { a: "1" }, xx: { a: "1", z: "9" } });
    return r.xx.extra.join() === "z";
  }],
  ["_meta is not counted as a translatable key", () => {
    const r = conferirCobertura({ en: { _meta: {}, a: "1" }, xx: { a: "1" } });
    return r.xx.coverage === 1 && r.xx.extra.length === 0;
  }],
  ["the shipped languages are all complete", () => {
    const r = conferirCobertura(carregarIdiomas());
    return Object.values(r).every((v) => v.coverage === 1);
  }],

  // --- serializarParaKit: safe to embed in a <script> -----------------------
  ["_meta is stripped before embedding", () => !serializarParaKit(carregarIdiomas()).includes("_meta")],
  ["the embedded literal parses back", () => {
    const s = serializarParaKit(carregarIdiomas());
    // The browser's JSON parser accepts the escaped slash as-is; Node's does
    // too, so this reads the literal exactly the way the injected page will.
    return JSON.parse(s).en["kit.send"] === "Send";
  }],
  ["a closing script tag inside a value is escaped", () => {
    const s = serializarParaKit({ en: { a: "x</script>y" } });
    const escapado = "<" + String.fromCharCode(92) + "/script";
    return !s.includes("</script") && s.includes(escapado);
  }],
  ["the escaped value still reads back as the original text", () => {
    const s = serializarParaKit({ en: { a: "x</script>y" } });
    return JSON.parse(s).en.a === "x</script>y";
  }],

  // --- idiomaDoSistema: reading the environment -----------------------------
  ["the explicit override wins over everything", () => idiomaDoSistema({ COLLAB_REVIEW_LANG: "fr", LANG: "pt_BR.UTF-8" }) === "fr"],
  ["a POSIX locale is trimmed to the tag", () => idiomaDoSistema({ LANG: "pt_BR.UTF-8" }) === "pt-BR"],
  ["LC_ALL outranks LANG", () => idiomaDoSistema({ LC_ALL: "es_ES.UTF-8", LANG: "en_US" }) === "es-ES"],
  ["an empty environment falls back to English", () => idiomaDoSistema({}) === IDIOMA_BASE],
];

const ehPrincipal = process.argv[1] && process.argv[1].endsWith("i18n.mjs");
if (ehPrincipal && process.argv[2] === "selftest") {
  let falhas = 0;
  for (const [nome, teste] of CASOS) {
    let ok = false, erro = "";
    try { ok = teste() === true; } catch (e) { erro = " -> threw: " + e.message; }
    if (!ok) falhas++;
    process.stdout.write(`${ok ? "  ok  " : "  FAIL"} ${nome}${erro}\n`);
  }
  process.stdout.write(`\ni18n: ${CASOS.length - falhas}/${CASOS.length} passed\n`);
  process.exit(falhas === 0 ? 0 : 1);
}
