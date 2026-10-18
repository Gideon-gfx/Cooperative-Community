import path from 'path';
import PDFDocument from 'pdfkit';
import { decisions } from '../../config/decisions';
import { prisma } from '../../lib/prisma';
import { koboToNaira } from '../../lib/kobo';
import { toCsv } from '../../services/ledger.service';
import { DAY_MS, monthlyEquivalent } from './billing.logic';

const n = (k: bigint) => koboToNaira(k);

/**
 * The admin revenue picture: subscriptions (MRR/ARR/churn), commission earned vs refunded, who owes commission,
 * which collectors' confirmed totals diverge from what members declared, and gateway fees against commission.
 */
export async function buildRevenueReport(now = new Date()) {
  // Subscriptions
  const active = await prisma.subscription.findMany({ where: { status: { in: ['ACTIVE', 'GRACE'] }, priceKobo: { not: null } } });
  const mrrKobo = active.reduce((s, x) => s + monthlyEquivalent(x.priceKobo!, x.interval), 0n);
  const since = new Date(now.getTime() - 30 * DAY_MS);
  const cancelled = await prisma.subscription.count({ where: { status: 'CANCELLED', cancelledAt: { gte: since } } });
  const lapsed = await prisma.subscription.count({ where: { status: 'LAPSED', graceEndsAt: { gte: since } } });
  const churned = cancelled + lapsed;
  const base = active.length + churned;

  // Commission
  const accruals = await prisma.commissionAccrual.groupBy({ by: ['status', 'fundsMode'], _sum: { amountKobo: true }, _count: { _all: true } });
  const sum = (status: string, mode?: string) => accruals.filter((a) => a.status === status && (!mode || a.fundsMode === mode)).reduce((s, a) => s + (a._sum.amountKobo ?? 0n), 0n);
  const invoices = await prisma.commissionInvoice.findMany({ orderBy: { createdAt: 'desc' }, take: 500 });
  const collectors = await prisma.user.findMany({ where: { id: { in: [...new Set(invoices.map((i) => i.collectorUserId))] } }, select: { id: true, fullName: true } });
  const name = (id: string) => collectors.find((c) => c.id === id)?.fullName ?? '—';
  const outstanding = invoices.filter((i) => i.status === 'PENDING');
  const byCollector = new Map<string, { collectorUserId: string; collector: string; owedKobo: bigint; invoices: number; worstLevel: number }>();
  for (const i of outstanding) {
    const cur = byCollector.get(i.collectorUserId) ?? { collectorUserId: i.collectorUserId, collector: name(i.collectorUserId), owedKobo: 0n, invoices: 0, worstLevel: 0 };
    cur.owedKobo += i.amountKobo; cur.invoices++; cur.worstLevel = Math.max(cur.worstLevel, i.escalationLevel);
    byCollector.set(i.collectorUserId, cur);
  }
  const flagged = invoices.filter((i) => i.flaggedDivergence && now.getTime() - i.createdAt.getTime() < 90 * DAY_MS);

  // Gateway fees vs commission. Real gateway fees are not reported to us per payment, so this is an ESTIMATE from the configured rate.
  const volume = await prisma.providerTransaction.aggregate({ where: { kind: 'COLLECT', status: 'PAID' }, _sum: { amountKobo: true } });
  const volumeKobo = volume._sum.amountKobo ?? 0n;
  const gatewayEstimateKobo = (volumeKobo * BigInt(decisions.gatewayFeeBp)) / 10_000n;
  const escrowCommission = sum('EARNED', 'ESCROW') + sum('PENDING', 'ESCROW');

  return {
    generatedAt: now.toISOString(),
    subscriptions: {
      active: active.length, mrr: n(mrrKobo), arr: n(mrrKobo * 12n),
      byPlan: { ORGANIZER: active.filter((x) => x.plan === 'ORGANIZER').length, MEMBER_PLUS: active.filter((x) => x.plan === 'MEMBER_PLUS').length },
      churn: { last30Days: churned, cancelled, lapsed, rateBp: base ? Math.round((churned * 10_000) / base) : 0 },
    },
    commission: {
      earned: n(sum('EARNED')), pending: n(sum('PENDING')), refunded: n(sum('REFUNDED')),
      byMode: { ESCROW: { earned: n(sum('EARNED', 'ESCROW')), refunded: n(sum('REFUNDED', 'ESCROW')) }, COLLECTOR_CUSTODY: { earned: n(sum('EARNED', 'COLLECTOR_CUSTODY')), refunded: n(sum('REFUNDED', 'COLLECTOR_CUSTODY')) } },
      invoiced: n(invoices.reduce((s, i) => s + i.amountKobo, 0n)),
      collected: n(invoices.filter((i) => i.status === 'PAID').reduce((s, i) => s + i.amountKobo, 0n)),
      outstandingTotal: n(outstanding.reduce((s, i) => s + i.amountKobo, 0n)),
      outstandingByCollector: [...byCollector.values()].map((c) => ({ ...c, owed: n(c.owedKobo), owedKobo: undefined })),
    },
    flaggedCollectors: flagged.map((i) => ({ invoiceId: i.id, collectorUserId: i.collectorUserId, collector: name(i.collectorUserId), declared: n(i.declaredKobo), confirmed: n(i.confirmedKobo), divergencePct: (i.divergenceBp / 100).toFixed(1), period: i.periodStart.toISOString().slice(0, 7) })),
    gatewayFees: {
      estimate: true, volume: n(volumeKobo), assumedRateBp: decisions.gatewayFeeBp, estimatedFees: n(gatewayEstimateKobo), escrowCommission: n(escrowCommission), bearer: decisions.gatewayFeeBearer,
      reviewBearer: decisions.gatewayFeeBp > decisions.gatewayFeeReviewThresholdBp || gatewayEstimateKobo > escrowCommission,
    },
  };
}

