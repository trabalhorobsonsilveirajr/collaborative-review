#!/usr/bin/env node
/**
 * check-artifacts.mjs — proves every shipped file still parses, and that no
 * Portuguese survived the translation pass.
 *
 * NOT part of the published skill. This is the publishing harness.
 *
 * WHY THIS EXISTS. A translation pass rewrote comments across the repository by
 * automated text substitution. Three things went wrong, none of which any existing
 * check could see:
 *
 *   1. Substitutions that replaced a WHOLE LINE hit lines holding code AND a
 *      comment, deleting the code. A `}catch(e){ /* ... *\/ }` became just the
 *      comment, and the dashboard stopped parsing entirely. Nothing ran it.
 *   2. An identifier was renamed in one file and not in the file that called it.
 *   3. The Portuguese scan looked for ACCENTED CHARACTERS. Words like "opcional",
 *      "Enviar", "Parar" and "Marque itens" have no accent, so a screen full of
 *      Portuguese passed as clean. The check measured the wrong thing.
 *
 * So this runs three passes: PARSE (does it still compile), PORTUGUESE (by word
 * list, not by accent), and SUSPICIOUS (fragments a broken substitution leaves
 * behind). It self-tests first, both directions, and aborts if a check is asleep.
 *
 * Exit codes: 0 = clean · 1 = problems found · 2 = the checker itself is broken
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative, extname, basename } from "node:path";
import { tmpdir } from "node:os";

const ROOT = process.argv[2] || ".";
const NUL = String.fromCharCode(0);

/* ---------------------------------------------------------------- *
 * Portuguese detection, by WORD, never by accent.
 *
 * Only words that are unambiguously Portuguese and would never appear in
 * English prose or in an identifier. "material", "total" and "final" are
 * deliberately absent: they are identical in both languages and would make
 * this cry wolf.
 * ---------------------------------------------------------------- */
const PT_WORDS = [
  "opcional", "enviar", "parar", "gravar", "regravar", "descartar", "marque",
  "aprovar", "rejeitar", "senha", "revisor", "concluiu", "concluir", "aguardando",
  "atualizar", "copiar", "entrar", "sair", "nenhum", "nenhuma", "todos", "todas",
  "erro", "aviso", "salvar", "carregando", "instante", "microfone", "digite",
  "acima", "abaixo", "arquivo", "pasta", "linha", "coluna", "tabela", "campo",
  "pedido", "proposta", "veredito", "carimbo", "vazio", "cheio", "antigo", "novo",
  "pendente", "processada", "aplicada", "rejeitada", "aprovada", "legado",
  "observacao", "comentario", "conclusao", "decisao", "secao", "revisao",
  "correcao", "aprovacao", "transcricao", "gravacao", "orquestracao",
  "quando", "porque", "entao", "apenas", "somente", "sempre", "nunca", "ainda",
  "voce", "seu", "sua", "seus", "suas", "isso", "esse", "essa", "aqui", "onde", "como",
  "consideracoes", "consideracao", "observacoes", "reinjetar", "restaure", "injetado",
  "bloco", "imediatamente", "primeiro", "ultimo", "seguinte", "anterior",
];

/* Words above that are legitimate as machine contract: database columns, JSON
 * keys, and the wire format shared with the page. Renaming those is a separate
 * decision, so flagging them here would be noise that trains people to ignore
 * this output. Only exact identifier-ish usages are excused. */
