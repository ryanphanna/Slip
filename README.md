# Slip

A personal receipt logging backend. Text a photo of a receipt to a Twilio number and it gets parsed by Gemini Vision and saved to Firestore — no app required.

## Problem

Mint is gone in Canada, and credit card CSV exports only show a merchant name and total. Receipts are in-the-moment: they have the actual items, tax breakdown, and real merchant detail that CSV exports miss. Slip captures that data at the point of purchase with a single MMS.

## Features

- **MMS Intake**: Send a photo to a Twilio number — no app, no UI, just your camera roll.
- **Gemini Vision Parsing**: Extracts merchant, date, total, subtotal, tax, line items, and category in one API call.
- **Allowlisting**: Only your number can submit receipts — prevents abuse and unexpected API costs.
- **SMS Confirmation**: Replies instantly with a summary (e.g. `Saved: T&T Supermarket — $23.14 (Grocery)`).
- **Firestore Storage**: Every receipt stored with full line items and metadata, queryable locally via `scripts/query.js`.

## Stack

- **Backend**: Firebase Cloud Functions (Node.js)
- **SMS/MMS**: Twilio
- **Vision / Parsing**: Google Gemini (gemini-2.0-flash)
- **Database**: Firestore

---

- [Roadmap](./ROADMAP.md)
- [Changelog](./CHANGELOG.md)
- [Security](./SECURITY.md)

Created by [Ryan Hanna](https://github.com/ryanphanna) | [ryanisnota.pro](https://ryanisnota.pro)
