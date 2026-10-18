import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Alert } from '../../../components/feedback';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { api, errMsg, money, uploadFile } from '../../../api/client';
import { useAuth } from '../../../auth/AuthContext';
import { Button, Card, Loading, Screen, Sheet, StatusBadge, s } from '../../../components/ui';
import type { FundsMode } from '../../../constants';
import { Chips, Field, LedgerNotice, ModeBadge, SectionTitle, usePinPrompt, usePinRequiredHandler } from '../../../components/widgets';
import { pickImage, type PickedFile } from '../../../components/pickers';
import { Banner, bannerLabel, ProgressLine, type Campaign, type Progress } from '../../../components/campaigns';
import { colors, fonts } from '../../../theme';

interface Gift {
  id: string; userId: string; name: string; kind: 'MONEY' | 'FOOD'; amount: number; foodNote?: string | null; status: 'PENDING' | 'VERIFIED';
  optionId?: string | null; optionLabel?: string | null; collectedAt?: string | null; createdAt: string; method?: string; proofUrl?: string; reference?: string; receiptNo?: string | null;
}
interface Detail {
  campaign: Campaign & { isRecipient: boolean; fundsMode?: FundsMode };
  gifts: Gift[]; progress: Progress;
  funds: { heldByCollector: number; totalIn: number; totalOut: number };
}

type SheetKind = 'pay' | 'food' | 'reject' | 'deliver' | null;