export type RevenueReport = Awaited<ReturnType<typeof buildRevenueReport>>;

export function revenueCsv(r: RevenueReport): string {
  return toCsv([
    ['Section', 'Metric', 'Value'],
    ['Subscriptions', 'Active', r.subscriptions.active], ['Subscriptions', 'MRR (NGN)', r.subscriptions.mrr], ['Subscriptions', 'ARR (NGN)', r.subscriptions.arr],
    ['Subscriptions', 'Churned, last 30 days', r.subscriptions.churn.last30Days], ['Subscriptions', 'Churn rate (%)', (r.subscriptions.churn.rateBp / 100).toFixed(1)],
    ['Commission', 'Earned (NGN)', r.commission.earned], ['Commission', 'Pending (NGN)', r.commission.pending], ['Commission', 'Refunded (NGN)', r.commission.refunded],
    ['Commission', 'Invoiced to collectors (NGN)', r.commission.invoiced], ['Commission', 'Collected from collectors (NGN)', r.commission.collected], ['Commission', 'Outstanding (NGN)', r.commission.outstandingTotal],
    [], ['Outstanding by collector', 'Collector', 'Owed (NGN)', 'Invoices', 'Escalation level'],
    ...r.commission.outstandingByCollector.map((c) => ['', c.collector, c.owed, c.invoices, c.worstLevel]),
    [], ['Flagged for divergence', 'Collector', 'Declared (NGN)', 'Confirmed (NGN)', 'Divergence (%)', 'Period'],
    ...r.flaggedCollectors.map((f) => ['', f.collector, f.declared, f.confirmed, f.divergencePct, f.period]),
    [], ['Gateway fees (ESTIMATE)', 'Volume (NGN)', 'Assumed rate (bp)', 'Estimated fees (NGN)', 'Escrow commission (NGN)', 'Review bearer'],
    ['', r.gatewayFees.volume, r.gatewayFees.assumedRateBp, r.gatewayFees.estimatedFees, r.gatewayFees.escrowCommission, r.gatewayFees.reviewBearer ? 'yes' : 'no'],
  ]);
}

const FONT_DIR = path.dirname(require.resolve('dejavu-fonts-ttf/ttf/DejaVuSans.ttf'));
const REG = path.join(FONT_DIR, 'DejaVuSans.ttf');
const BOLD = path.join(FONT_DIR, 'DejaVuSans-Bold.ttf');

/** A one-page statement for a calendar month (YYYY-MM): what was billed and collected in that month. */
export async function monthlyStatementPdf(month: string): Promise<Buffer> {
  const [y, m] = month.split('-').map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1));
  const to = new Date(Date.UTC(y, m, 1));
  const [subs, comms, earned, refunded] = await Promise.all([
    prisma.subscriptionInvoice.aggregate({ where: { status: 'PAID', paidAt: { gte: from, lt: to } }, _sum: { amountKobo: true }, _count: { _all: true } }),
    prisma.commissionInvoice.aggregate({ where: { status: 'PAID', paidAt: { gte: from, lt: to } }, _sum: { amountKobo: true }, _count: { _all: true } }),
    prisma.commissionAccrual.aggregate({ where: { status: 'EARNED', earnedAt: { gte: from, lt: to } }, _sum: { amountKobo: true } }),
    prisma.commissionAccrual.aggregate({ where: { status: 'REFUNDED', refundedAt: { gte: from, lt: to } }, _sum: { amountKobo: true } }),
  ]);
  const subTotal = subs._sum.amountKobo ?? 0n;
  const commTotal = comms._sum.amountKobo ?? 0n;
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const W = doc.page.width;
    doc.rect(0, 0, W, 90).fill('#C2410C');
    doc.fillColor('#FFFFFF').font(BOLD).fontSize(22).text(`CC-ÀJỌ · Revenue statement ${month}`, 50, 34);
    doc.rect(0, 90, W, 5).fill('#F6B33D');
    let yy = 130;
    const row = (label: string, value: string, bold = false) => {
      doc.fillColor('#2A1712').font(bold ? BOLD : REG).fontSize(12).text(label, 50, yy, { width: 300 });
      doc.font(BOLD).text(value, 360, yy, { width: W - 410, align: 'right' });
      yy += 26;
    };
    row('Subscriptions paid', `₦${n(subTotal)}  (${subs._count._all})`);
    row('Commission invoices paid by collectors', `₦${n(commTotal)}  (${comms._count._all})`);
    row('Total billed revenue received', `₦${n(subTotal + commTotal)}`, true);
    yy += 12;
    row('Commission earned this month (escrow + custody)', `₦${n(earned._sum.amountKobo ?? 0n)}`);
    row('Commission refunded this month (dissolved pools)', `₦${n(refunded._sum.amountKobo ?? 0n)}`);
    doc.page.margins.bottom = 0;
    doc.fillColor('#7A5C50').font(REG).fontSize(9).text('Platform revenue only. It is paid separately and never mixed with group funds.', 50, doc.page.height - 60, { align: 'center', width: W - 100 });
    doc.end();
  });
}
