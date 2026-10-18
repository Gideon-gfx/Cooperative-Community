import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { api, money } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Button, Card, Loading, Screen, StatusBadge, s } from '../../components/ui';
import { ReadAloud, SectionTitle } from '../../components/widgets';
import { ReadOnlyBanner, StatusCard } from '../../components/igba';
import { fmt, noticeText, useNotices } from '../../components/NotificationBell';
import { colors, fonts, TAP } from '../../theme';



const initials = (name?: string) => (name ?? '').split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('');

// Ilé: who you are, what needs you today, and your groups.
export default function Home() {
  const { user, t } = useAuth();
  const router = useRouter();

  const ajo = useNotices();
  const groups = useQuery({ queryKey: ['my-groups'], queryFn: async () => (await api.get<{ groups: { id: string; name: string; adminId: string }[] }>('/groups/mine')).data.groups });
  const profile = useQuery({ queryKey: ['profile'], queryFn: async () => (await api.get<{ user: { walletBalance: number; hasPin: boolean }; trust: { label: string; onTimePct: number } }>('/auth/profile')).data });

  const consents = useQuery({ queryKey: ['consent-mine'], queryFn: async () => (await api.get<{ required: { type: string; groupId: string | null; reason: string }[] }>('/consent/mine')).data.required });
  if (ajo.isLoading && groups.isLoading) return <Loading />;
  const notices = ajo.data?.notifications ?? [];
  const firstDue = notices.find((n) => n.kind === 'DUE' || n.kind === 'MISSED');
  const spoken = firstDue
    ? t('speakDue', { amount: money(firstDue.amount!, firstDue.currency), date: fmt(firstDue.dueAt), pool: firstDue.poolTitle })
    : t('speakNoDue');
  const isCollector = user?.role === 'COLLECTOR' || user?.role === 'ADMIN';
  const isFacilitator = isCollector || user?.role === 'FACILITATOR';
  const isBoard = user?.role === 'BOARD_MEMBER' || user?.role === 'ADMIN';
  const needSign = consents.data?.[0];

  return (
    <Screen>
      <View style={s.row}>
        <View style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: colors.orange, borderWidth: 2, borderColor: colors.cocoa, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ fontFamily: fonts.display, fontSize: 17, color: colors.cocoa }}>{initials(user?.fullName)}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={s.muted}>{t('hello', { name: '' }).replace(/,\s*$/, ',')}</Text>
          <Text style={s.h1} numberOfLines={1}>{user?.fullName.split(' ')[0] ?? ''}</Text>
        </View>
        <ReadAloud text={spoken} />
        <Pressable onPress={() => router.push('/settings')} style={{ minWidth: TAP, minHeight: TAP, alignItems: 'center', justifyContent: 'center' }} accessibilityLabel={t('settings')}><Text style={{ fontSize: 24 }}>⚙️</Text></Pressable>
      </View>

      <Card style={{ backgroundColor: colors.cocoaNight, borderColor: colors.cocoaNight }}>
        <Text style={{ color: colors.cream, fontFamily: fonts.body, fontSize: 14 }}>{t('wallet')}</Text>
        <Text style={{ color: colors.gold, fontFamily: fonts.mono, fontSize: 32 }}>{money(profile.data?.user.walletBalance ?? 0)}</Text>
        <View style={{ flexDirection: 'row', gap: 6, marginTop: 4 }}><StatusBadge status={user?.memberStatus ?? 'CLEAN'} /></View>
      </Card>

      {firstDue && (
        <Pressable onPress={() => router.push(`/ajo/${firstDue.poolId}`)}>
          <Card style={{ backgroundColor: firstDue.kind === 'MISSED' ? '#FDE4E1' : colors.accentLight }}>
            <Text style={s.h3}>{noticeText(firstDue).title}</Text>
            <Text style={s.body}>{noticeText(firstDue).body}</Text>
          </Card>
        </Pressable>
      )}

      {profile.data && !profile.data.user.hasPin && (
        <Pressable onPress={() => router.push('/settings')}>
          <Card style={{ backgroundColor: colors.accentLight, borderColor: colors.accent }}>
            <Text style={[s.body, { fontFamily: fonts.bodyBold }]}>🔒 Set a 4-digit PIN</Text>
            <Text style={s.muted}>It protects your account and is needed for money actions.</Text>
          </Card>
        </Pressable>
      )}

      <ReadOnlyBanner />
      {needSign && <StatusCard tone="yellow" title={t('ib_pleaseSign')} body={t(`ib_consent_${needSign.type}`)} speakText={t('ib_pleaseSign')} onPress={() => router.push({ pathname: '/consent/[type]', params: { type: needSign.type, ...(needSign.groupId ? { groupId: needSign.groupId } : {}) } })} />}
      {isCollector && <Button title={`🧰 ${t('collectorTools')}`} variant="accent" onPress={() => router.push('/collector')} />}
      {isFacilitator && <Button title={`🤝 ${t('ib_facilitator')}`} variant="outline" onPress={() => router.push('/facilitator')} />}
      {isBoard && <Button title={`⚖️ ${t('ib_trustBoard')}`} variant="accent" onPress={() => router.push('/trust')} />}
      <Button title={`🧵 ${t('ib_myApprenticeship')}`} variant="outline" onPress={() => router.push('/igba')} />
      <Button title={`💸 ${t('ib_feePreview')}`} variant="outline" onPress={() => router.push('/fees')} />
      {user?.role === 'TRANSPORTER' && <Button title="🚚 My delivery jobs" variant="accent" onPress={() => router.push('/jobs')} />}

      <SectionTitle>👥 {t('myGroups')}</SectionTitle>
      {groups.data?.length ? groups.data.map((g) => (
        <Pressable key={g.id} onPress={() => router.push(`/groups/${g.id}`)}><Card><Text style={s.h3}>{g.name}{g.adminId === user?.id ? '  · Collector' : ''}</Text></Card></Pressable>
      )) : <Text style={s.muted}>{t('askCollector')}</Text>}

      <Button title={`⚖️ ${t('disputes')}`} variant="outline" onPress={() => router.push('/disputes')} />

    </Screen>
  );
}
