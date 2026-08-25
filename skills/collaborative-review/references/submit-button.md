# The submit button: "I finished my review"

The piece that connects a human review to the automatic correction engine. It lives
inside the kit template (`assets/review-kit.tmpl.html`, function `makeFinalWrap`) rather
than as a separate asset, and is injected once, right after the general comment block
that follows the last section. It reuses the kit's name helpers and CSS.

## What it writes

An insert into the `feedbacks` table, through the same anonymous route as comments:

```json
{
  "reviewer_name": "<reviewer name, from local storage>",
  "section": "Review conclusion",
  "comment": "<final note typed by the reviewer> OR 'Review completed by the reviewer.'",
  "project": "<PROJECT>",
  "material": "<MATERIAL>",
  "type": "conclusion",
  "user_agent": "<navigator.userAgent, truncated to 300 chars>"
}
```

Three things about this row matter:

- **`type: "conclusion"` is the signal.** It is what the watcher looks for. A column
  rather than a separate table, so a conclusion is just another feedback row and the
  dashboard renders it with everything else.
- **The default comment text exists to satisfy a database constraint.** The security
  policy requires either text or audio on every row, and the final note is optional, so a
  reviewer who clicks the button without typing anything still produces a valid row.
- **The section is fixed** to "Review conclusion", which lets the dashboard group it and
  promote that group to the top.

## Required behavior

| Behavior | How it is implemented |
|---|---|
| Requires a name | Scrolls to the name field at the top, focuses it, shakes it, and shows a message |
| Double-click lock | The handler returns early if the button is disabled, and disables it before the request |
| Screen reader feedback | A status element with `role="status"` and `aria-live="polite"` announces sending, success, and failure |
| Success | Saves to local storage, the button becomes "Review complete" and is disabled, the textarea is disabled, the status turns green |
| Failure, HTTP or network | Re-enables the button and shows a retry message, so the reviewer is never stuck |
| Re-submission guard | A local storage key per project and material. On reload, the block renders already locked with "Your review has already been recorded" |
| Printing | The wrapper is inside the kit's print rules, so it disappears from the PDF |

**Known limitation:** the re-submission guard is per browser. The same reviewer on two
devices produces two conclusion rows. The engine processes each row id separately, and
deduplication against the applied-changes log prevents the same suggestion being applied
twice.

## How the watcher uses the signal

The real flow, implemented in `scripts/watcher.tmpl.ps1`:

1. On each tick, the watcher calls `read-feedback` filtered by the registered material's
   project and material, and separates rows where the type is a conclusion.

2. It cross-references each conclusion id against the **local ledger**, an append-only
   journal where the last line for a given conclusion wins:

   - In-flight statuses (applied, processing, awaiting structural approval) mean the
     conclusion is already handled or being handled. Skip it.
   - No record, pending, or error counts as new. **Error re-enters on purpose**: that is
     the retry mechanism.

3. Among the new ones, it sorts by creation time and processes only the oldest in this
   tick. It takes the lock, writes pending to the ledger, and invokes the engine. The
   rest wait for later ticks. Always serial: never two runs against the same material.

The division of responsibility is deliberate. The database carries only the **signal**,
written by a browser. All processing state is local, in the ledger. That way a network
failure or a database outage cannot corrupt the record of what has already been applied
to your files.
