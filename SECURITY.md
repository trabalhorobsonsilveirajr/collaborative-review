# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.** A public report
tells everyone about the flaw before there is a fix, including people who would
use it.

Instead, use GitHub's private reporting: go to the **Security** tab of this
repository and choose **Report a vulnerability**. That opens a private channel
visible only to the maintainer.

Expect an acknowledgement within a few days. If a report turns out to be valid,
the fix and an advisory are published together.

## What is in scope

This project stores reviewer feedback in **your own** backend, and runs an agent
that edits **your own** files. The parts most worth scrutiny:

| Area | Why it matters |
|---|---|
| The security policies in `assets/sql/` | They are what stop an anonymous visitor from reading other people's feedback. A gap here exposes data |
| The server functions | They authenticate by password in the request body. A path that answers without checking it is a serious bug |
| `scripts/gate.mjs` | It decides whether an automatic edit reaches a live file. A way to make it promote unverified content is a serious bug |
| `scripts/sync-approvals.ps1` | It turns database values into file paths and file content. Anything letting a database value escape its intended directory is a serious bug |
| Reviewer input handling | Comments are untrusted text. A comment that changes the engine's behavior, rather than being treated as data, is a serious bug |

## What is out of scope

- A backend **you** configured without the provided security policies. The SQL
  in this repository is the supported configuration.
- Deploying the server functions without a password configured. They return an
  error in that state on purpose; running them anyway is not a vulnerability in
  this project.
- Someone with your dashboard password reading your feedback. That password is
  the access control.
- Findings from automated scanners without a demonstrated impact.

## Design decisions that look like bugs and are not

**The public key is in the page on purpose.** It identifies the backend project
and grants nothing on its own. The row-level security policy is what protects
the data: the anonymous role can insert and can never read.

**The server functions deploy with JWT verification off, on purpose.** They
authenticate with the password in the request body instead. With verification
on, they would reject every call before the password is ever checked.

**The engine can edit your files.** That is the feature. What bounds it is the
quality gate: an isolated copy, a mechanical scope check, unanimous critics, and
a promotion step that refuses without a passing verdict. A way around any of
those is worth reporting.
