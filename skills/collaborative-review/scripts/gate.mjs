#!/usr/bin/env node
/**
 * gate.mjs — the mechanical half of the quality gate.
 *
 * The gate exists to make one guarantee: a reviewer's fix reaches the live file
 * ONLY if it changed exactly what it was allowed to change, and nothing else.
 *
 * It is deliberately dumb. It does not judge whether a fix is *good* — that is the
 * critics' job (see references/quality-gate.md). It judges whether the edit stayed
 * inside its lane, and it fails closed: anything it cannot verify is a refusal.
 *
 * Commands
 *   prepare  --file <path> --sections <a,b,c> [--work <dir>]
 *              Snapshots the live file and opens an isolated working copy.
 *   check    --file <path> --scope <b>
 *              Compares the working copy against the snapshot. Sections outside
 *              --scope must be byte-identical. Exits non-zero on any violation.
 *   critic   --file <path> --id <name> --verdict approve|reject [--reason <text>]
 *              Records one independent verdict, bound to the working copy it saw.
 *   promote  --file <path> [--critics <n>]
 *              Atomically swaps the working copy in. Refuses unless check passed,
 *              the copy is untouched since, and the required critic verdicts are
 *              recorded with no rejection. Default --critics 1.
 *   discard  --file <path>
 *              Throws the working copy away. The live file is never touched.
 *   selftest
 *              Proves the gate can both catch violations and stay quiet on clean
 *              runs. Run this before trusting it.
 *
 * Exit codes: 0 = ok · 1 = refused (violation) · 2 = misuse / cannot verify
 *
 * No dependencies. Node 18+.
 */

import { createHash } from "node:crypto";
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, renameSync,
} from "node:fs";
import { join, basename, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";

const OK = 0, REFUSED = 1, MISUSE = 2;

function sha(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

let INSIDE_SELFTEST = false;

/* In real use a refusal ends the process, which is correct and also untestable.
 * Inside the self-test it throws instead, so a case that MUST be refused can be
 * observed rather than taking the whole suite down with it. Without this, the
 * first refusal-case would kill the run and every later case would silently never
 * execute — a suite that looks green because it stopped early. */
class GateRefusal extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function die(code, message) {
  if (INSIDE_SELFTEST) throw new GateRefusal(code, message);
  process.stderr.write(`gate: ${message}\n`);
  process.exit(code);
}

/* Runs a command and returns its exit code, turning a refusal into a value. */
function attempt(fn) {
  try { return fn(); }
  catch (e) {
    if (e instanceof GateRefusal) return e.code;
    throw e;
  }
}

function report(lines) {
  process.stdout.write(lines.join("\n") + "\n");
}

/* ------------------------------------------------------------------ *
 * Sectioning
 *
 * The gate slices a document into ranges using caller-supplied section
 * markers, in document order. A "section" runs from the line where its
 * marker appears up to the line before the next marker. Everything above
 * the first marker is the preamble and is treated as an implicit
 * out-of-scope section, so a fix cannot quietly rewrite the <head>.
 *
 * Markers are matched as plain substrings, never as regex, so an id
 * containing regex metacharacters cannot change the matching rules.
 * ------------------------------------------------------------------ */

/**
 * strict = true  → a missing or ambiguous marker is a setup error and aborts.
 *                  Used on the live file, which prepare already validated.
 * strict = false → missing markers are RETURNED, not fatal. Used on the working
 *                  copy, where a vanished marker is the very violation the gate
 *                  exists to catch. Aborting there would turn the gate's most
 *                  important finding into a crash.
 */
function sliceSections(text, sections, { strict = true } = {}) {
  /* Split KEEPING the line terminator attached. Splitting on /\r?\n/ throws the
   * terminator away, so a section converted from LF to CRLF rejoined identically
   * and compared as unchanged. The gate then printed "byte-identical" about a
   * section in which every line ending had changed. */
  const lines = text.split(/(?<=\n)/);
  const found = new Map();
  const missing = [];
  const ambiguous = [];

  for (const id of sections) {
    if (!id) continue;
    /* Count EVERY occurrence, never just the first.
     *
     * Taking the first match is how this gate was defeated. On a page with a nav
     * menu, `sec-one` appears in `<a href="#sec-one">` before it appears on the
     * section itself. All three markers resolved inside the menu, producing three
     * empty ranges, and the entire body of the document fell into the last range,
     * which happened to be the one in scope. The gate reported three sections
     * byte-identical while two of them were being rewritten, and promoted.
     *
     * A marker that is not unique cannot map a document, so we refuse to try. */
    const occurrences = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(id)) occurrences.push(i);
    }
    if (occurrences.length > 1) {
      if (strict) {
        die(MISUSE, `section marker "${id}" appears ${occurrences.length} times ` +
          `(lines ${occurrences.map((n) => n + 1).join(", ")}). A marker must be unique ` +
          `or the document cannot be mapped. Use the full attribute, e.g. id="${id}".`);
      }
      ambiguous.push(id);
      continue;
    }
    const at = occurrences.length ? occurrences[0] : -1;
    if (at === -1) {
      if (strict) {
        die(MISUSE, `section marker not found in file: "${id}". ` +
          `Refusing to verify a document the gate cannot map.`);
      }
      missing.push(id);
      continue;
    }
    if ([...found.values()].includes(at)) {
      if (strict) {
        die(MISUSE, `two section markers resolve to the same line ("${id}"). ` +
          `Markers must be unique.`);
      }
      ambiguous.push(id);
      continue;
    }
    found.set(id, at);
  }

  const ordered = [...found.entries()].sort((a, b) => a[1] - b[1]);
  const ranges = new Map();

  ranges.set("__preamble__", lines.slice(0, ordered.length ? ordered[0][1] : lines.length));
  for (let i = 0; i < ordered.length; i++) {
    const [id, start] = ordered[i];
    const end = i + 1 < ordered.length ? ordered[i + 1][1] : lines.length;
    ranges.set(id, lines.slice(start, end));
  }
  return { ranges, missing, ambiguous };
}

