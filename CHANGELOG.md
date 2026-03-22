# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- **Twilio MMS Webhook**: Firebase Function that receives incoming MMS messages, validates the Twilio signature, and dispatches to receipt parsing.
- **Claude Vision Parsing**: Fetches the MMS image from Twilio (with auth), sends to `claude-opus-4-6`, and returns structured JSON with merchant, date, total, subtotal, tax, items, category, and currency.
- **Input Validation**: Cleans and validates parsed receipt data before writing — normalizes numbers, checks date format, coerces unknown categories to `Other`.
- **Allowlisting**: Rejects requests from phone numbers not in `ALLOWED_PHONES` env var to prevent unauthorized API usage.
- **Firestore Storage**: Writes validated receipts to the `receipts` collection with a server-side `createdAt` timestamp and sender phone number.
- **SMS Reply**: Confirms saved receipt with merchant, total, and category (e.g. `Saved: T&T Supermarket — $23.14 (Grocery)`).
- **Query Script**: `scripts/query.js` for pulling receipts from Firestore locally, with `--category`, `--month`, and `--limit` flags.
- **Test Parse Script**: `scripts/test-parse.js` for running Claude Vision parsing against a local image file without Firebase or Twilio.
- **Firestore Indexes**: Composite indexes on `(category, createdAt)`, `(date, createdAt)`, and `(merchant, createdAt)`.
- **Firestore Rules**: Denies all client-side reads and writes — receipts are server-only.
