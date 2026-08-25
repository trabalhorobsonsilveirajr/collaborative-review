# The quality gate

This is the half of the gate that requires judgment. The other half, the part
that cannot be talked out of a refusal, lives in `scripts/gate.mjs`.

Read both. Neither is sufficient alone: the script proves an edit stayed in its lane
but has no opinion about whether the edit is any good, and critics have opinions but
can be charmed. Applying a reviewer's feedback without both is how a small correction
quietly eats a paragraph nobody was watching.

## The one law

> **Nothing breaks AND the work gets finished. Both, always.**

Three honest outcomes, and only three:

- **Prove it**: verify the fix is sound and promote it.
- **Build the net**: if it cannot be verified directly, construct a way to verify it
  (isolated copy, recorded input, simulation), then verify.
- **Stop and ask**: when neither is possible, hand the decision to a human.

Never guess in the dark. Never refuse to act out of caution alone. A gate that never
promotes anything is as useless as one that promotes everything.

## Triage: what may be fixed automatically

Every reviewer note is one of two things, and getting this boundary wrong is the most
expensive mistake this skill can make.

| | Pointwise | Structural |
|---|---|---|
| What it is | A defect inside one section: wording, a typo, a wrong number, an unclear sentence, a broken link | Anything touching layout, section order, navigation, adding or removing sections, visual identity, or the document's argument |
| Who decides | The gate decides and applies | **The owner decides. Always.** |
| Why | Reversible, bounded, verifiable | Changes the shape of the thing; the reviewer may not have seen the whole picture |

When in doubt, it is structural. Asking the owner costs a few minutes. Guessing wrong
costs the owner a material they will have to rebuild, and worse, their trust that the
gate leaves their work alone.

**Never apply anything before the owner has approved the material for review in the
first place.** External reviewers commenting on a draft nobody signed off on produces
feedback about things that were already going to change.

## The cycle, per batch of pointwise fixes

```
prepare  →  apply  →  check (mechanical)  →  critics  →  promote
              ↑                                   |
              └───────── not unanimous ───────────┘
                         (up to the round limit)
```

1. **prepare**: `gate.mjs prepare` snapshots the live file and opens a working copy.
   From here until promote, the live file is untouchable. Never edit it directly, not
   even for something trivial.

2. **apply**: make the fixes in the working copy only. One batch, one scope: the list
   of sections the reviewers actually commented on.

3. **check**: `gate.mjs check --scope <sections>`. This is mechanical and absolute:
   sections outside the scope must be byte-identical, no section may vanish, the
   document may not shrink suspiciously, and something must actually have changed. A
   refusal here is not negotiable. Fix the edit, do not argue with the script.

4. **critics**: dispatch independent reviewers (subagents). Each one gets the
   reviewer's original note, the before and after of the section, and nothing else.
   They must not be told what previous critics concluded, and must not be told that a
   fix is expected to pass. Each returns a verdict and a reason.

   Ask each critic to answer, in order:

   - Does this actually address what the reviewer asked for, or does it merely look
     like a change?
   - Did it break anything that was working, such as meaning, tone, formatting, a link, a
     number that appears elsewhere?
   - Did it introduce a new problem the reviewer did not mention?
   - Would you sign your name under sending this to the client?

   **Unanimity is required.** Any single critic rejecting sends the batch back to step
   2 with that critic's reason attached. Not a majority vote: one competent objection
   is enough, because the cost of a bad fix reaching a client is higher than the cost
   of another round.

   Record each verdict so the gate can see it:

   ```
   gate.mjs critic --file <path> --id <critic-name> --verdict approve
   gate.mjs critic --file <path> --id <critic-name> --verdict reject --reason "..."
   ```

   Each vote is bound to the SHA of the copy that critic examined, so a vote cannot
   be recycled onto different content, and editing after a vote invalidates it.

5. **promote**: `gate.mjs promote [--critics <n>]`. It refuses unless check passed,
   the working copy is untouched since, the required number of approvals is on
   record, and no critic rejected. Default is one approval; `--critics 0` runs
   without any, and says so in the promotion log rather than hiding it.

   This used to be a rule in prose and nothing else. An audit put it plainly: the
   sequence prepare, apply, check, promote went through with no critic having said
   anything. The rule existed and nothing enforced it. A verdict that does not bind
   is decoration, so now the script holds the door.

## When the cycle does not converge

Set a round limit (three is a sane default). On exceeding it:

- **Do not promote.** A batch that could not satisfy the critics after several honest
  attempts is a batch that needs a human.
- Preserve the working copy and report: what the reviewer asked, what was attempted
  each round, and what each critic objected to.
- Say plainly that it did not converge. Never quietly promote the best attempt and
  call it done.

## Failure modes worth naming

These are the ways a gate like this rots. Each one has happened somewhere.

- **A critic that always approves.** If critics never reject anything, they are not
  critics. Verify the loop by feeding it a deliberately bad fix and confirming it gets
  rejected. Do this when you set the skill up, and again whenever you change the critic
  prompt.
- **Critics that share context.** A critic who knows the fix is "supposed to pass"
  agrees with it. Dispatch them independently, every round.
- **A green run that proves nothing.** `check` passing means the edit was contained,
  not that it was correct. Never report a mechanical pass as approval.
- **Editing after verification.** Any change to the working copy after the check,
  even a whitespace tidy, invalidates it. The script enforces this; do not look for a
  way around it.
- **Batches too large to judge.** Twenty fixes in one batch means the critics review
  an average, not the fixes. Split by section.
- **Silent scope creep.** If a fix cannot be made without touching another section, it
  was never pointwise. Stop and reclassify it as structural.

## Verifying the gate itself

A verifier nobody verified is decoration. Before trusting this on real work:

```
node scripts/gate.mjs selftest
```

It runs twenty-one cases in both directions: edits that must be refused, promotions
that must be blocked, and clean fixes that must be allowed. A gate that refuses
everything would pass a refusal-only suite while being useless, so both lists matter.

Six of those cases exist because an audit defeated an earlier version of this gate,
and each is worth knowing as a failure mode of any tool like this:

| What defeated it | Why it worked |
|---|---|
| A section marker repeated in a nav menu | The code took the first match, mapped every section inside the menu, and dropped the whole document body into the one range that was in scope |
| Declaring the whole document as one section | With nothing outside the scope, everything is trivially inside the lane |
| Scope covering every section | The same defeat by another road |
| Reordering sections | Every section stays byte-identical, just somewhere else |
| Changing line endings outside the scope | Comparison rejoined lines with a chosen separator, so it could not see it |
| Two materials both called index.html | They shared one working copy, and promoting one wrote the other one's content |

The lesson underneath all six: the original suite tested the gate against a document
the gate's own author wrote. It was tidy, and nothing in it was hostile. Test against
the document your users actually have.
