# Changelog

## 2.0

First public release.

### Added
- Portable quality gate (`scripts/gate.mjs`) with mechanical scope checking, atomic
  promotion, and a twelve-case self-test covering both refusals and clean passes.
- `references/quality-gate.md`: the gate protocol, the triage boundary between pointwise
  and structural changes, and the failure modes that make a gate like this rot.
- `SETUP.md` for first-time backend provisioning.

### Changed
- The correction engine no longer depends on any host-specific executor. The gate runs on
  Claude Code subagents and plain file operations, so it works on any machine.
- Every path, project name, and backend reference is now a placeholder.
- Documentation and interface text are in English.

### Fixed
- `promote` used to run even when `check` had rejected the fix. It now refuses without a
  recorded passing verdict, and refuses again if the working copy changed after the check.
- A deleted section used to crash the scope check instead of being reported as the
  violation it is.

## 1.0

Internal release: parameterized review kit, scoped backend, automatic correction engine.
