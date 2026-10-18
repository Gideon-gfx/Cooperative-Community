import { useEffect, useState } from 'react';
import { Linking, Pressable, Text, View } from 'react-native';
import { Alert } from '../../../components/feedback';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { differenceInSeconds, format } from 'date-fns';
import { api, errMsg, money, uploadFile } from '../../../api/client';
import { useAuth } from '../../../auth/AuthContext';
import { pickImage, type PickedFile } from '../../../components/pickers';
import { Button, Card, Loading, ProgressBar, Screen, Sheet, StatusBadge, s, LinkText } from '../../../components/ui';
import { Chips, Field, SectionTitle, usePinPrompt, usePinRequiredHandler } from '../../../components/widgets';
import { colors, TAP } from '../../../theme';

interface Tally { productId: string; name: string; supplier: string; votes: number }
interface Product { id: string; name: string; unitPrice: number; kgWeightPerUnit: number; supplier: { businessName: string; supplierType: string; ratingAvg: number; ratingCount: number } }
interface SlotRow { id: string; startsAt: string; endsAt: string; capacity: number; bookedCount: number; full: boolean }
interface MemberRow { id: string; fullName: string; shares: number; proofOfPaymentUrl: string | null; isPaidVerified: boolean; pickupSlotId: string | null; collectedAt: string | null; refundDue: number; refundedAt: string | null }
interface PoolData {
  pool: {
    id: string; status: 'COLLECTING' | 'LOCKED' | 'DISPATCHED' | 'DELIVERED' | 'DISSOLVED'; contributionAmt: number; targetMembers: number; currentMembers: number; totalFund: number; liveWindowEnd: string;
    communityHubAddr: string | null; transportFee: number; netFoodBudget: number; lockedUnitPrice: number | null; orderUnits: number | null; orderKg: number | null; leftoverAmt: number;
    receivedKg: number | null; deliveryProofUrl: string | null; supplierDepositPct: number; group: { id: string; name: string };
    winningProduct: { name: string; supplier: { businessName: string; ratingAvg: number; ratingCount: number } } | null;
  };
  currency: string; tallies: Tally[]; isCollector: boolean; iRated: boolean;
  myMembership: { shares: number; isPaidVerified: boolean; hasVoted: boolean; pickupSlotId: string | null; collectedAt: string | null; refundDue: number; refundedAt: string | null } | null;
  slots: SlotRow[];
  paid: { supplierDeposit: number; supplierBalance: number; driver: number; refunds: number };
  funds: { heldByCollector: number; totalIn: number; totalOut: number; lastAttestation?: { mismatch: number } | null };
  members?: MemberRow[];
}

function Countdown({ end }: { end: string }) {
  const [secs, setSecs] = useState(() => differenceInSeconds(new Date(end), new Date()));
  useEffect(() => { const t = setInterval(() => setSecs(differenceInSeconds(new Date(end), new Date())), 1000); return () => clearInterval(t); }, [end]);
  if (secs <= 0) return <Text style={{ color: colors.warning, fontWeight: '800', fontSize: 20 }}>Window closed</Text>;
  return <Text style={{ fontWeight: '800', fontSize: 20 }}>{Math.floor(secs / 3600)}h {Math.floor((secs % 3600) / 60)}m {secs % 60}s</Text>;
}
const stars = (n: number) => '★'.repeat(Math.round(n)) + '☆'.repeat(5 - Math.round(n));

type Sh = { kind: 'pay' } | { kind: 'refund'; m: MemberRow } | { kind: 'slot' } | null;

