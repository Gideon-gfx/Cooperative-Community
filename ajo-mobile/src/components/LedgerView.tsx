import { useState } from 'react';
import { Share, Text, View } from 'react-native';
import { Alert } from './feedback';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { api, errMsg, money } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { colors } from '../theme';
import { Button, Card, Loading, Screen, Sheet, s } from './ui';
import { Chips, Field, SectionTitle, usePinPrompt, usePinRequiredHandler } from './widgets';

interface Entry { id: string; direction: 'IN' | 'OUT'; type: string; amount: number; note?: string; createdAt: string }
interface Ledger {
  currency: string; isCollector: boolean; entries: Entry[]; totalIn: number; totalOut: number; heldByCollector: number; stillExpected?: number;
  lastAttestation?: { declaredAmount: number; ledgerAmountAtTime: number; mismatch: number; stale: boolean; createdAt: string; note?: string } | null;
}

const TYPE_LABEL: Record<string, string> = {
  CONTRIBUTION: 'Member payment', PAYOUT: 'Payout to recipient', COLLECTOR_FEE: 'Collector fee', FINE_COLLECTED: 'Late fee collected', EXPENSE: 'Expense',
  ADJUSTMENT: 'Adjustment', FOOD_PAYMENT: 'Member payment', REFUND: 'Refund', SUPPLIER_PAYMENT: 'Paid supplier', DRIVER_PAYMENT: 'Paid driver',
};

