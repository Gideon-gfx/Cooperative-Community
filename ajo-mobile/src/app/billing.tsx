import { useState } from 'react';
import { Linking, Text, View } from 'react-native';
import { Alert } from '../components/feedback';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { api, errMsg, naira } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Button, Card, Loading, Screen, s } from '../components/ui';
import { Chips, SectionTitle } from '../components/widgets';
import { LangToggle, ReadOnlyBanner, StatusCard, useRefreshModule, type Tone } from '../components/igba';

interface Plan { plan: 'ORGANIZER' | 'MEMBER_PLUS'; monthly: number | null; yearly: number | null }
interface Sub { id: string; plan: string; interval: string; status: string; price: number | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean }
interface Inv { id: string; status: string; amount: number; periodStart: string; periodEnd: string; dueAt?: string }
interface Me { organizer: { newCyclesBlocked: boolean; reason: string | null; enforced: boolean }; subscriptions: Sub[]; invoices: Inv[]; commissionInvoices: Inv[] }
const subTone = (st: string): Tone => (st === 'ACTIVE' ? 'green' : st === 'GRACE' ? 'yellow' : 'red');

// Plans, invoices and commission. Members use the core product free; paying is only for organisers and extras.
export default function Billing() {
  const { t } = useAuth();
  const refresh = useRefreshModule();
  const plans = useQuery({ queryKey: ['billing-plans'], queryFn: async () => (await api.get<{ plans: Plan[] }>('/billing/plans')).data.plans });
  const me = useQuery({ queryKey: ['billing-me'], queryFn: async () => (await api.get<Me>('/billing/me')).data });
  const [interval, setInterval_] = useState<'MONTHLY' | 'YEARLY'>('MONTHLY');
  const [busy, setBusy] = useState(false);
  if (plans.isLoading || me.isLoading || !me.data) return <Loading />;

  const go = async (fn: () => Promise<string | undefined>) => {
    setBusy(true);
    try { const url = await fn(); await refresh(); await me.refetch(); if (url) await Linking.openURL(url); }
    catch (e) { Alert.alert(t('ib_error'), errMsg(e)); } finally { setBusy(false); }
  };
  const subscribe = (plan: string) => go(async () => (await api.post<{ invoice?: { checkoutUrl: string } }>('/billing/subscribe', { plan, interval })).data.invoice?.checkoutUrl);
  const pay = (kind: 'invoices' | 'commission-invoices', id: string) => go(async () => (await api.post<{ checkoutUrl: string }>(`/billing/${kind}/${id}/pay`)).data.checkoutUrl);
  const cancel = (plan: string) => Alert.alert(t('ib_cancelPlan'), t('ib_cancelPlanBody'), [{ text: t('ib_back'), style: 'cancel' }, { text: t('ib_confirm'), onPress: () => go(async () => { await api.post('/billing/cancel', { plan }); return undefined; }) }]);

  return (
    <Screen loaderButtons>
      <LangToggle />
      <ReadOnlyBanner />
      <StatusCard tone="green" title={t('ib_billingFreeTitle')} body={t('ib_billingFreeBody')} speakText={t('ib_billingFreeBody')} />

      <SectionTitle>{t('ib_myPlans')}</SectionTitle>
      {me.data.subscriptions.length === 0 && <Text style={s.muted}>{t('ib_noPlan')}</Text>}
      {me.data.subscriptions.map((x) => (
        <View key={x.id} style={{ gap: 8 }}>
          <StatusCard tone={subTone(x.status)} title={`${t(`ib_plan_${x.plan}`)} · ${t(`ib_sub_${x.status}`)}`} body={x.currentPeriodEnd ? `${t(x.cancelAtPeriodEnd ? 'ib_endsOn' : 'ib_renewsOn')} ${format(new Date(x.currentPeriodEnd), 'd MMM yyyy')}${x.price !== null ? ` · ${naira(x.price)}` : ''}` : undefined} />
          {x.status !== 'CANCELLED' && !x.cancelAtPeriodEnd && <Button title={t('ib_cancelPlan')} variant="outline" onPress={() => cancel(x.plan)} />}
        </View>
      ))}

      <SectionTitle>{t('ib_choosePlan')}</SectionTitle>
      <Chips<'MONTHLY' | 'YEARLY'> value={interval} onChange={setInterval_} options={[{ value: 'MONTHLY', label: t('ib_monthly') }, { value: 'YEARLY', label: t('ib_yearly') }]} />
      {(plans.data ?? []).map((p) => {
        const price = interval === 'MONTHLY' ? p.monthly : p.yearly;
        return (
          <Card key={p.plan}>
            <Text style={s.h3}>{t(`ib_plan_${p.plan}`)}</Text>
            <Text style={s.muted}>{t(`ib_planWhat_${p.plan}`)}</Text>
            <Text style={[s.money, { fontSize: 22 }]}>{price !== null ? naira(price) : '—'} <Text style={s.muted}>/ {t(interval === 'MONTHLY' ? 'ib_perMonth' : 'ib_perYear')}</Text></Text>
            <Button title={t('ib_subscribe')} loading={busy} disabled={price === null} onPress={() => subscribe(p.plan)} />
          </Card>
        );
      })}

      <SectionTitle>{t('ib_invoices')}</SectionTitle>
      {me.data.invoices.length === 0 && me.data.commissionInvoices.length === 0 && <Text style={s.muted}>{t('ib_none')}</Text>}
      {me.data.invoices.map((i) => (
        <Card key={i.id}>
          <View style={s.row}><Text style={s.body}>{format(new Date(i.periodStart), 'MMM yyyy')}</Text><Text style={s.money}>{naira(i.amount)}</Text></View>
          <Text style={s.muted}>{t(`ib_inv_${i.status}`)}</Text>
          {i.status === 'PENDING' && <Button title={t('ib_payNow')} loading={busy} onPress={() => pay('invoices', i.id)} />}
        </Card>
      ))}
      {me.data.commissionInvoices.length > 0 && <SectionTitle>{t('ib_commissionInvoices')}</SectionTitle>}
      {me.data.commissionInvoices.map((i) => (
        <View key={i.id} style={{ gap: 8 }}>
          <StatusCard tone={i.status === 'PENDING' ? 'yellow' : 'green'} title={`${format(new Date(i.periodStart), 'MMM yyyy')} · ${naira(i.amount)}`} body={`${t(`ib_inv_${i.status}`)}${i.dueAt ? ` · ${t('ib_dueOn')} ${format(new Date(i.dueAt), 'd MMM yyyy')}` : ''}`} />
          {i.status === 'PENDING' && <Button title={t('ib_payNow')} loading={busy} onPress={() => pay('commission-invoices', i.id)} />}
        </View>
      ))}
    </Screen>
  );
}