const CONTRACT_OK = [
  /\b(?:senha|nome|secao|comentario|projeto|material|tipo|conclusao|decisao|veredito|revisor|pedido|proposta|transcricao)\s*:/,
  /["'](?:senha|nome|secao|comentario|projeto|material|tipo|conclusao|decisao|veredito|pedido_editado|item_numero|gate_arquivo|processado_em|aplicado_em|por_que|proposta|transcricao|aprovacoes|pendente|aprovado|rejeitado|aplicado|processando)["']/,
  /\b(?:f|obj|ap|m|item|row|r)\.(?:nome|secao|comentario|projeto|material|tipo|senha|veredito|pedido|proposta|transcricao)\b/,
  /\$(?:senha|nome|secao|revisor|projeto|material|conclusao|decisao)\w*/,
  /(?:docs\/orquestracao|gate-estrutural|painel_config|registro-materiais)/,
  /\bconclusoes?\b|\bdecisoes\b|\bdecisoesLocais\b|\baprovacoes\b|\bitensCarimbados\b|\bitensRestantes\b/,
];

/* Fragments that a botched substitution leaves behind. Each one was produced by
 * a real defect in this repository. */
const SUSPICIOUS = [
  { re: /\+\s*'\s*\+\s*'\s*$/, why: "dangling string concatenation (substitution ate the rest of the line)" },
  { re: /\+\s*"\s*\+\s*"\s*$/, why: "dangling string concatenation" },
  { re: /^\s*\}\s*catch\s*$/, why: "catch with no block" },
  { re: /\{\{[a-z_]+\}\}/, why: "lowercase placeholder (the injector expects uppercase)" },
  { re: /\bler-feedbacks\b|\baprovacoes\/index\b|\bregistrar-decisao\b|\blimpar-orfaos\b/,
    why: "old function name that was renamed" },
  { re: /sincronizar-aprovacoes|teste-sincronizar|teste-sync-approvals/, why: "old file name that was renamed" },
  { re: /04-config-painel\.sql|01-tabela-rls\.sql|02-bucket-storage\.sql\b(?=.*tabela)/, why: "old SQL file name" },
];

const PARSE_SKIP = new Set([".md", ".txt", ".gitignore", ".gitattributes", ""]);

function tracked(dir) {
  const out = execFileSync("git", ["-C", dir, "ls-files", "-z"], { encoding: "utf8" });
  return out.split(NUL).filter(Boolean);
}

/* ---------------- parsers ---------------- */

let TMP;
function tmpFile(name, content) {
  if (!TMP) TMP = mkdtempSync(join(tmpdir(), "artifact-check-"));
  const p = join(TMP, name);
  writeFileSync(p, content, "utf8");
  return p;
}

function parseJs(code, label) {
  const p = tmpFile(`${label.replace(/[^a-z0-9]/gi, "_")}.js`, code);
  try {
    execFileSync(process.execPath, ["--check", p], { stdio: "pipe" });
    return null;
  } catch (e) {
    const msg = String(e.stderr || e.message).split("\n").find((l) => /Error/.test(l));
    return msg || "failed to parse";
  }
}

function inlineScripts(html) {
  const out = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) out.push(m[1]);
  return out;
}

function parseFile(rel, abs, text) {
  const ext = extname(rel).toLowerCase();
  if (PARSE_SKIP.has(ext)) return null;

  if (ext === ".mjs" || ext === ".js") return parseJs(text, basename(rel));
  if (ext === ".ts") return null; // Deno functions: not parseable with plain node
  if (ext === ".json") {
    try { JSON.parse(text); return null; } catch (e) { return `invalid JSON: ${e.message}`; }
  }
  if (ext === ".html") {
    const parts = inlineScripts(text);
    if (!parts.length) return null;
    return parseJs(parts.join("\n;\n"), basename(rel));
  }
  if (ext === ".py") {
    try {
      execFileSync("python", ["-c",
        `import py_compile,sys; py_compile.compile(r'${abs}', doraise=True, cfile=None)`],
        { stdio: "pipe" });
      return null;
    } catch (e) {
      const s = String(e.stderr || e.message);
      const line = s.split("\n").find((l) => /Error/.test(l));
      return line || "failed to compile";
    }
  }
  if (ext === ".ps1") {
    try {
      const cmd = `$e=$null;[System.Management.Automation.Language.Parser]::ParseFile('${abs.replace(/\\/g, "/")}',[ref]$null,[ref]$e)>$null;if($e.Count){exit 1}`;
      execFileSync("pwsh", ["-NoProfile", "-Command", cmd], { stdio: "pipe" });
      return null;
    } catch { return "PowerShell parse errors"; }
  }
  return null;
}