/** The public book of a pool: every naira in and out, who holds it now, and the collector's own balance statements. */
export function LedgerView({ kind, id }: { kind: 'ajo' | 'food' | 'campaign'; id: string }) {
  const { t } = useAuth();
  const qc = useQueryClient();
  const base = kind === 'ajo' ? `/ajo/pools/${id}` : kind === 'food' ? `/ccgb/pools/${id}` : `/campaigns/${id}`;
  const who = kind === 'campaign' ? 'host' : 'collector';
  const { data, isLoading } = useQuery({ queryKey: ['ledger', kind, id], queryFn: async () => (await api.get<Ledger>(`${base}/ledger`)).data });
  const { ask, element } = usePinPrompt();
  const pinRequired = usePinRequiredHandler();
  const [sheet, setSheet] = useState<'attest' | 'note' | null>(null);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [type, setType] = useState<'FINE_COLLECTED' | 'EXPENSE' | 'ADJUSTMENT' | 'REFUND'>(kind === 'campaign' ? 'EXPENSE' : 'FINE_COLLECTED');
  const [dir, setDir] = useState<'IN' | 'OUT'>(kind === 'campaign' ? 'OUT' : 'IN');

  if (isLoading || !data) return <Loading />;
  const cur = data.currency;
  const att = data.lastAttestation;

  const submit = async () => {
    const pin = await ask();
    if (!pin) return;
    try {
      if (sheet === 'attest') await api.post(`${base}/attest`, { declaredAmount: Number(amount), note: note.trim() || undefined, pin });
      else await api.post(`${base}/ledger`, { type, direction: dir, amount: Number(amount), note: note.trim(), pin });
      setSheet(null); setAmount(''); setNote('');
      qc.invalidateQueries({ queryKey: ['ledger', kind, id] });
      qc.invalidateQueries({ queryKey: [kind, id] });
    } catch (e) { if (!pinRequired(e)) Alert.alert('Error', errMsg(e)); }
  };

  const exportCsv = async () => {
    try {
      const { data: csv } = await api.get<string>(`/ajo/pools/${id}/export.csv`, { responseType: 'text' });
      await Share.share({ message: csv, title: 'Àjọ pool record' });
    } catch (e) { Alert.alert('Error', errMsg(e)); }
  };

  return (
    <Screen>
      <Card style={{ backgroundColor: colors.primary, borderColor: colors.primary }}>
        <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 16 }}>{kind === 'campaign' ? 'Money held by the host' : t('heldByCollector')}</Text>
        <Text style={{ color: '#fff', fontSize: 36, fontWeight: '800' }}>{money(data.heldByCollector, cur)}</Text>
        <Text style={{ color: 'rgba(255,255,255,0.85)' }}>{t('moneyIn')} {money(data.totalIn, cur)} · {t('moneyOut')} {money(data.totalOut, cur)}{data.stillExpected !== undefined ? ` · ${t('stillExpected')} ${money(data.stillExpected, cur)}` : ''}</Text>
      </Card>

      <Card style={att && att.mismatch !== 0 ? { borderColor: colors.warning, borderWidth: 2 } : undefined}>
        <Text style={s.h3}>{kind === 'campaign' ? "Host's own statement" : "Collector's own statement"}</Text>
        {att ? (
          <>
            <Text style={s.body}>On {format(new Date(att.createdAt), 'd MMM, HH:mm')} the {who} said they hold <Text style={{ fontWeight: '800' }}>{money(att.declaredAmount, cur)}</Text>.</Text>
            {att.mismatch !== 0 && <Text style={{ color: colors.warning, fontWeight: '700' }}>⚠️ That differed from this ledger by {money(Math.abs(att.mismatch), cur)}.</Text>}
            {att.mismatch === 0 && <Text style={{ color: '#166534', fontWeight: '700' }}>✔ Matched the ledger.</Text>}
            {att.stale && <Text style={s.muted}>This statement is over a week old.</Text>}
          </>
        ) : <Text style={s.muted}>The {who} has not yet stated how much they hold.</Text>}
        {data.isCollector && <Button title="Declare how much I hold" variant="outline" onPress={() => setSheet('attest')} />}
      </Card>

      {data.isCollector && kind !== 'food' && (
        <View style={{ gap: 8 }}>
          <Button title={kind === 'campaign' ? '📒 Add a ledger note (fabric bought, refund…)' : '📒 Add a ledger note (late fee, expense…)'} variant="outline" onPress={() => setSheet('note')} />
          {kind === 'ajo' && <Button title="⬇️ Share full record (CSV)" variant="outline" onPress={exportCsv} />}
        </View>
      )}

      <SectionTitle>Every entry</SectionTitle>
      {data.entries.length === 0 && <Text style={s.muted}>Nothing recorded yet.</Text>}
      {data.entries.map((e) => (
        <Card key={e.id} style={{ paddingVertical: 10 }}>
          <View style={s.row}>
            <Text style={s.body}>{TYPE_LABEL[e.type] ?? e.type}</Text>
            <Text style={{ fontSize: 18, fontWeight: '800', color: e.direction === 'IN' ? '#166534' : colors.warning }}>{e.direction === 'IN' ? '+' : '−'}{money(e.amount, cur)}</Text>
          </View>
          {e.note ? <Text style={s.muted}>{e.note}</Text> : null}
          <Text style={s.muted}>{format(new Date(e.createdAt), 'd MMM yyyy, HH:mm')}</Text>
        </Card>
      ))}

      <Sheet title={sheet === 'attest' ? 'How much do you hold now?' : 'Ledger note'} visible={!!sheet} onClose={() => setSheet(null)}>
        <View style={{ gap: 10 }}>
          {sheet === 'note' && (
            <>
              <Chips value={type} onChange={(v) => { setType(v); if (v !== 'ADJUSTMENT') setDir(v === 'FINE_COLLECTED' ? 'IN' : 'OUT'); }} options={kind === 'campaign'
                ? [{ value: 'EXPENSE', label: 'Expense out' }, { value: 'REFUND', label: 'Refund out' }, { value: 'ADJUSTMENT', label: 'Adjustment' }]
                : [{ value: 'FINE_COLLECTED', label: 'Late fee in' }, { value: 'EXPENSE', label: 'Expense out' }, { value: 'ADJUSTMENT', label: 'Adjustment' }]} />
              {type === 'ADJUSTMENT' && <Chips value={dir} onChange={setDir} options={[{ value: 'IN', label: 'Money in' }, { value: 'OUT', label: 'Money out' }]} />}
            </>
          )}
          <Field label={t('amount')} value={amount} onChangeText={setAmount} keyboardType="numeric" />
          <Field label={sheet === 'attest' ? 'Note (optional)' : 'What is this for? (members will see it)'} value={note} onChangeText={setNote} />
          <Button title={t('continue')} disabled={!(Number(amount) >= 0) || amount === '' || (sheet === 'note' && note.trim().length < 3) || (sheet === 'note' && Number(amount) <= 0)} onPress={submit} />
        </View>
      </Sheet>
      {element}
    </Screen>
  );
}
