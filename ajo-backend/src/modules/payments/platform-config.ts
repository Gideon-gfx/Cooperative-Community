import { FundsPurpose } from '@prisma/client';
import { decisions } from '../../config/decisions';
import { prisma } from '../../lib/prisma';

/** The live, admin-editable pricing row. Created from the decisions defaults the first time it is read. */
export async function getPlatformConfig() {
  const existing = await prisma.platformConfig.findUnique({ where: { key: 'default' } });
  if (existing) return existing;
  return prisma.platformConfig.create({
    data: { key: 'default', platformCommissionBp: decisions.defaultPlatformCommissionBp, settlementCommissionBp: decisions.settlementCommissionBp, gatewayFeeBearer: decisions.gatewayFeeBearer },
  });
}

/** Apprenticeship settlement funds have their own (default 0%) commission, so the graduate's seed capital stays whole. */
export async function commissionBpFor(purpose: FundsPurpose): Promise<number> {
  const c = await getPlatformConfig();
  return purpose === 'SETTLEMENT_FUND' ? c.settlementCommissionBp : c.platformCommissionBp;
}
