# Roadmap

Slip is a personal finance backend for capturing receipt data at the point of purchase via MMS. This roadmap tracks the path from a single-user logging tool to a broader personal finance data layer.

## Features

- **Monthly Summaries**: Automated SMS digest at month-end — total spend, breakdown by category, biggest single purchase.
- **FinanceSocial Integration**: Pipe receipts into FinanceSocial as a second data source alongside CSV imports, replacing manual bank exports for in-store purchases.
- **Duplicate Detection**: Flag receipts that match a recent entry by merchant + total + date before saving.
- **Multi-Image Support**: Handle receipts sent as multiple photos (long rolls) and stitch them into one parsed document.
- **Web Viewer**: Minimal read-only dashboard to browse and search receipts without running the query script locally.
- **Budget Alerts**: Set a monthly cap per category; get an SMS when you're within 10% of the limit.

---

[Back to Home](./README.md)
