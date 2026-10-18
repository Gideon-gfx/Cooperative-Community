export type FundsMode = 'ESCROW' | 'COLLECTOR_CUSTODY';

/** Shown on every payment screen and receipt, by the group's funds mode. Mirrors the backend constants. */
export const CUSTODY_NOTICE = "Your money is paid directly to your group's collector. CC-ÀJỌ only records it and does not hold it.";
export const ESCROW_NOTICE = 'Your contribution is collected through our payment partner and is only released after the required approvals.';
export const noticeFor = (mode?: FundsMode) => (mode === 'ESCROW' ? ESCROW_NOTICE : CUSTODY_NOTICE);
