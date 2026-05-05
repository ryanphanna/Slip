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
- **Multi-Image Deduplication**: When overlapping photos are sent, Gemini double-counts items that appear in more than one frame. Prompt-based instructions are inconsistent. Correct approach: post-processing using contiguous block analysis — for any run of identical adjacent items, the true count is the max run length observed between two distinct anchor items (e.g. if DVALA → 8 candles → FRAKA appears in one image and 16 candles appear in the full merged list, the candle block between those two anchors is capped at 8). Also use the "Total items: N" line as a cross-check.
- **Flagged Merchant Image Retention**: For merchants with known parsing issues (e.g. IKEA inline discounts), store images indefinitely instead of letting them expire after 30 days. Approach: after parsing, check the merchant name against a known-issues list; if matched, save to `receipts-flagged/{messageSid}/` instead of `receipts/{messageSid}/`. The GCS lifecycle rule only targets the `receipts/` prefix — `receipts-flagged/` is excluded so images are kept forever for future re-parsing with better models.
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