export default function FoodPool() {
  const { poolId } = useLocalSearchParams<{ poolId: string }>();
  const { t } = useAuth();
  const router = useRouter();
  const qc = useQueryClient();
  const { ask, element: pinSheet } = usePinPrompt();
  const pinRequired = usePinRequiredHandler();

  const [file, setFile] = useState<PickedFile | null>(null);
  const [shares, setShares] = useState('1');
  const [productId, setProductId] = useState('');
  const [stars_, setStars] = useState('5');
  const [qualityOk, setQualityOk] = useState(true);
  const [comment, setComment] = useState('');
  const [sheet, setSheet] = useState<Sh>(null);
  const [payKind, setPayKind] = useState<'SUPPLIER_DEPOSIT' | 'SUPPLIER_BALANCE' | 'DRIVER_FEE'>('SUPPLIER_DEPOSIT');
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [slotStart, setSlotStart] = useState('');
  const [slotHours, setSlotHours] = useState('2');
  const [slotCap, setSlotCap] = useState('20');
  const [busy, setBusy] = useState(false);

  const { data, isLoading } = useQuery({ queryKey: ['food', poolId], queryFn: async () => (await api.get<PoolData>(`/ccgb/pools/${poolId}`)).data, refetchInterval: 10000 });
  const products = useQuery({ queryKey: ['products'], queryFn: async () => (await api.get<{ products: Product[] }>('/ccgb/suppliers/products?availableOnly=true')).data.products });
  if (isLoading || !data) return <Loading />;

  const { pool, myMembership: me, isCollector, currency: cur } = data;
  const collecting = pool.status === 'COLLECTING';
  const ordered = ['LOCKED', 'DISPATCHED', 'DELIVERED'].includes(pool.status);
  const maxVotes = Math.max(1, ...data.tallies.map((x) => x.votes));
  const refresh = () => { qc.invalidateQueries({ queryKey: ['food', poolId] }); qc.invalidateQueries({ queryKey: ['ledger'] }); qc.invalidateQueries({ queryKey: ['my-food'] }); };
  const reset = () => { setSheet(null); setAmount(''); setReference(''); setFile(null); };
  const guard = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); refresh(); } catch (e) { if (!pinRequired(e)) Alert.alert('Error', errMsg(e)); } finally { setBusy(false); }
  };
  const total = pool.contributionAmt * Number(shares);

  const join = () => guard(async () => { await api.post('/ccgb/pools/join', { poolId, shares: Number(shares), proofOfPaymentUrl: await uploadFile(file!) }); setFile(null); Alert.alert('Joined', 'Your collector will confirm your payment, then you can vote.'); });
  const vote = () => guard(async () => { await api.post('/ccgb/pools/vote', { poolId, productId }); });
  const verifyMember = (m: MemberRow) => guard(async () => { await api.patch(`/ccgb/admin/members/${m.id}/verify-payment`); });
  const lock = () => guard(async () => { const { data: r } = await api.post(`/ccgb/pools/${poolId}/lock`); Alert.alert('Pool locked', `${r.units} units ordered at the locked price. ${money(r.leftover, cur)} left over will be shared back.`); });
  const book = (slot: SlotRow) => guard(async () => { await api.post(`/ccgb/pools/${poolId}/slots/${slot.id}/book`); });
  const collected = (m: MemberRow) => guard(async () => { await api.post(`/ccgb/pools/${poolId}/members/${m.id}/collected`); });
  const rate = () => guard(async () => { await api.post(`/ccgb/pools/${poolId}/rate`, { stars: Number(stars_), qualityOk, comment: comment.trim() || undefined }); Alert.alert('Thank you', 'Your rating helps other groups choose good suppliers.'); });
  const pay = () => guard(async () => {
    const pin = await ask(); if (!pin) return;
    const proofUrl = file ? await uploadFile(file) : undefined;
    await api.post(`/ccgb/pools/${poolId}/payments`, { kind: payKind, amount: Number(amount), reference: reference.trim() || undefined, proofUrl, pin });
    reset();
  });
  const refund = (m: MemberRow) => guard(async () => {
    const pin = await ask(); if (!pin) return;
    const proofUrl = file ? await uploadFile(file) : undefined;
    await api.post(`/ccgb/pools/${poolId}/refunds/${m.id}`, { reference: reference.trim() || undefined, proofUrl, pin });
    reset();
  });
  const addSlot = () => guard(async () => {
    const startsAt = new Date(slotStart.replace(' ', 'T'));
    if (isNaN(startsAt.getTime())) throw new Error('Use the format 2026-11-05 10:00');
    await api.post(`/ccgb/pools/${poolId}/slots`, { slots: [{ startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + Number(slotHours) * 3600_000).toISOString(), capacity: Number(slotCap) }] });
    reset();
  });

  const supplierPaid = data.paid.supplierDeposit + data.paid.supplierBalance;

  return (
    <Screen>
      <View style={s.row}><Text style={s.h1}>{pool.group.name}</Text><StatusBadge status={pool.status} /></View>

      <Card>
        <View style={s.row}>
          <View><Text style={s.muted}>Price per share</Text><Text style={s.h2}>{money(pool.contributionAmt, cur)}</Text></View>
          <View><Text style={s.muted}>Members</Text><Text style={s.h2}>{pool.currentMembers} / {pool.targetMembers}</Text></View>
        </View>
        <ProgressBar value={pool.currentMembers} max={pool.targetMembers} color={colors.accent} />
        {collecting && <><Text style={s.muted}>Closes in</Text><Countdown end={pool.liveWindowEnd} /></>}
      </Card>

      <Card style={{ backgroundColor: colors.primary, borderColor: colors.primary }}>
        <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 16 }}>{t('heldByCollector')}</Text>
        <Text style={{ color: '#fff', fontSize: 30, fontWeight: '800' }}>{money(data.funds.heldByCollector, cur)}</Text>
        {data.funds.lastAttestation && data.funds.lastAttestation.mismatch !== 0 && <Text style={{ color: colors.accent, fontWeight: '700' }}>⚠️ Collector&apos;s last statement did not match the ledger</Text>}
        <Button title={`📖 ${t('ledger')}`} variant="accent" onPress={() => router.push(`/food/${poolId}/ledger`)} />
      </Card>

      {ordered && (
        <Card style={{ backgroundColor: colors.accentLight, borderColor: colors.accent, borderWidth: 2 }}>
          <Text style={s.h2}>🏆 {pool.winningProduct?.name}</Text>
          <Text style={s.body}>Supplier: {pool.winningProduct?.supplier.businessName} {pool.winningProduct && pool.winningProduct.supplier.ratingCount > 0 ? `${stars(pool.winningProduct.supplier.ratingAvg)} (${pool.winningProduct.supplier.ratingCount})` : ''}</Text>
          <Text style={s.body}>🔒 Price locked at <Text style={{ fontWeight: '800' }}>{money(pool.lockedUnitPrice ?? 0, cur)}</Text> per unit</Text>
          <Text style={s.body}>Order: <Text style={{ fontWeight: '800' }}>{pool.orderUnits} units ({pool.orderKg} kg)</Text> · transport {money(pool.transportFee, cur)}</Text>
          {pool.leftoverAmt > 0 && <Text style={s.body}>Left over {money(pool.leftoverAmt, cur)} is shared back by shares.</Text>}
          <Text style={s.body}>Paid to supplier so far: {money(supplierPaid, cur)} · driver: {money(data.paid.driver, cur)}</Text>
          <Text style={s.body}>Collection point: <Text style={{ fontWeight: '800' }}>{pool.communityHubAddr}</Text></Text>
          {pool.status === 'DELIVERED' && (
            <>
              <Text style={s.body}>📦 Delivered{pool.receivedKg != null ? ` · ${pool.receivedKg} kg received` : ''}</Text>
              {pool.deliveryProofUrl && <LinkText underline onPress={() => Linking.openURL(pool.deliveryProofUrl!)}>See delivery photo</LinkText>}
            </>
          )}
        </Card>
      )}
      {pool.status === 'DISSOLVED' && <Card><Text style={{ color: colors.warning, fontSize: 17 }}>This pool did not reach its target and was dissolved. Your collector will refund everyone who paid.</Text></Card>}

      {/* Refund owed to me */}
      {me && me.refundDue > 0 && (
        <Card style={{ borderColor: me.refundedAt ? '#16A34A' : colors.accent, borderWidth: 2 }}>
          <Text style={s.h3}>{me.refundedAt ? '✅ Refund recorded' : '↩️ Refund owed to you'}</Text>
          <Text style={{ fontSize: 26, fontWeight: '800' }}>{money(me.refundDue, cur)}</Text>
          {!me.refundedAt && <Text style={s.muted}>Your collector will pay you back and record it. If it doesn&apos;t happen, raise a problem from the Disputes screen.</Text>}
        </Card>
      )}

      {collecting && !me && (
        <Card style={{ gap: 10 }}>
          <Text style={s.h3}>Join this pool</Text>
          <Text style={[s.body, { fontWeight: '600' }]}>{t('shares')}</Text>
          <Chips value={shares} onChange={setShares} options={['1', '2', '3', '4', '5'].map((v) => ({ value: v, label: v }))} />
          <Text style={s.body}>Pay <Text style={{ fontWeight: '800' }}>{money(total, cur)}</Text> to your collector (they hold the money), then upload your proof.</Text>
          <Button title={file ? `📎 ${file.name}` : 'Choose proof of payment'} variant="outline" onPress={async () => setFile(await pickImage())} />
          <Button title="Submit" disabled={!file} loading={busy} onPress={join} />
        </Card>
      )}
      {collecting && me && !me.isPaidVerified && <Card><Text style={s.body}>⏳ Waiting for your collector to confirm your {money(pool.contributionAmt * me.shares, cur)}. Voting opens once confirmed.</Text></Card>}

      {collecting && me?.isPaidVerified && (
        <Card style={{ gap: 8 }}>
          <Text style={s.h3}>Vote for the food item</Text>
          {me.hasVoted ? <Text style={[s.body, { color: colors.primary, fontWeight: '700' }]}>✔ You have voted.</Text> : (
            <>
              {products.data?.map((p) => (
                <Pressable key={p.id} onPress={() => setProductId(p.id)} style={{ minHeight: TAP, borderRadius: 12, borderWidth: 2, padding: 10, borderColor: productId === p.id ? colors.primary : colors.border, backgroundColor: productId === p.id ? colors.primaryLight : '#fff' }}>
                  <Text style={[s.body, { fontWeight: '700' }]}>{p.name} · {money(p.unitPrice, cur)}</Text>
                  <Text style={s.muted}>{p.kgWeightPerUnit}kg · {p.supplier.businessName}{p.supplier.ratingCount > 0 ? ` · ${stars(p.supplier.ratingAvg)} (${p.supplier.ratingCount})` : ' · no ratings yet'}</Text>
                </Pressable>
              ))}
              {products.data?.length === 0 && <Text style={s.muted}>No products available yet.</Text>}
              <Button title={t('vote')} disabled={!productId} loading={busy} onPress={vote} />
            </>
          )}
        </Card>
      )}

      <Card>
        <Text style={s.h3}>Live tally</Text>
        {data.tallies.length === 0 && <Text style={s.muted}>No votes yet.</Text>}
        {data.tallies.map((x) => (
          <View key={x.productId} style={{ gap: 4 }}>
            <View style={s.row}><Text style={s.body}>{x.name} <Text style={s.muted}>({x.supplier})</Text></Text><Text style={{ fontWeight: '800' }}>{x.votes}</Text></View>
            <ProgressBar value={x.votes} max={maxVotes} color={colors.accent} />
          </View>
        ))}
      </Card>

      {/* Pickup time */}
      {ordered && me?.isPaidVerified && data.slots.length > 0 && (
        <Card style={{ gap: 8 }}>
          <Text style={s.h3}>🕒 {t('pickTime')}</Text>
          {me.collectedAt && <Text style={{ color: '#166534', fontWeight: '700' }}>✔ You collected your share.</Text>}
          {data.slots.map((sl) => {
            const mine = me.pickupSlotId === sl.id;
            return (
              <Pressable key={sl.id} disabled={sl.full && !mine} onPress={() => !mine && book(sl)} style={{ minHeight: TAP, borderRadius: 12, borderWidth: 2, padding: 10, borderColor: mine ? colors.primary : colors.border, backgroundColor: mine ? colors.primaryLight : '#fff', opacity: sl.full && !mine ? 0.5 : 1 }}>
                <Text style={[s.body, { fontWeight: '700' }]}>{mine ? '✔ ' : ''}{format(new Date(sl.startsAt), 'EEE d MMM, h:mma')} – {format(new Date(sl.endsAt), 'h:mma')}</Text>
                <Text style={s.muted}>{sl.full ? 'Full' : `${sl.capacity - sl.bookedCount} places left`}</Text>
              </Pressable>
            );
          })}
        </Card>
      )}

      {/* Rate */}
      {pool.status === 'DELIVERED' && me?.isPaidVerified && !data.iRated && (
        <Card style={{ gap: 8 }}>
          <Text style={s.h3}>⭐ {t('rate')}</Text>
          <Chips value={stars_} onChange={setStars} options={['1', '2', '3', '4', '5'].map((v) => ({ value: v, label: `${v}★` }))} />
          <Chips value={qualityOk ? 'ok' : 'bad'} onChange={(v) => setQualityOk(v === 'ok')} options={[{ value: 'ok', label: 'Good quality' }, { value: 'bad', label: 'There was a problem' }]} />
          <Field label="Comment (optional)" value={comment} onChangeText={setComment} />
          <Button title="Send rating" loading={busy} onPress={rate} />
        </Card>
      )}

      {/* Collector */}
      {isCollector && (
        <>
          <SectionTitle>{t('collectorTools')}</SectionTitle>
          <Card style={{ gap: 8 }}>
            {data.members?.length === 0 && <Text style={s.muted}>No members yet.</Text>}
            {data.members?.map((m) => (
              <View key={m.id} style={{ gap: 6, paddingVertical: 4 }}>
                <View style={s.row}><Text style={s.body}>{m.fullName} · {m.shares} share{m.shares > 1 ? 's' : ''}</Text>{m.isPaidVerified && <StatusBadge status="VERIFIED" />}</View>
                {m.proofOfPaymentUrl && <LinkText underline onPress={() => Linking.openURL(m.proofOfPaymentUrl!)}>View proof</LinkText>}
                {!m.isPaidVerified && collecting && <Button title={t('verify')} onPress={() => verifyMember(m)} />}
                {ordered && m.isPaidVerified && !m.collectedAt && <Button title="Mark as collected" variant="outline" onPress={() => collected(m)} />}
                {m.collectedAt && <Text style={{ color: '#166534' }}>✔ Collected</Text>}
                {m.refundDue > 0 && !m.refundedAt && <Button title={`Record refund of ${money(m.refundDue, cur)}`} variant="outline" onPress={() => setSheet({ kind: 'refund', m })} />}
                {m.refundedAt && <Text style={s.muted}>Refund recorded</Text>}
              </View>
            ))}
          </Card>
          {collecting && <Button title="Lock pool & place order" variant="accent" loading={busy} onPress={lock} />}
          {ordered && <Button title="💸 Record a payment I made" variant="outline" onPress={() => { setPayKind(pool.status === 'DELIVERED' ? 'SUPPLIER_BALANCE' : 'SUPPLIER_DEPOSIT'); setSheet({ kind: 'pay' }); }} />}
          {ordered && <Button title="➕ Add a collection time" variant="outline" onPress={() => setSheet({ kind: 'slot' })} />}
        </>
      )}

      <Sheet title="Record a payment I made" visible={sheet?.kind === 'pay'} onClose={reset}>
        <View style={{ gap: 10 }}>
          <Chips value={payKind} onChange={setPayKind} options={[{ value: 'SUPPLIER_DEPOSIT', label: `Deposit (max ${pool.supplierDepositPct}%)` }, { value: 'SUPPLIER_BALANCE', label: 'Balance (after delivery)' }, { value: 'DRIVER_FEE', label: 'Driver fee' }]} />
          <Field label={t('amount')} value={amount} onChangeText={setAmount} keyboardType="numeric" />
          <Field label="Transfer reference" value={reference} onChangeText={setReference} />
          <Button title={file ? `📎 ${file.name}` : 'Attach screenshot'} variant="outline" onPress={async () => setFile(await pickImage())} />
          <Button title={t('continue')} loading={busy} disabled={!(Number(amount) > 0) || (!reference.trim() && !file)} onPress={pay} />
        </View>
      </Sheet>
      <Sheet title="Record refund" visible={sheet?.kind === 'refund'} onClose={reset}>
        {sheet?.kind === 'refund' && (
          <View style={{ gap: 10 }}>
            <Text style={s.body}>Refund {money(sheet.m.refundDue, cur)} to {sheet.m.fullName}, then record it.</Text>
            <Field label="Transfer reference" value={reference} onChangeText={setReference} />
            <Button title={file ? `📎 ${file.name}` : 'Attach screenshot'} variant="outline" onPress={async () => setFile(await pickImage())} />
            <Button title={t('continue')} loading={busy} disabled={!reference.trim() && !file} onPress={() => refund(sheet.m)} />
          </View>
        )}
      </Sheet>
      <Sheet title="Add a collection time" visible={sheet?.kind === 'slot'} onClose={reset}>
        <View style={{ gap: 10 }}>
          <Field label="Starts (YYYY-MM-DD HH:MM)" value={slotStart} onChangeText={setSlotStart} placeholder="2026-11-05 10:00" />
          <Field label="Lasts how many hours" value={slotHours} onChangeText={setSlotHours} keyboardType="numeric" />
          <Field label="How many people at once" value={slotCap} onChangeText={setSlotCap} keyboardType="numeric" />
          <Button title="Add time" loading={busy} disabled={!slotStart.trim()} onPress={addSlot} />
        </View>
      </Sheet>
      {pinSheet}
    </Screen>
  );
}
