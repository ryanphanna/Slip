# Changelog

All notable changes to this project will be documented in this file.

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
