import { Router } from 'express';
import { z } from 'zod';
import { objectId } from '../../lib/validators';
import { authenticate, roleGuard } from '../../middleware/auth.middleware';
import {
  addBoardMember, appealLog, assignGroupToBoard, boardDashboard, collectorProfile, createBoard, decideBoardMember, listBoards, listGroupsForAssignment, myTrust, publicTrust, recomputeGuarantor, resolveAppeal, trustForBoard, verifyGuarantor,
} from './trust.service';

// Community Trust Board, guarantors and trust scores. Every user id comes from the JWT.
export const trustRouter = Router();
trustRouter.use(authenticate);

// ── Boards (admin) ──
trustRouter.get('/boards', async (req, res) => res.json({ boards: await listBoards(req.user!) }));
trustRouter.get('/groups', roleGuard(['ADMIN']), async (req, res) => res.json({ groups: await listGroupsForAssignment(req.user!) }));
trustRouter.post('/boards', roleGuard(['ADMIN']), async (req, res) => {
  const b = z.object({ name: z.string().trim().min(3).max(80), community: z.string().trim().min(2).max(60) }).parse(req.body);
  const board = await createBoard(req.user!, b);
  res.status(201).json({ id: board.id });
});
trustRouter.post('/boards/:id/members', roleGuard(['ADMIN']), async (req, res) => {
  const b = z.object({ phone: z.string().min(6).max(20), title: z.string().trim().min(3).max(60) }).parse(req.body);
  const m = await addBoardMember(req.user!, String(req.params.id), b);
  res.status(201).json({ id: m.id, status: m.status });
});
trustRouter.patch('/board-members/:id', roleGuard(['ADMIN']), async (req, res) => {
  const b = z.object({ approve: z.boolean() }).parse(req.body);
  res.json({ status: (await decideBoardMember(req.user!, String(req.params.id), b.approve)).status });
});
trustRouter.post('/boards/:id/groups', roleGuard(['ADMIN']), async (req, res) => {
  const b = z.object({ groupId: objectId }).parse(req.body);
  await assignGroupToBoard(req.user!, String(req.params.id), b.groupId);
  res.json({ ok: true });
});

// ── The board's dashboard ──
trustRouter.get('/dashboard', async (req, res) => res.json(await boardDashboard(req.user!)));

// ── Guarantors ──
trustRouter.post('/guarantors/:userId/verify', roleGuard(['ADMIN', 'BOARD_MEMBER']), async (req, res) => {
  const g = await verifyGuarantor(req.user!, String(req.params.userId));
  res.json({ verified: !!g.verifiedAt });
});
trustRouter.get('/guarantors/me', async (req, res) => {
  const g = await recomputeGuarantor(req.user!.id);
  res.json({ verified: !!g.verifiedAt, contractsGuaranteed: g.contractsGuaranteed, active: g.active, completed: g.completed, terminated: g.terminated });
});

// ── Scores ──
trustRouter.get('/me', async (req, res) => res.json({ scores: await myTrust(req.user!) }));
/** The public face of anyone: a tier and badges. No number. */
trustRouter.get('/users/:id/public', async (req, res) => res.json(await publicTrust(String(req.params.id))));
/** The full breakdown of anyone: the Trust Board and admins only. */
trustRouter.get('/users/:id', async (req, res) => res.json({ scores: await trustForBoard(req.user!, String(req.params.id)) }));
trustRouter.get('/groups/:groupId/collector', async (req, res) => res.json(await collectorProfile(req.user!, String(req.params.groupId))));

// ── Appeals ──
trustRouter.post('/appeals', async (req, res) => {
  const b = z.object({ conductLogId: objectId, reason: z.string().trim().min(10).max(500) }).parse(req.body);
  const a = await appealLog(req.user!, b.conductLogId, b.reason);
  res.status(201).json({ id: a.id, status: a.status });
});
trustRouter.post('/appeals/:id/resolve', roleGuard(['BOARD_MEMBER', 'ADMIN']), async (req, res) => {
  const b = z.object({ uphold: z.boolean(), note: z.string().trim().min(5).max(500) }).parse(req.body);
  res.json({ status: (await resolveAppeal(req.user!, String(req.params.id), b)).status });
});