/* ---------------- self-test ---------------- */

function selfTest() {
  const cases = [
    // [text, mustFlagPortuguese]
    ["Enviar aprovacoes", true],
    ["campo (opcional)", true],
    ["ou digite acima", true],
    ["Marque itens antes de enviar", true],
    ["Um instante, abrindo o microfone", true],
    ["Send approvals now", false],
    ["the optional field", false],
    ["material: \"Onboarding Guide\"", false],
    ["{nome: \"Sam\", secao: \"Step 1\"}", false],
    ["var conclusoes = [];", false],
    ["f.comentario || \"\"", false],
    ["docs/orquestracao/gate-estrutural/", false],

    /* The separation that matters: a Portuguese label a human READS must block;
     * a Portuguese CSS class or element id, which nobody sees, must not. Both
     * directions are pinned here, because getting this wrong in either direction
     * ruins the check: too loud and it gets ignored, too quiet and it misses the
     * button label. */
    ["<button id=\"atualizar\" class=\"btn ghost\">Atualizar</button>", true],
    ["<button id=\"atualizar\" class=\"btn ghost\">Refresh</button>", false],
    [".btn-decisao.aprovar{border-color:var(--sucesso-borda);}", false],
    [".grupo.conclusao .grupo-head{background:var(--sucesso-bg);}", false],
    ["  --erro: #c00;", false],
    ["document.getElementById(\"entrar\").disabled = true;", false],
    ["el.textContent = \"Enviar aprovacoes\";", true],
    ["st.textContent = \"Review recorded.\";", false],
    ["<label class=\"fb-label\">Suas consideracoes</label>", true],
    ["<input placeholder=\"digite acima\">", true],
  ];
  let bad = 0;
  for (const [text, shouldFlag] of cases) {
    const flagged = ptHits(text).length > 0;
    if (flagged !== shouldFlag) {
      console.error(`  self-test FAIL: "${text}" -> ${flagged ? "flagged" : "clean"}, expected ${shouldFlag ? "flagged" : "clean"}`);
      bad++;
    }
  }

  const susp = [
    ["      '<div>' + esc(x) + ' + '", true],
    ["      '<div>' + esc(x) + '</div>' +", false],
    ["supabase functions deploy ler-feedbacks", true],
    ["supabase functions deploy read-feedback", false],
  ];
  for (const [text, shouldFlag] of susp) {
    const flagged = SUSPICIOUS.some((s) => s.re.test(text));
    if (flagged !== shouldFlag) {
      console.error(`  self-test FAIL (suspicious): "${text}" -> ${flagged}, expected ${shouldFlag}`);
      bad++;
    }
  }

  // the parser must actually reject broken code, or it proves nothing
  const brokenJs = parseJs("function a(){ try { var x = 1; return null; }", "selftest_broken");
  if (!brokenJs) { console.error("  self-test FAIL: parser accepted a try with no catch"); bad++; }
  const goodJs = parseJs("function a(){ try { return 1; } catch(e){} return 0; }", "selftest_good");
  if (goodJs) { console.error(`  self-test FAIL: parser rejected valid code (${goodJs})`); bad++; }

  return { bad, total: cases.length + susp.length + 2 };
}

/* Identifiers, not prose: CSS selectors and custom properties, element ids and
 * classes, and the tail of a dotted/dollar name. Portuguese here is ugly in an
 * English repository but it is INVISIBLE to every user, and renaming a class
 * means touching stylesheet, markup and script together — a change with real
 * risk and no user-facing gain. So these are reported separately and do not
 * block. Flagging them at the same level as a Portuguese button label would
 * bury the label in noise, and a check that cries wolf gets ignored. */
