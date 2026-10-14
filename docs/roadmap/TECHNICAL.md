# Technical Roadmap

This sub-roadmap tracks goals and initiatives related to hardening Slip's functions, backend scalability, multi-tenancy, and operational maintenance.

## Active & Planned Initiatives

- **User Blocklist**: Add a mechanism to block abusive or spammy numbers by storing salted SHA-256 hashes of phone numbers in a Firestore `blocklist` collection to protect privacy while rejecting requests.
- **CI/CD**: GitHub Actions pipeline for automated lint checks, deployments, and Firestore index synchronization.
- **Monitoring**: Cloud Monitoring alerts for function errors, latency spikes, and Twilio credit balance.
- **Firestore Backups**: Scheduled daily exports of receipts database collections to Cloud Storage buckets.

## Completed Initiatives
- **Rate Limiting**: Added hourly rate limiting (max 15/hour) to protect the SMS endpoint from loops and abuse. (Done)
- **Retry Safety / Idempotency**: Implemented `MessageSid` check to prevent duplicate receipt logging from Twilio webhook retries. (Done)
- **firebase-functions Upgrade**: Upgraded core Firebase SDK dependencies to Node 22 aligned versions; the runtime is Node 22. (Done)
- **Timeout Guard**: Twilio media fetches abort after a hard timeout (`FETCH_MEDIA_TIMEOUT_MS`) via `AbortController`. (Done)
- **Image Validation**: Non-image MIME types are rejected and per-image and total media size limits are enforced before parsing. (Done)
- **User Profiles**: Multi-tenant support is in place, with receipts scoped to the signed-in account (uid) and phone rather than per-user subcollections. (Done)

---
[Back to Roadmap](../../ROADMAP.md)
