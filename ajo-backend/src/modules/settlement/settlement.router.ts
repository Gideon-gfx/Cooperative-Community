import { Router } from 'express';
import { z } from 'zod';
import { authenticate, roleGuard } from '../../middleware/auth.middleware';
import { monthlyStatementPdf } from './settlement.pdf';
import {
  approveRelease, boardQueue, cancelRelease, confirmDestination, contributeToFund, currentRelease, duesFor, fundOf, openRelease, proposeDestination, releasePreconditions, retryRelease, statement, statementCsv,
} from './settlement.service';
import { loadForUser } from '../apprenticeship/contracts.service';
import { koboToNaira } from '../../lib/kobo';

// Settlement Fund: monthly contributions through escrow, statements, and the guarded release. User ids come from the JWT.
export const settlementRouter = Router();
settlementRouter.use(authenticate);

const amount = z.union([z.string().min(1).max(20), z.number()]);

// Board and release routes are declared before the /:contractId ones so "board" and "releases" are never read as an id.
settlementRouter.get('/board/queue', roleGuard(['BOARD_MEMBER', 'ADMIN']), async (req, res) => res.json(await boardQueue(req.user!)));

settlementRouter.post('/releases/:id/destination', async (req, res) => {
  const b = z.object({ kind: z.enum(['GRADUATE', 'SUPPLIER', 'LANDLORD']), bankCode: z.string().regex(/^\d{3,6}$/), accountNumber: z.string().regex(/^\d{10}$/), note: z.string().trim().max(200).optional() }).parse(req.body);
  const r = await proposeDestination(req.user!, String(req.params.id), b);
  res.json({ status: r.status, accountName: r.accountName, nameMismatch: r.nameMismatch });
});
settlementRouter.post('/releases/:id/confirm', async (req, res) => res.json({ status: (await confirmDestination(req.user!, String(req.params.id))).status }));
settlementRouter.post('/releases/:id/approve', roleGuard(['BOARD_MEMBER']), async (req, res) => {
  const b = z.object({ approve: z.boolean(), note: z.string().trim().max(300).optional() }).parse(req.body);
  res.json(await approveRelease(req.user!, String(req.params.id), b));
});
settlementRouter.post('/releases/:id/retry', async (req, res) => res.json(await retryRelease(req.user!, String(req.params.id))));
settlementRouter.post('/releases/:id/cancel', async (req, res) => { await cancelRelease(req.user!, String(req.params.id)); res.json({ ok: true }); });

settlementRouter.get('/:contractId', async (req, res) => res.json(await statement(req.user!, String(req.params.contractId))));
settlementRouter.get('/:contractId/dues', async (req, res) => {
  const { c } = await loadForUser(req.user!, String(req.params.contractId));
  const fund = await fundOf(c.id);
  const { states } = await duesFor(fund, c.masterId);
  res.json({ dues: states.map((s) => ({ number: s.number, dueDate: s.dueDate.toISOString().slice(0, 10), amount: koboToNaira(s.amountKobo), paid: koboToNaira(s.paidKobo), remaining: koboToNaira(s.remainingKobo), status: s.status })) });
});
settlementRouter.post('/:contractId/contribute', async (req, res) => {
  const b = z.object({ amount: amount.optional(), asMatch: z.boolean().optional() }).parse(req.body ?? {});
  const out = await contributeToFund(req.user!, String(req.params.contractId), b);
  res.status(201).json({ mode: out.mode, notice: out.notice, waterfall: out.waterfall, result: out.result.kind === 'CHECKOUT' ? out.result : { kind: out.result.kind } });
});
settlementRouter.get('/:contractId/statement.csv', async (req, res) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="settlement-statement.csv"');
  res.send('﻿' + (await statementCsv(req.user!, String(req.params.contractId))));
});
settlementRouter.get('/:contractId/statement.pdf', async (req, res) => {
  const q = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM') }).parse(req.query);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="settlement-${q.month}.pdf"`);
  res.send(await monthlyStatementPdf(req.user!, String(req.params.contractId), q.month));
});

settlementRouter.get('/:contractId/release', async (req, res) => res.json({ release: await currentRelease(req.user!, String(req.params.contractId)) }));
settlementRouter.get('/:contractId/release/check', async (req, res) => {
  await loadForUser(req.user!, String(req.params.contractId));
  const p = await releasePreconditions(String(req.params.contractId));
  res.json({ ready: p.unmet.length === 0, unmet: p.unmet, balance: koboToNaira(p.balanceKobo) });
});
settlementRouter.post('/:contractId/release', async (req, res) => {
  const r = await openRelease(req.user!, String(req.params.contractId));
  res.status(201).json({ id: r.id, status: r.status });
});