function statePath(file) {
  /* Resolved, so ./x.html and x.html are recognised as the same cycle. */
  const stamp = sha(resolve(file)).slice(0, 12);
  return join(tmpdir(), `collab-review-gate-${stamp}.json`);
}

/* The working copy is named from the FULL path, not the base name.
 *
 * Naming it by base name meant two materials both called index.html - the most
 * common file name there is - shared a single working copy, and promoting one
 * wrote the other one's content into the live file, with a passing verdict. */
function workPath(file, workDir) {
  const dir = workDir || join(tmpdir(), "collab-review-gate-work");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const stamp = sha(resolve(file)).slice(0, 12);
  return join(dir, `${stamp}-${basename(file)}`);
}

/* ------------------------------------------------------------------ *
 * prepare
 * ------------------------------------------------------------------ */

function cmdPrepare(args) {
  const file = args.file;
  if (!file) die(MISUSE, "prepare needs --file <path>");
  if (!existsSync(file)) die(MISUSE, `file does not exist: ${file}`);
  if (!args.sections || args.sections === true) {
    die(MISUSE, "prepare needs --sections <id,id,...> so it knows what it is guarding");
  }

  const sections = String(args.sections).split(",").map((s) => s.trim()).filter(Boolean);
  if (!sections.length) die(MISUSE, "--sections resolved to an empty list");

  /* One section means there is nothing left OUTSIDE the scope to protect, and the
   * gate becomes theatre. This is not hypothetical: an auditor defeated an earlier
   * version by declaring the whole document as a single section, at which point
   * every possible edit was trivially "inside the lane". A boundary drawn by the
   * thing being contained is not a boundary. */
  if (sections.length < 2) {
    die(MISUSE, "prepare needs at least 2 sections. With one section there is nothing " +
      "outside the scope to protect, so the gate would guarantee nothing.");
  }

  const original = readFileSync(file, "utf8");
  const { ranges: initialRanges } = sliceSections(original, sections);
  const order = [...initialRanges.keys()];

  const work = workPath(file, args.work === true ? undefined : args.work);
  writeFileSync(work, original, "utf8");

  const state = {
    file, work, sections,
    /* The order the sections appear in. Reordering is declared STRUCTURAL by the
     * protocol, precisely because it breaks the link between a reviewer's note and
     * the section it referred to. Content comparison alone cannot see a reorder:
     * every section is still byte-identical, just somewhere else. */
    order,
    originalHash: sha(original),
    preparedAt: new Date().toISOString(),
  };
  writeFileSync(statePath(file), JSON.stringify(state, null, 2), "utf8");

  report([
    "prepared",
    `  live file : ${file}`,
    `  working   : ${work}`,
    `  sections  : ${sections.length} mapped`,
    "",
    "Edit ONLY the working copy. The live file stays untouched until promote.",
  ]);
  return OK;
}

