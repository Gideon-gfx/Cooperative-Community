import { ObjectId } from 'mongodb';
import { getMongoDb } from '../lib/mongodb';
import { findUserById } from '../lib/mongo-users';
import { computeTrustScore } from '../modules/ajo/ajo.logic';

export async function getTrustNative(userId: string) {
  const db = await getMongoDb();
  const contributorId = ObjectId.createFromHexString(userId);
  const contributions = db.collection<{ wasLate: boolean; coveredByCollector: boolean; ajoPoolId: ObjectId; status: string; contributorId: ObjectId }>('AjoContribution');
  const [verifiedRows, missed, poolIds] = await Promise.all([
    contributions.find({ contributorId, status: 'VERIFIED' }, { projection: { wasLate: 1, coveredByCollector: 1 } }).toArray(),
    contributions.countDocuments({ contributorId, status: 'MISSED' }),
    contributions.distinct('ajoPoolId', { contributorId }),
  ]);
  const completedPoolIds = poolIds.filter((id): id is ObjectId => id instanceof ObjectId);
  const completedPools = completedPoolIds.length
    ? await db.collection('AjoPool').countDocuments({ _id: { $in: completedPoolIds }, status: 'COMPLETED' })
    : 0;
  const covered = verifiedRows.filter((row) => row.coveredByCollector).length;
  const paid = verifiedRows.filter((row) => !row.coveredByCollector);
  const late = paid.filter((row) => row.wasLate).length;
  return computeTrustScore({ verified: paid.length, onTime: paid.length - late, late, missed: missed + covered, completedPools });
}

export async function getCollectorStatsNative(userId: string) {
  const db = await getMongoDb();
  const adminId = ObjectId.createFromHexString(userId);
  const groups = await db.collection('CommunityGroup').find({ adminId }, { projection: { _id: 1 } }).toArray();
  const groupIds = groups.map((group) => group._id);
  const poolIds = groupIds.length
    ? (await db.collection('AjoPool').find({ groupId: { $in: groupIds } }, { projection: { _id: 1 } }).toArray()).map((pool) => pool._id)
    : [];
  const [completedPayouts, confirmedPayouts, openDisputes, user] = await Promise.all([
    poolIds.length ? db.collection('AjoRotationSchedule').countDocuments({ status: 'COMPLETED', ajoPoolId: { $in: poolIds } }) : 0,
    poolIds.length ? db.collection('AjoRotationSchedule').countDocuments({ recipientConfirmedAt: { $ne: null }, ajoPoolId: { $in: poolIds } }) : 0,
    groupIds.length ? db.collection('Dispute').countDocuments({ groupId: { $in: groupIds }, status: { $in: ['OPEN', 'ESCALATED'] } }) : 0,
    findUserById(userId),
  ]);
  return { verified: !!user?.collectorApproved, groups: groupIds.length, completedPayouts, confirmedPayouts, openDisputes };
}
