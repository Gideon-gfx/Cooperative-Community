import 'dotenv/config';

const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' ? Number(v) : d);

export const config = {
  port: num(process.env.PORT, 4000),
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  // Optional: only used if the Monnify extension is switched back on (the platform is a facilitator for now).
  monnify: {
    apiKey: process.env.MONNIFY_API_KEY || '',
    clientSecret: process.env.MONNIFY_CLIENT_SECRET || '',
    baseUrl: process.env.MONNIFY_BASE_URL || 'https://sandbox.monnify.com',
    contractCode: process.env.MONNIFY_CONTRACT_CODE || '',
    sourceAccount: process.env.MONNIFY_SOURCE_ACCOUNT || '',
  },
  // LEDGER_ONLY: the app only records; members pay a named facilitator's own bank account.
  // PARTNER_ESCROW is reserved for a future licensed-partner provider and is not implemented.
  fundsMode: (process.env.FUNDS_MODE === 'PARTNER_ESCROW' ? 'PARTNER_ESCROW' : 'LEDGER_ONLY') as 'LEDGER_ONLY' | 'PARTNER_ESCROW',
  uploadDir: process.env.UPLOAD_DIR || 'uploads',
  publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort: Number(process.env.SMTP_PORT || 465),
  smtpUser: process.env.SMTP_USER || '',
  smtpPass: process.env.SMTP_PASS || '',
  resendApiKey: process.env.RESEND_API_KEY || '',
  mailFrom: process.env.MAIL_FROM || '',
  termiiApiKey: process.env.TERMII_API_KEY || '',
  // Shared secret for USSD / inbound-SMS webhooks (sent as ?key=... or x-webhook-key header)
  webhookSecret: process.env.WEBHOOK_SECRET || '',
  ussdShortCode: process.env.USSD_SHORT_CODE || '*384*00#',
  // The platform is a facilitator and never holds funds, so it takes no cut by default.
  ajoPlatformFeeRate: num(process.env.AJO_PLATFORM_FEE_RATE, 0),
  ccgbPlatformFeeRate: num(process.env.CCGB_PLATFORM_FEE_RATE, 0),
  transportBaseFee: num(process.env.TRANSPORT_BASE_FEE_NGN, 5000),
  transportRatePerKm: num(process.env.TRANSPORT_RATE_PER_KM, 250),
};