function loadState(file) {
  const p = statePath(file);
  if (!existsSync(p)) {
    die(MISUSE, `no prepared state for ${file}. Run prepare first.`);
  }
  const state = JSON.parse(readFileSync(p, "utf8"));
  if (!existsSync(state.work)) {
    die(MISUSE, `working copy is gone: ${state.work}. Nothing to verify.`);
  }
  return state;
}

/* ------------------------------------------------------------------ *
 * check — the part that must be able to say no
 * ------------------------------------------------------------------ */

function cmdCheck(args) {
  const file = args.file;
  if (!file) die(MISUSE, "check needs --file <path>");
  const state = loadState(file);

  const scope = args.scope && args.scope !== true
    ? String(args.scope).split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  const unknown = scope.filter((s) => !state.sections.includes(s));
  if (unknown.length) {
    die(MISUSE, `--scope names sections that were never mapped: ${unknown.join(", ")}`);
  }

  /* Scope covering every mapped section is the same defeat as one giant section,
   * arriving by another road: nothing is left outside, so nothing is guarded. */
  if (scope.length >= state.sections.length) {
    die(MISUSE, "scope covers every section, so nothing is protected. Narrow it to " +
      "the sections the reviewers actually commented on.");
  }

  const before = readFileSync(file, "utf8");
  const after = readFileSync(state.work, "utf8");

  if (sha(before) !== state.originalHash) {
    report([
      "REFUSED — the live file changed after prepare",
      "  Someone or something edited the real file while the fix was being made.",
      "  Promoting now would silently erase their change. Re-run prepare.",
    ]);
    return REFUSED;
  }

  const { ranges: a } = sliceSections(before, state.sections, { strict: true });
  const { ranges: b, missing, ambiguous } =
    sliceSections(after, state.sections, { strict: false });

  const violations = [];

  for (const id of missing) violations.push(`section was deleted from the document: ${id}`);
  for (const id of ambiguous) violations.push(`section marker became ambiguous: ${id}`);

  /* Every section can be byte-identical and the document still be wrong, because
   * they were shuffled. The protocol calls a reorder structural, so the gate has
   * to be able to see one. */
  const orderBefore = (state.order || [...a.keys()]).filter((id) => b.has(id));
  const orderAfter = [...b.keys()].filter((id) => a.has(id));
  if (orderBefore.join("|") !== orderAfter.join("|")) {
    violations.push("sections were reordered, which is a structural change: " +
      `before [${orderBefore.join(", ")}], after [${orderAfter.join(", ")}]`);
  }

  if (a.size !== b.size) {
    violations.push(`section count changed: ${a.size} -> ${b.size} (a section was added or lost)`);
  }

  for (const [id, linesBefore] of a) {
    if (!b.has(id)) continue; // already reported above as deleted
    const inScope = scope.includes(id);
    /* join("") because the terminators are already inside each entry: this is a
     * true byte comparison, and the word "byte-identical" in the report is now
     * literally true. */
    const same = Buffer.compare(
      Buffer.from(linesBefore.join(""), "utf8"),
      Buffer.from(b.get(id).join(""), "utf8")
    ) === 0;
    if (!inScope && !same) {
      const label = id === "__preamble__" ? "document head / preamble" : id;
      violations.push(`changed outside its lane: ${label}`);
    }
  }

  const shrink = 1 - after.length / Math.max(before.length, 1);
  if (shrink > 0.15) {
    violations.push(`document shrank by ${(shrink * 100).toFixed(1)}% — possible truncation`);
  }

  const touched = scope.filter((id) => a.has(id) && b.has(id) &&
    a.get(id).join("") !== b.get(id).join(""));

  /* The verdict is recorded in the state file, and promote refuses without it.
   * A check whose "no" does not actually hold the door shut is decoration. */
  const seal = (verdict) => {
    state.verdict = verdict;
    state.verdictWorkHash = verdict === "PASSED" ? sha(after) : null;
    state.verdictScope = scope;
    state.verdictAt = new Date().toISOString();
    writeFileSync(statePath(file), JSON.stringify(state, null, 2), "utf8");
  };

  if (violations.length) {
    seal("REFUSED");
    report([
      "REFUSED — the fix did not stay inside its lane",
      ...violations.map((v) => `  · ${v}`),
      "",
      "The live file was NOT modified. Nothing was lost.",
      "promote is now blocked for this cycle until a fresh check passes.",
    ]);
    return REFUSED;
  }

  if (!touched.length) {
    seal("REFUSED");
    report([
      "REFUSED — nothing actually changed",
      "  The working copy is identical to the live file inside the allowed scope.",
      "  A fix that changes nothing is a fix that did not happen.",
    ]);
    return REFUSED;
  }

  seal("PASSED");
  report([
    "PASSED — mechanical checks clean",
    `  changed in scope   : ${touched.join(", ")}`,
    `  untouched elsewhere: ${a.size - touched.length} section(s) byte-identical`,
    "",
    "This says the edit stayed in its lane. It does NOT say the edit is good —",
    "that verdict belongs to the critics. Do not promote without unanimity.",
  ]);
  return OK;
}

