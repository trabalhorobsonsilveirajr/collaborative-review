# collaborative-review

**A Claude Code skill that turns any HTML page into a reviewable document, collects
per-section feedback by text and voice, and then applies the corrections itself, behind
a quality gate that refuses to promote work it cannot vouch for.**

Most feedback tools stop at collecting comments. Someone still has to read them, decide
what they mean, and edit the file by hand. This skill closes that loop, and the
interesting part is not the automation. It is what keeps the automation honest.

## See it work in two minutes

No account, no SQL, no deploy. This stands up a throwaway backend in memory,
injects the real review kit into a real page, and serves both:

```bash
npm run demo
```

Then open the two links it prints: the page a reviewer would get, and the
dashboard you would get. Comment on a section, hit send, and watch the comment
arrive in your terminal.

Everything lives in a temporary folder and is removed when you stop it. Nothing
leaves your machine.

The correction engine is not part of the demo — it needs Claude Code, a scheduled
task and Windows. To watch the gate itself refuse an edit that strayed outside
its lane, run `npm run test:gate`.

## The problem

You send a landing page to three people for review. One replies in a chat thread, one
sends a voice message, one marks up a PDF. You now hold feedback in three formats,
scattered across sections, some of it contradictory. Merging it by hand takes longer
than writing the page did.

Automating that merge is easy and dangerous. An agent editing a client-facing page from
loose instructions will, sooner or later, rewrite a paragraph nobody asked it to touch.

## How it works

```
reviewer opens the link
        ↓
comments and voice notes, attached per section
        ↓
clicks "I finished my review"
        ↓
triage: pointwise fix  ·  structural change
        ↓                        ↓
   quality gate            owner decides
        ↓
promoted, or refused with a reason
```

**Pointwise** fixes (wording, a typo, a wrong number, an unclear sentence) go through the
gate automatically. **Structural** changes (layout, section order, navigation, adding or
removing sections) always stop and wait for a human. When classification is uncertain,
it is treated as structural. That bias is deliberate.

## The quality gate

This is the part worth reading even if you never install the skill.

Every automatic correction passes through four checks, and any one of them can refuse:

1. **Isolation.** The fix is applied to a copy. The live file is not touched until the
   very last step.

2. **Mechanical scope check.** A script verifies that sections outside the agreed scope
   are byte-identical, that no section vanished, that the document did not shrink
   suspiciously, and that something actually changed. This part cannot be argued with.

3. **Unanimous critics.** Independent reviewers examine the fix without knowing what the
   others concluded, and without being told it is expected to pass. One reasoned
   objection sends the batch back.

4. **Promotion requires a verdict.** The promote step refuses without a passing check,
   and refuses again if the copy was edited after that check. Editing after verification
   invalidates the verification.

If the cycle cannot satisfy the critics within its round limit, nothing is promoted. It
reports what was attempted and what each critic objected to. It does not quietly promote
the best attempt.

**Verify the gate before you trust it:**

```bash
node skills/collaborative-review/scripts/gate.mjs selftest
```

Twelve cases run: fixes that must be refused, promotions that must be blocked, and clean
fixes that must be allowed. It tests both directions on purpose, because a gate that
refuses everything would pass a refusal-only test suite while being useless.

## Requirements

This skill has two halves, and they do not have the same requirements. Read this
before investing time in the setup.

**Collecting feedback works anywhere.** The review kit is plain HTML and JavaScript,
the dashboard is a static page, and the backend is hosted. Any operating system.

**Applying corrections automatically is Windows-only today.** The watcher that wakes
the engine is a PowerShell script scheduled through Task Scheduler, and it reads
process information through a Windows-only interface. On macOS or Linux you can still
collect feedback and apply the corrections by hand; you cannot run the unattended
loop. A portable watcher is the most requested thing this project does not have yet,
and contributions are welcome.

| | | |
|---|---|---|
| [Claude Code](https://claude.com/claude-code) | Runs the skill | any OS |
| Node.js 18+ | The gate and the kit builder | any OS |
| A [Supabase](https://supabase.com) project | Stores feedback and audio. The free tier is enough | any OS |
| Git in the target project | So a correction can always be undone | any OS |
| **Windows 10/11 + PowerShell 7** | **The watcher, for the unattended loop only** | **Windows only** |
| Python 3 and a transcription API key | Optional, only for voice feedback | any OS |

## Install

```bash
git clone https://github.com/trabalhorobsonsilveirajr/collaborative-review.git
cp -r collaborative-review/skills/collaborative-review ~/.claude/skills/
```

Then set up the backend. **This is not optional, and it is where people get stuck:** the
skill needs somewhere to store feedback, and that has to be your own project.
[SETUP.md](SETUP.md) walks through it, roughly fifteen minutes.

Verify the gate afterwards with the selftest command above. If it does not pass, do not
use the skill on real work.

## Usage

Ask Claude Code, in your own words:

> open the landing page in `site/index.html` for review

The skill runs seven phases, stopping for your approval at each gate: detect the target,
confirm the draft is approved, inject the kit, provision or reuse the backend, publish
and verify end to end, activate the correction engine, and close the final version.

When the review is done, one flag removes the kit and the page ships clean. Nothing is
left behind in the HTML.

## What it will not do

- Inject the review kit before you approve the draft.
- Apply a structural change without asking you.
- Promote a correction its critics rejected.
- Read feedback in the browser. Anonymous visitors can only write; reading requires a
  password through a server function.
- Commit secrets. The versioned SQL carries placeholders, never real keys.

## Repository layout

```
skills/collaborative-review/
├── SKILL.md                  the guide Claude follows
├── references/               detail per phase, read on demand
│   ├── quality-gate.md       the gate protocol and its failure modes
│   ├── provision-backend.md  three backend situations, step by step
│   └── ...
├── assets/
│   ├── review-kit.tmpl.html  the kit injected into the page
│   ├── dashboard.tmpl.html   where feedback is read and decisions are made
│   ├── sql/                  schema, security policies, storage
│   └── edge-functions/       four server functions
└── scripts/
    ├── gate.mjs              the mechanical half of the gate (self-testing)
    └── build-kit.mjs         parameterizes and injects the kit
```

## Design notes

A few decisions that took a while to get right, in case they save you the same trouble:

**The gate's refusal has to hold the door shut.** An early version had a check that
reported failures and a promote step that ignored them. The check said no and the file
changed anyway. A verdict that does not bind is decoration, so promote now refuses
without a recorded passing verdict, and refuses again if the working copy moved after it.

**Critics must not share context.** A critic told that a fix is expected to pass will
agree with it. They are dispatched independently, every round.

**A mechanical pass is not approval.** The script proves an edit stayed in its lane. It
has no opinion on whether the edit is any good. Reporting one as the other is how bad
work ships with a green checkmark on it.

**Test the verifier itself.** The gate runs its own self-test against cases it must
refuse and cases it must allow, and exits non-zero if either list fails. Run it before
you trust it: `node skills/collaborative-review/scripts/gate.mjs selftest`. A verifier
nobody verified grants permission it never earned, and this one was caught doing exactly
that during development: an early version promoted a fix that its own check had already
rejected, because the check and the promotion were separate.

## License

MIT. See [LICENSE](LICENSE).

## Contributing

Issues and pull requests are welcome. If you change anything in `scripts/gate.mjs`, the
self-test must still pass, and new failure modes should get new cases in it.
