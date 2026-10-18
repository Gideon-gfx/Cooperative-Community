import 'dotenv/config';

// Every business decision lives here and nowhere else. Values are env-overridable; the ones marked "admin" are
// also editable in the database (PlatformConfig, CustodyTier overrides) by a platform admin.

const bool = (v: string | undefined, d = false) => (v === undefined || v === '' ? d : v === 'true' || v === '1');
const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' ? Number(v) : d);
const naira = (n: number) => BigInt(Math.round(n * 100)); // kobo

export interface CustodyTier {
  tier: 1 | 2 | 3;
  /** Max pool size and max funds held, per group (kobo). */
  maxPerGroupKobo: bigint;
  /** Max funds held by one collector across ALL their groups (kobo). */
  maxPerCollectorKobo: bigint;
  /** Completed cycles with a clean record needed before this tier can be granted. */
  minCleanCycles: number;
  needsNin: boolean;
  needsAddress: boolean;
  needsBoardEndorsement: boolean;
  /** Registered cooperative/business certificate + licensed/professional docs, verified by an admin. */
  needsEntityDocs: boolean;
  /** The receiving bank account must be in the entity's name, not a person's. */
  entityAccountOnly: boolean;
}

export const decisions = {
  // 1. Monnify and pooled funds. ESCROW is sandbox/staging only until Monnify confirms pooled use in writing.
  monnifyPoolingApproved: bool(process.env.MONNIFY_POOLING_APPROVED, false),
  // 2. Consent documents. Custody cannot be enabled in production until a lawyer approves them.
  consentDocsApproved: bool(process.env.CONSENT_DOCS_APPROVED, false),
  // 3. Commission
  defaultPlatformCommissionBp: num(process.env.PLATFORM_COMMISSION_BP, 500), // 5%
  settlementCommissionBp: num(process.env.SETTLEMENT_COMMISSION_PCT, 0) * 100, // 0% on apprenticeship settlement funds
  // 4. Custody caps and gateway fees
  gatewayFeeBearer: (['PLATFORM', 'GROUP', 'PAYER'].includes(process.env.GATEWAY_FEE_BEARER ?? '') ? process.env.GATEWAY_FEE_BEARER : 'PLATFORM') as 'PLATFORM' | 'GROUP' | 'PAYER',
  // What the gateway charges, in basis points of the payment. 0 until Monnify's rates for this account are confirmed.
  gatewayFeeBp: num(process.env.GATEWAY_FEE_BP, 0),
  gatewayFeeReviewThresholdBp: 150, // review the bearer if gateway fees exceed ~1.5% of volume
  custodyTiers: [
    { tier: 1, maxPerGroupKobo: naira(500_000), maxPerCollectorKobo: naira(1_000_000), minCleanCycles: 0, needsNin: false, needsAddress: false, needsBoardEndorsement: false, needsEntityDocs: false, entityAccountOnly: false },
    { tier: 2, maxPerGroupKobo: naira(2_000_000), maxPerCollectorKobo: naira(4_000_000), minCleanCycles: 2, needsNin: true, needsAddress: true, needsBoardEndorsement: true, needsEntityDocs: false, entityAccountOnly: false },
    { tier: 3, maxPerGroupKobo: naira(5_000_000), maxPerCollectorKobo: naira(10_000_000), minCleanCycles: 4, needsNin: true, needsAddress: true, needsBoardEndorsement: true, needsEntityDocs: true, entityAccountOnly: true },
  ] as CustodyTier[],
  // "Clean record": dispute rate under 2% and at least 95% of entries confirmed within 48h, over the trailing 90 days.
  clean: { maxDisputeRateBp: 200, minConfirmedWithinBp: 9500, confirmWithinHours: 48, windowDays: num(process.env.CLEAN_WINDOW_DAYS, 90) },
  // Biometric verification is out of scope. This flag exists only so it can be added later behind its own consent and review.
  biometricKycEnabled: false,
  // 5. Pilot caps until a pilot group is REGISTERED
  pilot: { maxGroups: num(process.env.PILOT_MAX_GROUPS, 5), maxMembersPerGroup: num(process.env.PILOT_MAX_MEMBERS, 30) },
  // 7. Subscriptions and commission billing (prices themselves live in the PlanPrice table, never here)
  billing: {
    // While false (the pilot), nobody is blocked for not subscribing. Turn on when billing launches.
    enforced: bool(process.env.BILLING_ENFORCED, false),
    memberPlusEnabled: bool(process.env.MEMBER_PLUS_ENABLED, false),
    graceDays: num(process.env.BILLING_GRACE_DAYS, 7),
    // Renewal reminders go out this many days before the period ends (0 = on the day)
    reminderDays: [7, 3, 0],
    // Only used to SUGGEST the yearly price from the monthly one when an admin sets prices: 10% off 12 months
    annualDiscountBp: 1000,
    commissionInvoice: { dueDays: 14, warnAfterDays: 1, blockAfterDays: 7, adminReviewAfterDays: 21, reminderDaysBeforeDue: [3, 0] },
    // A collector whose confirmed totals fall this far short of what members declared (after the 48h grace) is flagged
    divergence: { thresholdBp: num(process.env.DIVERGENCE_THRESHOLD_BP, 1000), minDeclaredKobo: naira(50_000), graceHours: 48 },
  },
  // Settlement Fund release: two distinct Trust Board members must approve; two rejections stop it.
  settlement: { approvalsRequired: num(process.env.RELEASE_APPROVALS_REQUIRED, 2), rejectionsToStop: 2, reminderDays: [3, 0, -2] },
  // 6. OCR / storage quotas (used by the records module)
  quotas: { storageGb: 5, ocrPagesPerMonth: 1000 },
};