/* ------------------------------------------------------------------ *
 * critic — records one independent verdict
 *
 * The protocol says a batch may only be promoted with UNANIMOUS approval from
 * independent critics. For a long time that sentence lived only in prose, and
 * an audit put it plainly: the sequence prepare, apply, check, promote went
 * through with no critic having said anything. The rule existed; nothing
 * enforced it. A verdict that does not bind is decoration.
 *
 * Each vote is bound to the SHA of the working copy it examined, so a vote
 * cannot be recycled onto different content. Editing after a vote invalidates
 * that vote, exactly as editing after the check invalidates the check.
 * ------------------------------------------------------------------ */

function cmdCritic(args) {
  const file = args.file;
  if (!file) die(MISUSE, "critic needs --file <path>");
  const state = loadState(file);

  const verdict = String(args.verdict || "").toLowerCase();
  if (verdict !== "approve" && verdict !== "reject") {
    die(MISUSE, 'critic needs --verdict approve|reject');
  }
  const id = args.id && args.id !== true ? String(args.id) : null;
  if (!id) die(MISUSE, "critic needs --id <name>, so votes can be told apart");
  const reason = args.reason && args.reason !== true ? String(args.reason) : "";
  if (verdict === "reject" && !reason) {
    die(MISUSE, "a rejection needs --reason: an objection nobody can read cannot be acted on");
  }

  const current = readFileSync(state.work, "utf8");
  const workHash = sha(current);

  state.critics = (state.critics || []).filter((c) => c.id !== id);
  state.critics.push({ id, verdict, reason, workHash, at: new Date().toISOString() });
  writeFileSync(statePath(file), JSON.stringify(state, null, 2), "utf8");

  const approvals = state.critics.filter((c) => c.verdict === "approve" && c.workHash === workHash);
  const rejections = state.critics.filter((c) => c.verdict === "reject" && c.workHash === workHash);

  report([
    `recorded: ${id} says ${verdict}`,
    reason ? `  reason: ${reason}` : "",
    `  votes on this exact copy: ${approvals.length} approve, ${rejections.length} reject`,
  ].filter(Boolean));
  return OK;
}

/* ------------------------------------------------------------------ *
 * promote / discard
 * ------------------------------------------------------------------ */