export default function CampaignScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { t } = useAuth();
  const qc = useQueryClient();
  const { ask, element: pinEl } = usePinPrompt();
  const pinRequired = usePinRequiredHandler();
  const { data, isLoading } = useQuery({ queryKey: ['campaign', id], queryFn: async () => (await api.get<Detail>(`/campaigns/${id}`)).data });
  const me = useQuery({ queryKey: ['profile'], queryFn: async () => (await api.get<{ user: { id: string } }>('/auth/profile')).data });

  const [sheet, setSheet] = useState<SheetKind>(null);
  const [option, setOption] = useState('');
  const [method, setMethod] = useState<'TRANSFER' | 'CASH'>('TRANSFER');
  const [reference, setReference] = useState('');
  const [amount, setAmount] = useState('');
  const [food, setFood] = useState('');
  const [note, setNote] = useState('');
  const [proof, setProof] = useState<PickedFile | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (isLoading || !data) return <Loading />;
  const { campaign: c, gifts, progress, funds } = data;
  const cur = c.currency;
  const mine = gifts.filter((g) => g.userId === me.data?.user.id);
  const myMoney = mine.find((g) => g.kind === 'MONEY');
  const waiting = gifts.filter((g) => g.status === 'PENDING');
  const outfit = option || c.options[0]?.id || '';
  const refresh = () => { qc.invalidateQueries({ queryKey: ['campaign', id] }); qc.invalidateQueries({ queryKey: ['campaigns'] }); qc.invalidateQueries({ queryKey: ['ledger', 'campaign', id] }); };
  const close = () => { setSheet(null); setAmount(''); setFood(''); setNote(''); setReference(''); setProof(null); setRejecting(null); };

  const run = async (fn: () => Promise<unknown>, done?: () => void) => {
    setBusy(true);
    try { await fn(); refresh(); done?.(); } catch (e) { if (!pinRequired(e)) Alert.alert('Error', errMsg(e)); } finally { setBusy(false); }
  };

  const give = (kind: 'MONEY' | 'FOOD') => run(async () => {
    await api.post(`/campaigns/${id}/gifts`, {
      kind, optionId: kind === 'MONEY' && c.kind === 'ASO_EBI' ? outfit : undefined,
      amount: kind === 'MONEY' && c.kind !== 'ASO_EBI' ? Number(amount) : undefined,
      foodNote: kind === 'FOOD' ? food.trim() : undefined,
      method: kind === 'MONEY' ? method : undefined, reference: reference.trim() || undefined,
      proofUrl: proof ? await uploadFile(proof) : undefined,
    });
  }, close);

  const deliver = async () => {
    const pin = await ask();
    if (!pin) return;
    await run(async () => {
      await api.post(`/campaigns/${id}/deliver`, { amount: amount ? Number(amount) : undefined, note: note.trim() || undefined, proofUrl: proof ? await uploadFile(proof) : undefined, pin });
    }, close);
  };

  const canGive = c.status === 'OPEN' && !(c.kind === 'ASO_EBI' && myMoney);
  const dateText = c.eventDate ? format(new Date(c.eventDate), 'EEE d MMM yyyy') : null;

  return (
    <Screen>
      <Card style={{ padding: 0, overflow: 'hidden', gap: 0 }}>
        <Banner kind={c.kind} label={bannerLabel(c, t)} />
        <View style={{ padding: 16, gap: 8 }}>
          <ModeBadge mode={c.fundsMode} />
          <Text style={s.h2}>{c.title}</Text>
          <Text style={s.muted}>{[dateText, c.venue, c.kind === 'HELP' && c.recipientName ? `For ${c.recipientName}` : null, `Host: ${c.hostName}`, c.groupName].filter(Boolean).join(' · ')}</Text>
          {(c.description || c.recipientNote) && <Text style={s.body}>{c.description || c.recipientNote}</Text>}
          {c.kind === 'ASO_EBI' && c.partAmount ? (
            <View style={s.row}><Text style={s.body}>Your part (set by host)</Text><Text style={{ fontFamily: fonts.mono, fontSize: 24, color: colors.cocoa }}>{money(c.partAmount, cur)}</Text></View>
          ) : null}
          <ProgressLine c={c} p={progress} />
          {progress.foodPledges > 0 && <Text style={s.muted}>🍚 {progress.foodPledges} food pledge{progress.foodPledges > 1 ? 's' : ''}</Text>}
          {c.status !== 'OPEN' && <StatusBadge status={c.status === 'CLOSED' ? 'LOCKED' : c.status} />}
        </View>
      </Card>

      {c.kind === 'ASO_EBI' && canGive && (
        <>
          <SectionTitle>Choose your outfit</SectionTitle>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            {c.options.map((o) => {
              const on = o.id === outfit;
              return (
                <Pressable key={o.id} onPress={() => setOption(o.id)} style={{ flexGrow: 1, flexBasis: '45%', minHeight: 64, padding: 12, borderRadius: 16, borderWidth: 2, borderColor: on ? colors.zobo : colors.border, backgroundColor: on ? '#FBE3EA' : colors.card }}>
                  <Text style={{ fontFamily: fonts.bodyBold, fontSize: 17, color: colors.text }}>{o.label}</Text>
                  {o.note ? <Text style={s.muted}>{o.note}</Text> : null}
                </Pressable>
              );
            })}
          </View>
          <Button title="Pay & reserve fabric" onPress={() => setSheet('pay')} />
        </>
      )}
      {c.kind !== 'ASO_EBI' && canGive && (
        <View style={{ gap: 10 }}>
          <Button title="Give money" onPress={() => setSheet('pay')} />
          <Button title="🍚 Pledge food" variant="outline" onPress={() => setSheet('food')} />
        </View>
      )}

      {mine.length > 0 && (
        <Card style={{ borderColor: colors.green }}>
          <Text style={s.h3}>Your gift</Text>
          {mine.map((g) => (
            <Text key={g.id} style={s.body}>
              {g.kind === 'MONEY' ? money(g.amount, cur) : `🍚 ${g.foodNote}`}{g.optionLabel ? ` · ${g.optionLabel}` : ''} ·{' '}
              <Text style={{ fontFamily: fonts.bodyBold, color: g.status === 'VERIFIED' ? colors.green : colors.muted }}>{g.status === 'VERIFIED' ? `✔ Confirmed · receipt ${g.receiptNo}` : '🕒 waiting for the host'}</Text>
              {g.collectedAt ? ' · picked up' : ''}
            </Text>
          ))}
        </Card>
      )}

      {c.kind === 'HELP' && c.deliveredAt && (
        <Card style={{ borderColor: c.recipientConfirmedAt ? colors.green : colors.cocoa }}>
          <Text style={s.h3}>✅ Help delivered</Text>
          <Text style={s.body}>{c.deliveredAmount ? `${money(c.deliveredAmount, cur)} ` : ''}{c.deliveryNote ?? ''}</Text>
          <Text style={s.muted}>{format(new Date(c.deliveredAt), 'd MMM yyyy')} · {c.recipientConfirmedAt ? `${c.recipientName} confirmed it arrived` : 'waiting for the family to confirm'}</Text>
          {c.isRecipient && !c.recipientConfirmedAt && (
            <View style={{ gap: 8, marginTop: 6 }}>
              <Button title="It arrived" loading={busy} onPress={() => run(() => api.post(`/campaigns/${id}/confirm`, { received: true }))} />
              <Button title="It did NOT arrive" variant="danger" onPress={() => run(() => api.post(`/campaigns/${id}/confirm`, { received: false }))} />
            </View>
          )}
        </Card>
      )}

      <Card>
        <Text style={s.muted}>Money held by the host</Text>
        <Text style={{ fontFamily: fonts.mono, fontSize: 26, color: colors.cocoa }}>{money(funds.heldByCollector, cur)}</Text>
        <Text style={s.muted}>In {money(funds.totalIn, cur)} · Out {money(funds.totalOut, cur)}</Text>
        <Button title="📒 See every naira" variant="outline" onPress={() => router.push(`/campaigns/${id}/ledger`)} />
      </Card>

      {c.isHost && (
        <>
          {waiting.length > 0 && (
            <>
              <SectionTitle>To confirm</SectionTitle>
              {waiting.map((g) => (
                <Card key={g.id}>
                  <Text style={s.h3}>{g.name}</Text>
                  <Text style={s.body}>{g.kind === 'MONEY' ? `${money(g.amount, cur)} · ${(g.method ?? '').toLowerCase()}` : `🍚 ${g.foodNote}`}{g.optionLabel ? ` · ${g.optionLabel}` : ''}</Text>
                  {g.reference ? <Text style={s.muted}>Ref: {g.reference}</Text> : null}
                  <View style={{ flexDirection: 'row', gap: 10 }}>
                    <Button style={{ flex: 1 }} title="Confirm" loading={busy} onPress={() => run(() => api.patch(`/campaigns/gifts/${g.id}/verify`))} />
                    <Button style={{ flex: 1 }} title="Reject" variant="outline" onPress={() => { setRejecting(g.id); setSheet('reject'); }} />
                  </View>
                </Card>
              ))}
            </>
          )}
          <SectionTitle>Host tools</SectionTitle>
          {c.kind === 'HELP' && c.status !== 'COMPLETED' && <Button title="Record that help reached them" onPress={() => setSheet('deliver')} />}
          {c.status === 'OPEN' && <Button title="Stop taking gifts" variant="outline" onPress={() => run(() => api.patch(`/campaigns/${id}/status`, { status: 'CLOSED' }))} />}
          {c.status === 'CLOSED' && <Button title="Open it again" variant="outline" onPress={() => run(() => api.patch(`/campaigns/${id}/status`, { status: 'OPEN' }))} />}
        </>
      )}

      <SectionTitle>Who has given</SectionTitle>
      {c.kind === 'ASO_EBI' && c.options.map((o) => {
        const n = gifts.filter((g) => g.optionId === o.id && g.status === 'VERIFIED').length;
        return <Text key={o.id} style={s.muted}>{o.label}: {n}</Text>;
      })}
      {gifts.length === 0 && <Text style={s.muted}>Nobody yet. Be the first.</Text>}
      {gifts.map((g) => (
        <Card key={g.id} style={{ paddingVertical: 10 }}>
          <View style={s.row}>
            <View style={{ flex: 1 }}>
              <Text style={s.body}>{g.name}</Text>
              <Text style={s.muted}>{g.kind === 'FOOD' ? `🍚 ${g.foodNote}` : g.optionLabel ?? money(g.amount, cur)}</Text>
            </View>
            {g.status === 'VERIFIED' ? <StatusBadge status="VERIFIED" /> : <StatusBadge status="PENDING" />}
            {c.isHost && c.kind === 'ASO_EBI' && g.status === 'VERIFIED' && (
              <Pressable accessibilityLabel="Mark handed over" onPress={() => run(() => api.patch(`/campaigns/gifts/${g.id}/collected`, { collected: !g.collectedAt }))} style={{ minWidth: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ fontSize: 24 }}>{g.collectedAt ? '✅' : '⬜'}</Text>
              </Pressable>
            )}
            {!c.isHost && g.collectedAt ? <Text>✅</Text> : null}
          </View>
        </Card>
      ))}

      <Sheet title={c.kind === 'ASO_EBI' ? 'Pay & reserve fabric' : 'Give money'} visible={sheet === 'pay'} onClose={close}>
        <View style={{ gap: 10 }}>
          <LedgerNotice mode={c.fundsMode} />
          {c.kind === 'ASO_EBI' ? <Text style={s.body}>You pay <Text style={{ fontFamily: fonts.mono }}>{money(c.partAmount ?? 0, cur)}</Text> to the host.</Text> : <Field label="Amount" value={amount} onChangeText={setAmount} keyboardType="numeric" />}
          <Text style={s.muted}>Pay the host by bank transfer or cash, then record it here. They will confirm it and you get a receipt.</Text>
          <Chips value={method} onChange={setMethod} options={[{ value: 'TRANSFER', label: 'Bank transfer' }, { value: 'CASH', label: 'Cash' }]} />
          <Field label="Reference (optional)" value={reference} onChangeText={setReference} />
          <Button title={proof ? `📷 ${proof.name}` : '📷 Add proof (optional)'} variant="outline" onPress={async () => setProof(await pickImage())} />
          <Button title="I have paid" loading={busy} disabled={c.kind !== 'ASO_EBI' && !(Number(amount) > 0)} onPress={() => give('MONEY')} />
        </View>
      </Sheet>

      <Sheet title="Pledge food" visible={sheet === 'food'} onClose={close}>
        <View style={{ gap: 10 }}>
          <Field label="What will you give?" value={food} onChangeText={setFood} placeholder="2 bags of rice" maxLength={150} />
          <Button title="Pledge it" loading={busy} disabled={food.trim().length < 2} onPress={() => give('FOOD')} />
        </View>
      </Sheet>

      <Sheet title="Why not?" visible={sheet === 'reject'} onClose={close}>
        <View style={{ gap: 10 }}>
          <Field label="Tell them why" value={note} onChangeText={setNote} maxLength={200} />
          <Button title="Reject" variant="danger" loading={busy} disabled={note.trim().length < 2} onPress={() => run(() => api.patch(`/campaigns/gifts/${rejecting}/reject`, { reason: note.trim() }), close)} />
        </View>
      </Sheet>

      <Sheet title="Help reached them" visible={sheet === 'deliver'} onClose={close}>
        <View style={{ gap: 10 }}>
          <Field label="Money paid out (optional)" value={amount} onChangeText={setAmount} keyboardType="numeric" />
          <Field label="What was delivered? (e.g. 5 bags of rice)" value={note} onChangeText={setNote} maxLength={300} />
          <Button title={proof ? `📷 ${proof.name}` : '📷 Add a photo (optional)'} variant="outline" onPress={async () => setProof(await pickImage())} />
          <Button title="Record it" loading={busy} disabled={!(Number(amount) > 0) && note.trim().length < 2} onPress={deliver} />
        </View>
      </Sheet>
      {pinEl}
    </Screen>
  );
}
