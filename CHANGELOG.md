# Changelog

All notable changes to this project will be documented in this file.

## [1.2.1] — 2026-05-20

### Added
- **Startup runtime health logging**: The `sms` function now logs a one-time startup health summary per revision, including whether `ALLOWED_PHONES`, `WEBHOOK_URL`, Twilio credentials, and Gemini credentials are actually loaded in production.
- **Signed production smoke test**: Added `functions/scripts/smoke.js` and `npm run smoke` to exercise the live webhook with a correctly signed synthetic Twilio request and verify that a reply SMS is emitted.
- **Webhook failure check script**: Added `functions/scripts/check-webhook-health.js` and `npm run check:webhook-health` to flag repeated inbound Twilio `11200` webhook failures.
- **Release check script**: Added `functions/scripts/release-check.js` and `npm run check:release` to catch Firebase runtime drift and missing required Firestore indexes before deploy.

### Fixed
- **Media fetch CDN redirect**: The strict `ALLOWED_MEDIA_HOSTS` check was applied to every redirect in the chain, blocking Twilio CDN redirects to S3 or CloudFront. Now only the initial webhook-supplied URL is validated against the allowlist (SSRF protection on user-controlled input); CDN redirects enforce HTTPS only.
- **Function timeout**: Default Cloud Run timeout of 60s was too short for Gemini Flash + optional Pro fallback. Increased to 180s.
- **Index-light command path**: `LAST` and hourly rate limiting no longer depend on Firestore composite indexes for `from + createdAt`, so inbound command replies do not hard-fail if indexes lag behind deployment.
- **Runtime config loading**: `ALLOWED_PHONES` and `WEBHOOK_URL` now resolve cleanly through the same runtime-health path used for startup diagnostics instead of silently drifting between local envs and deployed secrets.
- **Twilio config drift recovery**: `ALLOWED_PHONES` and `WEBHOOK_URL` are now mounted as Firebase secrets in production, which closes the gap between local `.env` analysis and actual runtime config.

### Changed
- **Firebase runtime alignment**: `firebase.json` now targets `nodejs22`, matching `functions/package.json` and avoiding the stale Node 20 deployment path.
- **Operational docs**: README and env examples now document the production secret set, deploy order, smoke testing, and webhook health checks.
- **Twilio webhook handling**: Allowed senders currently bypass strict Twilio signature rejection while signature mismatches remain logged, restoring service without hiding the underlying validation issue.

## [1.2.0] — 2026-05-05

### Added
- **Confidence-Based Fallback**: The system now requests a `confidence` score from Gemini. If the primary `gemini-3-flash` model returns low confidence (< 0.8), it automatically falls back to `gemini-3.1-pro` for a more accurate re-parse.
- **Item Count in SMS**: Confirmation messages now include the number of items extracted (e.g., `(Grocery, 8 items)`).
- **Low Confidence Warning**: If the final extraction confidence is still low (< 0.7), the confirmation SMS is prefixed with a ⚠️ warning.
- **Message Idempotency**: Added a check for Twilio `MessageSid` at the beginning of the function. Exact retries from Twilio are now handled instantly without invoking the Gemini API or Storage.
- **Hourly Rate Limiting**: Added a safety valve to limit the number of receipts logged per phone number per hour (default: 15). Protects against abuse and accidental loops.
- **SMS Text Commands**: Added support for direct querying via SMS. Use `TOTAL` (monthly spend), `SUMMARY` (category breakdown), `LAST` (latest receipt), or `INFO`.
- **Duplicate Detection**: Implemented a check to prevent redundant receipt entries by matching merchant, total, and sender within a 10-minute window.
- **Dependabot Configuration**: Enabled weekly automated `npm` dependency updates for the `functions` directory via `.github/dependabot.yml`.
- **User Blocklist (Roadmap)**: Added a strategy for blocking abusive users using a Firestore `blocklist` collection with salted SHA-256 hashes for privacy.

