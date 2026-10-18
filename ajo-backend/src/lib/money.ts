/** Formats an amount in the group's currency, e.g. ₦5,000 or GH₵20. */
export function money(amount: number | string, currency = 'NGN'): string {
  const n = Number(amount);
  const symbols: Record<string, string> = { NGN: '₦', GHS: 'GH₵', KES: 'KSh ' };
  const sym = symbols[currency];
  const body = n.toLocaleString('en-NG', { maximumFractionDigits: 2 });
  return sym ? `${sym}${body}` : `${currency} ${body}`;
}

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
