import { prisma } from '../../lib/prisma';

// Who sits on the Trust Board for a community. A group that has been given a board is overseen by that board's approved
// members. A group with none is overseen by the platform-wide board: every user with the board role who has no board of
// their own. Platform admins oversee everything.

export async function approvedBoardIds(userId: string): Promise<string[]> {
  const rows = await prisma.trustBoardMember.findMany({ where: { userId, status: 'APPROVED' } });
  return rows.map((r) => r.boardId);
}

export async function boardIdOfGroup(groupId?: string | null): Promise<string | null> {
  if (!groupId) return null;
  const g = await prisma.communityGroup.findUnique({ where: { id: groupId } });
  return g?.trustBoardId ?? null;
}

/** The people to tell, and the only people who may act, for this group's community. */
export async function boardMemberIdsFor(groupId?: string | null): Promise<string[]> {
  const boardId = await boardIdOfGroup(groupId);
  if (boardId) return (await prisma.trustBoardMember.findMany({ where: { boardId, status: 'APPROVED' } })).map((m) => m.userId);
  const global = await prisma.user.findMany({ where: { role: 'BOARD_MEMBER' } });
  const withBoards = new Set((await prisma.trustBoardMember.findMany({ where: { status: 'APPROVED' } })).map((m) => m.userId));
  return global.filter((u) => !withBoards.has(u.id)).map((u) => u.id);
}

export async function isBoardMemberFor(userId: string, groupId?: string | null): Promise<boolean> {
  return (await boardMemberIdsFor(groupId)).includes(userId);
}

/** Which groups a board user oversees. Admins see all. */
export async function groupIdsOverseenBy(user: { id: string; role: string }): Promise<'ALL' | string[]> {
  if (user.role === 'ADMIN') return 'ALL';
  const boards = await approvedBoardIds(user.id);
  // MongoDB: a group that was never given a board has no stored field at all, so "no board" matches both null and unset.
  const groups = await prisma.communityGroup.findMany({ where: boards.length ? { trustBoardId: { in: boards } } : { OR: [{ trustBoardId: null }, { trustBoardId: { isSet: false } }] }, select: { id: true } });
  return groups.map((g) => g.id);
}