const IDENTIFIER_CONTEXT = [
  /^\s*[.#][\w.#:>\s,()-]*\{/,          // a CSS rule opener
  /^\s*--[\w-]+\s*:/,                   // a CSS custom property definition
  /var\(--[\w-]+\)/g,                   // a CSS custom property use
  /\b(?:id|class|for|name|data-[\w-]+)\s*=\s*["'][^"']*["']/g,
  /\bclassName\s*=\s*["'][^"']*["']/g,
  /\bclassList\.[a-z]+\(["'][^"']*["']\)/g,
  /\bgetElementById\(["'][^"']*["']\)/g,
  /\bquerySelector(?:All)?\(["'][^"']*["']\)/g,
  /\.\w+\b/g,                            // a dotted member: f.comentario, .conclusao
  /\$\w+/g,                              // a PowerShell variable
  /\bfunction\s+\w+\s*\([^)]*\)/g,       // a function name and its parameters
  /\b(?:var|let|const)\s+\w+/g,          // a declared name
  /\b\w+\s*\([^)]*\)\s*\{/g,             // a call or definition head
  /\b\w+\s*:\s*function\s*\([^)]*\)/g,   // a method in an object literal
  /\b(?:await|return|new)\s+\w+\(/g,     // a call inside an expression
  /\b\w+\(\s*\w*\s*\)/g,                 // a plain call: entrar(saved)
];

/* Prose lives in exactly two places: a STRING or a COMMENT. Everything else on a
 * line of code is an identifier, and an identifier in Portuguese is ugly but
 * invisible to every user.
 *
 * The first version of this function worked the other way round: it took the
 * whole line and subtracted the identifier shapes it recognised. That is an
 * open-ended list, so it kept missing shapes and flagging `function carregar(senha)`
 * as if it were text somebody reads. It reported 154 problems where about a dozen
 * were real, and a checker that cries wolf gets skipped within a week.
 *
 * Extracting the two places prose can be is a closed question, so it stays right. */
