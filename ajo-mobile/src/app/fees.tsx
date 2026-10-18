import { useState } from 'react';
import { Text, View } from 'react-native';
import { useAuth } from '../auth/AuthContext';
import { Card, Screen, s } from '../components/ui';
import { Chips, Field, LedgerNotice } from '../components/widgets';
import { FeeBreakdown, useFeePreview, type FeePurpose } from '../components/fees';
import { LangToggle, StatusCard } from '../components/igba';

// "What happens to my naira?" Anyone can try an amount before paying anything.
export default function FeePreview() {
  const { t } = useAuth();
  const [amount, setAmount] = useState('10000');
  const [purpose, setPurpose] = useState<FeePurpose>('AJO');
  const [collectorFeePct, setCollectorFeePct] = useState('');
  const [transport, setTransport] = useState('');
  const q = useFeePreview(amount, purpose, { collectorFeePct: collectorFeePct || undefined, transportFee: purpose === 'CCGB' ? transport || undefined : undefined });
  return (
    <Screen>
      <LangToggle />
      <StatusCard tone="green" title={t('ib_feeTitle')} body={t('ib_feeIntro')} speakText={t('ib_feeIntro')} />
      <Chips<FeePurpose> value={purpose} onChange={setPurpose} options={[{ value: 'AJO', label: t('ib_purpose_AJO') }, { value: 'CCGB', label: t('ib_purpose_CCGB') }, { value: 'SETTLEMENT_FUND', label: t('ib_purpose_SETTLEMENT_FUND') }]} />
      <Field label={t('ib_amountNaira')} value={amount} onChangeText={setAmount} keyboardType="numeric" />
      <Field label={t('ib_collectorFeePct')} value={collectorFeePct} onChangeText={setCollectorFeePct} keyboardType="numeric" placeholder="0" />
      {purpose === 'CCGB' && <Field label={t('ib_transportFee')} value={transport} onChangeText={setTransport} keyboardType="numeric" />}
      {q.data ? <FeeBreakdown w={q.data.waterfall} bp={q.data.platformCommissionBp} /> : <Card><Text style={s.muted}>{t('ib_feeEnter')}</Text></Card>}
      <View><LedgerNotice mode="ESCROW" /></View>
    </Screen>
  );
}
