import { useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { Alert } from '../../../components/feedback';
import { useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { api, errMsg, naira } from '../../../api/client';
import { useAuth } from '../../../auth/AuthContext';
import { Button, Card, Loading, Screen, Sheet, s } from '../../../components/ui';
import { Chips, Field, LedgerNotice, SectionTitle } from '../../../components/widgets';
import { FeeBreakdown, useFeePreview } from '../../../components/fees';
import { LangToggle, ModeLabel, StatusCard, toneOfDue, useRefreshModule, type Contract } from '../../../components/igba';
import { downloadAndShare } from '../../../download';
import { colors, fonts } from '../../../theme';

interface Due { number: number; dueDate: string; amount: number; paid: number; remaining: number; status: string }
interface Release { id: string; status: string; accountName: string | null; nameMismatch: boolean; accountNumber: string | null; graduateConfirmed: boolean; guardianConfirmed: boolean; approvals: number; approvalsRequired: number; rejections: number; amount: number | null; failureReason: string | null }
interface Statement {
  fundStatus: string; contractStatus: string; dues: Due[]; release: Release | null;
  totals: { masterContributions: number; communityMatch: number; contributionsTotal: number; pending: number; released: number; refunded: number; balance: number; plannedContributions: number; stillPlanned: number; owedSoFar: number };
}

// The Settlement Fund: money paid in month by month and released to the graduate only after confirmations and board approvals. No interest.
export default function SettlementFund() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useAuth();
  const refresh = useRefreshModule();
  const contract = useQuery({ queryKey: ['contract', id], queryFn: async () => (await api.get<Contract>(`/contracts/${id}`)).data });
  const st = useQuery({ queryKey: ['fund', id], queryFn: async () => (await api.get<Statement>(`/settlement/${id}`)).data });
  const check = useQuery({ queryKey: ['fund-check', id], queryFn: async () => (await api.get<{ ready: boolean; unmet: string[]; balance: number }>(`/settlement/${id}/release/check`)).data });
  const [pay, setPay] = useState<{ asMatch: boolean } | null>(null);
  const [amount, setAmount] = useState('');
  const [dest, setDest] = useState(false);
  const [kind, setKind] = useState<'GRADUATE' | 'SUPPLIER' | 'LANDLORD'>('GRADUATE');
  const [bank, setBank] = useState('');
  const [acct, setAcct] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const fee = useFeePreview(amount, 'SETTLEMENT_FUND');

  if (st.isLoading || contract.isLoading || !st.data) return <Loading />;
  const d = st.data, me = contract.data?.myRole, rel = d.release;
  const nextDue = d.dues.find((x) => x.status !== 'PAID');
  const wrap = async (fn: () => Promise<void>) => { setBusy(true); try { await fn(); await refresh(); await Promise.all([st.refetch(), check.refetch()]); } catch (e) { Alert.alert(t('ib_error'), errMsg(e)); } finally { setBusy(false); } };

  const contribute = () => wrap(async () => {
    const { data } = await api.post<{ result: { kind: string; checkoutUrl?: string } }>(`/settlement/${id}/contribute`, { amount, asMatch: pay!.asMatch });
    setPay(null); setAmount('');
    if (data.result.checkoutUrl) await Linking.openURL(data.result.checkoutUrl); else Alert.alert(t('ib_done'), t('ib_paymentRecorded'));
  });
  const proposeDest = () => wrap(async () => {
    const { data } = await api.post<{ accountName: string; nameMismatch: boolean }>(`/settlement/releases/${rel!.id}/destination`, { kind, bankCode: bank, accountNumber: acct, ...(note.trim() ? { note: note.trim() } : {}) });
    setDest(false); Alert.alert(data.nameMismatch ? t('ib_nameDiffers') : t('ib_accountFound'), data.accountName);
  });

  const releaseHelp = rel ? t(`ib_rel_${rel.status}`) : check.data?.ready ? t('ib_rel_READY') : t('ib_rel_NOT_READY');
  return (
    <Screen>
      <LangToggle />
      <ModeLabel mode="ESCROW" />
      <Card style={{ backgroundColor: colors.cocoaNight, borderColor: colors.cocoaNight }}>
        <Text style={{ color: colors.cream, fontFamily: fonts.body }}>{t('ib_fundBalance')}</Text>
        <Text style={{ color: colors.gold, fontFamily: fonts.mono, fontSize: 32 }}>{naira(d.totals.balance)}</Text>
        <Text style={{ color: colors.cream, fontFamily: fonts.body, fontSize: 13 }}>{t('ib_noInterest')}</Text>
      </Card>
      <Card>
        <View style={s.row}><Text style={s.muted}>{t('ib_paidByMaster')}</Text><Text style={s.money}>{naira(d.totals.masterContributions)}</Text></View>
        <View style={s.row}><Text style={s.muted}>{t('ib_communityMatch')}</Text><Text style={s.money}>{naira(d.totals.communityMatch)}</Text></View>
        <View style={s.row}><Text style={s.muted}>{t('ib_stillPlanned')}</Text><Text style={s.money}>{naira(d.totals.stillPlanned)}</Text></View>
        <View style={s.row}><Text style={s.muted}>{t('ib_released')}</Text><Text style={s.money}>{naira(d.totals.released)}</Text></View>
        {d.totals.pending > 0 && <View style={s.row}><Text style={s.muted}>{t('ib_pendingPay')}</Text><Text style={s.money}>{naira(d.totals.pending)}</Text></View>}
      </Card>
      {d.fundStatus === 'FORFEIT_REVIEW' && <StatusCard tone="red" title={t('ib_forfeitReview')} body={t('ib_forfeitReviewBody')} speakText={t('ib_forfeitReviewBody')} />}

      {me === 'MASTER' && nextDue && <Button title={`💳 ${t('ib_payThisMonth', { amount: naira(nextDue.remaining) })}`} onPress={() => { setAmount(String(nextDue.remaining)); setPay({ asMatch: false }); }} />}
      {me && me !== 'MASTER' && d.fundStatus === 'ACCUMULATING' && <Button title={`🎁 ${t('ib_giveMatch')}`} variant="accent" onPress={() => setPay({ asMatch: true })} />}

      <SectionTitle>{t('ib_monthlyDues')}</SectionTitle>
      {d.dues.map((x) => <StatusCard key={x.number} tone={toneOfDue(x.status)} title={`${t('ib_monthN', { n: x.number })} · ${naira(x.amount)}`} body={`${t(`ib_due_${x.status}`)} · ${format(new Date(x.dueDate), 'd MMM yyyy')}${x.paid > 0 && x.remaining > 0 ? ` · ${t('ib_paidSoFar', { amount: naira(x.paid) })}` : ''}`} />)}

      <Button title={`📊 ${t('ib_downloadStatement')}`} variant="outline" onPress={() => downloadAndShare(`/settlement/${id}/statement.csv`, 'settlement-statement.csv', 'text/csv').catch(() => Alert.alert(t('ib_error'), t('ib_downloadFailed')))} />

      <SectionTitle>{t('ib_releaseTitle')}</SectionTitle>
      <StatusCard tone={rel?.status === 'RELEASED' ? 'green' : rel?.status === 'FAILED' || rel?.status === 'REJECTED' ? 'red' : 'yellow'} title={rel ? t(`ib_relStatus_${rel.status}`) : t('ib_noReleaseYet')} body={releaseHelp} speakText={releaseHelp} />
      {!rel && check.data && !check.data.ready && check.data.unmet.map((u) => <Text key={u} style={s.muted}>• {u}</Text>)}
      {!rel && check.data?.ready && (me === 'APPRENTICE' || me === 'MASTER') && <Button title={t('ib_startRelease')} loading={busy} onPress={() => wrap(async () => { await api.post(`/settlement/${id}/release`); })} />}
      {rel && (
        <Card>
          {rel.accountName && <Text style={s.body}>{rel.accountName} · {rel.accountNumber}</Text>}
          {rel.nameMismatch && <Text style={{ color: colors.red, fontFamily: fonts.bodyBold }}>{t('ib_nameDiffersWarn')}</Text>}
          {rel.amount !== null && <Text style={s.money}>{naira(rel.amount)}</Text>}
          {rel.status === 'AWAITING_APPROVALS' && <Text style={s.body}>{t('ib_approvalsOf', { n: rel.approvals, total: rel.approvalsRequired })}</Text>}
          {rel.failureReason && <Text style={{ color: colors.red }}>{rel.failureReason}</Text>}
        </Card>
      )}
      {rel?.status === 'AWAITING_DESTINATION' && me === 'APPRENTICE' && <Button title={t('ib_chooseAccount')} onPress={() => setDest(true)} />}
      {rel?.status === 'AWAITING_CONFIRMATION' && ((me === 'APPRENTICE' && !rel.graduateConfirmed) || (me === 'PARENT_GUARDIAN' && !rel.guardianConfirmed)) && <Button title={t('ib_confirmAccount')} loading={busy} onPress={() => wrap(async () => { await api.post(`/settlement/releases/${rel.id}/confirm`); })} />}
      {rel?.status === 'FAILED' && <Button title={t('ib_retry')} variant="accent" loading={busy} onPress={() => wrap(async () => { await api.post(`/settlement/releases/${rel.id}/retry`); })} />}
      {rel && ['AWAITING_DESTINATION', 'AWAITING_CONFIRMATION', 'AWAITING_APPROVALS'].includes(rel.status) && me && <Button title={t('ib_cancelRelease')} variant="outline" loading={busy} onPress={() => wrap(async () => { await api.post(`/settlement/releases/${rel.id}/cancel`); })} />}

      <Sheet title={pay?.asMatch ? t('ib_giveMatch') : t('ib_payThisMonthTitle')} visible={!!pay} onClose={() => setPay(null)}>
        <View style={{ gap: 12 }}>
          <Field label={t('ib_amountNaira')} value={amount} onChangeText={setAmount} keyboardType="numeric" />
          {fee.data && <FeeBreakdown w={fee.data.waterfall} bp={fee.data.platformCommissionBp} />}
          <LedgerNotice mode="ESCROW" />
          <Button title={t('ib_payNow')} loading={busy} disabled={!(Number(amount) > 0)} onPress={contribute} />
        </View>
      </Sheet>
      <Sheet title={t('ib_chooseAccount')} visible={dest} onClose={() => setDest(false)}>
        <View style={{ gap: 12 }}>
          <Chips<'GRADUATE' | 'SUPPLIER' | 'LANDLORD'> value={kind} onChange={setKind} options={[{ value: 'GRADUATE', label: t('ib_dest_GRADUATE') }, { value: 'SUPPLIER', label: t('ib_dest_SUPPLIER') }, { value: 'LANDLORD', label: t('ib_dest_LANDLORD') }]} />
          <Field label={t('ib_bankCode')} value={bank} onChangeText={setBank} keyboardType="number-pad" maxLength={6} />
          <Field label={t('ib_accountNumber')} value={acct} onChangeText={setAcct} keyboardType="number-pad" maxLength={10} />
          <Field label={t('ib_noteOptional')} value={note} onChangeText={setNote} maxLength={200} />
          <Button title={t('ib_checkAccount')} loading={busy} disabled={!/^\d{3,6}$/.test(bank) || !/^\d{10}$/.test(acct)} onPress={proposeDest} />
        </View>
      </Sheet>
    </Screen>
  );
}
