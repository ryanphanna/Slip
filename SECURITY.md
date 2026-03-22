# Security Model

Slip is a private, single-user backend. All data ingestion is locked behind phone number allowlisting and Twilio webhook validation.

- **Allowlisting**: Only phone numbers listed in `ALLOWED_PHONES` can submit receipts. Requests from unlisted numbers are rejected before any parsing occurs.
- **Webhook Validation**: Every incoming request is validated against the Twilio signature header to prevent spoofing.
- **AI Privacy**: Receipt images are processed by Anthropic's Claude API.
    - **Privacy Commitment**: Covered by [Anthropic's usage policies](https://www.anthropic.com/legal/usage-policy).
    - **No Training**: Images sent via API are not used to train Claude models.
- **Firestore Rules**: Client-side reads and writes are fully disabled — all access goes through Firebase Admin SDK in Cloud Functions.
- **Secret Management**: API keys (Anthropic, Twilio) are stored in Google Cloud Secret Manager via `defineSecret` and never committed to the repository.
