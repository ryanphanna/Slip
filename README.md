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
- **AI Assistant Import**: Connect your own AI assistant to add receipts from photos.
- **Budgets**: Set per-category monthly budgets and get weekly SMS budget checks.
- **Digests**: Monthly spending recap texts.
- **Web Inbox**: Browse, search, filter, and correct receipts in the browser.
- **Notifications**: Recaps are also saved as in-app notifications in the web inbox.
- **Items**: Browse and correct individual line items across receipts in the web app.
- **Private by Design**: Built for personal use with server-side storage, locked-down client access, and allowlisted intake.

## Stack

- **Backend**: Firebase Cloud Functions (Node.js)
- **Intake**: Twilio SMS/MMS
- **Vision / Parsing**: Google Gemini (gemini-flash-latest / gemini-pro-latest fallback)
- **Database**: Firestore
- **Web**: React, hosted on Firebase Hosting

---

- [Roadmap](./ROADMAP.md)
- [Development](./docs/DEVELOPMENT.md)
- [Changelog](./CHANGELOG.md)
- [Security](./SECURITY.md)

Created by [Ryan Hanna](https://github.com/ryanphanna) | [ryanisnota.pro](https://ryanisnota.pro)
