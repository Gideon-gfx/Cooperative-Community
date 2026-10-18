import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Alert } from '../../components/feedback';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { api, errMsg } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Button, Card, Loading, ProgressBar, Screen, s } from '../../components/ui';
import { Chips, Field } from '../../components/widgets';
import { FeeBreakdown, useFeePreview } from '../../components/fees';
import { LangToggle, ModeLabel, StatusCard, useRefreshModule } from '../../components/igba';
import { colors, fonts, TAP } from '../../theme';

const DURATIONS = [6, 9, 12, 18, 24];
const STEPS = 6;
interface Group { id: string; name: string; adminId: string; fundsMode?: string }
interface Ms { title: string; dueMonth: string }

// Contract wizard: one question group per screen, with the money breakdown shown before anything is sent.
export default function NewAgreement() {
  const { t } = useAuth();
  const router = useRouter();
  const refresh = useRefreshModule();
  const groups = useQuery({ queryKey: ['my-groups'], queryFn: async () => (await api.get<{ groups: Group[] }>('/groups/mine')).data.groups });
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [groupId, setGroupId] = useState('');
  const [trade, setTrade] = useState('');
  const [months, setMonths] = useState(12);
  const [monthly, setMonthly] = useState('');
  const [target, setTarget] = useState('');
  const [stipend, setStipend] = useState('');
  const [apprentice, setApprentice] = useState('');
  const [guarantor, setGuarantor] = useState('');
  const [guardian, setGuardian] = useState('');
  const [needsGuardian, setNeedsGuardian] = useState(false);
  const [terms, setTerms] = useState('');
  const [ms, setMs] = useState<Ms[]>([{ title: '', dueMonth: '3' }]);
  const fee = useFeePreview(monthly, 'SETTLEMENT_FUND');

  if (groups.isLoading) return <Loading />;
  const g = groups.data?.find((x) => x.id === groupId);
  const cleanMs = ms.filter((m) => m.title.trim().length >= 2).map((m) => ({ title: m.title.trim(), dueMonth: Math.min(24, Math.max(1, Number(m.dueMonth) || 1)) }));
  const canNext = [
    !!groupId && (!g?.fundsMode || g.fundsMode === 'ESCROW'),
    trade.trim().length >= 2,
    Number(monthly) > 0 && Number(target) > 0,
    apprentice.length >= 6 && guarantor.length >= 6 && (!needsGuardian || guardian.length >= 6),
    terms.trim().length >= 30,
    true,
  ][step];

  const create = async () => {
    setBusy(true);
    try {
      const { data } = await api.post<{ id: string }>('/contracts', {
        groupId, tradeCategory: trade.trim(), durationMonths: months, monthlyContribution: monthly, targetSettlement: target, ...(stipend ? { monthlyStipend: stipend } : {}),
        termsAndConditions: terms.trim(), apprenticePhone: apprentice.trim(), guarantorPhone: guarantor.trim(), ...(needsGuardian ? { guardianPhone: guardian.trim() } : {}), milestones: cleanMs,
      });
      await api.post(`/contracts/${data.id}/send`);
      await refresh();
      router.replace(`/igba/${data.id}`);
    } catch (e) { Alert.alert(t('ib_error'), errMsg(e)); } finally { setBusy(false); }
  };

  return (
    <Screen>
      <LangToggle />
      <ProgressBar value={step + 1} max={STEPS} color={colors.green} />
      <Text style={s.muted}>{t('ib_stepOf', { n: step + 1, total: STEPS })}</Text>

      {step === 0 && (<>
        <Text style={s.h2}>{t('ib_wiz_group')}</Text>
        <Text style={s.muted}>{t('ib_wiz_groupHint')}</Text>
        {(groups.data ?? []).map((x) => (
          <Pressable key={x.id} onPress={() => setGroupId(x.id)} style={{ minHeight: TAP }}>
            <Card style={groupId === x.id ? { borderColor: colors.green, backgroundColor: '#DCFCE7' } : undefined}>
              <Text style={s.h3}>{x.name}</Text>
              <ModeLabel mode={x.fundsMode} />
              {x.fundsMode && x.fundsMode !== 'ESCROW' && <Text style={{ color: colors.red, fontFamily: fonts.bodyBold }}>{t('ib_needEscrow')}</Text>}
            </Card>
          </Pressable>
        ))}
        {!groups.data?.length && <StatusCard tone="yellow" title={t('ib_noGroup')} body={t('ib_noGroupHint')} />}
      </>)}

      {step === 1 && (<>
        <Text style={s.h2}>{t('ib_wiz_trade')}</Text>
        <Field label={t('ib_trade')} value={trade} onChangeText={setTrade} placeholder={t('ib_tradeHint')} />
        <Text style={s.body}>{t('ib_duration')}</Text>
        <Chips<string> value={String(months)} onChange={(v) => setMonths(Number(v))} options={DURATIONS.map((d) => ({ value: String(d), label: t('ib_nMonths', { n: d }) }))} />
      </>)}

      {step === 2 && (<>
        <Text style={s.h2}>{t('ib_wiz_money')}</Text>
        <Field label={t('ib_monthlySaving')} value={monthly} onChangeText={setMonthly} keyboardType="numeric" />
        <Field label={t('ib_target')} value={target} onChangeText={setTarget} keyboardType="numeric" />
        <Field label={t('ib_stipend')} value={stipend} onChangeText={setStipend} keyboardType="numeric" />
        <Text style={s.muted}>{t('ib_noInterest')}</Text>
        {fee.data && (<><Text style={s.h3}>{t('ib_feeEachMonth')}</Text><FeeBreakdown w={fee.data.waterfall} bp={fee.data.platformCommissionBp} /></>)}
      </>)}

      {step === 3 && (<>
        <Text style={s.h2}>{t('ib_wiz_people')}</Text>
        <Field label={t('ib_apprenticePhone')} value={apprentice} onChangeText={setApprentice} keyboardType="phone-pad" />
        <Field label={t('ib_guarantorPhone')} value={guarantor} onChangeText={setGuarantor} keyboardType="phone-pad" />
        <Text style={s.muted}>{t('ib_guarantorHint')}</Text>
        <Chips<string> value={needsGuardian ? 'Y' : 'N'} onChange={(v) => setNeedsGuardian(v === 'Y')} options={[{ value: 'N', label: t('ib_adult') }, { value: 'Y', label: t('ib_minor') }]} />
        {needsGuardian && <Field label={t('ib_guardianPhone')} value={guardian} onChangeText={setGuardian} keyboardType="phone-pad" />}
      </>)}

      {step === 4 && (<>
        <Text style={s.h2}>{t('ib_wiz_terms')}</Text>
        <Field label={t('ib_terms')} value={terms} onChangeText={setTerms} multiline maxLength={10000} />
        <Text style={s.h3}>{t('ib_milestones')}</Text>
        {ms.map((m, i) => (
          <Card key={i}>
            <Field label={t('ib_milestoneTitle')} value={m.title} onChangeText={(v) => setMs(ms.map((x, j) => (j === i ? { ...x, title: v } : x)))} />
            <Field label={t('ib_dueMonth')} value={m.dueMonth} onChangeText={(v) => setMs(ms.map((x, j) => (j === i ? { ...x, dueMonth: v.replace(/\D/g, '') } : x)))} keyboardType="number-pad" maxLength={2} />
          </Card>
        ))}
        <Button title={`➕ ${t('ib_addMilestone')}`} variant="outline" onPress={() => setMs([...ms, { title: '', dueMonth: String(Math.min(24, Number(ms[ms.length - 1]?.dueMonth || 0) + 3)) }])} />
      </>)}

      {step === 5 && (<>
        <Text style={s.h2}>{t('ib_wiz_review')}</Text>
        <Card>
          <Text style={s.h3}>{trade} · {t('ib_nMonths', { n: months })}</Text>
          <Text style={s.body}>{g?.name}</Text>
          <ModeLabel mode={g?.fundsMode ?? 'ESCROW'} />
          <Text style={s.body}>{t('ib_monthlySaving')}: ₦{Number(monthly).toLocaleString()}</Text>
          <Text style={s.body}>{t('ib_target')}: ₦{Number(target).toLocaleString()}</Text>
          <Text style={s.body}>{t('ib_milestonesN', { n: cleanMs.length })}</Text>
        </Card>
        <StatusCard tone="yellow" title={t('ib_beforeSending')} body={t('ib_beforeSendingBody')} speakText={t('ib_beforeSendingBody')} />
      </>)}

      <View style={{ flexDirection: 'row', gap: 10 }}>
        {step > 0 && <Button style={{ flex: 1 }} title={t('ib_back')} variant="outline" onPress={() => setStep(step - 1)} />}
        {step < STEPS - 1
          ? <Button style={{ flex: 1 }} title={t('ib_next')} disabled={!canNext} onPress={() => setStep(step + 1)} />
          : <Button style={{ flex: 1 }} title={t('ib_createSend')} loading={busy} onPress={create} />}
      </View>
    </Screen>
  );
}
