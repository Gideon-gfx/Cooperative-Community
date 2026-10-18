import { prisma } from './prisma';
import { HttpError } from './errors';

export async function assertGroupMember(groupId: string, userId: string) {
  const m = await prisma.groupMember.findUnique({ where: { groupId_userId: { groupId, userId } } });
  if (!m) throw new HttpError(403, 'You are not a member of this group');
}

export async function assertGroupAdmin(groupId: string, userId: string, allowPlatformAdmin = false, role?: string) {
  const g = await prisma.communityGroup.findUnique({ where: { id: groupId } });
  if (!g) throw new HttpError(404, 'Group not found');
  if (g.adminId !== userId && !(allowPlatformAdmin && role === 'ADMIN')) {
    throw new HttpError(403, 'Only the group admin can do this');
  }
  return g;
}
