#!/usr/bin/env node
/**
 * check-no-leaks.mjs — refuses to let private material reach a public repository.
 *
 * Scans the working tree AND every blob in git history. Public history is
 * permanent: a secret removed in a later commit is still served by the commit
 * that introduced it, so scanning only the current files is a hole big enough to
 * publish a secret through while believing it was cleaned.
 *
 * TWO KINDS OF PATTERN, and why they live in different places:
 *
 *   CREDENTIALS are universal. Every project's tokens look the same, so they are
 *   built in below and work for you with no configuration.
 *
 *   NAMES are yours. Your employer, your clients, your colleagues, your internal
 *   project names. Those go in a file this tool reads and git never sees —
 *   because a list of things that must not be published is itself a list of
 *   private things, and publishing the scanner would publish exactly what it
 *   guards.
 *
 * To set up the private list:
 *
 *   cp tools/private-terms.example.json .private-terms.json
 *   (edit it, and confirm .private-terms.json is in .gitignore)
 *
 * HOW THIS SCANNER FAILED ONCE, which shaped what is below: an earlier version
 * passed a repository containing a real reviewer's name, a client material name,
 * and a private project name. Three causes, all fixed here:
 *   1. A case-sensitive pattern for a term that appeared capitalised.
 *   2. A pattern written only in Portuguese for a term that had been TRANSLATED
 *      during the same cleanup. Translating a forbidden term smuggled it past the
 *      scanner looking for it. Hence: list every language a term might wear.
 *   3. No self-test case for any of them, so nothing warned they were asleep.
 *
 * Exit codes: 0 = clean · 1 = leak found (do not publish) · 2 = scanner is broken
 */

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative, extname } from "node:path";

const ROOT = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : ".";
const NUL = String.fromCharCode(0);
const SCAN_HISTORY = !process.argv.includes("--tree-only");

