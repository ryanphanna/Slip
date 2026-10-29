# Development

## Web app

The React receipt inbox lives in `web/` and is hosted by Firebase Hosting. Setup: copy `web/.env.example` to `web/.env.local` and fill in the Firebase web app configuration (every variable is listed in that file), then run:

```sh
cd web
npm install
npm run dev
```

The browser uses Firebase Phone Authentication and calls authenticated Cloud Functions; Firestore and Cloud Storage remain inaccessible directly from the client. Historical records can be attached to an account with `cd functions && npm run migrate:accounts -- --phone <E.164> --uid <firebase-uid> --apply`.

---

[Back to Home](../README.md)