function cmdPromote(args) {
  const file = args.file;
  if (!file) die(MISUSE, "promote needs --file <path>");
  const state = loadState(file);

  /* Fail closed. promote is not a decision — it is the execution of a verdict
   * that check already reached. No verdict, no promotion. */
  if (state.verdict !== "PASSED") {
    report([
      state.verdict === "REFUSED"
        ? "REFUSED — check rejected this fix; promote will not override it"
        : "REFUSED — this fix was never checked",
      "  Run check first. promote only carries out a verdict, it never issues one.",
    ]);
    return REFUSED;
  }

  const current = readFileSync(state.work, "utf8");
  if (sha(current) !== state.verdictWorkHash) {
    report([
      "REFUSED — the working copy changed after it was checked",
      "  Editing after the check invalidates the check. Run check again.",
    ]);
    return REFUSED;
  }

  /* Unanimity, enforced rather than requested. --critics <n> declares how many
   * independent verdicts this batch requires; the default of 1 keeps a solo run
   * possible while still demanding that SOMEONE looked. Votes only count if they
   * examined this exact copy. */
  const required = args.critics === undefined ? 1
    : Number.parseInt(String(args.critics), 10);
  if (!Number.isInteger(required) || required < 0) {
    die(MISUSE, "--critics needs a whole number (0 disables the requirement, and says so in the log)");
  }
  const votes = (state.critics || []).filter((c) => c.workHash === state.verdictWorkHash);
  const rejected = votes.filter((c) => c.verdict === "reject");
  const approved = votes.filter((c) => c.verdict === "approve");

  if (rejected.length) {
    report([
      "REFUSED — a critic rejected this batch",
      ...rejected.map((c) => `  ${c.id}: ${c.reason}`),
      "",
      "One competent objection is enough. Fix the edit and run the cycle again.",
    ]);
    return REFUSED;
  }
  if (approved.length < required) {
    report([
      `REFUSED — ${required} critic verdict(s) required, ${approved.length} recorded`,
      "  A batch nobody reviewed is a batch nobody vouched for.",
      "  Record one with: gate.mjs critic --file <path> --id <name> --verdict approve",
      "  Or state plainly that this run has no critics: --critics 0",
    ]);
    return REFUSED;
  }

  const live = readFileSync(file, "utf8");
  if (sha(live) !== state.originalHash) {
    report([
      "REFUSED — live file changed since prepare; not promoting",
      "  Swapping now would destroy an edit made outside this cycle.",
    ]);
    return REFUSED;
  }

  const backup = `${file}.gate-backup`;
  writeFileSync(backup, live, "utf8");

  const staged = join(dirname(file), `.${basename(file)}.gate-staged`);
  writeFileSync(staged, readFileSync(state.work, "utf8"), "utf8");
  renameSync(staged, file); // atomic on the same volume

  rmSync(statePath(file), { force: true });

  report([
    "promoted",
    `  live file : ${file}`,
    `  rollback  : ${backup}`,
    approved.length
      ? `  approved by: ${approved.map((c) => c.id).join(", ")}`
      : "  approved by: NOBODY (--critics 0 was used)",
  ]);
  return OK;
}

function cmdDiscard(args) {
  const file = args.file;
  if (!file) die(MISUSE, "discard needs --file <path>");
  const p = statePath(file);
  if (existsSync(p)) {
    const state = JSON.parse(readFileSync(p, "utf8"));
    rmSync(state.work, { force: true });
    rmSync(p, { force: true });
  }
  report(["discarded — the live file was never touched"]);
  return OK;
}

/* ------------------------------------------------------------------ *
 * selftest — a gate that was never seen refusing is decoration
 *
 * Two lists: cases the gate MUST refuse, and cases it MUST let through.
 * If any expectation fails, this exits non-zero and the gate should not
 * be trusted until it is fixed.
 * ------------------------------------------------------------------ */

