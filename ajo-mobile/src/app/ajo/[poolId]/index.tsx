import { useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { Alert } from '../../../components/feedback';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { api, errMsg, money, uploadFile } from '../../../api/client';
import { useAuth } from '../../../auth/AuthContext';
import { postOrQueue } from '../../../offline';
import { pickImage, type PickedFile } from '../../../components/pickers';
import { Button, Card, Loading, ProgressBar, Screen, Sheet, StatusBadge, s, LinkText } from '../../../components/ui';
import type { FundsMode } from '../../../constants';
import { Chips, Field, LedgerNotice, ModeBadge, ReadAloud, SectionTitle, usePinPrompt, usePinRequiredHandler } from '../../../components/widgets';
import { colors } from '../../../theme';

type Method = 'TRANSFER' | 'CASH';
interface Slot {
  id: string; payoutOrder: number; recipientId: string; recipientName: string; payoutDate: string; status: 'SCHEDULED' | 'READY' | 'COMPLETED' | 'DISPUTED';
  contributionsCount: number; verifiedCount: number; receiptUrl: string | null; netPayout: number; payoutMethod: string | null; payoutRef: string | null; recipientConfirmedAt: string | null;
}
interface Mine { id: string; scheduleId: string; amount: number; paidAmount: number; pendingAmount: number; remaining: number; status: string; dueAt: string; fineAmount: number }
interface Swap { id: string; requesterId: string; peerId: string; scheduleAId: string; scheduleBId: string; status: 'PENDING_PEER' | 'PENDING_COLLECTOR'; reason?: string }
interface PoolData {
  pool: { id: string; title: string; amountPerMember: number; cycleFrequency: string; status: string; rulesText?: string; lateFeeAmount: number; graceDays: number; isCollector: boolean; group: { id: string; name: string; currency: string; fundsMode?: FundsMode } };
  schedule: Slot[]; myContributions: Mine[]; rulesAccepted: boolean; pendingSwaps: Swap[]; openDisputes: number;
  funds: { heldByCollector: number; totalIn: number; totalOut: number; stillExpected: number; lastAttestation?: { mismatch: number; stale: boolean } | null };
}
interface PaymentRow { id: string; amount: number; method: Method; status: 'PENDING' | 'VERIFIED' | 'REJECTED'; proofUrl: string | null; reference: string | null; rejectReason?: string }
interface Row { id: string; contributorId: string; contributorName: string; assisted: boolean; amount: number; paidAmount: number; remaining: number; status: string; covered: boolean; payments: PaymentRow[] }

const fmtDate = (d: string) => format(new Date(d), 'EEE, d MMM yyyy');

type Sheets =
  | { kind: 'pay'; contribution: Mine }
  | { kind: 'cash'; scheduleId: string; row: Row }
  | { kind: 'reject'; payment: PaymentRow }
  | { kind: 'payout'; slot: Slot }
  | { kind: 'swap'; mine: Slot; peer: Slot }
  | null;

export default function AjoPool() {
  const { poolId } = useLocalSearchParams<{ poolId: string }>();
  const { user, t } = useAuth();
  const router = useRouter();
  const qc = useQueryClient();
  const { ask, element: pinSheet } = usePinPrompt();
  const pinRequired = usePinRequiredHandler();

  const [sheet, setSheet] = useState<Sheets>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [showRules, setShowRules] = useState(false);
  // shared form state for the sheets
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<Method>('TRANSFER');
  const [reference, setReference] = useState('');
  const [file, setFile] = useState<PickedFile | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const { data, isLoading } = useQuery({ queryKey: ['ajo', poolId], queryFn: async () => (await api.get<PoolData>(`/ajo/pools/${poolId}`)).data });
  const contribs = useQuery({
    queryKey: ['contribs', open], enabled: !!open,
    queryFn: async () => (await api.get<{ contributions: Row[] }>(`/ajo/schedules/${open}/contributions`)).data.contributions,
  });
  if (isLoading || !data) return <Loading />;

  const { pool, schedule, myContributions, funds } = data;
  const cur = pool.group.currency;
  const current = schedule.find((x) => x.status !== 'COMPLETED');
  const refresh = () => { qc.invalidateQueries({ queryKey: ['ajo', poolId] }); qc.invalidateQueries({ queryKey: ['contribs'] }); qc.invalidateQueries({ queryKey: ['ledger'] }); qc.invalidateQueries({ queryKey: ['my-ajo'] }); };
  const reset = () => { setSheet(null); setAmount(''); setMethod('TRANSFER'); setReference(''); setFile(null); setReason(''); };
  const guard = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); refresh(); } catch (e) { if (!pinRequired(e)) Alert.alert('Error', errMsg(e)); } finally { setBusy(false); }
  };

  const due = myContributions.filter((c) => c.remaining > 0 && c.status !== 'VERIFIED').sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  const nextDue = due[0];
  const spoken = nextDue
    ? t('speakDue', { amount: money(nextDue.remaining, cur), date: format(new Date(nextDue.dueAt), 'd MMM'), pool: pool.title }) + ' ' + t('speakHeld', { pool: pool.title, held: money(funds.heldByCollector, cur) })
    : t('speakNoDue') + ' ' + t('speakHeld', { pool: pool.title, held: money(funds.heldByCollector, cur) });

  const pickProof = async () => setFile(await pickImage());

  // ── actions ──
  const submitPayment = (c: Mine) => guard(async () => {
    const body = { contributionId: c.id, amount: Number(amount) || c.remaining, method, reference: reference.trim() || undefined };
    if (file) await api.post('/ajo/contributions/record', { ...body, proofUrl: await uploadFile(file) });
    else { const r = await postOrQueue('post', '/ajo/contributions/record', body, 'payment'); if (r.queued) Alert.alert(t('queued')); }
    reset();
  });
  const verify = (row: Row) => guard(async () => {
    const { data: res } = await api.patch(`/ajo/contributions/${row.id}/verify`);
    if (res.payoutReady) Alert.alert('All payments are in', 'You can now pay the recipient and record the payout.');
  });
  const reject = (p: PaymentRow) => guard(async () => { await api.patch(`/ajo/payments/${p.id}/reject`, { reason: reason.trim() }); reset(); });
  const recordCash = (scheduleId: string, row: Row) => guard(async () => {
    await api.post('/ajo/contributions/record-for', { scheduleId, contributorId: row.contributorId, amount: Number(amount) || row.remaining, method: 'CASH', reference: reference.trim() || undefined });
    reset();
  });
  const cover = (row: Row) => Alert.alert('Cover this share?', `You will pay ${money(row.remaining, cur)} from your own pocket. This counts as a missed payment for ${row.contributorName}.`, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Cover it', onPress: () => guard(async () => { await api.post('/ajo/contributions/record-for', { contributionId: row.id, contributorId: row.contributorId, coverShortfall: true }); }) },
  ]);
  const payout = (slot: Slot) => guard(async () => {
    const pin = await ask();
    if (!pin) return;
    const proofUrl = file ? await uploadFile(file) : undefined;
    const { data: res } = await api.post(`/ajo/schedules/${slot.id}/payout`, { method, reference: reference.trim() || undefined, proofUrl, pin });
    reset();
    Alert.alert('Payout recorded', `${slot.recipientName} will be asked to confirm they received ${money(res.netPayout, cur)}.`);
  });
  const confirmReceipt = (slot: Slot, received: boolean) => guard(async () => { await api.post(`/ajo/schedules/${slot.id}/confirm-receipt`, { received }); });
  const acceptRules = () => guard(async () => { await api.post(`/ajo/pools/${poolId}/accept-rules`, {}); });
  const requestSwap = (mine: Slot, peer: Slot) => guard(async () => { await api.post(`/ajo/pools/${poolId}/swaps`, { myScheduleId: mine.id, peerScheduleId: peer.id, reason: reason.trim() || undefined }); reset(); Alert.alert('Request sent', `${peer.recipientName} was asked to agree.`); });
  const respondSwap = (sw: Swap, accept: boolean) => guard(async () => { await api.post(`/ajo/swaps/${sw.id}/respond`, { accept }); });
  const decideSwap = (sw: Swap, approve: boolean) => guard(async () => { await api.post(`/ajo/swaps/${sw.id}/decide`, { approve }); });

  const myScheduled = schedule.find((x) => x.recipientId === user?.id && x.status === 'SCHEDULED' && x.verifiedCount === 0);
  const slotName = (id: string) => schedule.find((x) => x.id === id);

  return (
    <Screen>
      <Stack.Screen options={{ title: pool.title }} />
      <View style={s.row}>
        <View style={{ flex: 1, gap: 4 }}><ModeBadge mode={pool.group.fundsMode} /><Text style={s.h1}>{pool.title}</Text><Text style={s.muted}>{money(pool.amountPerMember, cur)} · {pool.cycleFrequency.toLowerCase()} · grace {pool.graceDays}d{pool.lateFeeAmount > 0 ? ` · late fee ${money(pool.lateFeeAmount, cur)}` : ''}</Text></View>
        <ReadAloud text={spoken} />
        <StatusBadge status={pool.status} />
      </View>

      {/* Where the money is */}
      <Card style={{ backgroundColor: colors.primary, borderColor: colors.primary }} >
        <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 16 }}>{t('heldByCollector')}</Text>
        <Text style={{ color: '#fff', fontSize: 32, fontWeight: '800' }}>{money(funds.heldByCollector, cur)}</Text>
        {funds.lastAttestation && funds.lastAttestation.mismatch !== 0 && <Text style={{ color: colors.accent, fontWeight: '700' }}>⚠️ Collector&apos;s last statement did not match the ledger</Text>}
        <Button title={`📖 ${t('ledger')}`} variant="accent" onPress={() => router.push(`/ajo/${poolId}/ledger`)} />
      </Card>

      {/* Rules */}
      {!!pool.rulesText && (
        <Card>
          <Text style={s.h3} onPress={() => setShowRules((v) => !v)}>{showRules ? '▾' : '▸'} {t('rules')}</Text>
          {showRules && <Text style={s.body}>{pool.rulesText}</Text>}
          {!data.rulesAccepted && !pool.isCollector && <Button title={t('acceptRules')} onPress={acceptRules} />}
          {data.rulesAccepted && <Text style={{ color: '#166534', fontWeight: '700' }}>✔ You accepted these rules</Text>}
        </Card>
      )}

      {/* Swap requests that need me */}
      {data.pendingSwaps.map((sw) => {
        const a = slotName(sw.scheduleAId); const b = slotName(sw.scheduleBId);
        const text = `${a?.recipientName} (${a ? fmtDate(a.payoutDate) : ''}) ↔ ${b?.recipientName} (${b ? fmtDate(b.payoutDate) : ''})`;
        return (
          <Card key={sw.id} style={{ borderColor: colors.accent, borderWidth: 2 }}>
            <Text style={s.h3}>🔁 Turn swap</Text>
            <Text style={s.body}>{text}</Text>
            {!!sw.reason && <Text style={s.muted}>“{sw.reason}”</Text>}
            {sw.status === 'PENDING_PEER' && sw.peerId === user?.id && <View style={{ gap: 8 }}><Button title="Agree to swap" onPress={() => respondSwap(sw, true)} /><Button title="Decline" variant="outline" onPress={() => respondSwap(sw, false)} /></View>}
            {sw.status === 'PENDING_PEER' && sw.peerId !== user?.id && <Text style={s.muted}>Waiting for the other member to agree.</Text>}
            {sw.status === 'PENDING_COLLECTOR' && pool.isCollector && <View style={{ gap: 8 }}><Button title="Approve swap" onPress={() => decideSwap(sw, true)} /><Button title="Decline" variant="outline" onPress={() => decideSwap(sw, false)} /></View>}
            {sw.status === 'PENDING_COLLECTOR' && !pool.isCollector && <Text style={s.muted}>Both agreed. Waiting for the collector to approve.</Text>}
          </Card>
        );
      })}

      {/* What I owe */}
      {due.map((c) => (
        <Card key={c.id} style={{ borderColor: c.status === 'MISSED' ? colors.warning : colors.accent, borderWidth: 2 }}>
          <Text style={s.h3}>{c.status === 'MISSED' ? '⚠️ Missed payment' : 'Payment due'}</Text>
          <Text style={{ fontSize: 28, fontWeight: '800' }}>{money(c.remaining, cur)}</Text>
          <Text style={s.muted}>Due {fmtDate(c.dueAt)}{c.paidAmount > 0 ? ` · ${money(c.paidAmount, cur)} already confirmed` : ''}{c.pendingAmount > 0 ? ` · ${money(c.pendingAmount, cur)} waiting for your collector` : ''}{c.fineAmount > 0 ? ` · late fee ${money(c.fineAmount, cur)}` : ''}</Text>
          <Button title={t('recordPayment')} variant="accent" onPress={() => { setAmount(String(c.remaining)); setSheet({ kind: 'pay', contribution: c }); }} />
        </Card>
      ))}

      <SectionTitle>Rotation</SectionTitle>
      {schedule.map((sl) => {
        const yourTurn = current?.id === sl.id && sl.recipientId === user?.id;
        const isMe = sl.recipientId === user?.id;
        return (
          <Card key={sl.id} style={yourTurn ? { backgroundColor: colors.accentLight, borderColor: colors.accent, borderWidth: 2 } : undefined}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: '#fff', fontWeight: '800', fontSize: 18 }}>{sl.payoutOrder}</Text></View>
              <View style={{ flex: 1 }}><Text style={s.h3}>{sl.recipientName}</Text><Text style={s.muted}>{fmtDate(sl.payoutDate)}</Text></View>
              <StatusBadge status={sl.status} />
            </View>
            {yourTurn && <View style={{ alignSelf: 'flex-start', backgroundColor: colors.accent, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 4 }}><Text style={{ fontWeight: '800' }}>{t('yourTurn')}</Text></View>}
            <View style={s.row}><Text style={s.muted}>{t('verified')}</Text><Text style={s.muted}>{sl.verifiedCount}/{sl.contributionsCount}</Text></View>
            <ProgressBar value={sl.verifiedCount} max={sl.contributionsCount} />

            {sl.status === 'READY' && !pool.isCollector && <Text style={s.muted}>All payments are in. Waiting for the collector to pay out.</Text>}
            {(sl.status === 'COMPLETED' || sl.status === 'DISPUTED') && (
              <Text style={s.muted}>Paid {money(sl.netPayout, cur)}{sl.payoutMethod ? ` by ${sl.payoutMethod.toLowerCase()}` : ''}{sl.payoutRef ? ` · ${sl.payoutRef}` : ''}{sl.recipientConfirmedAt ? ' · ✅ recipient confirmed' : sl.status === 'DISPUTED' ? ' · ⚠️ disputed' : ' · waiting for recipient'}</Text>
            )}
            {sl.receiptUrl && <LinkText underline onPress={() => Linking.openURL(sl.receiptUrl!)}>Download receipt</LinkText>}

            {isMe && sl.status === 'COMPLETED' && !sl.recipientConfirmedAt && (
              <View style={{ gap: 8 }}>
                <Button title={t('confirmReceived')} onPress={() => confirmReceipt(sl, true)} />
                <Button title={t('notReceived')} variant="danger" onPress={() => Alert.alert('Not received?', 'Your collector and the group will be told, and a dispute will be opened.', [{ text: 'Cancel', style: 'cancel' }, { text: 'Yes, not received', style: 'destructive', onPress: () => confirmReceipt(sl, false) }])} />
              </View>
            )}

            {/* Swap: I can ask to swap my unstarted turn with another unstarted turn */}
            {myScheduled && sl.status === 'SCHEDULED' && sl.verifiedCount === 0 && !isMe && (
              <Button title="Ask to swap turns" variant="outline" onPress={() => setSheet({ kind: 'swap', mine: myScheduled, peer: sl })} />
            )}

            {pool.isCollector && sl.status !== 'COMPLETED' && (
              <>
                {sl.status === 'READY' && <Button title={`💸 ${t('recordPayout')}`} variant="accent" onPress={() => { setMethod('TRANSFER'); setSheet({ kind: 'payout', slot: sl }); }} />}
                <Button title={open === sl.id ? 'Hide payments' : 'Review payments'} variant="outline" onPress={() => setOpen(open === sl.id ? null : sl.id)} />
                {open === sl.id && (
                  <View style={{ gap: 8, marginTop: 4 }}>
                    {contribs.data?.map((row) => (
                      <View key={row.id} style={{ backgroundColor: colors.background, borderRadius: 12, padding: 10, gap: 6 }}>
                        <View style={s.row}><Text style={s.body}>{row.contributorName}{row.assisted ? ' 📞' : ''}</Text><StatusBadge status={row.status} /></View>
                        <Text style={s.muted}>{money(row.paidAmount, cur)} of {money(row.amount, cur)}{row.covered ? ' · covered by you' : ''}</Text>
                        {row.payments.map((p) => (
                          <View key={p.id} style={{ borderLeftWidth: 3, borderLeftColor: p.status === 'VERIFIED' ? '#16A34A' : p.status === 'REJECTED' ? colors.warning : colors.accent, paddingLeft: 8 }}>
                            <Text style={s.body}>{money(p.amount, cur)} · {p.method.toLowerCase()} · {p.status.toLowerCase()}{p.reference ? ` · ${p.reference}` : ''}</Text>
                            {p.proofUrl && <LinkText underline onPress={() => Linking.openURL(p.proofUrl!)}>View proof</LinkText>}
                            {p.rejectReason && <Text style={s.muted}>Rejected: {p.rejectReason}</Text>}
                            {p.status === 'PENDING' && <Text onPress={() => setSheet({ kind: 'reject', payment: p })} style={{ color: colors.warning, fontWeight: '700', paddingVertical: 8 }}>Reject this payment</Text>}
                          </View>
                        ))}
                        {row.payments.some((p) => p.status === 'PENDING') && <Button title={t('verify')} onPress={() => verify(row)} />}
                        {row.status !== 'VERIFIED' && row.remaining > 0 && (
                          <View style={{ gap: 8 }}>
                            <Button title="💵 Record cash from member" variant="outline" onPress={() => { setAmount(String(row.remaining)); setSheet({ kind: 'cash', scheduleId: sl.id, row }); }} />
                            {row.status === 'MISSED' && <Button title="Cover this share myself" variant="outline" onPress={() => cover(row)} />}
                          </View>
                        )}
                      </View>
                    ))}
                  </View>
                )}
              </>
            )}
          </Card>
        );
      })}

      {/* ── Sheets ── */}
      <Sheet title={t('recordPayment')} visible={sheet?.kind === 'pay'} onClose={reset}>
        {sheet?.kind === 'pay' && (
          <View style={{ gap: 10 }}>
            <LedgerNotice mode={pool.group.fundsMode} />
            <Field label={`${t('amount')} (${money(sheet.contribution.remaining, cur)} still owed: you may pay part now)`} value={amount} onChangeText={setAmount} keyboardType="numeric" />
            <Text style={[s.body, { fontWeight: '600' }]}>{t('method')}</Text>
            <Chips value={method} onChange={setMethod} options={[{ value: 'TRANSFER', label: t('transfer') }, { value: 'CASH', label: t('cash') }]} />
            <Field label={t('reference')} value={reference} onChangeText={setReference} />
            <Button title={file ? `📎 ${file.name}` : t('payProof')} variant="outline" onPress={pickProof} />
            <Button title={t('iHavePaid')} loading={busy} disabled={!(Number(amount) > 0)} onPress={() => submitPayment(sheet.contribution)} />
          </View>
        )}
      </Sheet>

      <Sheet title="Record cash from member" visible={sheet?.kind === 'cash'} onClose={reset}>
        {sheet?.kind === 'cash' && (
          <View style={{ gap: 10 }}>
            <Text style={s.body}>{sheet.row.contributorName} handed you cash. It is added to the ledger at once and they get an SMS receipt.</Text>
            <Field label={t('amount')} value={amount} onChangeText={setAmount} keyboardType="numeric" />
            <Field label="Note (optional)" value={reference} onChangeText={setReference} />
            <Button title="Record cash" loading={busy} disabled={!(Number(amount) > 0)} onPress={() => recordCash(sheet.scheduleId, sheet.row)} />
          </View>
        )}
      </Sheet>

      <Sheet title="Reject payment" visible={sheet?.kind === 'reject'} onClose={reset}>
        {sheet?.kind === 'reject' && (
          <View style={{ gap: 10 }}>
            <Field label="Why? (the member will be told)" value={reason} onChangeText={setReason} />
            <Button title={t('reject')} variant="danger" loading={busy} disabled={reason.trim().length < 2} onPress={() => reject(sheet.payment)} />
          </View>
        )}
      </Sheet>

      <Sheet title={t('recordPayout')} visible={sheet?.kind === 'payout'} onClose={reset}>
        {sheet?.kind === 'payout' && (
          <View style={{ gap: 10 }}>
            <Text style={s.body}>First pay {sheet.slot.recipientName} yourself (cash or bank transfer), then record it here. They will be asked to confirm.</Text>
            <Chips value={method} onChange={setMethod} options={[{ value: 'TRANSFER', label: t('transfer') }, { value: 'CASH', label: t('cash') }]} />
            <Field label={method === 'TRANSFER' ? 'Transfer reference (or attach a screenshot)' : 'Note (optional)'} value={reference} onChangeText={setReference} />
            <Button title={file ? `📎 ${file.name}` : 'Attach screenshot / photo'} variant="outline" onPress={pickProof} />
            <Button title={t('recordPayout')} loading={busy} disabled={method === 'TRANSFER' && !reference.trim() && !file} onPress={() => payout(sheet.slot)} />
          </View>
        )}
      </Sheet>

      <Sheet title="Ask to swap turns" visible={sheet?.kind === 'swap'} onClose={reset}>
        {sheet?.kind === 'swap' && (
          <View style={{ gap: 10 }}>
            <Text style={s.body}>Swap your turn ({fmtDate(sheet.mine.payoutDate)}) with {sheet.peer.recipientName} ({fmtDate(sheet.peer.payoutDate)}). They must agree and the collector must approve.</Text>
            <Field label="Reason (optional)" value={reason} onChangeText={setReason} />
            <Button title="Send request" loading={busy} onPress={() => requestSwap(sheet.mine, sheet.peer)} />
          </View>
        )}
      </Sheet>
      {pinSheet}
    </Screen>
  );
}
