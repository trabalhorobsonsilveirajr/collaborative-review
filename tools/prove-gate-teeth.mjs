#!/usr/bin/env node
/**
 * prove-gate-teeth.mjs — proves the gate's own test suite can fail.
 *
 * A green suite proves nothing on its own. It could be green because the code is
 * right, or green because the tests do not actually exercise the guard they claim
 * to. The only way to tell the two apart is to BREAK the guard on purpose and
 * require the suite to notice.
 *
 * So: for each guard in the gate, this undoes it in a temporary copy and runs the
 * gate's self-test against that copy. The suite must go red. If it stays green,
 * that guard has no test behind it, and the coverage is decoration.
 *
 * This caught a real regression once. A test that had teeth lost them when a
 * newer guard started stopping the run BEFORE the case it was meant to measure —
 * the suite stayed green while measuring nothing. Nothing else would have noticed.
 *
 * Exit codes: 0 = every guard is tested · 1 = a guard has no test · 2 = misuse
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = process.argv[2] || ".";
const GATE = join(ROOT, "skills", "collaborative-review", "scripts", "gate.mjs");

/* Each entry: a guard, the exact text that implements it, and the text that
 * disables it. Anything that cannot be located is reported as an INVALID PROOF,
 * never quietly skipped: a proof that did not run is not a proof that passed. */
const GUARDS = [
  {
    name: "a section marker must be unique",
    from: "    if (occurrences.length > 1) {",
    to: "    if (false) {",
  },
  {
    name: "at least two sections are required",
    from: "  if (sections.length < 2) {",
    to: "  if (false) {",
  },
  {
    name: "scope cannot cover every section",
    from: "  if (scope.length >= state.sections.length) {",
    to: "  if (false) {",
  },
  {
    name: "reordering sections is detected",
    from: '  if (orderBefore.join("|") !== orderAfter.join("|")) {',
    to: "  if (false) {",
  },
  {
    name: "comparison is byte-exact (line endings count)",
    from: 'Buffer.from(linesBefore.join(""), "utf8"),\n      Buffer.from(b.get(id).join(""), "utf8")',
    to: 'Buffer.from(linesBefore.join("").replace(/\\r/g, ""), "utf8"),\n      Buffer.from(b.get(id).join("").replace(/\\r/g, ""), "utf8")',
  },
  {
    name: "working copies are isolated by full path",
    from: "  const stamp = sha(resolve(file)).slice(0, 12);\n  return join(dir, `${stamp}-${basename(file)}`);",
    to: "  return join(dir, basename(file));",
  },
  {
    name: "promote requires a passing check",
    from: '  if (state.verdict !== "PASSED") {',
    to: "  if (false) {",
    /* Layered on purpose: promote also refuses if the copy moved after the check.
     * Undoing one layer of a layered defence measures nothing, so both go. */
    also: {
      from: "  if (sha(current) !== state.verdictWorkHash) {",
      to: "  if (false) {",
    },
  },
  {
    name: "promote requires critic approval",
    from: "  if (approved.length < required) {",
    to: "  if (false) {",
  },
  {
    name: "one critic rejection blocks promotion",
    from: "  if (rejected.length) {",
    to: "  if (false) {",
  },
];

let source;
try {
  source = readFileSync(GATE, "utf8");
} catch {
  console.error(`cannot read the gate at ${GATE}`);
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), "gate-teeth-"));
const toothless = [];
const invalid = [];

console.log("proving the gate's tests have teeth");
console.log("(each guard is disabled in a copy; the suite must go red)\n");

for (const guard of GUARDS) {
  if (!source.includes(guard.from)) {
    invalid.push(`${guard.name}: the guard's code was not found, so nothing was proven`);
    console.log(`  ??    ${guard.name}`);
    continue;
  }
  let mutated = source.replace(guard.from, guard.to);
  if (guard.also) {
    if (!mutated.includes(guard.also.from)) {
      invalid.push(`${guard.name}: the second layer was not found`);
      console.log(`  ??    ${guard.name}`);
      continue;
    }
    mutated = mutated.replace(guard.also.from, guard.also.to);
  }

  const target = join(work, "gate.mjs");
  writeFileSync(target, mutated, "utf8");

  let noticed = false;
  try {
    execFileSync(process.execPath, [target, "selftest"], { stdio: "pipe" });
  } catch {
    noticed = true; // non-zero exit: the suite went red, which is what we want
  }

  console.log(`  ${noticed ? "ok  " : "GAP "}  ${guard.name}`);
  if (!noticed) {
    toothless.push(`${guard.name}: the suite stayed green with this guard disabled`);
  }
}

rmSync(work, { recursive: true, force: true });
console.log("");

if (invalid.length) {
  console.log(`INVALID PROOF: ${invalid.length}\n`);
  for (const i of invalid) console.log(`  · ${i}`);
  console.log("\nA proof that did not run is not a proof that passed.");
  console.log("The guard was probably renamed or rewritten. Update this file.");
  process.exit(1);
}

if (toothless.length) {
  console.log(`GUARDS WITH NO TEST BEHIND THEM: ${toothless.length}\n`);
  for (const t of toothless) console.log(`  · ${t}`);
  console.log("\nThe suite reports coverage it does not have. Add a case that exercises");
  console.log("this guard, and confirm it goes red here before trusting it again.");
  process.exit(1);
}

console.log(`Every one of the ${GUARDS.length} guards has a test that notices when it is removed.`);
process.exit(0);
