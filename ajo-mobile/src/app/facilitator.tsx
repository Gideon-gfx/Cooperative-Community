import { useState } from 'react';
import { Text, View } from 'react-native';
import { Alert } from '../components/feedback';
import { useQuery } from '@tanstack/react-query';
import { api, errMsg } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Button, Card, Loading, Screen, Sheet, s } from '../components/ui';
import { Chips, Field, SectionTitle } from '../components/widgets';
import { LangToggle, ModeLabel, ReadOnlyBanner, StatusCard, useRefreshModule } from '../components/igba';
import { useRouter } from 'expo-router';

interface Custody { approvedTier: number; requestedTier: number | null; pendingTier: number | null; eligibleTier: number; cleanRecord: { clean: boolean }; completedCycles: number }
interface Group { id: string; name: string; adminId: string; fundsMode?: string; pendingFundsMode?: string | null }
interface CollectorRec { collector: string; disputeRatePct: string; onTimeConfirmationPct: string; entriesInWindow: number; cleanRecord: boolean; completedCycles: number }

// Facilitator tools: the collector's verification level, each group's funds mode, and the record members see.
export default function Facilitator() {
  const { t, user } = useAuth();
  const router = useRouter();
  const refresh = useRefreshModule();
  const me = useQuery({ queryKey: ['custody-me'], queryFn: async () => (await api.get<Custody>('/payments/custody/me')).data });
  const groups = useQuery({ queryKey: ['my-groups'], queryFn: async () => (await api.get<{ groups: Group[] }>('/groups/mine')).data.groups });
  const [kyc, setKyc] = useState(false);
  const [kind, setKind] = useState<'BVN' | 'NIN'>('BVN');
  const [idNo, setIdNo] = useState('');
  const [rec, setRec] = useState<{ g: Group; r: CollectorRec } | null>(null);
  const [busy, setBusy] = useState(false);
  if (me.isLoading || groups.isLoading || !me.data) return <Loading />;
  const mine = (groups.data ?? []).filter((g) => g.adminId === user?.id);
  const m = me.data;

  const run = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); await refresh(); await Promise.all([me.refetch(), groups.refetch()]); } catch (e) { Alert.alert(t('ib_error'), errMsg(e)); } finally { setBusy(false); } };
  const verify = () => run(async () => { const { data } = await api.post<{ nameMatch: boolean }>('/payments/custody/kyc', { kind, idNumber: idNo }); setKyc(false); setIdNo(''); Alert.alert(data.nameMatch ? t('ib_verified') : t('ib_nameNoMatch')); });
  const showRecord = async (g: Group) => { try { setRec({ g, r: (await api.get<CollectorRec>(`/trust/groups/${g.id}/collector`)).data }); } catch (e) { Alert.alert(t('ib_error'), errMsg(e)); } };

  return (
    <Screen loaderButtons>
      <LangToggle />
      <ReadOnlyBanner />
      <StatusCard tone={m.approvedTier > 0 ? 'green' : 'yellow'} title={t('ib_custodyLevel', { n: m.approvedTier })} body={t(m.approvedTier > 0 ? 'ib_custodyOk' : 'ib_custodyNone')} speakText={t(m.approvedTier > 0 ? 'ib_custodyOk' : 'ib_custodyNone')} />
      <Card>
        <Text style={s.body}>{t('ib_cyclesDone', { n: m.completedCycles })}</Text>
        <Text style={s.body}>{m.cleanRecord.clean ? `🟢 ${t('ib_cleanRecord')}` : `🟡 ${t('ib_notCleanRecord')}`}</Text>
        {m.pendingTier ? <Text style={s.muted}>{t('ib_tierPending', { n: m.pendingTier })}</Text> : null}
        <Button title={t('ib_verifyId')} variant="outline" onPress={() => setKyc(true)} />
        {m.eligibleTier > m.approvedTier && <Button title={t('ib_requestTier', { n: m.eligibleTier })} variant="accent" loading={busy} onPress={() => run(() => api.post('/payments/custody/tier/request', { tier: m.eligibleTier }))} />}
      </Card>

      <SectionTitle>{t('ib_myGroups')}</SectionTitle>
      {mine.length === 0 && <Text style={s.muted}>{t('ib_noOwnGroups')}</Text>}
      {mine.map((g) => (
        <Card key={g.id}>
          <Text style={s.h3}>{g.name}</Text>
          <ModeLabel mode={g.fundsMode} />
          {g.pendingFundsMode ? <Text style={s.muted}>{t('ib_modeChangeNext')}</Text> : null}
          <Chips<string> value={g.pendingFundsMode ?? g.fundsMode ?? 'ESCROW'} onChange={(v) => v !== (g.pendingFundsMode ?? g.fundsMode) && Alert.alert(t('ib_changeModeTitle'), t(v === 'ESCROW' ? 'ib_changeToEscrow' : 'ib_changeToCustody'), [{ text: t('ib_cancel'), style: 'cancel' }, { text: t('ib_confirm'), onPress: () => run(() => api.post(`/payments/groups/${g.id}/funds-mode`, { mode: v })) }])} options={[{ value: 'ESCROW', label: t('ib_modeEscrow') }, { value: 'COLLECTOR_CUSTODY', label: t('ib_modeCustody') }]} />
          <Button title={t('ib_viewMyRecord')} variant="outline" onPress={() => showRecord(g)} />
          <Button title={t('ib_importCenter')} variant="outline" onPress={() => router.push({ pathname: '/import', params: { groupId: g.id } })} />
          {(g.fundsMode === 'COLLECTOR_CUSTODY' || g.pendingFundsMode === 'COLLECTOR_CUSTODY') && <Button title={t('ib_signCollectorAgreement')} variant="accent" onPress={() => router.push({ pathname: '/consent/[type]', params: { type: 'CUSTODY_COLLECTOR_AGREEMENT', groupId: g.id } })} />}
        </Card>
      ))}
      <Button title={`💳 ${t('ib_billing')}`} variant="outline" onPress={() => router.push('/billing')} />

      <Sheet title={t('ib_verifyId')} visible={kyc} onClose={() => setKyc(false)}>
        <View style={{ gap: 12 }}>
          <Text style={s.muted}>{t('ib_kycPrivacy')}</Text>
          <Chips<'BVN' | 'NIN'> value={kind} onChange={setKind} options={[{ value: 'BVN', label: 'BVN' }, { value: 'NIN', label: 'NIN' }]} />
          <Field label={t('ib_idNumber')} value={idNo} onChangeText={setIdNo} keyboardType="number-pad" maxLength={11} secure />
          <Button title={t('ib_verify')} loading={busy} disabled={!/^\d{11}$/.test(idNo)} onPress={verify} />
        </View>
      </Sheet>
      <Sheet title={rec?.g.name ?? ''} visible={!!rec} onClose={() => setRec(null)}>
        {rec && (
          <View style={{ gap: 8 }}>
            <Text style={s.body}>{t('ib_disputeRate')}: {rec.r.disputeRatePct}%</Text>
            <Text style={s.body}>{t('ib_onTimeConfirm')}: {rec.r.onTimeConfirmationPct}%</Text>
            <Text style={s.body}>{t('ib_entriesChecked', { n: rec.r.entriesInWindow })}</Text>
            <Text style={s.body}>{rec.r.cleanRecord ? `🟢 ${t('ib_cleanRecord')}` : `🟡 ${t('ib_notCleanRecord')}`}</Text>
          </View>
        )}
      </Sheet>
    </Screen>
  );
}
