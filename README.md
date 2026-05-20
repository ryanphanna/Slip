# Slip

A personal receipt logging backend. Text a receipt photo to Slip and it gets parsed by Gemini Vision and saved to Firestore.

## Problem

Mint is gone in Canada, and credit card CSV exports only show a merchant name and total. Receipts are in-the-moment: they have the actual items, tax breakdown, and real merchant detail that CSV exports miss. Slip captures that data at the point of purchase with a single SMS/MMS message.

## Features

- **SMS/MMS Intake**: Send a photo or pasted receipt text directly by message.
- **Gemini Vision Parsing**: Extracts merchant, date, total, subtotal, tax, line items, and category in one API call.
- **Allowlisting**: Only approved phone numbers can submit receipts.
- **Instant Confirmation**: Bot replies with a summary (e.g. `Saved: T&T Supermarket — $23.14 (Grocery)`).
- **Firestore Storage**: Every receipt stored with full line items and metadata, queryable locally via `scripts/query.js`.
- **Operational Guardrails**: Startup config logging, release checks, webhook-health checks, and a signed production smoke test.

## Stack

- **Backend**: Firebase Cloud Functions (Node.js)
- **Intake**: Twilio SMS/MMS
- **Vision / Parsing**: Google Gemini (gemini-3-flash)
- **Database**: Firestore

## Ops

- Run `npm run check:release` in `functions/` before deploying. This catches Firebase runtime drift and missing required Firestore indexes.
- Run `npm run smoke -- LAST` in `functions/` after deploying. It signs a synthetic Twilio webhook request against the live `WEBHOOK_URL` and optionally verifies that an outbound SMS reply was sent.
- Run `npm run check:webhook-health` in `functions/` from cron or CI. It exits non-zero if recent inbound Twilio messages show repeated `11200` webhook failures.
- Production-critical config should live in Firebase Secret Manager: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `GEMINI_API_KEY`, `ALLOWED_PHONES`, and `WEBHOOK_URL`.
- Deploy order should be: `firebase deploy --only firestore:indexes`, `npm run check:release`, `firebase deploy --only functions:sms`, then `npm run smoke -- LAST`.

---

- [Roadmap](./ROADMAP.md)
- [Changelog](./CHANGELOG.md)
- [Security](./SECURITY.md)

Created by [Ryan Hanna](https://github.com/ryanphanna) | [ryanisnota.pro](https://ryanisnota.pro)
