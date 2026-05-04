# Changelog

All notable changes to this project will be documented in this file.

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
- **Gemini Pipeline Hardening**: Enforced `responseMimeType: 'application/json'` on model generation to prevent strict JSON parsing crashes caused by conversational hallucinations, and added an automated fallback to `gemini-2.5-pro` if `gemini-2.5-flash` fails.
- **Error Transparency**: Piped internal error logs directly into the SMS failure response (e.g. `Couldn't read that receipt. Error: ...`) to enable real-time debugging without needing to pull delayed Google Cloud logs.

## [1.0.0] — 2026-05-04

### Changed
- **Upgraded vision model to `gemini-2.5-flash`**: replaces `gemini-2.0-flash`, which is deprecated and shuts down June 1 2026; same price, better OCR accuracy.
- **Migrated intake from Telegram to Twilio SMS/MMS**: replaced `lib/telegram.js` with `lib/twilio.js`; webhook now receives Twilio form-encoded POST data instead of Telegram JSON updates.
- **Twilio signature validation**: validates `X-Twilio-Signature` header using `WEBHOOK_URL` env var to match the exact URL configured in Twilio's dashboard; eliminates proxy header mismatches behind Cloud Run.
- **Response timing fix**: HTTP response to Twilio is now sent *after* all async work (Gemini parsing, Firestore write, SMS reply) completes, preventing Cloud Run from throttling CPU mid-execution.
- **Twilio media fetch**: images fetched from `MediaUrl0` using HTTP Basic Auth (Account SID + Auth Token) as required by Twilio's media API.
- **Allowlist now uses phone numbers**: `ALLOWED_PHONES` env var (E.164 format) replaces `ALLOWED_CHATS`.
- **Switched vision model to Gemini**: `parseReceiptFromBase64` replaces `parseReceiptFromUrl` as the core parsing entry point; URL-based fetch kept for `test-parse.js`.

### Added
- **Twilio MMS Webhook**: Firebase Function (`exports.sms`) that receives incoming MMS, validates the Twilio signature, and dispatches to receipt parsing.
- **Gemini Vision Parsing**: Fetches the MMS image from Twilio (with auth), sends to `gemini-2.5-flash`, and returns structured JSON with merchant, location, date, total, subtotal, tax, items, category, and currency.
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