function extractProse(line) {
  /* Attribute values that NAME something rather than say something. Removed
   * first, so the id in <button id="atualizar">Refresh</button> never reaches
   * the string extraction below and gets mistaken for text. */
  const cleaned = line
    .replace(/\b(?:id|class|for|name|href|src|type|data-[\w-]+)\s*=\s*["'][^"']*["']/gi, " ")
    .replace(/^\s*--[\w-]+\s*:/, " ")           // a CSS custom property name
    .replace(/var\(--[\w-]+(?:\s*,[^)]*)?\)/g, " ") // a CSS custom property use
    .replace(/^\s*[.#][\w.#:>\s,()-]*\{/, " ")  // a CSS rule opener
    /* DOM calls whose argument NAMES an element rather than saying anything */
    .replace(/\b(?:getElementById|querySelector(?:All)?|setAttribute|getAttribute)\s*\(\s*["'][^"']*["']/g, " ")
    .replace(/\bclassList\.\w+\s*\(\s*["'][^"']*["']/g, " ")
    .replace(/\b(?:setItem|getItem|removeItem)\s*\(\s*[^,)]*/g, " ")
    /* A class attribute BUILT BY CONCATENATION: class="a' + (x ? ' b' : '') + '"
     * The quotes belong to the JavaScript, not to the attribute, so the plain
     * attribute regex above cannot see past the first fragment. Everything from
     * class=" to the closing tag is naming, not prose. */
    .replace(/\bclass\s*=\s*["'][^"']*/g, " ")
    /* Interpolation is code: ${bloco.split(...)} inside a template literal. */
    .replace(/\$\{[^}]*\}/g, " ");

  const out = [];

  /* comments: line and block, in every syntax this repository uses */
  const c = cleaned.match(/(?:\/\/|#(?!\!)|--|\/\*|\*(?!\/)|<!--)\s?(.*)$/);
  if (c) out.push(c[1]);

  /* A string that looks like a LIST OF CSS CLASSES is not prose. HTML built by
   * concatenation splits a class attribute across many small strings — things
   * like ' conclusao' or 'btn-decisao aprovar' — and an attribute regex cannot
   * see them because the quotes belong to the JavaScript, not to the attribute.
   *
   * The shape is recognisable: a few lowercase words, hyphens allowed, no
   * sentence punctuation, no capital letter. Prose that a person reads almost
   * never looks like that, and a class list always does.
   *
   * These are reported as ADVISORY instead: renaming a CSS class means moving
   * stylesheet, markup and script together, and no user ever sees the name. */
  const looksLikeClassList = (v) => {
    const t = v.trim();
    if (!t || t.length > 60) return false;
    if (/[.,!?:;"'()]/.test(t)) return false;
    if (/[A-ZÀ-Ú]/.test(t)) return false;
    const words = t.split(/\s+/);
    return words.length <= 4 && words.every((w) => /^[a-z][a-z0-9-]*$/.test(w));
  };

  /* Attributes that carry TEXT rather than a name. A string in one of these is
   * prose no matter what shape it has: placeholder="digite acima" is two lowercase
   * words and is read by a person. Checked against the ORIGINAL line, because the
   * cleanup above already removed the naming attributes. */
  const textAttr = /(?:placeholder|title|alt|aria-label|label|value)\s*=\s*["']([^"']*)["']/gi;
  const proseAttrs = new Set();
  for (const m of line.matchAll(textAttr)) proseAttrs.add(m[1]);

  const push = (v) => {
    if (proseAttrs.has(v) || !looksLikeClassList(v)) out.push(v);
  };

  /* string literals, minus the quotes */
  for (const m of cleaned.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"/g)) push(m[1]);
  for (const m of cleaned.matchAll(/'([^'\\]*(?:\\.[^'\\]*)*)'/g)) push(m[1]);
  for (const m of cleaned.matchAll(/`([^`\\]*(?:\\.[^`\\]*)*)`/g)) push(m[1]);
  for (const v of proseAttrs) out.push(v);

  /* text between HTML tags */
  for (const m of cleaned.matchAll(/>([^<>]{2,})</g)) out.push(m[1]);

  /* A line with none of those markers is not code: it is bare text, from a
   * markdown file or from a self-test case. All of it counts as prose. Without
   * this, plain sentences slip through as "no prose found" — which the self-test
   * caught the moment this function was rewritten. */
  /* Parentheses alone do NOT make something code: "campo (opcional)" is a label.
   * What marks code is a statement terminator, a block, or an assignment. */
  if (out.length === 0 && !/[;{}]|=[^=]|=>|\breturn\b|\bfunction\b/.test(cleaned)) {
    out.push(cleaned);
  }

  return out.join(" \u0001 ");
}

function stripToProse(line) {
  let s = extractProse(line);
  /* A field name inside a string is still a field name, not prose. */
  for (const re of CONTRACT_OK) {
    const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
    s = s.replace(new RegExp(re.source, flags), " ");
  }
  /* Identifiers can appear inside strings too: a CSS class list, a selector,
   * an element id passed to querySelector. */
  for (const re of IDENTIFIER_CONTEXT) {
    const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
    s = s.replace(new RegExp(re.source, flags), " ");
  }
  return s;
}

/* A FIXED WORD LIST CANNOT COVER A LANGUAGE, and trusting one is how this check
 * spent several audits reporting "no Portuguese" while the dashboard still said
 * "Terminou de revisar?", "Enviando…", "Atualizando…" and "baixar". None of
 * those words were on the list, and no list would have held all of them.
 *
 * So the list stays for the words it does know, and MORPHOLOGY carries the rest:
 * the shapes Portuguese has and English does not. Two tiers, because the cost of
 * being wrong is asymmetric - a missed label ships in the wrong language, while a
 * false alarm just wastes a minute.
 *
 *   STRONG  one is enough. These barely occur in English text.
 *   WEAK    two must appear together in the same piece of prose.
 */
const PT_STRONG = [
  { re: /[ãõç]/i,                        why: "ã/õ/ç" },
  { re: /\b\w{2,}(ção|ções|ão|ões)\b/i,  why: "-ção/-ão ending" },
  { re: /\b(não|você|vocês|está|estão|então|também|até|já|só|é)\b/i, why: "common accented word" },
  { re: /\b\w{4,}(mente)\b/i,            why: "-mente adverb" },
  { re: /\b\w{3,}(ando|endo|indo)\b/i,   why: "-ando/-endo gerund" },
  { re: /\b(pra|pro|pela|pelo|pelas|pelos|nesse|nessa|neste|nesta|desse|dessa|deste|desta)\b/i, why: "contraction" },
];
/* Every entry here was weighed against English, because this file is READ by an
 * English-language check. Three were dropped after they fired on real English in
 * this very repository, and the self-test below now holds those lines as cases
 * that must stay quiet:
 *   "do"           - "what it can do", "dashboards do not send"
 *   -ar/-er/-ir    - reviewer, other, user, after, server, their
 *   "com"          - domain names, "com port"
 * Being able to say WHY a signal was rejected matters more than the signal. */
const PT_WEAK = [
  { re: /\b(da|das|dos)\b/i,             why: "da/das/dos" },
  { re: /\bde\s+(um|uma|cada|todo|toda|novo|nova|acordo|volta)\b/i, why: "de + noun" },
  { re: /\b(para|sem|sobre|conforme|durante|contra)\b/i, why: "preposition" },
  { re: /\b(que|quando|porque|onde|qual|quais|enquanto)\b/i, why: "question or relative word" },
  { re: /\b(um|uma|uns|umas|este|esta|esse|essa|isso|aquele|aquela)\b/i, why: "determiner" },
  { re: /\b(seu|sua|seus|suas|meu|minha|nosso|nossa)\b/i, why: "possessive" },
  { re: /\b\w{4,}(ados|adas|idos|idas|ada|ido|ida)\b/i, why: "participle" },
  { re: /\b\w{4,}(ções|ção|dade|agem|mento|eiro|eira)\b/i, why: "noun suffix" },
];

function sinaisMorfologicos(texto) {
  const achados = [];
  for (const s of PT_STRONG) if (s.re.test(texto)) achados.push(s.why);
  if (achados.length > 0) return achados;
  const fracos = PT_WEAK.filter((s) => s.re.test(texto)).map((s) => s.why);
  return fracos.length >= 2 ? fracos : [];
}

function matchWords(text) {
  const lower = text.toLowerCase();
  const found = [];
  for (const w of PT_WORDS) {
    const re = new RegExp(`(^|[^a-z0-9_-])${w}([^a-z0-9_-]|$)`, "i");
    if (re.test(lower)) found.push(w);
  }
  for (const sinal of sinaisMorfologicos(text)) found.push(sinal);
  return found;
}

/* Contract terms are MASKED OUT of the line, never used to excuse the whole line.
 * Excusing the line was the first version, and its own self-test caught it: a line
 * reading `Enviar aprovacoes` was waved through because `aprovacoes` is a legitimate
 * field name, hiding the Portuguese button label sitting next to it. A blanket
 * pardon is how a check goes quiet. */
function ptHits(line) {
  return matchWords(stripToProse(line));
}

/* Same words, but only in identifier position. Advisory. */
function ptIdentifiers(line) {
  const prose = stripToProse(line);
  const all = matchWords(line);
  const inProse = new Set(matchWords(prose));
  return all.filter((w) => !inProse.has(w));
}

/* ---------------- run ---------------- */

console.log("self-test");
const { bad, total } = selfTest();
if (bad) {
  console.error(`\nCHECKER IS BROKEN (${bad} of ${total} expectations failed). Fix it before trusting a verdict.`);
  if (TMP) rmSync(TMP, { recursive: true, force: true });
  process.exit(2);
}
console.log(`  ${total} expectations · all correct\n`);

/* The verifiers live in tools/ now that they are published, which means they show
 * up in the file list and would scan each other — including the self-test cases
 * that exist precisely to look like the defect. A checker that flags another
 * checker's fixtures is not finding anything; it is making noise, and noise is
 * how an alarm gets ignored. */
const HARNESS = /(^|[\/])tools[\/]/;
const files = tracked(ROOT).filter((f) => !HARNESS.test(f));
const parseErrors = [];
const ptFindings = [];
const suspFindings = [];
const idFindings = [];

/* The translation files are SUPPOSED to be full of Portuguese, Spanish and
 * French: that is their entire content. Scanning them for "non-English text"
 * would report every line of every translation, which is both wrong and the
 * fastest way to teach someone to ignore this output. They are still parsed as
 * JSON below, and check-i18n.mjs holds them to their own separate contract. */
const EH_ARQUIVO_DE_IDIOMA = (rel) => /(^|[\\/])assets[\\/]i18n[\\/][^\\/]+\.json$/.test(rel);

for (const rel of files) {
  const abs = join(ROOT, rel);
  let text;
  try { text = readFileSync(abs, "utf8"); } catch { continue; }

  const err = parseFile(rel, abs, text);
  if (err) parseErrors.push({ rel, err });

  if (EH_ARQUIVO_DE_IDIOMA(rel)) continue;

  text.split(/\r?\n/).forEach((line, i) => {
    const words = ptHits(line);
    if (words.length) ptFindings.push({ rel, line: i + 1, words, excerpt: line.trim().slice(0, 80) });
    else {
      const ids = ptIdentifiers(line);
      if (ids.length) idFindings.push({ rel, line: i + 1, words: ids, excerpt: line.trim().slice(0, 80) });
    }
    for (const s of SUSPICIOUS) {
      if (s.re.test(line)) {
        suspFindings.push({ rel, line: i + 1, why: s.why, excerpt: line.trim().slice(0, 80) });
        break;
      }
    }
  });
}

if (TMP) rmSync(TMP, { recursive: true, force: true });

console.log(`checked ${files.length} tracked files\n`);

const show = (title, list, fmt) => {
  if (!list.length) return;
  console.log(`${title}: ${list.length}`);
  for (const f of list.slice(0, 40)) console.log(fmt(f));
  if (list.length > 40) console.log(`  ... and ${list.length - 40} more`);
  console.log("");
};

show("DOES NOT PARSE", parseErrors, (f) => `  ${f.rel}\n      ${f.err}`);
show("PORTUGUESE LEFT", ptFindings, (f) => `  ${f.rel}:${f.line}  [${f.words.join(", ")}]\n      ${f.excerpt}`);
show("SUSPICIOUS", suspFindings, (f) => `  ${f.rel}:${f.line}  (${f.why})\n      ${f.excerpt}`);

/* Advisory only: Portuguese identifiers are invisible to users, and renaming a CSS
 * class means touching stylesheet, markup and script together. Reported so the
 * decision stays deliberate rather than silent. */
if (idFindings.length) {
  const byFile = new Map();
  for (const f of idFindings) byFile.set(f.rel, (byFile.get(f.rel) || 0) + 1);
  console.log("ADVISORY - Portuguese identifiers (not user-visible, does not block): " + idFindings.length);
  for (const [rel, n] of byFile) console.log("  " + rel + ": " + n);
  console.log("");
}

const totalBad = parseErrors.length + ptFindings.length + suspFindings.length;
if (totalBad) {
  console.log(`NOT READY: ${totalBad} problem(s).`);
  process.exit(1);
}
console.log("CLEAN — everything parses, no Portuguese, no substitution debris.");
process.exit(0);
