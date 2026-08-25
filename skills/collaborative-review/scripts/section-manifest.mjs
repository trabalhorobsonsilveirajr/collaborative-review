#!/usr/bin/env node
/**
 * section-manifest.mjs — finds the reviewable sections of a page and writes down
 * exactly what they are.
 *
 * WHY THIS EXISTS. The quality gate has to know which parts of a document may be
 * edited and which may not. Until now, that list was supplied by the very agent
 * the gate was meant to contain, on the command line. An audit defeated the gate
 * in four commands by simply declaring different markers: pass the body tags as
 * if they were sections, and the whole document becomes "inside the lane".
 *
 * A boundary drawn by the thing being contained is not a boundary.
 *
 * So the list stops being an argument and becomes a FACT, established once when
 * the review kit is injected, recorded on disk, and checked by hash afterwards.
 *
 * TWO DESIGN DECISIONS worth knowing:
 *
 * 1. Each section gets an explicit marker attribute written into it. We do not
 *    hunt for whatever identifier a section happens to have, because an existing
 *    id can appear elsewhere in the page (a nav menu links to it, for one) and an
 *    ambiguous marker is how the gate fell the first time. An attribute this tool
 *    writes is unique by construction.
 *
 * 2. The selector support is deliberately small: tag, .class, tag.class, and
 *    [attribute]. Anything else is REFUSED, loudly, with the reason. Guessing at
 *    a selector this tool does not really understand would produce a manifest
 *    that looks right and maps the wrong regions, which is worse than no manifest.
 *
 * Exit codes: 0 = ok · 1 = refused · 2 = misuse
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const MARKER_ATTR = "data-review-section";

/* ------------------------------------------------------------------ *
 * Selector support, kept small on purpose.
 * ------------------------------------------------------------------ */

export function parseSelector(selector) {
  const s = String(selector || "").trim();
  if (!s) return { ok: false, why: "empty selector" };

  /* Refuse anything that implies structure we do not parse. Listing the reason
   * matters: a user who sees "unsupported" with no explanation guesses, and a
   * guess here silently maps the wrong part of the document. */
  const unsupported = [
    [/[>+~]/, "combinators (>, +, ~) are not supported"],
    [/,/, "selector lists (a, b) are not supported: use one selector"],
    [/:/, "pseudo-classes and pseudo-elements are not supported"],
    [/\s/, "descendant selectors (space) are not supported"],
    [/\*/, "the universal selector is not supported"],
  ];
  for (const [re, why] of unsupported) {
    if (re.test(s)) return { ok: false, why };
  }

  let m;
  if ((m = s.match(/^([a-z][a-z0-9]*)?\.([A-Za-z_][\w-]*)$/))) {
    return { ok: true, kind: "class", tag: m[1] || null, value: m[2] };
  }
  if ((m = s.match(/^\[([A-Za-z_][\w-]*)\]$/))) {
    return { ok: true, kind: "attr", tag: null, value: m[1] };
  }
  if ((m = s.match(/^([a-z][a-z0-9]*)$/))) {
    return { ok: true, kind: "tag", tag: m[1], value: m[1] };
  }
  if (/^#/.test(s)) {
    return { ok: false, why: "an id selector matches one element; sections need a selector that matches several" };
  }
  return { ok: false, why: `selector shape not recognised: ${s}` };
}

/* ------------------------------------------------------------------ *
 * Finding the opening tags that match.
 *
 * This is not a full HTML parser and does not pretend to be. It finds opening
 * tags and decides whether each matches the selector. That is enough to place a
 * marker attribute, and anything it cannot do confidently it refuses.
 * ------------------------------------------------------------------ */

