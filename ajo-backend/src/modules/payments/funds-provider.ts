import { FundsEntry, FundsMode, FundsPurpose } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/errors';

// Every money-moving feature calls ONLY this interface, never Monnify or bank logic directly.
// ESCROW  -> MonnifyEscrowProvider: Monnify collects, the app tracks, Monnify disburses after the required approvals.
// COLLECTOR_CUSTODY -> CollectorCustodyProvider: members pay the collector's own bank account; the app is a ledger and never moves money.

export interface CollectInput {
  groupId: string;
  payerUserId: string;
  purposeType: FundsPurpose;
  purposeId: string;
  /** The contribution (gross), in kobo. */
  amountKobo: bigint;
  // Escrow
  /** What the payer is actually charged. Gross, plus the gateway fee when the PAYER bears it. */
  chargeKobo?: bigint;
  payerName?: string;
  // Custody
  facilitatorAccountId?: string;
  bankReference?: string;
  proofImageUrl?: string;
}

export type CollectResult =
  | { kind: 'CHECKOUT'; checkoutUrl: string; paymentReference: string }
  | { kind: 'DECLARED'; entry: FundsEntry };

export interface ReleaseInput {
  groupId: string;
  purposeType: FundsPurpose;
  purposeId: string;
  /** The person who authorised this. The caller has already checked the approvals the purpose requires. */
  actorId: string;
  recipientUserId: string;
  amountKobo: bigint;
  note?: string;
  // Escrow: where Monnify sends the money
  destination?: { bankCode: string; accountNumber: string; accountName?: string };
  // Custody
  facilitatorAccountId?: string;
  bankReference?: string;
  proofImageUrl?: string;
}

export interface RefundInput {
  /** The confirmed CONTRIBUTION being refunded. Refunds are always the full contribution, commission included. */
  entryId: string;
  actorId: string;
  reason?: string;
  bankReference?: string;
  proofImageUrl?: string;
}

export interface AdjustmentInput { adminId: string; entryId: string; amountKobo: bigint; note: string }

export interface FundsFilter { groupId?: string; purposeType?: FundsPurpose; purposeId?: string; payerUserId?: string; facilitatorAccountId?: string; fundsMode?: FundsMode }
export interface Totals { contributions: bigint; adjustments: bigint; releases: bigint; refunds: bigint; commissions: bigint; balance: bigint }

export interface FundsProvider {
  readonly mode: FundsMode;
  collect(input: CollectInput): Promise<CollectResult>;
  /** Custody: the facilitator (or recipient) confirms the money moved. Escrow: confirmation is automatic. */
  confirm(entryId: string, confirmerId: string): Promise<FundsEntry>;
  dispute(entryId: string, disputerId: string, note: string): Promise<FundsEntry>;
  release(input: ReleaseInput): Promise<FundsEntry>;
  refund(input: RefundInput): Promise<FundsEntry>;
  /** Correct a mistake with a new signed entry. Amounts are never edited. */
  adjust(input: AdjustmentInput): Promise<FundsEntry>;
  totals(filter: FundsFilter): Promise<Totals>;
}

/**
 * Balances are always derived from CONFIRMED rows: money in (contributions, adjustments) minus money out
 * (releases, refunds) minus the platform's commission. Nothing is stored and nothing is ever edited.
 */
export async function deriveTotals(filter: FundsFilter): Promise<Totals> {
  const rows = await prisma.fundsEntry.groupBy({ by: ['type'], where: { status: 'CONFIRMED', ...filter }, _sum: { amountKobo: true } });
  const sum = (t: string) => rows.find((r) => r.type === t)?._sum.amountKobo ?? 0n;
  const contributions = sum('CONTRIBUTION');
  const adjustments = sum('ADJUSTMENT');
  const releases = sum('RELEASE');
  const refunds = sum('REFUND');
  const commissions = sum('COMMISSION');
  return { contributions, adjustments, releases, refunds, commissions, balance: contributions + adjustments - releases - refunds - commissions };
}

/** Money that has been promised out but not yet confirmed (release/refund waiting on the bank or the recipient). */
export async function pendingOutKobo(filter: FundsFilter): Promise<bigint> {
  const r = await prisma.fundsEntry.aggregate({ where: { type: { in: ['RELEASE', 'REFUND'] }, status: 'DECLARED', ...filter }, _sum: { amountKobo: true } });
  return r._sum.amountKobo ?? 0n;
}

export const entryRef = (id: string) => `FE-${id.slice(-6).toUpperCase()}`;

// Providers are imported lazily to avoid a cycle: they import the helpers above.
export async function getFundsProvider(mode: FundsMode): Promise<FundsProvider> {
  if (mode === 'ESCROW') return new (await import('./monnify-escrow.provider')).MonnifyEscrowProvider();
  if (mode === 'COLLECTOR_CUSTODY') return new (await import('./collector-custody.provider')).CollectorCustodyProvider();
  throw new HttpError(500, 'Unknown funds mode');
}
