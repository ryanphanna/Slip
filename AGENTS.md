# Slip — Working Notes

SMS-based receipt tracker: text a receipt (photo or text) to a Twilio number, Gemini parses it, results land in Firestore. Also does monthly digests, weekly budget checks, and duplicate detection.

**Note (2026-07-11)**: this file (previously `CLAUDE.md`) was tracked in git despite being intended as agent-only — the `.gitignore` entry was added after it was already committed, so it was visible on the public `ryanphanna/Slip` repo. Untracked now (`git rm --cached`).

Global rules (MANGO push, changelog order, subagent use, etc.) apply — see your tool's own global instructions file. This file adds Slip-specific detail; deeper/local rules take precedence on conflicts. Two things this file used to say that contradicted global rules have been dropped: it used to suggest committing rather than committing proactively, and allowed version bumps "when deploying" without explicit approval — both now just defer to the global rule (commit proactively, never bump version/cut a release without Ryan's go-ahead).

## Tech Stack

Firebase Functions (Node 22) + Firestore + Twilio (SMS/media webhook) + Gemini (`@google/generative-ai`) for receipt parsing. `functions/` is the actual deployable — root has no `package.json` of its own.

## Architecture

- `functions/index.js` — entry point
- `functions/lib/` — shared logic (includes `digest.js` for monthly/weekly summaries)
- `functions/scripts/` — `smoke.js`, `replay.js`, `reparse.js`, `setup-lifecycle.js`, `check-webhook-health.js`, `release-check.js`
- `firestore.rules`, `firestore.indexes.json`, `storage.rules` — Firebase config
- `docs/`, `KNOWN_ISSUES.md`, `SECURITY.md`, `ROADMAP.md` — reference docs

## Versioning

Patch (x.x.1) for prompt tweaks, bug fixes, script updates. Minor (x.1.0) for new features. Major (1.0.0) for breaking changes. Still requires explicit approval to actually cut, per global rules.

## Reference

Repo: `/Users/ryan/Desktop/Dev/Coding/Backend/Slip`
GitHub: `ryanphanna/Slip`