### Fixed
- **Structured JSON Logging**: Migrated from `console` to `firebase-functions/logger` for better observability and filtering in Google Cloud Logs. Includes relevant metadata like `messageSid` and masked phone numbers.
- **Storage Path Sanitization**: Implemented alphanumeric sanitization for `messageSid` in `functions/lib/image-store.js` to prevent potential path traversal vulnerabilities in Cloud Storage.
- **PII Masking in Logs**: Added `maskPhone` utility to `functions/index.js` to hide all but the last 4 digits of phone numbers in console logs, preventing accidental exposure of personal data.

### Changed
- **Dependency Upgrades**: Upgraded `twilio` to v6.0.0 and `@google/generative-ai` to v0.24.1. Core Firebase SDKs are verified as up-to-date.
- **Gemini Model Upgrade**: Upgraded the parsing pipeline to use the 2026 fleet: `gemini-3-flash` as the primary model and `gemini-3.1-pro` as the fallback for maximum accuracy and reasoning.
- **Security Housekeeping**: Removed the deprecated and unused `functions/lib/telegram.js` library following the migration to Twilio.

---

## [1.1.3] — 2026-05-05


### Fixed
- **Webhook authentication restored**: removed temporary Twilio signature bypass and added robust validation across forwarded host/protocol URL variants.
- **Allowlist fail-closed**: missing `ALLOWED_PHONES` now rejects requests instead of allowing all senders.
- **Media fetch hardening**: restricted media downloads to approved Twilio HTTPS hosts with controlled redirect handling to block SSRF and credential forwarding to arbitrary domains.
- **Input abuse limits**: added bounds for max attachments, per-image size, total media size, and max text body length.
- **Error response sanitization**: removed internal exception details from user-facing SMS errors.
- **Security housekeeping**: removed tracked log artifacts and added ignore rules for logs, local service account key files, and assistant-local markdown artifacts.
- **Dependency vulnerability remediation**: added dependency overrides and lockfile updates resolving Dependabot/npm audit findings (including path-to-regexp, protobufjs, fast-xml-parser, and @tootallnate/once transitive issues).

---

## [1.1.2] — 2026-05-04

### Added
- **Image Storage**: Receipt images are now saved to Firebase Storage under `receipts/{messageSid}/{index}.jpg` before parsing. Storage path is saved to the Firestore document as `imagePaths`. Storage failures are non-fatal — the receipt is still saved if the image upload fails.
- **Storage Rules**: `storage.rules` blocks all client-side reads and writes — images are server-only.
- **30-day lifecycle**: GCS bucket lifecycle rule auto-deletes images after 30 days (configured manually in GCS console).

---

## [1.1.1] — 2026-05-04

### Fixed
- **Prompt: inline discount handling** — Gemini now records the final net price per item after inline per-item discounts and omits the coupon summary line at the bottom of the receipt (e.g. IKEA "$35 off $120" total), which was previously being double-counted as a separate line item.

### Changed
- **`test-parse.js`**: synced prompt with `receipt.js`; now accepts multiple image paths as arguments for testing multi-image receipts locally; added items-sum vs subtotal check at the end of output.
- **`query.js`**: now prints Firestore doc ID alongside each receipt for use with `delete.js`.
- **`delete.js`**: new script for deleting receipts by ID, date, date range, or all.

---

## [1.1.0] — 2026-05-04

### Added
- **Text Receipt Extraction**: You can now copy and paste the raw text of an email receipt directly into the SMS thread. The backend detects empty media payloads, extracts the text, and feeds it into the exact same Gemini prompt for seamless JSON parsing.
- **Multi-Image Stitching**: Twilio webhooks containing multiple images (e.g. 2 or 3 photos of a very long CVS receipt) are now bundled together and passed simultaneously to Gemini. Gemini seamlessly stitches the context across the photos into a single JSON extraction.
- **Hyper-Differentiated Categorization**: Replaced generic 'Food' category with 'Takeout/Dining' and added a dynamic 'subCategory' extraction in Gemini (e.g., 'Coffee Shop', 'Fast Food', 'Supermarket') for granular tracking.
- **Loyalty & Currency Metadata**: Added robust extraction for `loyaltyPointsEarned`, `loyaltyPointsBalance`, and inferred `currency` to the Gemini schema and validation layer.

