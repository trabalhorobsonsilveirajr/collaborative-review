# Contributing

Thanks for looking. This page has two halves: how the project expects changes to be
made, and a list of what it is missing, written plainly so you can pick something up
without having to guess where the gaps are.

## Running the checks

```bash
npm test
```

Thirteen checks. They need Node 18 or newer. One of them needs PowerShell 7, and it
is skipped elsewhere. None of them need a network, an account, or a backend.

To see the thing actually working, with no account and no setup:

```bash
npm run demo
```

That serves a real page with the kit injected, a real dashboard, and an in-memory
backend. Password `demo`.

## The one rule that matters here

**A check that has never failed has not been tested.**

Before a verifier is trusted, it has to be run against the broken state it exists to
catch, and it has to go red. This is not a style preference. Every verifier in this
repository has, at some point, reported "clean" while the exact defect it was written
for sat in the code:

* the leak scanner reported clean while a brand name sat in the dashboard, because
  the name was split across an HTML tag and no plain text search could see it
* the language checker reported "no Portuguese" against a file containing
  "Terminou de revisar?" and "Enviando...", because it used a fixed word list, and no
  list covers a language
* the payload type checker reported ok with the defect deliberately put back, because
  it stopped at an unresolved import and never reached the code it was checking

So verifiers here test themselves before they look at anything, and refuse to run when
their own detection is wrong. If you add one, do the same. If you change one, prove it
still goes red.

The same applies to the quality gate. `scripts/gate.mjs` has twenty-one self-test cases
and nine guards, and `tools/prove-gate-teeth.mjs` disables each guard in turn and
requires the suite to fail. A guard that cannot be shown to fail is decoration.

## Adding a language

This is the smallest useful contribution, and it needs no knowledge of the rest.

1. Copy `skills/collaborative-review/assets/i18n/en.json` to your language code,
   for example `de.json` or `ja.json`. Use the BCP 47 tag: `pt-BR`, not `pt_br`.
2. Translate the values. Leave the keys alone.
3. Set `_meta.language` to how your language writes its own name. That string is what
   appears in the dashboard's language menu, so `Deutsch`, not `German`.
4. Run `node tools/check-i18n.mjs .`

**A partial translation is welcome.** Any key you leave out falls back to English on
its own, key by key, so a half-finished file still ships a working interface. There is
no need to do all ninety strings before opening a pull request.

Nothing else has to change. The dictionaries are discovered by reading the folder, and
the language menu builds itself from what it finds.

Two things to know while translating:

* Values may contain `<b>` and `<strong>`. Keep the tags, translate around them.
* Never translate a value that is stored in the database. There are none in the
  language files, and there is a check that keeps it that way.

## Where help is wanted

Ordered by how much difference it would make. Sizes are honest estimates, not promises.

### 1. A portable watcher (large)

**The problem.** Collecting feedback works on any operating system. Applying the
approved corrections automatically does not: the watcher is a PowerShell script driven
by Windows Task Scheduler, and it reads process state through a Windows-only interface.
On macOS or Linux you can collect feedback and apply corrections by hand, but the
unattended loop, which is the most distinctive thing this project does, is out of reach.

**What it involves.** The watcher does five things: read the material registry, hold a
lock so two runs cannot overlap, ask the backend for approved gates, invoke the agent,
and record the outcome in a ledger. Four of those are ordinary file and HTTP work. The
one that is genuinely platform-bound is deciding whether the process holding the lock is
still alive.

`skills/collaborative-review/scripts/watcher.tmpl.ps1` is the reference, and its
comments explain why each part is the way it is, including several defects that shaped
it. `sync-approvals.test.ps1` is a closed-world test suite for the module it calls: 45
cases, no network, no backend. A port should aim for the same.

Scheduling would be the caller's business: cron, launchd, systemd timers, or a
long-running process. The watcher itself should not care.

### 2. A shorter path to the first comment (large, needs a design decision first)

**The problem.** Setup is six steps: create a backend project, run the schema, deploy
four server functions, configure a storage bucket, wire the dashboard, and optionally
schedule the watcher. Between thirty and sixty minutes before anyone sees a single
comment. `npm run demo` exists precisely because that gap is too wide, but a demo is
not the product.

**What it involves.** Deciding where feedback can live without a hosted database, and
whether that mode is a first-class path or a starting point people graduate from. A
local file, SQLite, or a single-file server are all plausible. This is a design
question before it is a coding one, so open an issue and argue for an approach before
writing much.

### 3. Real-world reports (small, and the most valuable thing on this list)

**The problem.** This has been used by one person. Everything here has been verified
internally, which catches a certain kind of mistake and is blind to another: the parts
that are confusing, the assumptions that only hold on the machine it was built on, the
step where someone gives up.

If you install this and something is unclear, wrong, or broken, an issue saying so is
worth more than most patches. Especially the boring parts: a command that failed, a
step whose wording did not match what you saw, a screen that looked wrong.

### 4. Making the gate the authority (medium)

**The problem.** Today the agent is told which sections it may touch, and the gate
verifies afterwards that it stayed inside them. That works, and it is enforced byte for
byte. But the boundary is still computed by the same party that has to respect it.

**What it involves.** Moving the scope calculation into the watcher, which already
reads the section manifest and the database. The agent would receive the boundary
rather than derive it, and become an executor of edits instead of the judge of its own
limits. The manifest already carries a SHA-256 of the document, so the pieces exist.

### 5. Accessibility of the review kit (medium)

**The problem.** The kit has never been tested with a screen reader. Reviewers include
people who use one, and this is the surface they interact with.

The kit already uses `role="status"` and `aria-live` for the send feedback, which is a
start and not a substitute for testing. Keyboard-only operation of the recorder, the
focus order after a section is submitted, and the announcements when the language
changes are all unverified.

### 6. The last Portuguese names (small, mechanical)

`node tools/check-artifacts.mjs . --advisory` lists twenty-six identifiers that are
still in Portuguese. None of them cross a file boundary and none are contract, so they
can be renamed in isolation. Good first change if you want to see the test suite run
before touching anything that matters.

## Opening a pull request

* `npm test` passes.
* If you fixed a defect, there is a case that fails without your fix. State in the
  description how you confirmed it fails, not just that it passes now.
* If you changed a verifier, say how you proved it still catches what it is for.
* Commit messages explain why, not what. The diff already says what.

## What is deliberately not here

Some absences are decisions, not oversights:

* **No build step, no bundler, no framework.** The kit is injected into someone else's
  page and has to survive contact with whatever is already there.
* **No dependencies in the skill itself.** It runs with plain Node. The only packages
  in `package.json` are for running checks.
* **The password is not a user account system.** It is one shared secret for a small
  team looking at their own materials. `SECURITY.md` says what that does and does not
  protect, and points at what to do if you need more.
