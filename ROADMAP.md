# Roadmap

Slip is a personal finance backend for capturing receipt data at the point of purchase via MMS. This roadmap tracks the path from a single-user logging tool to a broader personal finance data layer.

## Reliability & Security

- **Rate Limiting**: No throttle exists on the SMS endpoint. A malicious actor (or Twilio retry storm) could rack up Gemini API costs and Firestore writes. Add per-number rate limiting (e.g. max 10 receipts/hour).
- **Timeout Guard**: Gemini parsing + Twilio media fetch can exceed Cloud Run's 60s timeout on slow images. Add an `AbortController` with a hard cutoff and graceful error reply.
- **Image Validation**: No checks on `MediaContentType0` — the function will happily send a PDF, video, or 20MB file to Gemini. Reject non-image MIME types and enforce a max file size before fetching.
- **Retry Safety / Idempotency**: Twilio retries failed webhooks. Without idempotency (e.g. dedup on `MessageSid`), the same receipt can be saved multiple times (as we saw tonight with 4 identical entries).
- **Node.js 20 Deprecation**: Runtime was deprecated 2026-04-30 and decommissions 2026-10-30. Upgrade to Node.js 22 before October.
- **firebase-functions Upgrade**: CLI warns the current version is outdated. Upgrade to latest and address any breaking changes.
- **Structured Error Logging**: Errors are logged as raw strings. Use structured JSON logging (`severity`, `message`, `receiptId`) for better filtering in Cloud Logging.

## Data Quality

- **Duplicate Detection**: Flag receipts that match a recent entry by merchant + total + date before saving. Prevents accidental re-submissions.
- **Confidence Scoring**: Have Gemini return a confidence score for each field. Flag low-confidence parses for manual review instead of silently saving bad data.
- **Receipt Image Storage**: Store the original image in Cloud Storage alongside the parsed data. Useful for auditing, re-parsing with better models, and dispute resolution.
- **Multi-Image Support**: Handle receipts sent as multiple photos (long rolls) and stitch them into one parsed document.
- **Currency Detection**: Currently hardcoded to `CAD`. Let Gemini detect the currency from the receipt itself for travel receipts.

## Features

- **Monthly Summaries**: Automated SMS digest at month-end — total spend, breakdown by category, biggest single purchase.
- **Text Commands**: Reply with keywords like `TOTAL`, `LAST`, or `SUMMARY` to query your data over SMS without needing the query script.
- **Budget Alerts**: Set a monthly cap per category; get an SMS when you're within 10% of the limit.
- **Web Viewer**: Minimal read-only dashboard to browse and search receipts without running the query script locally.
- **Export**: CSV/JSON export of all receipts for tax season or spreadsheet analysis.
- **FinanceSocial Integration**: Pipe receipts into FinanceSocial as a second data source alongside CSV imports.
- **Email Receipt Ingestion**: Forward email receipts to a dedicated inbox (e.g. via SendGrid Inbound Parse or Mailgun) and extract structured data from HTML/PDF attachments using Gemini — covers digital receipts from Amazon, Uber, etc.

## Infrastructure

- **User Profiles**: Migrate from flat `receipts` collection to per-user subcollections (`users/{phone}/receipts`) to support multi-user access and personalized settings.
- **CI/CD**: GitHub Actions pipeline for lint, deploy-on-push, and automated Firestore index sync.
- **Monitoring**: Cloud Monitoring alerts for function error rate spikes, latency degradation, and Twilio credit balance.
- **Firestore Backups**: Scheduled daily export of the `receipts` collection to Cloud Storage for disaster recovery.

---

[Back to Home](./README.md)
