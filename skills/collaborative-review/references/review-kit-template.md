# The review kit template (assets/review-kit.tmpl.html)

Detail reference for Phase 2. The template is a self-contained block, CSS plus JavaScript
in an immediately-invoked function, with no external dependency. It injects a text
comment field and an audio recorder into every section, plus the "I finished my review"
button at the end.

## The ten placeholders

| Placeholder | Example | Where it comes from |
|---|---|---|
| `SUPABASE_URL` | `https://YOUR_PROJECT_REF.supabase.co` | The backend project chosen in Phase 3 |
| `SUPABASE_ANON_KEY` | The public key | Same project. Public by design: the security policy is what protects the data, since the anonymous role can only insert |
| `PROJECT` | `my-project` | Phase 0. Becomes the `project` column |
| `MATERIAL` | `Onboarding Guide` | Phase 0. Becomes the `material` column |
| `SECTION_SELECTOR` | `.step` | Inspecting the target HTML: the CSS selector for the repeated elements that are the reviewable sections |
| `SECTION_TITLE_SELECTOR` | `h3` | The title **inside** each section, used to build the block label |
| `SECTION_BODY_SELECTOR` | `.step-body` | The element **inside** the section where the comment block is attached |
| `NAME_BAR_ANCHOR` | `.topbar` | The "Your name" bar is inserted right after this element |
| `SECTION_LABEL` | `Step ` (trailing space intentional) | Editorial choice. The kit builds "Step 1: Title" |
| `BUCKET_AUDIO` | `audio-feedback` | The private storage bucket created in Phase 3 |

A complete config example lives in `assets/example-config.json`.

## Choosing selectors for a new page

Before parameterizing, open the target HTML and verify in the browser console:

1. `document.querySelectorAll(SECTION_SELECTOR).length` returns **exactly** the number of
   sections that should get a comment field. Not one more (decorative cards are the usual
   trap), not one less.

2. Inside one section, `sec.querySelector(SECTION_TITLE_SELECTOR)` finds the right title.
   If it does not, nothing breaks: the label falls back to "Step N" without a title.

3. `sec.querySelector(SECTION_BODY_SELECTOR)` points at the section's body. If it does
   not match, the kit uses the section itself. Prefer an explicit body, since the block is
   appended as its last child.

4. `document.querySelector(NAME_BAR_ANCHOR)` finds a single element near the top. Without
   it the name bar lands at the top of `<body>`, which usually looks wrong. Pick a real
   anchor.

5. `SECTION_LABEL` matches the page's own vocabulary: "Step ", "Section ", "Module ".
   Remember the trailing space.

6. No value may contain a double quote, a backslash, a line break, or `</script`. The
   builder rejects them, because these values end up inside JavaScript strings.

## The three invariants, never to regress

Each came from a real production bug. Any future edit to the kit must preserve them.

| # | Invariant | Where | Why |
|---|---|---|---|
| 1 | Validate name and content **before** uploading audio | The send handler: validation runs before the upload call | If the upload happens first and validation then fails, the file is orphaned in storage with no database row pointing at it |
| 2 | The recorder's state machine (idle, opening, recording) with a double-click lock | `makeBlock`, the state variable | Without it, a double click, or a click while the microphone is still opening, creates phantom recorders. The send-on-stop flag makes one click during recording both stop and send |
| 3 | Print rules hide the entire kit | End of the kit stylesheet | The printed material and its PDF come out clean even with the kit active |

The database security policy reinforces invariant 1 on the server side, requiring either
text or audio on every row. Client validation is convenience; the constraint is what
makes it true.

## Using the kit builder

```bash
node scripts/build-kit.mjs --kit assets/review-kit.tmpl.html --config <config.json> --target <page.html>
```

What it guarantees, in order:

1. Collects **every** placeholder in the template and requires the config to cover all of
   them, failing with a list of what is missing. It never injects a half-configured kit.
2. Validates each value: non-empty, and free of the characters that would break the
   injected script.
3. **Refuses re-injection.** If the target already contains the kit, it exits rather than
   nesting a second copy. To re-inject, restore the backup or remove the current block.
4. Backs up the target before touching it.
5. Substitutes, confirms no placeholder survived, and injects immediately before the last
   `</body>`.
6. Writes atomically, through a temporary file and a rename, so an interrupted run cannot
   leave a half-written page.

Exit codes: 0 success, 1 usage or file not found, 2 incomplete config or invalid value,
3 target already has the kit, 4 target has no `</body>`.

After injecting, serve over local HTTP, never `file://`, and check the three invariants
by hand.

## Reviewer name and drafts

Stored in the browser, namespaced so materials do not bleed into each other:

- The reviewer's name is **global** on purpose: typed once, it applies to every material
  in that browser.
- Text drafts are namespaced by project and material, so a draft written on one material
  never appears on another.
- The submit-button lock uses the same namespace.

## Review mode and shipping the final version

`REVIEW_MODE` is the first meaningful line of the kit's script. It is a literal switch:
with it false, the function returns immediately and nothing renders, so the page ships
clean without removing the block.

To close the final version (Phase 6):

1. Set `REVIEW_MODE` to false in the published HTML, or remove the whole block between
   its opening and closing comments.
2. Clean redeploy.
3. Run the `clean-orphans` function to remove audio with no matching database row.
4. Confirm on the live URL that the fields are gone and printing is clean. Check the live
   URL, not the local preview: they are not the same thing, and the difference is exactly
   where this kind of mistake hides.
