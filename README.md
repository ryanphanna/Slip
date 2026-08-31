# Slip

A personal receipt logging backend. Text a receipt photo to Slip and it gets parsed by Gemini Vision and saved to Firestore.

## Problem

Mint is gone in Canada, and credit card CSV exports only show a merchant name and total. Receipts are in-the-moment: they have the actual items, tax breakdown, and real merchant detail that CSV exports miss. Slip captures that data at the point of purchase with a single SMS/MMS message.

## Features

- **SMS/MMS Intake**: Send a photo or pasted receipt text directly by message.
- **Gemini Vision Parsing**: Extracts merchant, date, total, subtotal, tax, line items, and category in one API call.
- **Allowlisting**: Only approved phone numbers can submit receipts.
- **Quick Confirmation**: Sends back a short receipt summary after each successful save.
- **Detailed History**: Stores itemized receipts with merchant, date, totals, tax, categories, and line items.
- **Private by Design**: Built for personal use with server-side storage, locked-down client access, and allowlisted intake.

## Web interface

The React receipt inbox lives in `web/` and is hosted by Firebase Hosting. Copy `web/.env.example` to `web/.env.local`, fill in the Firebase web app configuration, then run:

```sh
cd web
npm install
npm run dev
```

The browser uses Firebase Phone Authentication and calls authenticated Cloud Functions; Firestore and Cloud Storage remain inaccessible directly from the client. Historical records can be attached to an account with `cd functions && npm run migrate:accounts -- --phone <E.164> --uid <firebase-uid> --apply`.

## Stack

- **Backend**: Firebase Cloud Functions (Node.js)
- **Intake**: Twilio SMS/MMS
- **Vision / Parsing**: Google Gemini (gemini-flash-latest / gemini-pro-latest fallback)
- **Database**: Firestore

---

- [Roadmap](./ROADMAP.md)
- [Changelog](./CHANGELOG.md)
- [Security](./SECURITY.md)

Created by [Ryan Hanna](https://github.com/ryanphanna) | [ryanisnota.pro](https://ryanisnota.pro)
