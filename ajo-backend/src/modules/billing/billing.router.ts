import { Router } from 'express';
import { z } from 'zod';
import { decisions } from '../../config/decisions';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/errors';
import { koboToNaira, nairaToKobo } from '../../lib/kobo';

import { authenticate, roleGuard } from '../../middleware/auth.middleware';
import { toCsv } from '../../services/ledger.service';
import { annualFromMonthly } from './billing.logic';
import { buildRevenueReport, monthlyStatementPdf, revenueCsv } from './revenue.service';
import { cancelSubscription, organizerStatus, payInvoice, setPrice, subscribe, waiveCommissionInvoice } from './billing.service';

const plan = z.enum(['ORGANIZER', 'MEMBER_PLUS']);
const interval = z.enum(['MONTHLY', 'YEARLY']);

// ── /api/billing: plans, my subscription, my invoices ──
export const billingRouter = Router();
billingRouter.use(authenticate);

/** Current prices, read from the database. Member Plus only shows when it is switched on. */
billingRouter.get('/plans', async (_req, res) => {
  const now = new Date();
  const rows = await prisma.planPrice.findMany({ where: { effectiveFrom: { lte: now } }, orderBy: { effectiveFrom: 'desc' } });
  const latest = (p: string, i: string) => rows.find((r) => r.plan === p && r.interval === i);
  const plans = (['ORGANIZER', 'MEMBER_PLUS'] as const)
    .filter((p) => p === 'ORGANIZER' || decisions.billing.memberPlusEnabled)
    .map((p) => ({ plan: p, monthly: latest(p, 'MONTHLY') ? koboToNaira(latest(p, 'MONTHLY')!.amountKobo) : null, yearly: latest(p, 'YEARLY') ? koboToNaira(latest(p, 'YEARLY')!.amountKobo) : null }));
  res.json({ plans, note: 'Custody mode costs the same as escrow: it is not a priced add-on. Members use the core product free.' });
});

billingRouter.get('/me', async (req, res) => {
  const me = req.user!;
  const [status, subs, invoices, commission] = await Promise.all([
    organizerStatus(me),
    prisma.subscription.findMany({ where: { userId: me.id } }),
    prisma.subscriptionInvoice.findMany({ where: { userId: me.id }, orderBy: { createdAt: 'desc' }, take: 24 }),
    prisma.commissionInvoice.findMany({ where: { collectorUserId: me.id }, orderBy: { createdAt: 'desc' }, take: 24 }),
  ]);
  res.json({
    organizer: status,
    subscriptions: subs.map((s) => ({ ...s, priceKobo: undefined, price: s.priceKobo === null ? null : koboToNaira(s.priceKobo) })),
    invoices: invoices.map((i) => ({ ...i, amountKobo: undefined, amount: koboToNaira(i.amountKobo) })),
    commissionInvoices: commission.map((i) => ({ ...i, amountKobo: undefined, confirmedKobo: undefined, declaredKobo: undefined, amount: koboToNaira(i.amountKobo), declared: koboToNaira(i.declaredKobo), confirmed: koboToNaira(i.confirmedKobo) })),
  });
});

billingRouter.post('/subscribe', async (req, res) => {
  const b = z.object({ plan, interval }).parse(req.body);
  const out = await subscribe(req.user!, b.plan, b.interval);
  res.status(201).json({ status: out.subscription.status, invoice: out.invoice && { id: out.invoice.id, amount: koboToNaira(out.invoice.amountKobo), checkoutUrl: out.invoice.checkoutUrl } });
});

billingRouter.post('/cancel', async (req, res) => {
  const b = z.object({ plan }).parse(req.body);
  const s = await cancelSubscription(req.user!.id, b.plan);
  res.json({ cancelAtPeriodEnd: s.cancelAtPeriodEnd, activeUntil: s.currentPeriodEnd });
});

billingRouter.post('/invoices/:id/pay', async (req, res) => {
  res.json(await payInvoice(req.user!.id, 'subscription', String(req.params.id)));
});
billingRouter.post('/commission-invoices/:id/pay', async (req, res) => {
  res.json(await payInvoice(req.user!.id, 'commission', String(req.params.id)));
});

/**
 * An extra for Member Plus: a CSV of my own payment history. Core records are never behind a plan: every member can
 * always see their own contributions, receipts and balances in the normal screens.
 */
billingRouter.get('/me/export.csv', async (req, res) => {
  if (!decisions.billing.memberPlusEnabled) throw new HttpError(404, 'Not available');
  const sub = await prisma.subscription.findUnique({ where: { userId_plan: { userId: req.user!.id, plan: 'MEMBER_PLUS' } } });
  if (!sub || (sub.status !== 'ACTIVE' && sub.status !== 'GRACE')) throw new HttpError(402, 'The history export is part of Member Plus');
  const rows = await prisma.fundsEntry.findMany({ where: { OR: [{ payerUserId: req.user!.id }, { counterpartyUserId: req.user!.id }] }, orderBy: { createdAt: 'asc' }, take: 5000 });
  const csv = toCsv([['Date', 'Type', 'Purpose', 'Amount (NGN)', 'Status', 'Mode'], ...rows.map((r) => [r.createdAt.toISOString(), r.type, r.purposeType, koboToNaira(r.amountKobo), r.status, r.fundsMode])]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="my-payment-history.csv"');
  res.send('﻿' + csv);
});

// ── /api/admin: prices, revenue ──
export const adminBillingRouter = Router();
adminBillingRouter.use(authenticate, roleGuard(['ADMIN']));

adminBillingRouter.get('/billing/prices', async (_req, res) => {
  const rows = await prisma.planPrice.findMany({ orderBy: [{ plan: 'asc' }, { interval: 'asc' }, { effectiveFrom: 'desc' }] });
  res.json({ prices: rows.map((r) => ({ ...r, amountKobo: undefined, amount: koboToNaira(r.amountKobo) })), suggestedYearlyFromMonthly: 'yearly = 12 x monthly less the annual discount' });
});

/** Sets a new effective-dated price. Subscriptions already paid keep the price they were paid at. */
adminBillingRouter.put('/billing/prices', async (req, res) => {
  const b = z.object({ plan, interval, amount: z.union([z.string(), z.number()]), effectiveFrom: z.coerce.date().optional() }).parse(req.body);
  const row = await setPrice(req.user!.id, { plan: b.plan, interval: b.interval, amountKobo: nairaToKobo(b.amount), effectiveFrom: b.effectiveFrom });
  res.json({ id: row.id, amount: koboToNaira(row.amountKobo), effectiveFrom: row.effectiveFrom, suggestedYearly: b.interval === 'MONTHLY' ? koboToNaira(annualFromMonthly(row.amountKobo)) : undefined });
});

adminBillingRouter.patch('/commission-invoices/:id/waive', async (req, res) => {
  const b = z.object({ reason: z.string().trim().min(5).max(300) }).parse(req.body);
  await waiveCommissionInvoice(req.user!.id, String(req.params.id), b.reason);
  res.json({ ok: true });
});

adminBillingRouter.get('/revenue', async (req, res) => {
  const q = z.object({ format: z.enum(['json', 'csv']).default('json') }).parse(req.query);
  const report = await buildRevenueReport();
  if (q.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="revenue.csv"');
    return void res.send('﻿' + revenueCsv(report));
  }
  res.json(report);
});

adminBillingRouter.get('/revenue/statement.pdf', async (req, res) => {
  const q = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM') }).parse(req.query);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="revenue-${q.month}.pdf"`);
  res.send(await monthlyStatementPdf(q.month));
});