export function findSectionTags(html, sel) {
  const tagRe = sel.tag
    ? new RegExp(`<${sel.tag}\\b([^>]*)>`, "gi")
    : /<([a-z][a-z0-9]*)\b([^>]*)>/gi;

  const hits = [];
  let m;
  while ((m = tagRe.exec(html))) {
    const attrs = sel.tag ? m[1] : m[2];
    let matches = false;
    if (sel.kind === "tag") {
      matches = true;
    } else if (sel.kind === "class") {
      const cm = attrs.match(/\bclass\s*=\s*["']([^"']*)["']/i);
      matches = !!cm && cm[1].split(/\s+/).includes(sel.value);
    } else if (sel.kind === "attr") {
      matches = new RegExp(`\\b${sel.value}\\b\\s*(=|>|\\s|$)`, "i").test(attrs);
    }
    if (matches) {
      hits.push({ start: m.index, end: m.index + m[0].length, attrs, raw: m[0] });
    }
  }
  return hits;
}

/* ------------------------------------------------------------------ *
 * Writing the markers and building the manifest.
 * ------------------------------------------------------------------ */

export function buildManifest(html, selector, { material = "", project = "" } = {}) {
  const sel = parseSelector(selector);
  if (!sel.ok) {
    return { ok: false, why: `cannot use this section selector: ${sel.why}` };
  }

  const hits = findSectionTags(html, sel);
  if (hits.length === 0) {
    return { ok: false, why: `the selector "${selector}" matched no element in this page` };
  }
  if (hits.length === 1) {
    return {
      ok: false,
      why: `the selector "${selector}" matched only one element. With a single ` +
        `section there is nothing outside the scope to protect, so the gate would ` +
        `guarantee nothing. Use a selector that matches each reviewable section.`,
    };
  }

  /* Already marked? Re-marking would produce duplicate attributes and an
   * ambiguous document, which is exactly what the gate cannot cope with. */
  if (html.includes(MARKER_ATTR)) {
    return {
      ok: false,
      why: `this page already contains ${MARKER_ATTR} markers. Re-running would ` +
        `duplicate them. Restore the pre-kit backup first.`,
    };
  }

  let out = "";
  let cursor = 0;
  const sections = [];
  hits.forEach((hit, i) => {
    const id = `s${i + 1}`;
    const marker = `${MARKER_ATTR}="${id}"`;
    const opening = hit.raw.replace(/>$/, ` ${marker}>`);
    out += html.slice(cursor, hit.start) + opening;
    cursor = hit.end;
    sections.push({ id, marker, order: i + 1 });
  });
  out += html.slice(cursor);

  const manifest = {
    format: "collaborative-review/section-manifest@1",
    project,
    material,
    selector,
    marker_attribute: MARKER_ATTR,
    /* The hash of the document AS MARKED. If the page is edited outside the
     * cycle, the gate notices the manifest no longer describes it. */
    document_sha256: createHash("sha256").update(out, "utf8").digest("hex"),
    sections,
  };
  /* The manifest signs itself, so tampering with the section list is detectable
   * without needing a secret. This does not stop someone determined; it stops the
   * list from drifting silently, which is the failure that actually happens. */
  manifest.manifest_sha256 = createHash("sha256")
    .update(JSON.stringify({ ...manifest, manifest_sha256: undefined }), "utf8")
    .digest("hex");

  return { ok: true, html: out, manifest };
}

