import { FundsMode } from '@prisma/client';

/** Shown on every payment screen and receipt for a group in COLLECTOR_CUSTODY mode. */
export const CUSTODY_NOTICE = "Your money is paid directly to your group's collector. CC-ÀJỌ only records it and does not hold it.";
/** Shown on every payment screen and receipt for a group in ESCROW mode. */
export const ESCROW_NOTICE = 'Your contribution is collected through our payment partner and is only released after the required approvals.';

export const noticeFor = (mode: FundsMode) => (mode === 'ESCROW' ? ESCROW_NOTICE : CUSTODY_NOTICE);

/** Badge text/colour for the group mode: "Escrow" green, "Collector-held" amber. */
export const modeBadge = (mode: FundsMode) => (mode === 'ESCROW' ? { label: 'Escrow', color: 'green' } : { label: 'Collector-held', color: 'amber' });
