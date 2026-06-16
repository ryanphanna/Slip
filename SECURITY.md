# Security Model

Slip is a private, single-user backend. All data ingestion is locked behind phone number allowlisting and Twilio webhook validation, with allowlisted senders permitted to continue if Twilio signature validation is unavailable or mismatched.

- **Allowlisting**: Only phone numbers listed in `ALLOWED_PHONES` can submit receipts. Missing allowlist configuration fails closed.
- **Webhook Validation**: Incoming requests are validated against the Twilio signature header to prevent spoofing. If a request comes from an allowlisted phone number but the signature check fails, the sender is still processed and the mismatch is logged.
- **Media URL Hardening**: Media fetches are restricted to approved Twilio hosts over HTTPS, with controlled redirect handling to prevent SSRF and credential forwarding to untrusted domains.
- **Abuse Controls**: Requests are bounded by attachment count, per-image size, total media size, and max text length.
- **AI Privacy**: Receipt images are processed by Google's Gemini API server-side — the key is never exposed to the client.
    - **Privacy Commitment**: Covered by [Google's API Terms of Service](https://ai.google.dev/gemini-api/terms).
    - **No Training**: API usage is not used to train Gemini models.
- **Firestore Rules**: Client-side reads and writes are fully disabled — all access goes through Firebase Admin SDK in Cloud Functions.
- **Secret Management**: API keys (Gemini, Twilio) are stored in Google Cloud Secret Manager via `defineSecret` and never committed to the repository.
