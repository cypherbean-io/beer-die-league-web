# Beer Die League - Web

<!-- Target: under 200 lines. If it grows past that, move topics into
     .claude/rules/<topic>.md with `paths:` frontmatter so they load on demand.
     HTML comments like this one are stripped before Claude sees the file. -->

This web app is a tracker for beer die leagues. The app does not keep scores of
individual games; it tracks wins, losses, and other stats from individual games. It can
track all-time stats as well as season stats. For the stats to be recorded to the league
database, all four players of that game must confirm the results of the game from their
account.  

## Commands

<!-- The highest-value lines in this file. Claude cannot guess these. -->

| Task | Command |
| --- | --- |
| Install | `TODO` |
| Dev server | `TODO` |
| Test (all) | `TODO` |
| Test (single file) | `TODO` |
| Lint | `TODO` |
| Typecheck | `TODO` |
| Build | `TODO` |

Prefer running a single test file over the whole suite while iterating.

## Architecture

<!-- Only what cannot be derived by reading the code: boundaries, invariants,
     and decisions with rationale. Not a directory listing. -->

- TODO: module boundaries and what may depend on what
- TODO: the one or two invariants that must never be violated

## Conventions

- TODO: naming, error handling, module style — only where it differs from the
  language default.

## Workflow

- Work in plan mode for anything touching more than two files.
- Every change ships with a test. Run the relevant tests before calling a task done,
  and show the output rather than asserting success.
- Conventional Commits (`feat:`, `fix:`, `chore:`, ...). Branches: `type/short-slug`.
- Never commit directly to `main`; open a PR.

## Guardrails

<!-- Reminders only. Enforcement lives in .claude/settings.json and .claude/hooks/. -->

- IMPORTANT: never read, print, or copy the contents of `.env*`, `secrets/**`, or any
  private key. Read `.env.example` for variable *names* only.
- Do not add a dependency without asking first. Justify it and check its transitive
  footprint.
- Do not edit `.github/workflows/**` or `.claude/**` without an explicit request.

## Gotchas

<!-- Append here whenever a correction has to be given twice. Over time this becomes
     the highest-signal part of the file. -->

- TODO