export function verifyManifest(manifest) {
  if (!manifest || typeof manifest !== "object") return { ok: false, why: "not an object" };
  if (manifest.format !== "collaborative-review/section-manifest@1") {
    return { ok: false, why: `unknown manifest format: ${manifest.format}` };
  }
  const claimed = manifest.manifest_sha256;
  const actual = createHash("sha256")
    .update(JSON.stringify({ ...manifest, manifest_sha256: undefined }), "utf8")
    .digest("hex");
  if (claimed !== actual) {
    return { ok: false, why: "manifest hash does not match its contents: it was edited after being written" };
  }
  if (!Array.isArray(manifest.sections) || manifest.sections.length < 2) {
    return { ok: false, why: "a manifest needs at least 2 sections to be useful" };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * Self-test — both directions.
 * ------------------------------------------------------------------ */

function selfTest() {
  let pass = 0, fail = 0;
  const bad = [];
  const check = (label, cond) => { if (cond) pass++; else { fail++; bad.push(label); } };

  /* selectors that must be refused, each for a stated reason */
  for (const s of ["div > p", ".a, .b", "div:first-child", "div p", "*", "#only-one", ""]) {
    check(`refuses selector ${JSON.stringify(s)}`, !parseSelector(s).ok);
  }
  /* selectors that must work */
  for (const s of [".step", "section", "section.step", "[data-review]"]) {
    check(`accepts selector ${JSON.stringify(s)}`, parseSelector(s).ok);
  }

  const page = [
    "<html><head><title>T</title></head><body>",
    "<nav><a href='#one'>One</a><a href='#two'>Two</a></nav>",
    '<section class="step" id="one"><p>First.</p></section>',
    '<section class="step" id="two"><p>Second.</p></section>',
    '<section class="step" id="three"><p>Third.</p></section>',
    "<footer>Footer text.</footer>",
    "</body></html>",
  ].join("\n");

  const r = buildManifest(page, ".step", { material: "M", project: "P" });
  check("builds a manifest from a normal page", r.ok);
  check("finds all three sections", r.ok && r.manifest.sections.length === 3);
  check("markers are unique in the document", r.ok &&
    r.manifest.sections.every((s) => r.html.split(s.marker).length === 2));
  check("the nav menu does not become a section", r.ok &&
    !r.html.slice(0, r.html.indexOf("<section")).includes(MARKER_ATTR));
  check("manifest verifies against itself", r.ok && verifyManifest(r.manifest).ok);

  /* the very failure that motivated this file */
  const tampered = r.ok ? JSON.parse(JSON.stringify(r.manifest)) : null;
  if (tampered) {
    tampered.sections.push({ id: "s99", marker: 'data-review-section="s99"', order: 99 });
    check("detects a manifest edited after the fact", !verifyManifest(tampered).ok);
  }

  const onlyOne = buildManifest('<div class="solo">x</div>', ".solo");
  check("refuses a page with a single section", !onlyOne.ok);

  const none = buildManifest("<p>nothing here</p>", ".step");
  check("refuses when the selector matches nothing", !none.ok);

  const twice = r.ok ? buildManifest(r.html, ".step") : { ok: true };
  check("refuses to mark an already-marked page", !twice.ok);

  console.log("self-test");
  console.log(`  passed: ${pass}`);
  console.log(`  failed: ${fail}`);
  for (const b of bad) console.log(`  · ${b}`);
  return fail === 0 ? 0 : 1;
}

/* ------------------------------------------------------------------ */

const isMain = process.argv[1] && process.argv[1].endsWith("section-manifest.mjs");
if (isMain) {
  const cmd = process.argv[2];
  if (cmd === "selftest") {
    process.exit(selfTest());
  }
  if (cmd === "build") {
    const args = process.argv.slice(3);
    const get = (n) => {
      const i = args.indexOf(`--${n}`);
      return i === -1 ? null : args[i + 1];
    };
    const file = get("file");
    const selector = get("selector");
    if (!file || !selector) {
      process.stderr.write("usage: section-manifest.mjs build --file <html> --selector <css> [--out <json>]\n");
      process.exit(2);
    }
    if (!existsSync(file)) {
      process.stderr.write(`file does not exist: ${file}\n`);
      process.exit(2);
    }
    const html = readFileSync(file, "utf8");
    const r = buildManifest(html, selector, {
      material: get("material") || "",
      project: get("project") || "",
    });
    if (!r.ok) {
      process.stderr.write(`refused: ${r.why}\n`);
      process.exit(1);
    }
    writeFileSync(file, r.html, "utf8");
    const out = get("out") || file.replace(/\.html?$/i, "") + ".sections.json";
    writeFileSync(out, JSON.stringify(r.manifest, null, 2), "utf8");
    process.stdout.write(
      `marked ${r.manifest.sections.length} sections\n` +
      `  page     : ${file}\n` +
      `  manifest : ${out}\n`
    );
    process.exit(0);
  }
  process.stderr.write("usage: section-manifest.mjs <build|selftest> [options]\n");
  process.exit(2);
}