export const isProduction = () => process.env.NODE_ENV === 'production';

export function tierConfig(tier: number): CustodyTier | undefined {
  return decisions.custodyTiers.find((t) => t.tier === tier);
}

export interface Gate { name: string; open: boolean; effect: string }

/** What is switched on and off right now. Production refuses gated features until the gate is opened. */
export function launchGates(): Gate[] {
  return [
    { name: 'MONNIFY_POOLING_APPROVED', open: decisions.monnifyPoolingApproved, effect: 'ESCROW collection/disbursement in production (sandbox always works)' },
    { name: 'CONSENT_DOCS_APPROVED', open: decisions.consentDocsApproved, effect: 'COLLECTOR_CUSTODY in production, and the production consent flow' },
    { name: 'BILLING_ENFORCED', open: decisions.billing.enforced, effect: 'Blocks NEW cycles for organizers with no active subscription or an unpaid commission invoice (members are never blocked)' },
    { name: 'BIOMETRIC_KYC_ENABLED', open: decisions.biometricKycEnabled, effect: 'Not implemented. Always closed in this phase' },
  ];
}

export function logLaunchGates() {
  for (const g of launchGates()) console.log(`[gate] ${g.name} = ${g.open ? 'OPEN' : 'closed'} (${g.effect})`);
  if (isProduction() && !decisions.monnifyPoolingApproved) {
    console.warn('\n⚠️  [gate] MONNIFY_POOLING_APPROVED is false in PRODUCTION. Confirm in writing with Monnify that rotational savings, group buying and settlement funds are permitted merchant use before enabling escrow.\n');
  }
}

/** Throws a clear error if a gated feature is used in production while its gate is closed. */
export function assertGateOpen(gate: 'MONNIFY_POOLING_APPROVED' | 'CONSENT_DOCS_APPROVED'): void {
  if (!isProduction()) return;
  const open = gate === 'MONNIFY_POOLING_APPROVED' ? decisions.monnifyPoolingApproved : decisions.consentDocsApproved;
  if (!open) {
    const e = new Error(`${gate} is not enabled yet, so this feature is unavailable in production.`) as Error & { status: number };
    e.status = 503;
    throw e;
  }
}
