#!/usr/bin/env node
/**
 * check-edge-types.mjs - the payload TYPE must describe the fields the code
 * actually reads.
 *
 * Why this file exists: `record-decision` shipped with a type declaring `secao`
 * and `comentario` while the code destructured `section` and `comment`. A
 * translation pass renamed the reading side and left the type behind. Every
 * other check here waved it through: the wire-format check reads field names in
 * requests, and the parse check skips .ts files entirely.
 *
 * The damage is not just a failed build. A type is documentation with teeth:
 * someone reading it to learn what to POST would send `secao`, the function
 * would look for `section`, find nothing, and store an empty comment. This
 * repository has already shipped that exact failure once, elsewhere.
 *
 * WHY NOT JUST RUN A TYPE CHECKER: the first version of this file did exactly
 * that, and it FAILED ITS OWN CONTROL TEST - with the defect deliberately put
 * back, it still reported ok. The checker stopped at an unresolved third-party
 * import and never reached our code, so the run said "no errors" for the same
 * reason a checker that never runs says "no errors". Comparing the two lists
 * directly needs no network, no Deno, and no package tree, and it cannot be
 * quietly skipped.
 */

import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** `const { a, b = "", c } = body as { … };` -> the names, and the type body. */
const RE_DESESTRUTURA = /const\s*\{([^}]*)\}\s*=\s*\w+\s+as\s*\{([^}]*)\}/g;

function nomesDesestruturados(trecho) {
  return trecho
    .split(",")
    .map((p) => p.split("=")[0].split(":")[0].trim())
    .filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
}

function camposDoTipo(trecho) {
  return [...trecho.matchAll(/([A-Za-z_$][\w$]*)\s*\??\s*:/g)].map((m) => m[1]);
}

/* --- self-test: prove it catches the real defect, and stays quiet otherwise -- */
{
  const QUEBRADO = 'const { password = "", project, section, comment } = body as {\n' +
    "  password?: string;\n  project?: string;\n  secao?: string;\n  comentario?: string;\n};";
  const SADIO = 'const { password = "", project, section, comment } = body as {\n' +
    "  password?: string;\n  project?: string;\n  section?: string;\n  comment?: string;\n};";
  const analisar = (codigo) => {
    RE_DESESTRUTURA.lastIndex = 0;
    const m = RE_DESESTRUTURA.exec(codigo);
    if (!m) return null;
    const lidos = nomesDesestruturados(m[1]);
    const declarados = new Set(camposDoTipo(m[2]));
    return lidos.filter((n) => !declarados.has(n));
  };
  const falhas = [];
  const noQuebrado = analisar(QUEBRADO);
  if (!noQuebrado || noQuebrado.length !== 2) {
    falhas.push(`should have flagged section and comment, got: ${JSON.stringify(noQuebrado)}`);
  }
  const noSadio = analisar(SADIO);
  if (!noSadio || noSadio.length !== 0) {
    falhas.push(`should have stayed quiet on the healthy version, got: ${JSON.stringify(noSadio)}`);
  }
  if (falhas.length) {
    process.stderr.write("check-edge-types self-test FAILED, refusing to run:\n");
    for (const f of falhas) process.stderr.write("  - " + f + "\n");
    process.exit(3);
  }
}

const RAIZ = resolve(process.argv[2] || ".");
const DIR = join(RAIZ, "skills", "collaborative-review", "assets", "edge-functions");
if (!existsSync(DIR)) {
  process.stderr.write(`No edge-functions folder at ${DIR}\n`);
  process.exit(2);
}

const funcoes = readdirSync(DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(DIR, d.name, "index.ts")))
  .map((d) => d.name);

let falhas = 0;
let contratos = 0;
for (const nome of funcoes) {
  const codigo = readFileSync(join(DIR, nome, "index.ts"), "utf8");
  const problemas = [];
  RE_DESESTRUTURA.lastIndex = 0;
  let m;
  while ((m = RE_DESESTRUTURA.exec(codigo)) !== null) {
    contratos++;
    const lidos = nomesDesestruturados(m[1]);
    const declarados = camposDoTipo(m[2]);
    const conjunto = new Set(declarados);
    for (const campo of lidos) {
      if (!conjunto.has(campo)) {
        problemas.push(`reads "${campo}", which the type does not declare`);
      }
    }
    const lidosSet = new Set(lidos);
    for (const campo of declarados) {
      if (!lidosSet.has(campo)) {
        problemas.push(`declares "${campo}", which nothing reads`);
      }
    }
  }
  if (problemas.length === 0) {
    process.stdout.write(`  ok   ${nome}\n`);
  } else {
    falhas++;
    process.stdout.write(`  FAIL ${nome}\n`);
    for (const p of problemas) process.stdout.write(`         ${p}\n`);
  }
}

process.stdout.write(
  falhas === 0
    ? `\nedge function payload types: ${contratos} contract(s) across ${funcoes.length} function(s), all consistent\n`
    : `\nedge function payload types: ${falhas} function(s) FAILED\n`
);
process.exit(falhas === 0 ? 0 : 1);