### Changed
- **Node.js Environment**: Upgraded Firebase Cloud Functions runtime to Node.js 22 to address decommissioning warnings, alongside bumps to core `firebase-functions` and `firebase-admin` dependencies.
- **Twilio Signature Validation Bypassed**: Signature validation is conditionally disabled to ensure pipeline stability against Cloud Run proxy header mutability, relying fully on `ALLOWED_PHONES` allowlist for security.
- **Gemini Pipeline Hardening**: Enforced `responseMimeType: 'application/json'` on model generation to prevent strict JSON parsing crashes caused by conversational hallucinations, and added an automated fallback to `gemini-3.1-pro` if `gemini-3-flash` fails.
- **Error Transparency**: Piped internal error logs directly into the SMS failure response (e.g. `Couldn't read that receipt. Error: ...`) to enable real-time debugging without needing to pull delayed Google Cloud logs.

## [1.0.0] — 2026-05-04

### Changed
- **Upgraded vision model to `gemini-3-flash`**: replaces `gemini-2.0-flash`, which is deprecated and shuts down June 1 2026; same price, better OCR accuracy.
- **Migrated intake from Telegram to Twilio SMS/MMS**: replaced `lib/telegram.js` with `lib/twilio.js`; webhook now receives Twilio form-encoded POST data instead of Telegram JSON updates.
- **Twilio signature validation**: validates `X-Twilio-Signature` header using `WEBHOOK_URL` env var to match the exact URL configured in Twilio's dashboard; eliminates proxy header mismatches behind Cloud Run.
- **Response timing fix**: HTTP response to Twilio is now sent *after* all async work (Gemini parsing, Firestore write, SMS reply) completes, preventing Cloud Run from throttling CPU mid-execution.
- **Twilio media fetch**: images fetched from `MediaUrl0` using HTTP Basic Auth (Account SID + Auth Token) as required by Twilio's media API.
- **Allowlist now uses phone numbers**: `ALLOWED_PHONES` env var (E.164 format) replaces `ALLOWED_CHATS`.
- **Switched vision model to Gemini**: `parseReceiptFromBase64` replaces `parseReceiptFromUrl` as the core parsing entry point; URL-based fetch kept for `test-parse.js`.

### Added
- **Twilio MMS Webhook**: Firebase Function (`exports.sms`) that receives incoming MMS, validates the Twilio signature, and dispatches to receipt parsing.
- **Gemini Vision Parsing**: Fetches the MMS image from Twilio (with auth), sends to `gemini-3-flash`, and returns structured JSON with merchant, location, date, total, subtotal, tax, items, category, and currency.
- **Store Location Extraction**: Gemini prompt now extracts the store address as printed on the receipt and saves it as the `location` field.
- **Input Validation**: Cleans and validates parsed receipt data before writing — normalizes numbers, checks date format, coerces unknown categories to `Other`.
- **Idempotency**: Deduplicates on Twilio `MessageSid` — if a message was already processed (e.g. from Twilio retries), the function returns immediately without re-parsing or re-saving.
- **Image Validation**: Rejects non-image MIME types (only allows JPEG, PNG, GIF, WebP, HEIC/HEIF) and enforces a 10 MB file size limit before sending to Gemini.
- **Allowlisting**: Rejects requests from phone numbers not in `ALLOWED_PHONES` env var to prevent unauthorized API usage.
- **Firestore Storage**: Writes validated receipts to the `receipts` collection with a server-side `createdAt` timestamp and sender phone number.
- **Secret Manager Integration**: Migrated credentials (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `GEMINI_API_KEY`) from `.env` to Google Cloud Secret Manager for secure production deployment.
- **SMS Reply**: Confirms saved receipt with merchant, total, and category (e.g. `Saved: T&T Supermarket — $23.14 (Grocery)`).
- **Query Script**: `scripts/query.js` for pulling receipts from Firestore locally, with `--category`, `--month`, and `--limit` flags.
- **Test Parse Script**: `scripts/test-parse.js` for running Gemini Vision parsing against a local image file without Firebase or Twilio.
- **Firestore Indexes**: Composite indexes on `(category, createdAt)`, `(date, createdAt)`, and `(merchant, createdAt)`.
- **Firestore Rules**: Denies all client-side reads and writes — receipts are server-only.
