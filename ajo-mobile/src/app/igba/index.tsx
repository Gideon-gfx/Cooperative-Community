import { useState } from 'react';
import { Text, View } from 'react-native';
import { Alert } from '../../components/feedback';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { differenceInCalendarMonths, format } from 'date-fns';
import { api, errMsg, naira } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Button, Card, Loading, Screen, Sheet, s } from '../../components/ui';
import { Field, SectionTitle } from '../../components/widgets';
import { LangToggle, ProgressRing, ReadOnlyBanner, StatusCard, TierBadge, toneOfContract, useMyContracts, type Contract } from '../../components/igba';

interface TrustRow { subject: 'APPRENTICE' | 'MASTER'; score: number | null; tier: string; honestyFlags: number }

const monthsDone = (c: Contract) => (c.startDate ? Math.max(0, Math.min(c.durationMonths, differenceInCalendarMonths(new Date(), new Date(c.startDate)))) : 0);

// My Apprenticeship: one card per agreement, as apprentice, master, guarantor or guardian.
export default function MyApprenticeship() {
  const { user, t } = useAuth();
  const router = useRouter();
  const list = useMyContracts();
  const trust = useQuery({ queryKey: ['trust-me'], queryFn: async () => (await api.get<{ scores: TrustRow[] }>('/trust/me')).data.scores });
  const [apply, setApply] = useState(false);
  const [trades, setTrades] = useState('');
  const [dobOpen, setDobOpen] = useState(false);
  const [dob, setDob] = useState('');
  const [busy, setBusy] = useState(false);

  if (list.isLoading) return <Loading />;
  const mine = list.data ?? [];
  const isMaster = user?.role === 'TRADE_MASTER' || mine.some((c) => c.myRole === 'MASTER');

  const submitApply = async () => {
    setBusy(true);
    try {
      await api.post('/contracts/masters/apply', { tradeCategories: trades.split(',').map((x) => x.trim()).filter(Boolean) });
      setApply(false); Alert.alert(t('ib_sent'), t('ib_masterApplied'));
    } catch (e) { Alert.alert(t('ib_error'), errMsg(e)); } finally { setBusy(false); }
  };
  const submitDob = async () => {
    setBusy(true);
    try { await api.post('/contracts/me/date-of-birth', { dateOfBirth: dob }); setDobOpen(false); Alert.alert(t('ib_saved'), t('ib_dobSaved')); }
    catch (e) { Alert.alert(t('ib_error'), errMsg(e)); } finally { setBusy(false); }
  };

  return (
    <Screen>
      <LangToggle />
      <ReadOnlyBanner />
      <SectionTitle>{t('ib_myApprenticeship')}</SectionTitle>

      {(trust.data ?? []).map((r) => (
        <Card key={r.subject}>
          <Text style={s.muted}>{t(r.subject === 'MASTER' ? 'ib_trustAsMaster' : 'ib_trustAsApprentice')}</Text>
          <View style={[s.row, { justifyContent: 'flex-start', gap: 12 }]}>
            <TierBadge tier={r.tier} />
            {r.score !== null && <Text style={[s.money, { fontSize: 20 }]}>{r.score}/100</Text>}
          </View>
          {r.honestyFlags > 0 && <Text style={s.muted}>{t('ib_honestyFlags', { n: r.honestyFlags })}</Text>}
        </Card>
      ))}

      {mine.length === 0 && <StatusCard tone="yellow" title={t('ib_noAgreementsTitle')} body={t('ib_noAgreementsBody')} speakText={t('ib_noAgreementsBody')} />}

      {mine.map((c) => {
        const done = c.milestones.filter((m) => m.status === 'APPROVED').length;
        const waiting = c.status === 'PENDING_SIGNATURES' && c.waitingFor.includes(c.myRole ?? '');
        const inReview = c.milestones.filter((m) => m.status === 'SUBMITTED_FOR_REVIEW').length;
        const next = c.milestones.find((m) => m.status !== 'APPROVED');
        const tone = waiting || (c.myRole === 'MASTER' && inReview > 0) ? 'yellow' : toneOfContract(c.status);
        const body = waiting ? t('ib_yourSignatureNeeded')
          : c.myRole === 'MASTER' && inReview > 0 ? t('ib_toReviewN', { n: inReview })
          : next ? t('ib_nextMilestone', { title: next.title, date: format(new Date(next.dueDate), 'd MMM yyyy') }) : t(`ib_status_${c.status}`);
        return (
          <View key={c.id} style={{ gap: 8 }}>
            <StatusCard tone={tone} title={`${c.tradeCategory} · ${t(`ib_status_${c.status}`)}`} body={`${t(`ib_role_${c.myRole}`)} · ${body}`} speakText={`${c.tradeCategory}. ${body}`} onPress={() => router.push(`/igba/${c.id}`)} />
            {c.startDate && (
              <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
                <ProgressRing value={monthsDone(c)} max={c.durationMonths} label={t('ib_months')} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={s.body}>{t('ib_milestonesDone', { done, total: c.milestones.length })}</Text>
                  <Text style={s.muted}>{t('ib_monthlySaving')}: {naira(c.monthlyContribution)}</Text>
                  <Text style={s.muted}>{t('ib_target')}: {naira(c.targetSettlement)}</Text>
                </View>
              </Card>
            )}
          </View>
        );
      })}

      {isMaster && <Button title={`➕ ${t('ib_newAgreement')}`} onPress={() => router.push('/igba/new')} />}
      {isMaster && <Button title={`📝 ${t('ib_reviewQueue')}`} variant="accent" onPress={() => router.push('/igba/review')} />}
      {!isMaster && <Button title={t('ib_applyMaster')} variant="outline" onPress={() => setApply(true)} />}
      <Button title={t('ib_setDob')} variant="outline" onPress={() => setDobOpen(true)} />
      <Button title={`💸 ${t('ib_feePreview')}`} variant="outline" onPress={() => router.push('/fees')} />

      <Sheet title={t('ib_applyMaster')} visible={apply} onClose={() => setApply(false)}>
        <View style={{ gap: 12 }}>
          <Text style={s.muted}>{t('ib_applyMasterHint')}</Text>
          <Field label={t('ib_trades')} value={trades} onChangeText={setTrades} placeholder={t('ib_tradesHint')} />
          <Button title={t('ib_send')} loading={busy} disabled={!trades.trim()} onPress={submitApply} />
        </View>
      </Sheet>
      <Sheet title={t('ib_setDob')} visible={dobOpen} onClose={() => setDobOpen(false)}>
        <View style={{ gap: 12 }}>
          <Text style={s.muted}>{t('ib_dobWhy')}</Text>
          <Field label={t('ib_dobLabel')} value={dob} onChangeText={setDob} placeholder="2008-05-17" keyboardType="numbers-and-punctuation" maxLength={10} />
          <Button title={t('ib_save')} loading={busy} disabled={!/^\d{4}-\d{2}-\d{2}$/.test(dob)} onPress={submitDob} />
        </View>
      </Sheet>
    </Screen>
  );
}