/* Credentials. Broad on purpose: a false alarm costs a second, a miss is permanent. */
const CREDENTIALS = [
  { re: /eyJ[A-Za-z0-9_-]{20,}\./, why: "a JWT or API key" },
  { re: /\bsb_secret_/, why: "a Supabase secret key" },
  { re: /\bghp_[A-Za-z0-9]{20,}/, why: "a GitHub personal token" },
  { re: /\bgho_[A-Za-z0-9]{20,}/, why: "a GitHub OAuth token" },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/, why: "a GitHub fine-grained token" },
  { re: /\bgsk_[A-Za-z0-9]{20,}/, why: "a Groq API key" },
  { re: /\bsk-ant-[A-Za-z0-9-]{20,}/, why: "an Anthropic API key" },
  { re: /\bsk-[A-Za-z0-9]{20,}/, why: "an OpenAI-style API key" },
  { re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/, why: "a Stripe live key" },
  { re: /\bAIza[A-Za-z0-9_-]{30,}/, why: "a Google API key" },
  { re: /\bnpm_[A-Za-z0-9]{30,}/, why: "an npm token" },
  { re: /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, why: "a SendGrid key" },
  { re: /\bAKIA[0-9A-Z]{16}\b/, why: "an AWS access key id" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, why: "a Slack token" },
  { re: /hooks\.slack\.com\/services\/[A-Za-z0-9\/]{20,}/, why: "a Slack webhook" },
  { re: /postgres(?:ql)?:\/\/[^\s:]+:[^\s@]+@/i, why: "a database URL with a password" },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, why: "a private key" },
  { re: /\b[a-z]{20}\.supabase\.co/, why: "a real backend project ref" },
  /* Local machine paths, any OS, any drive. */
  { re: /[A-Za-z]:[\\/]Users[\\/][A-Za-z]/, why: "a local Windows user path" },
  { re: /\/home\/[a-z][a-z0-9_-]*\//i, why: "a local Linux home path" },
  { re: /\/Users\/[A-Za-z][A-Za-z0-9_-]*\//, why: "a local macOS home path" },
];

/* Private terms, loaded from a file git never sees. */
function loadPrivate() {
  const p = join(ROOT, ".private-terms.json");
  if (!existsSync(p)) return { patterns: [], configured: false };
  let raw;
  try { raw = JSON.parse(readFileSync(p, "utf8")); } catch (e) {
    console.error(`.private-terms.json is not valid JSON: ${e.message}`);
    process.exit(2);
  }
  const patterns = [];
  for (const entry of raw.terms || []) {
    const term = typeof entry === "string" ? { term: entry } : entry;
    if (!term.term) continue;
    /* Case-insensitive by default. A case-sensitive pattern here is a pattern
     * asleep half the time, which is how a name got through once. */
    patterns.push({
      re: new RegExp(`\\b${term.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"),
      why: term.why || "a private term",
      allow: term.allow ? new RegExp(term.allow, "i") : undefined,
    });
  }
  return { patterns, configured: true };
}

const priv = loadPrivate();
const FORBIDDEN = [...CREDENTIALS, ...priv.patterns];

const BINARY = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".ico",
  ".woff", ".woff2", ".ttf", ".mp3", ".webm", ".zip", ".pyc", ".bundle"]);

function hit(text) {
  return FORBIDDEN.find((f) => f.re.test(text) && !(f.allow && f.allow.test(text)));
}

/* ---------------- self-test ---------------- */

function selfTest() {
  const mustCatch = [
    [("key eyJhbGciOiJIUzI1NiIsInR5"+"cCI6IkpXVCJ9"+".body"), "JWT"],
    [("token ghp"+"_"+"abcdefghijklmnopqrstuvwxyz01"), "github token"],
    [("sk"+"-ant-"+"abcdefghijklmnopqrstuvwxyz012345"), "anthropic key"],
    [("sk"+"_live_"+"abcdefghijklmnopqrstuvwxyz"), "stripe live key"],
    [("AKIA"+"IOSFODNN7"+"EXAMPLE"), "aws key id"],
    ["postgres://admin:hunter2@db.example.com/x", "database url with password"],
    /* Assembled at runtime, not written out. A literal PEM header in a test
     * case trips every credential hook there is, including the one on the
     * maintainer's machine, and a test fixture should never look like the
     * thing it tests for. */
    [["-----BEGIN", "RSA", "PRIVATE", "KEY-----"].join(" "), "private key header"],
    ["path C:/Users/SomeUser/thing", "local Windows path"],
    ["/home/someuser/projects/x", "local Linux path"],
    ["https://abcdefghijklmnopqrst.supabase.co", "a real backend ref"],
  ];
  const mustIgnore = [
    ["YOUR_PROJECT_REF.supabase.co", "placeholder ref"],
    ["https://your-project-ref.supabase.co", "hyphenated placeholder"],
    ["set SUPABASE_SERVICE_ROLE_KEY as a secret", "env var name"],
    ["the reviewer finished", "ordinary words"],
    ["<your-home>/projects/page.html", "sanitised path"],
    ["run node tools/check-no-leaks.mjs", "own command"],
  ];

  /* Split across markup: invisible to a plain search, obvious on screen.
   * These use a credential pattern rather than a private name, so the case
   * still runs on a machine with no .private-terms.json - a CI runner, or
   * anyone who cloned the repository. */
  const mustCatchThroughMarkup = [
    [("<b>AKIA</b>"+"IOSFODNN7"+"EXAMPLE"), "aws key split by a bold tag"],
    [("AKIA"+"IOSFO<span>DNN7"+"EXAMPLE</span>"), "aws key split by a span"],
    [("<i>sk"+"-ant-</i>"+"abcdefghijklmnopqrstuvwxyz012345"), "anthropic key split by an italic tag"],
  ];
  /* Stripping tags must not INVENT a match by gluing unrelated words together.
   * "</td><td>" separates two cells; the text either side is not one string. */
  const mustIgnoreThroughMarkup = [
    ["<td>the reviewer</td><td>finished the page</td>", "two table cells are not one word"],
    ["<p>nothing to see</p><p>here at all</p>", "two paragraphs are not one word"],
  ];

  let bad = 0;
  for (const [text, label] of mustCatch) {
    if (!hit(text)) { console.error(`  self-test FAIL: should have caught ${label}: "${text}"`); bad++; }
  }
  for (const [text, label] of mustIgnore) {
    const h = hit(text);
    if (h) { console.error(`  self-test FAIL: false positive on ${label} (${h.why}): "${text}"`); bad++; }
  }
  for (const [text, label] of mustCatchThroughMarkup) {
    if (hit(text)) continue;                    // caught as written, fine
    if (!hit(semTags(text))) { console.error(`  self-test FAIL: should have caught ${label}: "${text}"`); bad++; }
  }
  for (const [text, label] of mustIgnoreThroughMarkup) {
    const h = hit(semTags(text));
    if (h) { console.error(`  self-test FAIL: stripping markup invented a match on ${label} (${h.why})`); bad++; }
  }
  return {
    bad,
    total: mustCatch.length + mustIgnore.length + mustCatchThroughMarkup.length + mustIgnoreThroughMarkup.length,
  };
}

/* ---------------- sources ---------------- */

function trackedFiles() {
  try {
    const out = execFileSync("git", ["-C", ROOT, "ls-files", "-z"], { encoding: "utf8" });
    return out.split(NUL).filter(Boolean).map((f) => join(ROOT, f));
  } catch { return null; }
}

/* Files that a `git add -A` would pick up but git does not track yet. A scratch
 * folder full of client-imitating fixtures once sat here, unignored, while this
 * tool reported the repository clean. */
function untrackedNotIgnored() {
  try {
    const out = execFileSync("git", ["-C", ROOT, "ls-files", "-z", "--others", "--exclude-standard"],
      { encoding: "utf8" });
    return out.split(NUL).filter(Boolean).map((f) => join(ROOT, f));
  } catch { return []; }
}

function historyBlobs() {
  try {
    const raw = execFileSync("git", ["-C", ROOT, "rev-list", "--objects", "--all"],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const blobs = [];
    for (const line of raw.split("\n")) {
      const sp = line.indexOf(" ");
      if (sp === -1) continue;
      const path = line.slice(sp + 1).trim();
      if (!path || BINARY.has(extname(path).toLowerCase())) continue;
      blobs.push({ sha: line.slice(0, sp), path });
    }
    return blobs;
  } catch { return []; }
}

/* Files that legitimately CONTAIN example credentials: this scanner's own
 * self-test cases, and the example private-term file. Scanning them finds the
 * examples every time, and a scanner that always fires teaches people to ignore
 * it — which is how the real finding gets skipped. */
const SELF = [
  "tools/check-no-leaks.mjs",
  "tools/private-terms.example.json",
  ".private-terms.json",
];
function isSelf(label) {
  const norm = label.split("\\").join("/");
  return SELF.some((s) => norm.includes(s));
}

const findings = [];
/* A name split across markup reads normally on screen and is invisible to a
 * plain text search: "proteu<span>auto</span>" renders as one word but matches
 * neither half of a pattern looking for the whole one. Every line is therefore
 * scanned TWICE - once as written, once with the tags stripped out. Found in
 * this repository's own dashboard, where a brand name had been sitting in plain
 * sight through several audits that all reported clean. */
function semTags(linha) {
  return linha.replace(/<[^<>]{0,200}>/g, "");
}

function scanText(text, label) {
  if (isSelf(label)) return;
  text.split(/\r?\n/).forEach((line, i) => {
    let h = hit(line);
    let trecho = line;
    if (!h) {
      const achatada = semTags(line);
      if (achatada !== line) {
        h = hit(achatada);
        if (h) trecho = achatada + "   [found with the markup stripped]";
      }
    }
    if (h) findings.push({ where: `${label}:${i + 1}`, why: h.why, excerpt: trecho.trim().slice(0, 90) });
  });
}

/* ---------------- run ---------------- */

console.log("self-test");
const { bad, total } = selfTest();
if (bad) {
  console.error(`\nSCANNER IS BROKEN (${bad} of ${total} expectations failed). Not publishing.`);
  process.exit(2);
}
console.log(`  ${FORBIDDEN.length} patterns · ${total} expectations · all correct\n`);

if (!priv.configured) {
  console.log("NOTE: no .private-terms.json found, so only credential patterns are active.");
  console.log("      Your own names, clients and project names are NOT being checked.");
  console.log("      Copy tools/private-terms.example.json to .private-terms.json to enable them.\n");
}

const tracked = trackedFiles() || [];
for (const f of tracked.filter((x) => !BINARY.has(extname(x).toLowerCase()))) {
  let t; try { t = readFileSync(f, "utf8"); } catch { continue; }
  scanText(t, relative(ROOT, f));
}
console.log(`working tree: ${tracked.length} tracked file(s)`);

const loose = untrackedNotIgnored().filter((x) => !BINARY.has(extname(x).toLowerCase()));
for (const f of loose) {
  let t; try { t = readFileSync(f, "utf8"); } catch { continue; }
  scanText(t, `untracked ${relative(ROOT, f)}`);
}
if (loose.length) console.log(`untracked but not ignored: ${loose.length} file(s) — a git add -A would publish these`);

let blobCount = 0;
if (SCAN_HISTORY) {
  const seen = new Set();
  for (const { sha, path } of historyBlobs()) {
    if (seen.has(sha)) continue;
    seen.add(sha);
    let t;
    try {
      t = execFileSync("git", ["-C", ROOT, "cat-file", "-p", sha],
        { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    } catch { continue; }
    blobCount++;
    scanText(t, `history ${sha.slice(0, 8)} ${path}`);
  }
  console.log(`git history: ${blobCount} blob(s) across all commits`);
} else {
  console.log("git history: SKIPPED (--tree-only)");
}

if (findings.length) {
  console.log(`\nLEAKS FOUND: ${findings.length}\n`);
  for (const f of findings.slice(0, 60)) {
    console.log(`  ${f.where}  (${f.why})`);
    console.log(`      ${f.excerpt}`);
  }
  if (findings.length > 60) console.log(`  ... and ${findings.length - 60} more`);
  const inHistory = findings.filter((f) => f.where.startsWith("history "));
  console.log("\nDO NOT PUBLISH. Public history is permanent.");
  if (inHistory.length) {
    console.log(`${inHistory.length} finding(s) are in git HISTORY: editing the file is not enough.`);
  }
  process.exit(1);
}

console.log(SCAN_HISTORY
  ? "\nCLEAN - nothing found in the working tree or in git history."
  : "\nTREE CLEAN - but history was NOT scanned. This is NOT clearance to publish.");
process.exit(0);
