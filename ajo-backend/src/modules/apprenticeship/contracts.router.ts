import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { HttpError } from '../../lib/errors';
import { koboToNaira } from '../../lib/kobo';
import { objectId } from '../../lib/validators';
import { authenticate, roleGuard } from '../../middleware/auth.middleware';
import { publicBaseUrl } from '../../services/storage.service';
import { buildContractPdf } from './contracts.pdf';
import {
  applyAsMaster, conductFor, logConduct, createContract, decideMaster, editDraft, getContract, loadForUser, myContracts, pauseContract, pendingMasters, resumeContract, reviewMilestone, setMyDateOfBirth,
  signContract, startMilestone, submitForSignatures, submitMilestone, terminateContract, tryActivate,
} from './contracts.service';

// Igba Boyi apprenticeship agreements. Every person id comes from the JWT, never from the request body.
export const contractsRouter = Router();

/** Public: lets anyone who scans the QR code on a printed agreement check it is real. Shows no names. */
contractsRouter.get('/verify/:id', async (req, res) => {
  const id = z.string().regex(/^[a-f\d]{24}$/i).safeParse(req.params.id);
  const c = id.success ? await prisma.apprenticeshipContract.findUnique({ where: { id: id.data }, include: { signatures: true } }) : null;
  if (!c || c.status === 'DRAFT') return void res.status(404).json({ valid: false });
  res.json({ valid: true, status: c.status, tradeCategory: c.tradeCategory, durationMonths: c.durationMonths, startDate: c.startDate, signedBy: c.signatures.map((s) => s.signerRole) });
});

contractsRouter.use(authenticate);

const amount = z.union([z.string().min(1).max(20), z.number()]);

// ── Trade masters and date of birth ──
contractsRouter.post('/masters/apply', async (req, res) => {
  const b = z.object({ tradeCategories: z.array(z.string().trim().min(2).max(40)).min(1).max(10) }).parse(req.body);
  res.status(201).json({ status: (await applyAsMaster(req.user!, b.tradeCategories)).status });
});
contractsRouter.get('/masters/pending', async (req, res) => res.json({ applications: await pendingMasters(req.user!) }));
contractsRouter.patch('/masters/:userId/decision', roleGuard(['ADMIN', 'BOARD_MEMBER']), async (req, res) => {
  const b = z.object({ approve: z.boolean(), note: z.string().trim().max(300).optional() }).parse(req.body);
  res.json({ status: (await decideMaster(req.user!, String(req.params.userId), b.approve, b.note)).status });
});
contractsRouter.post('/me/date-of-birth', async (req, res) => {
  const b = z.object({ dateOfBirth: z.coerce.date() }).parse(req.body);
  await setMyDateOfBirth(req.user!.id, b.dateOfBirth);
  res.json({ ok: true });
});

// ── Contracts ──
contractsRouter.post('/', async (req, res) => {
  const b = z
    .object({
      groupId: objectId, tradeCategory: z.string().trim().min(2).max(40), durationMonths: z.number().int(), monthlyContribution: amount, targetSettlement: amount, monthlyStipend: amount.optional(),
      termsAndConditions: z.string().trim().min(30).max(10_000), apprenticePhone: z.string().min(6).max(20), guarantorPhone: z.string().min(6).max(20), guardianPhone: z.string().min(6).max(20).optional(),
      milestones: z.array(z.object({ title: z.string().trim().min(2).max(120), description: z.string().trim().max(500).optional(), dueMonth: z.number().int().min(1).max(24) })).max(24).optional(),
    })
    .parse(req.body);
  // The master is always the signed-in user. There is no masterId in the body to forge.
  const c = await createContract(req.user!, b);
  res.status(201).json({ id: c.id, status: c.status });
});

contractsRouter.get('/mine', async (req, res) => res.json({ contracts: await myContracts(req.user!) }));
contractsRouter.get('/:id', async (req, res) => res.json(await getContract(req.user!, String(req.params.id))));

contractsRouter.patch('/:id', async (req, res) => {
  const b = z.object({ termsAndConditions: z.string().trim().min(30).max(10_000).optional(), monthlyContribution: amount.optional(), targetSettlement: amount.optional(), monthlyStipend: amount.nullable().optional() }).parse(req.body);
  await editDraft(req.user!, String(req.params.id), b);
  res.json(await getContract(req.user!, String(req.params.id)));
});
contractsRouter.post('/:id/send', async (req, res) => {
  await submitForSignatures(req.user!, String(req.params.id));
  res.json(await getContract(req.user!, String(req.params.id)));
});
contractsRouter.post('/:id/sign', async (req, res) => {
  const b = z.object({ typedName: z.string().trim().min(2).max(120), signatureImageUrl: z.string().url() }).parse(req.body);
  const out = await signContract(req.user!, String(req.params.id), b, { ipAddress: req.ip ?? 'unknown', userAgent: req.header('user-agent') ?? 'unknown' });
  res.status(201).json(out);
});
/** Retry the start: for example after a group was switched back to escrow while everyone had already signed. */
contractsRouter.post('/:id/activate', async (req, res) => {
  await loadForUser(req.user!, String(req.params.id));
  res.json(await tryActivate(String(req.params.id)));
});

