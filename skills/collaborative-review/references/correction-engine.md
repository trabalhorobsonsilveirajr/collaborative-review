# The correction engine (Phase 5)

How "a reviewer finished" becomes "the corrections are applied". The execution steps
themselves live in `assets/engine-protocol.tmpl.md`, which is the prompt the headless run
receives. This file describes the machinery around those steps, and
`references/quality-gate.md` describes what guards them.

## Overview

```
CREATION                 REVIEW                      AUTOMATIC CORRECTION
────────                 ──────                      ────────────────────
page approved            reviewers comment           scheduler, every 10 to 15 min
   │ (phase 1 gate)      (text or audio,               └─ watcher (lightweight):
   ▼                      per section)                     locked? exit
skill injects the kit       │                              new conclusions? take lock
   │                        ▼                              invoke the engine
   ▼                    reviewer clicks                      │
publish the link        "I finished my review"               ▼
   │                        │ insert type=conclusion    one reviewer per run:
   ▼                        ▼                           compile and transcribe
materials registry      FIFO queue by created_at        → deduplicate
(project, material)                                     → classify
 → folder, HTML,                                        → POINTWISE: quality gate
   deploy command                                       → STRUCTURAL: queue for owner
                                                        → commit, republish, unlock
```

## The parts

| Part | What it is | What it does |
|---|---|---|
| Scheduler | An OS scheduled task | Fires the watcher every 10 to 15 minutes, even when nobody is logged in |
| Watcher | A lightweight script, one **per machine**, instantiated from `scripts/watcher.tmpl.ps1` | Detects a new conclusion, takes the lock, invokes the engine. It corrects nothing itself |
| Engine | Claude Code running headless, with tool permissions pre-allowed | Executes the protocol for **one** conclusion |
| Protocol | `assets/engine-protocol.tmpl.md` | The steps. The watcher's prompt points at the file on disk rather than inlining it, which avoids command-line length limits and escaping problems |
| Materials registry | Your registry JSON file | Maps project and material to a folder, an HTML file, a publish command, and a branch. Without it the watcher does not know **where** to apply anything |

Rules the watcher honors:

- It writes its own PID file and **never kills a process by name.** On a machine running
  several projects, matching by a generic script name terminates a neighbor's work
  silently. Identify by PID or by a signature unique to this tool.
- A fresh lock, under an hour old, means skip this material. A stale lock is removed with
  a warning, since it indicates a previous crash.
- At most one conclusion per material per tick, oldest first. Always serial.
- An empty tick logs nothing. A watcher that writes a line every ten minutes trains you
  to stop reading its log.
- The password never appears in a log, a prompt, or a command line. The engine receives
  the **path** to the password file, not its contents.

## Local state, per project

| File | Format | Contents |
|---|---|---|
| `ledger.jsonl` | One JSON per line, append-only, last line per id wins | Watcher rows and engine rows. Status is one of pending, processing, applied, awaiting structural approval, or error |
| `changelog-applied.jsonl` | One JSON per line, written **immediately** per applied item | What was changed, by whom, in which section, with a natural-language summary. Written per item so a crash cannot lose the record of what already landed. The summary is what deduplication compares between reviewers |
| `structural-gate/<reviewer>-<timestamp>.md` | Markdown, one per structural batch | The owner's decision queue: the raw request, why it is structural, and a concrete proposal that can be decided in seconds |
| `lock` | Single JSON | Presence means a run is in progress |
| `backups/` | Timestamped copies | The file before each batch, independent of version control |

## Classification

- **Pointwise**, applied automatically: content **inside** a section (wording, typos,
  tone, terminology, a wrong fact), small visual tweaks within the existing pattern,
  metadata, reordering items **within** a list.

- **Structural**, stops and asks: creating, removing, reordering, or renumbering
  **sections** (which breaks the link between feedback and section), layout and
  architecture, navigation, logic and scripts, the review kit itself, the backend
  integration, redesigns, anything contradicting the project's own recorded decisions, or
  a new global terminology.

- **When in doubt, structural.** The bias is deliberate and it is cheap: asking costs
  minutes, a wrong automatic edit costs a material.

Deduplication runs **before** classification. Already handled means skip and record.
Partially handled means apply only the difference. Conflicting with something already
applied makes it structural, because two reviewers disagreeing is a human decision.

## Batch routes

| Batch | Route | Detail |
|---|---|---|
| Normal (anything visual, or four or more items) | **Full quality gate** | Isolated copy, mechanical scope check, unanimous critics, atomic promotion. See `references/quality-gate.md` |
| Tiny (one to three text-only items) | **Light route** | Still isolated and still scope-checked, but with a single reviewing pass instead of a full panel. Proportionate, not lax |
| Structural, after the owner approved it | **Full quality gate, always** | A change to the skeleton deserves the strongest check available |

Two rules that do not bend:

- **A rejected batch is never promoted.** It goes to the owner's queue with the reason.
  Fail closed on quality: when in doubt, do not publish.
- **The loop never stalls waiting.** If a batch cannot be resolved, it is set aside with
  its reason recorded and the queue moves on. Stalled automation gets switched off, and
  switched-off automation protects nobody.

## Multiple reviewers

- First in, first out, always serial, re-reading the current file each time.
- A pending structural decision does **not** block pointwise fixes from later reviewers.
- A structural item approved late: the engine re-reads the file's current state,
  reconciles, and flags whether the change invalidated an earlier pointwise fix.
- The file in `structural-gate/` is the source of truth for decisions. The dashboard's
  pending-decisions tab is a convenience on top of it, not a replacement.

## Scheduling the watcher

Schedule it every 10 to 15 minutes with these properties:

| Property | Why |
|---|---|
| Start when available | If the machine was off, missed runs are recovered rather than skipped forever |
| Do not stop on idle end | Otherwise it dies the moment someone touches the keyboard |
| Ignore new instances | Never two watchers at once. The PID file is the second belt, for manual triggers |
| Allow start on battery, do not stop on battery | Otherwise it silently never runs on a laptop |
| Execution time limit, 30 to 60 minutes | This is what kills a hung headless run. The orphaned lock it leaves is cleaned by staleness on the next tick |
| Run whether the user is logged on or not | Otherwise it only works while someone is watching, which defeats the purpose |

A machine that is off is fine: the queue waits and processes on the next boot. Verify
with a real manual trigger, not just by reading the schedule back.
