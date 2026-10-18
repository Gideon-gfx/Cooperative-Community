import crypto from 'crypto';
import { BillingInterval, CommissionInvoice, FundsEntry, PlanKind, Subscription, SubscriptionInvoice } from '@prisma/client';
import { decisions } from '../../config/decisions';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/errors';
import { audit } from '../../lib/audit';
import { koboToNaira } from '../../lib/kobo';
import { safeSms } from '../../lib/notify';
import * as monnify from '../../services/monnify.service';
import { computeWaterfall } from '../payments/fee-engine';
import { commissionBpFor } from '../payments/platform-config';
import { annualFromMonthly, DAY_MS, daysUntil, divergence, escalationLevelFor, nextReminder, periodEndFor, previousMonth } from './billing.logic';

const newRef = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`.toUpperCase();
const payerEmail = (userId: string) => `payer+${userId}@cc-ajo.app`;
const ORGANIZER_ROLES = ['COLLECTOR', 'FACILITATOR', 'ADMIN'];

// ── Prices (always read from the database) ──────────────────────────────────

/** The price in force at a moment: the newest row that has started by then. Rows never overlap, so effectiveTo is informational. */
export async function priceAt(plan: PlanKind, interval: BillingInterval, at = new Date()): Promise<bigint> {
  const row = await prisma.planPrice.findFirst({ where: { plan, interval, effectiveFrom: { lte: at } }, orderBy: { effectiveFrom: 'desc' } });
  if (!row) throw new HttpError(503, 'This plan has no price set yet');
  return row.amountKobo;
}

/** An admin sets a new price from a date. The previous row is closed off; active periods keep the price they were paid at. */
export async function setPrice(adminId: string, input: { plan: PlanKind; interval: BillingInterval; amountKobo: bigint; effectiveFrom?: Date }) {
  if (input.amountKobo <= 0n) throw new HttpError(400, 'A price must be greater than zero');
  const from = input.effectiveFrom ?? new Date();
  const prev = await prisma.planPrice.findFirst({ where: { plan: input.plan, interval: input.interval }, orderBy: { effectiveFrom: 'desc' } });
  if (prev && from <= prev.effectiveFrom) throw new HttpError(409, 'The new price must start after the current one');
  if (prev) await prisma.planPrice.update({ where: { id: prev.id }, data: { effectiveTo: from } });
  const row = await prisma.planPrice.create({ data: { plan: input.plan, interval: input.interval, amountKobo: input.amountKobo, effectiveFrom: from, effectiveTo: null, createdById: adminId } });
  await audit(adminId, 'PLAN_PRICE_SET', 'PlanPrice', row.id, { plan: input.plan, interval: input.interval, amountKobo: input.amountKobo.toString(), from: from.toISOString() });
  return row;
}

/** First-run prices (naira): organizer 10,000/month, 108,000/year; member plus 2,000/month, 21,600/year. Stored in the DB, editable by an admin. */
export async function seedPlanPrices(): Promise<number> {
  const seeds: [PlanKind, BillingInterval, bigint][] = [
    ['ORGANIZER', 'MONTHLY', 1_000_000n], ['ORGANIZER', 'YEARLY', annualFromMonthly(1_000_000n)],
    ['MEMBER_PLUS', 'MONTHLY', 200_000n], ['MEMBER_PLUS', 'YEARLY', annualFromMonthly(200_000n)],
  ];
  let n = 0;
  for (const [plan, interval, amountKobo] of seeds) {
    if (await prisma.planPrice.findFirst({ where: { plan, interval } })) continue;
    await prisma.planPrice.create({ data: { plan, interval, amountKobo, effectiveFrom: new Date(0), effectiveTo: null } });
    n++;
  }
  return n;
}

// ── Subscriptions ───────────────────────────────────────────────────────────

async function checkoutFor(ref: string, amountKobo: bigint, userId: string, description: string): Promise<{ checkoutUrl: string; transactionReference: string }> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  try {
    return await monnify.initializeTransaction(Number(koboToNaira(amountKobo)), user.fullName, payerEmail(userId), ref, { purpose: description });
  } catch (e) {
    throw new HttpError(502, 'The payment service could not start this payment. Please try again.');
  }
}

export async function createSubscriptionInvoice(sub: Subscription, periodStart: Date): Promise<SubscriptionInvoice> {
  const amountKobo = await priceAt(sub.plan, sub.interval, new Date());
  const paymentReference = newRef('CCS');
  const invoice = await prisma.subscriptionInvoice.create({
    data: { subscriptionId: sub.id, userId: sub.userId, plan: sub.plan, interval: sub.interval, amountKobo, periodStart, periodEnd: periodEndFor(periodStart, sub.interval), paymentReference },
  });
  try {
    const c = await checkoutFor(paymentReference, amountKobo, sub.userId, `${sub.plan} ${sub.interval}`);
    return await prisma.subscriptionInvoice.update({ where: { id: invoice.id }, data: { checkoutUrl: c.checkoutUrl, transactionReference: c.transactionReference } });
  } catch (e) {
    await prisma.subscriptionInvoice.update({ where: { id: invoice.id }, data: { status: 'VOID' } });
    throw e;
  }
}

export async function subscribe(user: { id: string; role: string }, plan: PlanKind, interval: BillingInterval) {
  if (plan === 'ORGANIZER' && !ORGANIZER_ROLES.includes(user.role)) throw new HttpError(403, 'The organizer plan is for collectors, facilitators and admins');
  if (plan === 'MEMBER_PLUS' && !decisions.billing.memberPlusEnabled) throw new HttpError(409, 'Member Plus is not available yet');
  let sub = await prisma.subscription.findUnique({ where: { userId_plan: { userId: user.id, plan } } });
  if (!sub) sub = await prisma.subscription.create({ data: { userId: user.id, plan, interval, status: 'LAPSED', currentPeriodStart: null, currentPeriodEnd: null, graceEndsAt: null, priceKobo: null, remindersSent: [] } });
  if (sub.status === 'ACTIVE' || sub.status === 'GRACE') {
    // Already paid up: a change of interval simply takes effect at the next renewal.
    if (sub.interval !== interval || sub.cancelAtPeriodEnd) sub = await prisma.subscription.update({ where: { id: sub.id }, data: { interval, cancelAtPeriodEnd: false } });
    return { subscription: sub, invoice: null as SubscriptionInvoice | null };
  }
  sub = await prisma.subscription.update({ where: { id: sub.id }, data: { interval, status: 'LAPSED', cancelAtPeriodEnd: false, cancelledAt: null } });
  const pending = await prisma.subscriptionInvoice.findFirst({ where: { subscriptionId: sub.id, status: 'PENDING', interval } });
  const invoice = pending ?? (await createSubscriptionInvoice(sub, new Date()));
  await audit(user.id, 'SUBSCRIBED', 'Subscription', sub.id, { plan, interval });
  return { subscription: sub, invoice };
}

export async function cancelSubscription(userId: string, plan: PlanKind) {
  const sub = await prisma.subscription.findUnique({ where: { userId_plan: { userId, plan } } });
  if (!sub || sub.status === 'CANCELLED') throw new HttpError(404, 'No active subscription to cancel');
  // Cancelling never cuts a paid period short: it simply does not renew.
  const done = await prisma.subscription.update({ where: { id: sub.id }, data: { cancelAtPeriodEnd: true } });
  await audit(userId, 'SUBSCRIPTION_CANCEL_REQUESTED', 'Subscription', sub.id);
  return done;
}

/** A paid subscription invoice extends the period from where the last one ended, so paying early loses no time and paying late gains none. */
async function applySubscriptionPayment(invoice: SubscriptionInvoice, transactionReference: string) {
  const now = new Date();
  return prisma.$transaction(async (db) => {
    const claimed = await db.subscriptionInvoice.updateMany({ where: { id: invoice.id, status: 'PENDING' }, data: { status: 'PAID', paidAt: now, transactionReference } });
    if (claimed.count === 0) return null;
    const sub = await db.subscription.findUniqueOrThrow({ where: { id: invoice.subscriptionId } });
    const lapsed = sub.status === 'LAPSED' || sub.status === 'CANCELLED' || !sub.currentPeriodEnd;
    const start = lapsed ? now : invoice.periodStart;
    return db.subscription.update({
      where: { id: sub.id },
      data: { status: 'ACTIVE', currentPeriodStart: start, currentPeriodEnd: periodEndFor(start, invoice.interval), graceEndsAt: null, priceKobo: invoice.amountKobo, interval: invoice.interval, remindersSent: [], cancelledAt: null },
    });
  });
}

export type BillingOutcome = 'RECORDED' | 'DUPLICATE' | 'UNKNOWN' | 'NOT_PAID' | 'AMOUNT_MISMATCH';

/** Called by the Monnify webhook (and reconciliation) for subscription (CCS-) and commission (CCC-) references. Idempotent. */
export async function recordBillingPayment(paymentReference: string, transactionReference: string): Promise<BillingOutcome> {
  const sInv = await prisma.subscriptionInvoice.findUnique({ where: { paymentReference } });
  const cInv = sInv ? null : await prisma.commissionInvoice.findUnique({ where: { paymentReference } });
  const inv = sInv ?? cInv;
  if (!inv) return 'UNKNOWN';
  if (inv.status === 'PAID') return 'DUPLICATE';
  if (inv.status !== 'PENDING') return 'UNKNOWN';

  const live = await monnify.verifyTransaction(transactionReference);
  if (String(live.paymentStatus).toUpperCase() !== 'PAID') return 'NOT_PAID';
  if (BigInt(Math.round(Number(live.amountPaid) * 100)) < inv.amountKobo) {
    const admins = await prisma.user.findMany({ where: { role: 'ADMIN' } });
    for (const a of admins) await safeSms(a.phoneNumber, `ÀJỌ alert: invoice payment ${paymentReference} was less than the amount due. Please review.`);
    return 'AMOUNT_MISMATCH';
  }
  if (sInv) {
    const sub = await applySubscriptionPayment(sInv, transactionReference);
    if (!sub) return 'DUPLICATE';
    await audit(sInv.userId, 'SUBSCRIPTION_PAID', 'SubscriptionInvoice', sInv.id, { amountKobo: sInv.amountKobo.toString() });
    const u = await prisma.user.findUnique({ where: { id: sInv.userId } });
    await safeSms(u?.phoneNumber, `ÀJỌ: thank you. Your ${sInv.plan === 'ORGANIZER' ? 'organizer' : 'Member Plus'} plan is paid until ${sub.currentPeriodEnd?.toISOString().slice(0, 10)}.`);
    return 'RECORDED';
  }
  const claimed = await prisma.commissionInvoice.updateMany({ where: { id: cInv!.id, status: 'PENDING' }, data: { status: 'PAID', paidAt: new Date(), transactionReference } });
  if (claimed.count === 0) return 'DUPLICATE';
  await audit(cInv!.collectorUserId, 'COMMISSION_INVOICE_PAID', 'CommissionInvoice', cInv!.id, { amountKobo: cInv!.amountKobo.toString() });
  const c = await prisma.user.findUnique({ where: { id: cInv!.collectorUserId } });
  await safeSms(c?.phoneNumber, `ÀJỌ: thank you. Your commission invoice of ₦${koboToNaira(cInv!.amountKobo)} is paid.`);
  return 'RECORDED';
}

/** Gives the person a checkout link for an unpaid invoice, starting a fresh one if the first attempt never got a link. */
export async function payInvoice(userId: string, kind: 'subscription' | 'commission', invoiceId: string) {
  if (kind === 'subscription') {
    const inv = await prisma.subscriptionInvoice.findUnique({ where: { id: invoiceId } });
    if (!inv || inv.userId !== userId) throw new HttpError(404, 'Invoice not found');
    if (inv.status !== 'PENDING') throw new HttpError(409, 'This invoice is already settled');
    if (inv.checkoutUrl) return { checkoutUrl: inv.checkoutUrl, amount: koboToNaira(inv.amountKobo) };
    const ref = newRef('CCS');
    const c = await checkoutFor(ref, inv.amountKobo, userId, 'subscription');
    await prisma.subscriptionInvoice.update({ where: { id: inv.id }, data: { paymentReference: ref, checkoutUrl: c.checkoutUrl, transactionReference: c.transactionReference } });
    return { checkoutUrl: c.checkoutUrl, amount: koboToNaira(inv.amountKobo) };
  }
  const inv = await prisma.commissionInvoice.findUnique({ where: { id: invoiceId } });
  if (!inv || inv.collectorUserId !== userId) throw new HttpError(404, 'Invoice not found');
  if (inv.status !== 'PENDING') throw new HttpError(409, 'This invoice is already settled');
  if (inv.checkoutUrl) return { checkoutUrl: inv.checkoutUrl, amount: koboToNaira(inv.amountKobo) };
  const ref = newRef('CCC');
  const c = await checkoutFor(ref, inv.amountKobo, userId, 'commission');
  await prisma.commissionInvoice.update({ where: { id: inv.id }, data: { paymentReference: ref, checkoutUrl: c.checkoutUrl, transactionReference: c.transactionReference } });
  return { checkoutUrl: c.checkoutUrl, amount: koboToNaira(inv.amountKobo) };
}

/**
 * Daily: renewal reminders (7, 3 and 0 days before), the renewal invoice a week ahead, then ACTIVE → GRACE (7 days) → LAPSED.
 * A paid period is never shortened. Nothing here touches any member's money or access.
 */
export async function runSubscriptionCycle(now = new Date()) {
  const subs = await prisma.subscription.findMany({ where: { status: { in: ['ACTIVE', 'GRACE'] }, currentPeriodEnd: { not: null } } });
  const out = { reminded: 0, invoiced: 0, graced: 0, lapsed: 0, cancelled: 0 };
  for (const sub of subs) {
    const end = sub.currentPeriodEnd!;
    const user = await prisma.user.findUnique({ where: { id: sub.userId } });
    const label = sub.plan === 'ORGANIZER' ? 'organizer plan' : 'Member Plus plan';

    if (sub.status === 'ACTIVE' && now < end && !sub.cancelAtPeriodEnd) {
      const r = nextReminder(daysUntil(end, now), sub.remindersSent);
      if (r) {
        // The renewal invoice exists from a week out, so there is always a link to pay.
        let invoice = await prisma.subscriptionInvoice.findFirst({ where: { subscriptionId: sub.id, status: 'PENDING', periodStart: end } });
        if (!invoice) {
          try { invoice = await createSubscriptionInvoice(sub, end); out.invoiced++; } catch (e) { console.error('[billing] renewal invoice failed', (e as Error).message); }
        }
        const claimed = await prisma.subscription.updateMany({ where: { id: sub.id, remindersSent: { equals: sub.remindersSent } }, data: { remindersSent: [...sub.remindersSent, ...r.markSent.filter((d) => !sub.remindersSent.includes(d))] } });
        if (claimed.count > 0) {
          out.reminded++;
          await safeSms(user?.phoneNumber, r.send === 0 ? `ÀJỌ: your ${label} renews today. Please pay in the app to keep creating new cycles.` : `ÀJỌ: your ${label} ends in ${r.send} days. Please pay in the app to renew.`);
        }
      }
    }
    if (now >= end && sub.status === 'ACTIVE') {
      if (sub.cancelAtPeriodEnd) {
        await prisma.subscription.update({ where: { id: sub.id }, data: { status: 'CANCELLED', cancelledAt: now } });
        await prisma.subscriptionInvoice.updateMany({ where: { subscriptionId: sub.id, status: 'PENDING' }, data: { status: 'VOID' } });
        out.cancelled++;
      } else {
        const graceEndsAt = new Date(end.getTime() + decisions.billing.graceDays * DAY_MS);
        await prisma.subscription.update({ where: { id: sub.id }, data: { status: 'GRACE', graceEndsAt } });
        await safeSms(user?.phoneNumber, `ÀJỌ: your ${label} has ended. You have ${decisions.billing.graceDays} days to renew. Your groups and members are not affected.`);
        out.graced++;
      }
    } else if (sub.status === 'GRACE' && sub.graceEndsAt && now >= sub.graceEndsAt) {
      await prisma.subscription.update({ where: { id: sub.id }, data: { status: 'LAPSED' } });
      await prisma.subscriptionInvoice.updateMany({ where: { subscriptionId: sub.id, status: 'PENDING', periodStart: { lt: now } }, data: { status: 'VOID' } });
      await safeSms(user?.phoneNumber, `ÀJỌ: your ${label} has lapsed. Existing cycles continue to the end and members can still pay, confirm and be paid, but you cannot start new cycles until you renew.`);
      out.lapsed++;
    }
  }
  return out;
}

// ── Gating: only NEW cycles, never members ──────────────────────────────────

/**
 * Called when an organizer creates a new group or starts a new cycle, and nowhere else. Existing cycles always run to the
 * end, and members can always view, pay, confirm, dispute, be refunded and be paid. Does nothing until BILLING_ENFORCED.
 */
export async function assertCanStartCycle(user: { id: string; role: string }) {
  if (!decisions.billing.enforced || user.role === 'ADMIN') return;
  const overdue = await prisma.commissionInvoice.findFirst({ where: { collectorUserId: user.id, status: 'PENDING', escalationLevel: { gte: 2 } } });
  if (overdue) throw new HttpError(402, `COMMISSION_OVERDUE: pay your overdue commission invoice of ₦${koboToNaira(overdue.amountKobo)} to start new cycles. Your current cycles and your members are not affected.`);
  const sub = await prisma.subscription.findUnique({ where: { userId_plan: { userId: user.id, plan: 'ORGANIZER' } } });
  if (!sub || (sub.status !== 'ACTIVE' && sub.status !== 'GRACE')) {
    throw new HttpError(402, 'SUBSCRIPTION_REQUIRED: renew your organizer plan to start new cycles. Your current cycles and your members are not affected.');
  }
}

/**
 * New imports and uploads are part of the organizer plan. A lapsed organizer can NEVER lose sight of their records:
 * viewing, searching and exporting never call this. Does nothing until BILLING_ENFORCED.
 */
export async function assertCanImportRecords(user: { id: string; role: string }) {
  if (!decisions.billing.enforced || user.role === 'ADMIN') return;
  const sub = await prisma.subscription.findUnique({ where: { userId_plan: { userId: user.id, plan: 'ORGANIZER' } } });
  if (!sub || (sub.status !== 'ACTIVE' && sub.status !== 'GRACE')) {
    throw new HttpError(402, 'SUBSCRIPTION_REQUIRED: renew your organizer plan to import new records. You can still view and export all your records.');
  }
}

/** The status screen's read-only banner: new cycles are blocked, nothing else is. */
export async function organizerStatus(user: { id: string; role: string }) {
  const sub = await prisma.subscription.findUnique({ where: { userId_plan: { userId: user.id, plan: 'ORGANIZER' } } });
  const overdue = await prisma.commissionInvoice.findFirst({ where: { collectorUserId: user.id, status: 'PENDING', escalationLevel: { gte: 2 } } });
  const newCyclesBlocked = decisions.billing.enforced && user.role !== 'ADMIN' && (!!overdue || !sub || (sub.status !== 'ACTIVE' && sub.status !== 'GRACE'));
  return { subscription: sub, newCyclesBlocked, reason: overdue ? 'COMMISSION_OVERDUE' : newCyclesBlocked ? 'SUBSCRIPTION_REQUIRED' : null, enforced: decisions.billing.enforced };
}

// ── Commission (collector custody) ──────────────────────────────────────────

/**
 * A confirmed custody contribution accrues commission, exactly as an escrow one does. It is PENDING until the cycle
 * completes, EARNED then, and billed to the collector in the next monthly invoice. Fee-engine math, so receipts match.
 */
export async function accrueCustodyCommission(entry: FundsEntry, collectorUserId: string) {
  if (entry.type !== 'CONTRIBUTION' || !entry.groupId) return null;
  const bp = await commissionBpFor(entry.purposeType);
  const w = computeWaterfall({ gross: koboToNaira(entry.amountKobo), platformBp: bp });
  const kobo = BigInt(w.platformCommission.mul(100).toFixed(0));
  if (kobo <= 0n) return null;
  try {
    return await prisma.commissionAccrual.create({
      data: { groupId: entry.groupId, purposeType: entry.purposeType, purposeId: entry.purposeId, fundsEntryId: entry.id, payerUserId: entry.payerUserId, amountKobo: kobo, fundsMode: 'COLLECTOR_CUSTODY', collectorUserId, invoiceId: null },
    });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') return null; // confirming twice must not double-accrue
    throw e;
  }
}

/** Monthly: one invoice per collector for commission EARNED on completed cycles and not yet invoiced. */
export async function generateCommissionInvoices(now = new Date()) {
  const { start, end } = previousMonth(now);
  const accruals = await prisma.commissionAccrual.findMany({ where: { fundsMode: 'COLLECTOR_CUSTODY', status: 'EARNED', invoiceId: null, collectorUserId: { not: null } } });
  const byCollector = new Map<string, typeof accruals>();
  for (const a of accruals) byCollector.set(a.collectorUserId!, [...(byCollector.get(a.collectorUserId!) ?? []), a]);

  const created: CommissionInvoice[] = [];
  for (const [collectorUserId, rows] of byCollector) {
    const amountKobo = rows.reduce((s, r) => s + r.amountKobo, 0n);
    if (amountKobo <= 0n) continue;
    // What the collector confirmed vs what members declared, for the same cycles. Older than the 48h grace only.
    const purposes = [...new Set(rows.map((r) => `${r.purposeType}:${r.purposeId}`))].map((k) => ({ purposeType: k.split(':')[0] as 'AJO' | 'CCGB' | 'SETTLEMENT_FUND', purposeId: k.split(':')[1] }));
    const cutoff = new Date(now.getTime() - decisions.billing.divergence.graceHours * 3600 * 1000);
    const declared = await prisma.fundsEntry.aggregate({
      where: { fundsMode: 'COLLECTOR_CUSTODY', type: 'CONTRIBUTION', status: { in: ['DECLARED', 'CONFIRMED', 'DISPUTED'] }, createdAt: { lt: cutoff }, OR: purposes },
      _sum: { amountKobo: true },
    });
    const confirmed = await prisma.fundsEntry.aggregate({
      where: { fundsMode: 'COLLECTOR_CUSTODY', type: 'CONTRIBUTION', status: 'CONFIRMED', createdAt: { lt: cutoff }, OR: purposes },
      _sum: { amountKobo: true },
    });
    const declaredKobo = declared._sum.amountKobo ?? 0n;
    const confirmedKobo = confirmed._sum.amountKobo ?? 0n;
    const d = divergence(declaredKobo, confirmedKobo);
    try {
      const invoice = await prisma.commissionInvoice.create({
        data: {
          collectorUserId, periodStart: start, periodEnd: end, amountKobo, accrualCount: rows.length, confirmedKobo, declaredKobo, divergenceBp: d.bp, flaggedDivergence: d.flagged,
          dueAt: new Date(now.getTime() + decisions.billing.commissionInvoice.dueDays * DAY_MS), remindersSent: [], paymentReference: newRef('CCC'), checkoutUrl: null, transactionReference: null, paidAt: null,
        },
      });
      await prisma.commissionAccrual.updateMany({ where: { id: { in: rows.map((r) => r.id) }, invoiceId: null }, data: { invoiceId: invoice.id } });
      created.push(invoice);
      const u = await prisma.user.findUnique({ where: { id: collectorUserId } });
      await safeSms(u?.phoneNumber, `ÀJỌ: your commission invoice for ${start.toISOString().slice(0, 7)} is ₦${koboToNaira(amountKobo)}, due in ${decisions.billing.commissionInvoice.dueDays} days. Pay it in the app.`);
      if (d.flagged) await audit(null, 'COMMISSION_DIVERGENCE_FLAGGED', 'CommissionInvoice', invoice.id, { collectorUserId, divergenceBp: d.bp });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') continue; // this month was already invoiced for this collector
      throw e;
    }
  }
  return created;
}

/** Daily: reminders before the due date, then warn → block new cycles → admin review as an invoice ages. */
export async function chaseCommissionInvoices(now = new Date()) {
  const cfg = decisions.billing.commissionInvoice;
  const open = await prisma.commissionInvoice.findMany({ where: { status: 'PENDING' } });
  const out = { reminded: 0, escalated: 0 };
  for (const inv of open) {
    const u = await prisma.user.findUnique({ where: { id: inv.collectorUserId } });
    const dueIn = daysUntil(inv.dueAt, now);
    if (dueIn >= 0) {
      const r = nextReminder(dueIn, inv.remindersSent, cfg.reminderDaysBeforeDue);
      if (r) {
        const claimed = await prisma.commissionInvoice.updateMany({ where: { id: inv.id, remindersSent: { equals: inv.remindersSent } }, data: { remindersSent: [...inv.remindersSent, ...r.markSent.filter((d) => !inv.remindersSent.includes(d))] } });
        if (claimed.count > 0) {
          out.reminded++;
          await safeSms(u?.phoneNumber, r.send === 0 ? `ÀJỌ: your commission invoice of ₦${koboToNaira(inv.amountKobo)} is due today.` : `ÀJỌ: your commission invoice of ₦${koboToNaira(inv.amountKobo)} is due in ${r.send} days.`);
        }
      }
      continue;
    }
    const level = escalationLevelFor(Math.floor((now.getTime() - inv.dueAt.getTime()) / DAY_MS));
    if (level <= inv.escalationLevel) continue;
    const claimed = await prisma.commissionInvoice.updateMany({ where: { id: inv.id, escalationLevel: { lt: level } }, data: { escalationLevel: level } });
    if (claimed.count === 0) continue;
    out.escalated++;
    await audit(null, 'COMMISSION_ESCALATED', 'CommissionInvoice', inv.id, { level });
    if (level === 1) await safeSms(u?.phoneNumber, `ÀJỌ: your commission invoice of ₦${koboToNaira(inv.amountKobo)} is overdue. Please pay it in the app.`);
    if (level === 2) await safeSms(u?.phoneNumber, `ÀJỌ: your commission invoice is still unpaid, so you cannot start new cycles. Your current cycles and members are not affected.`);
    if (level === 3) {
      const admins = await prisma.user.findMany({ where: { role: 'ADMIN' } });
      for (const a of admins) await safeSms(a.phoneNumber, `ÀJỌ: a collector's commission invoice of ₦${koboToNaira(inv.amountKobo)} is ${cfg.adminReviewAfterDays}+ days overdue. Please review.`);
    }
  }
  return out;
}

export async function waiveCommissionInvoice(adminId: string, invoiceId: string, reason: string) {
  if (reason.trim().length < 5) throw new HttpError(400, 'Say why it is being waived');
  const done = await prisma.commissionInvoice.updateMany({ where: { id: invoiceId, status: 'PENDING' }, data: { status: 'WAIVED' } });
  if (done.count === 0) throw new HttpError(409, 'Only an unpaid invoice can be waived');
  await audit(adminId, 'COMMISSION_INVOICE_WAIVED', 'CommissionInvoice', invoiceId, { reason });
}
