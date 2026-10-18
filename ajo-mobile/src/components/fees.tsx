import { Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { api, naira } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { colors, fonts } from '../theme';
import { Card, s } from './ui';

export interface Waterfall { gross: string; platformCommission: string; collectorFee: string; transportFee: string; gatewayFeeFromNet: string; net: string; payerTotal: string }
export type FeePurpose = 'AJO' | 'CCGB' | 'SETTLEMENT_FUND';

/** Where each naira goes, in the fixed order the server uses. Shown before anyone pays. */
export function FeeBreakdown({ w, bp }: { w: Waterfall; bp?: number }) {
  const { t } = useAuth();
  const line = (label: string, value: string, strong = false, minus = false) => (
    <View style={s.row} key={label}>
      <Text style={[s.body, strong && { fontFamily: fonts.bodyBold }]}>{label}</Text>
      <Text style={[s.money, { fontSize: 16 }, strong && { fontFamily: fonts.mono, color: colors.green }]}>{minus ? '− ' : ''}{naira(value)}</Text>
    </View>
  );
  return (
    <Card>
      {line(t('ib_fee_gross'), w.gross, true)}
      {line(`${t('ib_fee_platform')}${bp !== undefined ? ` (${(bp / 100).toFixed(bp % 100 ? 2 : 0)}%)` : ''}`, w.platformCommission, false, true)}
      {Number(w.collectorFee) > 0 && line(t('ib_fee_collector'), w.collectorFee, false, true)}
      {Number(w.transportFee) > 0 && line(t('ib_fee_transport'), w.transportFee, false, true)}
      {Number(w.gatewayFeeFromNet) > 0 && line(t('ib_fee_gateway'), w.gatewayFeeFromNet, false, true)}
      <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 4 }} />
      {line(t('ib_fee_net'), w.net, true)}
      {Number(w.payerTotal) !== Number(w.gross) && line(t('ib_fee_payerTotal'), w.payerTotal)}
    </Card>
  );
}

export function useFeePreview(amount: string, purpose: FeePurpose, extra: { collectorFeePct?: string; transportFee?: string } = {}) {
  const ok = Number(amount) > 0;
  return useQuery({
    enabled: ok, queryKey: ['fee-preview', amount, purpose, extra.collectorFeePct, extra.transportFee],
    queryFn: async () => (await api.get<{ waterfall: Waterfall; platformCommissionBp: number }>('/fees/preview', { params: { amount, purpose, ...(extra.collectorFeePct ? { collectorFeePct: extra.collectorFeePct } : {}), ...(extra.transportFee ? { transportFee: extra.transportFee } : {}) } })).data,
  });
}
