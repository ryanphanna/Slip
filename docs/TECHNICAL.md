# Technical Roadmap

This sub-roadmap tracks goals and initiatives related to hardening Slip's functions, backend scalability, multi-tenancy, and operational maintenance.

## Active & Planned Initiatives

- **Timeout Guard**: Gemini parsing + Twilio media fetch can exceed Cloud Run's 60s timeout on slow images. Add an `AbortController` with a hard cutoff and graceful error reply.
- **Image Validation**: Reject non-image MIME types and enforce a max file size before fetching to prevent sending invalid or massive payloads to Gemini.
- **User Blocklist**: Add a mechanism to block abusive or spammy numbers by storing salted SHA-256 hashes of phone numbers in a Firestore `blocklist` collection to protect privacy while rejecting requests.
- **User Profiles**: Migrate from a single receipts collection to per-user subcollections (`users/{phone}/receipts`) for multi-tenant support.
- **CI/CD**: GitHub Actions pipeline for automated lint checks, deployments, and Firestore index synchronization.
- **Monitoring**: Cloud Monitoring alerts for function errors, latency spikes, and Twilio credit balance.
- **Firestore Backups**: Scheduled daily exports of receipts database collections to Cloud Storage buckets.
- **Node.js 20 Deprecation**: Address deprecations by ensuring the runtime is migrated cleanly (upgraded to Node 22).

## Completed Initiatives
- **Rate Limiting**: Added hourly rate limiting (max 15/hour) to protect the SMS endpoint from loops and abuse. (✅ Done)
- **Retry Safety / Idempotency**: Implemented `MessageSid` check to prevent duplicate receipt logging from Twilio webhook retries. (✅ Done)
- **firebase-functions Upgrade**: Upgraded core Firebase SDK dependencies to Node 22 aligned versions. (✅ Done)

---
[Back to Roadmap](../ROADMAP.md)