function cmdSelftest() {
  INSIDE_SELFTEST = true;
  const dir = join(tmpdir(), `collab-review-selftest-${process.pid}`);
  mkdirSync(dir, { recursive: true });

  const doc = [
    "<head><title>Original title</title></head>",
    '<section id="sec-one">',
    "  <p>First section body.</p>",
    "</section>",
    '<section id="sec-two">',
    "  <p>Second section body.</p>",
    "</section>",
    '<section id="sec-three">',
    "  <p>Third section body.</p>",
    "</section>",
  ].join("\n");

  const SECTIONS = 'id="sec-one",id="sec-two",id="sec-three"';
  const SCOPE = 'id="sec-two"';

  let pass = 0, fail = 0;
  const failures = [];

  const run = (label, mutate, expected) => {
    const file = join(dir, `case-${pass + fail}.html`);
    writeFileSync(file, doc, "utf8");
    const work = join(dir, `work-${pass + fail}`);

    const prep = cmdPrepareQuiet({ file, sections: SECTIONS, work });
    if (prep !== OK) {
      fail++; failures.push(`${label}: prepare itself failed`); return;
    }
    const state = JSON.parse(readFileSync(statePath(file), "utf8"));
    mutate(state.work, file);

    const got = cmdCheckQuiet({ file, scope: SCOPE });
    if (got === expected) pass++;
    else {
      fail++;
      failures.push(`${label}: expected ${expected === OK ? "PASS" : "REFUSE"}, got ${got === OK ? "PASS" : "REFUSE"}`);
    }
    cmdDiscardQuiet({ file });
  };

  // MUST refuse
  run("edit leaked into another section", (w) => {
    writeFileSync(w, readFileSync(w, "utf8")
      .replace("Second section body.", "Second section, fixed.")
      .replace("Third section body.", "Third section, meddled with."), "utf8");
  }, REFUSED);

  run("rewrote the document head", (w) => {
    writeFileSync(w, readFileSync(w, "utf8")
      .replace("Original title", "Hijacked title")
      .replace("Second section body.", "Second section, fixed."), "utf8");
  }, REFUSED);

  run("deleted a whole section", (w) => {
    writeFileSync(w, readFileSync(w, "utf8")
      .replace('<section id="sec-three">\n  <p>Third section body.</p>\n</section>', ""), "utf8");
  }, REFUSED);

  run("truncated the document", (w) => {
    writeFileSync(w, '<head><title>Original title</title></head>\n<section id="sec-one">\n', "utf8");
  }, REFUSED);

  run("changed nothing at all", () => {}, REFUSED);

  run("live file edited behind our back", (w, file) => {
    writeFileSync(w, readFileSync(w, "utf8")
      .replace("Second section body.", "Second section, fixed."), "utf8");
    writeFileSync(file, doc + "\n<!-- someone else was here -->", "utf8");
  }, REFUSED);

  /* ---- cases an audit found, which the original twelve did not cover ----
   *
   * Every one of these was reproduced against the previous version: each PASSED
   * and PROMOTED. They live here now so the same escape cannot happen twice.
   * The originals all used a tidy document the gate's own author wrote, which is
   * exactly why they proved less than they appeared to. */

  /* A marker repeated in a nav menu. The old code took the first match, mapped
   * every section inside the menu, and dropped the whole body into the last
   * range, which was the one in scope. */
  {
    const label = "marker repeated in a nav menu";
    const file = join(dir, "nav.html");
    const navDoc = [
      "<head><title>T</title></head>",
      "<nav>",
      '  <a href="#sec-one">One</a>',
      '  <a href="#sec-two">Two</a>',
      "</nav>",
      '<section id="sec-one">',
      "  <p>Legal text that must survive.</p>",
      "</section>",
      '<section id="sec-two">',
      "  <p>Second.</p>",
      "</section>",
    ].join("\n");
    writeFileSync(file, navDoc, "utf8");
    const got = silence(() => attempt(() => cmdPrepare({
      file, sections: "sec-one,sec-two", work: join(dir, "navwork"),
    })));
    if (got === MISUSE) pass++;
    else { fail++; failures.push(`${label}: expected a refusal to map, got ${got}`); }
    cmdDiscardQuiet({ file });
  }

  /* Scope covering every section: nothing left outside, so nothing guarded. */
  {
    const label = "scope covers every section";
    const file = join(dir, "allscope.html");
    writeFileSync(file, doc, "utf8");
    silence(() => attempt(() => cmdPrepare({ file, sections: SECTIONS, work: join(dir, "allwork") })));
    const st = JSON.parse(readFileSync(statePath(file), "utf8"));
    writeFileSync(st.work, readFileSync(st.work, "utf8")
      .replace("Second section body.", "changed"), "utf8");
    const got = silence(() => attempt(() => cmdCheck({ file, scope: SECTIONS })));
    if (got === MISUSE) pass++;
    else { fail++; failures.push(`${label}: expected MISUSE, got ${got}`); }
    cmdDiscardQuiet({ file });
  }

  /* A single section: the boundary would be drawn by the thing being contained. */
  {
    const label = "only one section declared";
    const file = join(dir, "onesec.html");
    writeFileSync(file, doc, "utf8");
    const got = silence(() => attempt(() => cmdPrepare({
      file, sections: 'id="sec-two"', work: join(dir, "onework"),
    })));
    if (got === MISUSE) pass++;
    else { fail++; failures.push(`${label}: expected MISUSE, got ${got}`); }
    cmdDiscardQuiet({ file });
  }

  /* Reordering sections: every section stays byte-identical, in a new place.
   * The protocol calls this structural. */
  run("sections reordered", (w) => {
    const t = readFileSync(w, "utf8");
    const secOne = '<section id="sec-one">\n  <p>First section body.</p>\n</section>\n';
    const secTwo = '<section id="sec-two">\n  <p>Second section body, corrected.</p>\n</section>\n';
    const rest = t.slice(t.indexOf('<section id="sec-three">'));
    writeFileSync(w, t.slice(0, t.indexOf('<section id="sec-one">')) + secTwo + secOne + rest, "utf8");
  }, REFUSED);

  /* Line endings changed on a section OUTSIDE the scope. The old code rejoined
   * lines with a chosen separator, so this compared as identical while every
   * line ending in that section had in fact changed. */
  run("line endings changed outside the scope", (w) => {
    let t = readFileSync(w, "utf8").replace("Second section body.", "Second, fixed.");
    const before = '<section id="sec-three">\n  <p>Third section body.</p>\n</section>';
    const after = before.split("\n").join("\r\n");
    writeFileSync(w, t.replace(before, after), "utf8");
  }, REFUSED);

  /* Two materials with the same base name sharing one working copy: promoting
   * one wrote the other one's content into the live file. */
  {
    const label = "two materials with the same base name";
    const dirA = join(dir, "projA"); const dirB = join(dir, "projB");
    mkdirSync(dirA, { recursive: true }); mkdirSync(dirB, { recursive: true });
    const fileA = join(dirA, "index.html");
    const fileB = join(dirB, "index.html");
    const docA = doc.replace("Second section body.", "PRICE IS 100 (MATERIAL A)");
    const docB = doc.replace("Second section body.", "PRICE IS 999 (MATERIAL B)");
    writeFileSync(fileA, docA, "utf8");
    writeFileSync(fileB, docB, "utf8");
    silence(() => attempt(() => cmdPrepare({ file: fileA, sections: SECTIONS, work: join(dir, "shared") })));
    silence(() => attempt(() => cmdPrepare({ file: fileB, sections: SECTIONS, work: join(dir, "shared") })));
    const stA = JSON.parse(readFileSync(statePath(fileA), "utf8"));
    writeFileSync(stA.work, readFileSync(stA.work, "utf8")
      .replace("PRICE IS 100 (MATERIAL A)", "PRICE IS 100, corrected"), "utf8");
    silence(() => attempt(() => cmdCheck({ file: fileA, scope: 'id="sec-two"' })));
    /* A vote is recorded so the promotion actually happens: without it the run
     * stops at the critics gate and never exercises the collision this case
     * exists to catch. A new guard can quietly hollow out an older test. */
    cmdCriticQuiet({ file: fileA, id: "critic-a", verdict: "approve" });
    silence(() => attempt(() => cmdPromote({ file: fileA })));
    const liveA = readFileSync(fileA, "utf8");
    if (liveA.includes("MATERIAL B") || liveA.includes("999")) {
      fail++; failures.push(`${label}: material B's content reached material A's live file`);
    } else pass++;
    cmdDiscardQuiet({ file: fileA });
    cmdDiscardQuiet({ file: fileB });
  }

  // MUST allow
  run("clean in-scope fix", (w) => {
    writeFileSync(w, readFileSync(w, "utf8")
      .replace("Second section body.", "Second section body, corrected per reviewer."), "utf8");
  }, OK);

  run("larger in-scope rewrite", (w) => {
    writeFileSync(w, readFileSync(w, "utf8")
      .replace("  <p>Second section body.</p>",
        "  <p>A fuller rewrite of the second section.</p>\n  <p>With an added paragraph.</p>"), "utf8");
  }, OK);

  /* ---- promote must obey check, never outrank it ----
   * These cases exist because an early version of this gate promoted a fix that
   * check had already rejected. A refusal that does not hold the door shut is
   * decoration, so every path into promote is pinned down here. */

  const runPromote = (label, steps, expected) => {
    const file = join(dir, `prom-${pass + fail}.html`);
    writeFileSync(file, doc, "utf8");
    const work = join(dir, `promwork-${pass + fail}`);
    if (cmdPrepareQuiet({ file, sections: SECTIONS, work }) !== OK) {
      fail++; failures.push(`${label}: prepare failed`); return;
    }
    const state = JSON.parse(readFileSync(statePath(file), "utf8"));
    steps(state.work, file);
    const got = silence(() => attempt(() => cmdPromote({ file })));
    if (got === expected) pass++;
    else {
      fail++;
      failures.push(`${label}: expected ${expected === OK ? "PROMOTE" : "REFUSE"}, got ${got === OK ? "PROMOTE" : "REFUSE"}`);
    }
    if (expected === REFUSED && readFileSync(file, "utf8") !== doc) {
      fail++; failures.push(`${label}: live file was modified despite a refusal`);
    }
    cmdDiscardQuiet({ file });
  };

  const goodFix = (w) => writeFileSync(w, readFileSync(w, "utf8")
    .replace("Second section body.", "Second section, fixed."), "utf8");
  const leakyFix = (w) => writeFileSync(w, readFileSync(w, "utf8")
    .replace("Second section body.", "Second section, fixed.")
    .replace("Third section body.", "Third, meddled with."), "utf8");

  runPromote("promote without any check", goodFix, REFUSED);

  runPromote("promote after check REFUSED", (w, f) => {
    leakyFix(w);
    silence(() => attempt(() => cmdCheck({ file: f, scope: SCOPE })));
  }, REFUSED);

  runPromote("promote after editing the copy post-check", (w, f) => {
    goodFix(w);
    silence(() => attempt(() => cmdCheck({ file: f, scope: SCOPE })));
    writeFileSync(w, readFileSync(w, "utf8")
      .replace("Third section body.", "sneaked in after the check"), "utf8");
  }, REFUSED);

  runPromote("promote after a clean check and one approval", (w, f) => {
    goodFix(w);
    silence(() => attempt(() => cmdCheck({ file: f, scope: SCOPE })));
    cmdCriticQuiet({ file: f, id: "critic-a", verdict: "approve" });
  }, OK);

  /* ---- the critics' unanimity, as a mechanism rather than a sentence ----
   *
   * These exist because an audit pointed out that the rule was written in prose
   * and enforced nowhere: prepare, apply, check, promote went through with no
   * critic having spoken. */

  runPromote("promote with no critic verdict at all", (w, f) => {
    goodFix(w);
    silence(() => attempt(() => cmdCheck({ file: f, scope: SCOPE })));
  }, REFUSED);

  runPromote("promote when a critic rejected", (w, f) => {
    goodFix(w);
    silence(() => attempt(() => cmdCheck({ file: f, scope: SCOPE })));
    cmdCriticQuiet({ file: f, id: "critic-a", verdict: "approve" });
    cmdCriticQuiet({ file: f, id: "critic-b", verdict: "reject", reason: "changes the meaning" });
  }, REFUSED);

  runPromote("promote when the copy changed after the vote", (w, f) => {
    goodFix(w);
    silence(() => attempt(() => cmdCheck({ file: f, scope: SCOPE })));
    cmdCriticQuiet({ file: f, id: "critic-a", verdict: "approve" });
    writeFileSync(w, readFileSync(w, "utf8").replace("Second section, fixed.", "something else"), "utf8");
  }, REFUSED);

  rmSync(dir, { recursive: true, force: true });

  report([
    "selftest",
    `  passed: ${pass}`,
    `  failed: ${fail}`,
    ...failures.map((f) => `  · ${f}`),
    "",
    fail === 0
      ? "The gate refuses what it must and stays quiet when it should."
      : "DO NOT TRUST THIS GATE until the failures above are fixed.",
  ]);
  return fail === 0 ? OK : REFUSED;
}

/* quiet wrappers used by selftest so its output stays readable */
function silence(fn) {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  try { return fn(); } finally { process.stdout.write = write; }
}
const cmdPrepareQuiet = (a) => silence(() => attempt(() => cmdPrepare(a)));
const cmdCheckQuiet = (a) => silence(() => attempt(() => cmdCheck(a)));
const cmdDiscardQuiet = (a) => silence(() => attempt(() => cmdDiscard(a)));
const cmdCriticQuiet = (a) => silence(() => attempt(() => cmdCritic(a)));

/* ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const cmd = argv[0];
const args = parseArgs(argv.slice(1));

const table = {
  prepare: cmdPrepare,
  check: cmdCheck,
  critic: cmdCritic,
  promote: cmdPromote,
  discard: cmdDiscard,
  selftest: cmdSelftest,
};

if (!cmd || !table[cmd]) {
  process.stderr.write(
    "usage: gate.mjs <prepare|check|critic|promote|discard|selftest> [options]\n" +
    "  see the header of this file for the full contract\n"
  );
  process.exit(MISUSE);
}

process.exit(table[cmd](args));