contractsRouter.post('/:id/pause', async (req, res) => {
  const b = z.object({ reason: z.string().trim().min(5).max(300) }).parse(req.body);
  await pauseContract(req.user!, String(req.params.id), b.reason);
  res.json(await getContract(req.user!, String(req.params.id)));
});
contractsRouter.post('/:id/resume', async (req, res) => {
  await resumeContract(req.user!, String(req.params.id));
  res.json(await getContract(req.user!, String(req.params.id)));
});
contractsRouter.post('/:id/terminate', async (req, res) => {
  const b = z.object({ reason: z.string().trim().min(5).max(300) }).parse(req.body);
  await terminateContract(req.user!, String(req.params.id), b.reason);
  res.json(await getContract(req.user!, String(req.params.id)));
});

contractsRouter.patch('/milestones/:id/start', async (req, res) => res.json({ status: (await startMilestone(req.user!, String(req.params.id))).status }));
contractsRouter.patch('/milestones/:id/submit', async (req, res) => {
  const b = z.object({ evidenceUrl: z.string().url().optional(), note: z.string().trim().max(500).optional() }).parse(req.body ?? {});
  res.json({ status: (await submitMilestone(req.user!, String(req.params.id), b)).status });
});
contractsRouter.patch('/milestones/:id/review', async (req, res) => {
  const b = z.object({ approve: z.boolean(), note: z.string().trim().max(500).optional(), badgeSkill: z.string().trim().min(2).max(60).optional() }).parse(req.body);
  res.json({ status: (await reviewMilestone(req.user!, String(req.params.id), b)).status });
});

contractsRouter.post('/:id/conduct', async (req, res) => {
  const b = z.object({ category: z.enum(['PUNCTUALITY', 'SKILL_PROGRESS', 'HONESTY', 'ATTITUDE', 'SAFETY', 'TEACHING', 'FAIR_TREATMENT', 'WELFARE', 'OTHER']), rating: z.number().int().min(1).max(5), note: z.string().trim().max(500).optional() }).parse(req.body);
  const log = await logConduct(req.user!, String(req.params.id), b);
  res.status(201).json({ id: log.id, about: log.ratedParty });
});
contractsRouter.get('/:id/conduct', async (req, res) => res.json({ logs: await conductFor(req.user!, String(req.params.id)) }));

/** The signed agreement as a PDF, generated on the spot and only for the people it is about. */
contractsRouter.get('/:id/pdf', async (req, res) => {
  const { c } = await loadForUser(req.user!, String(req.params.id));
  if (c.status === 'DRAFT') throw new HttpError(409, 'The agreement has not been sent for signatures yet');
  const names = await prisma.user.findMany({ where: { id: { in: [c.masterId, c.apprenticeId, c.guarantorId, ...(c.guardianId ? [c.guardianId] : [])] } }, select: { id: true, fullName: true } });
  const group = await prisma.communityGroup.findUniqueOrThrow({ where: { id: c.communityGroupId }, select: { name: true } });
  const n = (id: string) => names.find((x) => x.id === id)?.fullName ?? '—';
  const pdf = await buildContractPdf({
    contractId: c.id, status: c.status, tradeCategory: c.tradeCategory, durationMonths: c.durationMonths, startDate: c.startDate, endDate: c.endDate, groupName: group.name,
    parties: [{ role: 'MASTER', name: n(c.masterId) }, { role: 'APPRENTICE', name: n(c.apprenticeId) }, { role: 'GUARANTOR', name: n(c.guarantorId) }, ...(c.guardianId ? [{ role: 'PARENT_GUARDIAN', name: n(c.guardianId) }] : [])],
    monthlyContribution: koboToNaira(c.monthlyContributionKobo), targetSettlement: koboToNaira(c.targetSettlementKobo), monthlyStipend: c.monthlyStipendKobo === null ? null : koboToNaira(c.monthlyStipendKobo),
    terms: c.termsAndConditions, signatures: c.signatures.map((s) => ({ role: s.signerRole, typedName: s.typedName, signedAt: s.signedAt, ip: s.ipAddress, imageUrl: s.signatureImageUrl })),
    verifyUrl: `${publicBaseUrl()}/api/contracts/verify/${c.id}`,
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="agreement-${c.id.slice(-6)}.pdf"`);
  res.send(pdf);
});

