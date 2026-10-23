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
SMS delivery for notifications and account recovery requires `TERMII_API_KEY`. Account creation does not send a phone verification code.

## iOS push notifications
The iOS app uses bundle ID `com.cooperativecommunity.ajo`. Push notifications are opt-in from **Settings** and cover
due and missed contributions, payout confirmations, payouts ready to record, and member payments awaiting verification.
The backend stores each signed-in device's Expo push token and removes tokens reported as unregistered by Expo.
Production mobile builds use `https://theccajo.com/api`; local development uses the Expo host and port 4000 unless
`EXPO_PUBLIC_API_URL` is set. The EAS `preview` profile explicitly uses the hosted API, so preview builds can test
against the live Hostinger-hosted backend before production. Local development overrides do not change that profile.

Remote pushes do not work in Expo Go. From `ajo-mobile`, link the app to an Expo account/project and create a development
build on a physical iPhone:
```
npx eas-cli@latest init
npx eas-cli@latest build --platform ios --profile development
```
`eas init` adds the required `extra.eas.projectId` to `app.json`. EAS Build also needs an Apple Developer account and
APNs push credentials; EAS can manage those credentials during the build. Use that development build (not Expo Go) to
test notifications. The device must be signed in, opt in on the Settings screen, and be able to reach the backend API.

The web and mobile apps use email-address/password registration and sign-in (passwords must be at least 8 characters). Registration requires a phone number and country selection, but does not send a verification code. Phone numbers are collected as contact details; email/password sign-in does not verify ownership of the email inbox and is not Google OAuth.

## Tests
`npm test` (unit, fast) and `npm run test:int` (real services against an in-memory MongoDB replica set; first run downloads ~60 MB).

## Needs your accounts before launch
- **Termii** (SMS), set `TERMII_API_KEY`.
- **USSD**: a provider such as Africa's Talking. Point its callback at `POST /api/ussd?key=<WEBHOOK_SECRET>`; inbound SMS at `/api/sms/inbound?key=…`.
- Yorùbá / Hausa / Igbo texts are drafts: have native speakers review `ajo-backend/src/lib/i18n.ts` and `ajo-mobile/src/i18n.ts`.
- Approve collectors and suppliers via the admin endpoints (`PATCH /api/auth/admin/collectors/:id/approve`, `PATCH /api/ccgb/admin/suppliers/:id/approve`).
