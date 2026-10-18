# ÀJỌ: Community Co-operative

Facilitator model: the **collector (Baba Àlàjọ) holds the money**. ÀJỌ records, verifies and shows every payment
(ledger, receipts, collector balance statements). The platform never holds or moves customer funds.

| Folder | What |
|---|---|
| `ajo-backend` | Express + TypeScript + Prisma (MongoDB). API, cron jobs, USSD/SMS webhooks |
| `ajo-mobile` | Expo (React Native) app, runs in Expo Go |
| `ajo-web` | Early React web client (not updated for the facilitator flows) |

## Run it
```
# 1. MongoDB must be a replica set (Atlas works as is; local: mongod --replSet rs0, then rs.initiate())
cd ajo-backend && cp .env.example .env   # set DATABASE_URL, JWT_SECRET
npm run migrate        # prisma db push: creates collections + unique indexes
npm run dev            # API on :4000

cd ajo-mobile && npx expo start --port 8082   # scan with Expo Go (same Wi‑Fi)
```
Without `TERMII_API_KEY`, SMS texts (including OTP codes) are printed in the backend terminal.

The web and mobile apps support phone sign-in with an SMS code or PIN, and email-address/password registration and sign-in (passwords must be at least 8 characters). Email accounts do not require a phone number; phone-based SMS and USSD features need one. Email/password sign-in does not verify ownership of the email inbox and is not Google OAuth.

## Tests
`npm test` (unit, fast) and `npm run test:int` (real services against an in-memory MongoDB replica set; first run downloads ~60 MB).

## Needs your accounts before launch
- **Termii** (SMS), set `TERMII_API_KEY`.
- **USSD**: a provider such as Africa's Talking. Point its callback at `POST /api/ussd?key=<WEBHOOK_SECRET>`; inbound SMS at `/api/sms/inbound?key=…`.
- Yorùbá / Hausa / Igbo texts are drafts: have native speakers review `ajo-backend/src/lib/i18n.ts` and `ajo-mobile/src/i18n.ts`.
- Approve collectors and suppliers via the admin endpoints (`PATCH /api/auth/admin/collectors/:id/approve`, `PATCH /api/ccgb/admin/suppliers/:id/approve`).
