# Product Roadmap

This sub-roadmap tracks improvements to the accuracy, reliability, and coverage of receipt data parsed by Gemini.

## Active & Planned Initiatives

- **Receipt Image Storage**: Store the original image in Cloud Storage alongside the parsed data for auditing and re-parsing.
- **Multi-Image Support**: Handle receipts sent as multiple photos (long rolls) and stitch them into one parsed document.
- **Multi-Image Deduplication**: Handle item overlap in multiple photos using post-processing contiguous block analysis.
- **Flagged Merchant Image Retention**: Store images for merchants with known parsing issues (e.g. IKEA) indefinitely for future model tuning.
- **Currency Detection**: Automatically detect currency from the receipt image to support travel receipts instead of assuming CAD.

## Completed Initiatives

- **Confidence Scoring**: Have Gemini return a confidence score and warn users or fall back to Pro on low-confidence parses. (✅ Done)

---
[Back to Roadmap](../ROADMAP.md)
