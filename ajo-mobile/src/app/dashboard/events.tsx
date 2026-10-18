import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { api, money } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Button, Card, Loading, Screen, StatusBadge, s } from '../../components/ui';
import { ReferralCard } from '../../components/ReferralCard';
import { Banner, bannerLabel, ProgressLine, type Campaign, type CampaignKind, type Progress } from '../../components/campaigns';
import { colors, fonts } from '../../theme';

type Row = Campaign & { progress: Progress; myGiftStatus: 'PENDING' | 'VERIFIED' | null };

// Events & Help: matching outfits for parties, or money and food for someone in need.
export default function Events() {
  const router = useRouter();
  const { t } = useAuth();
  const [kind, setKind] = useState<CampaignKind>('ASO_EBI');
  const { data, isLoading } = useQuery({ queryKey: ['campaigns', kind], queryFn: async () => (await api.get<{ campaigns: Row[] }>('/campaigns/mine', { params: { kind } })).data.campaigns });

  return (
    <Screen>
      <Text style={[s.muted, { fontFamily: fonts.mono, letterSpacing: 1.5, color: colors.indigo }]}>{t('kickerEvents')}</Text>
      <Text style={s.h1}>{t('evTitle')}</Text>
      <Text style={s.muted}>{t('evSub')}</Text>

      <ReferralCard />

      <View style={{ flexDirection: 'row', backgroundColor: '#F0E2CC', borderRadius: 18, borderWidth: 1.5, borderColor: colors.cocoa, padding: 4 }}>
        {([['ASO_EBI', t('kindAso')], ['HELP', t('kindHelp')], ['OTHER', t('kindOther')]] as const).map(([k, label]) => {
          const on = kind === k;
          return (
            <Pressable key={k} accessibilityRole="button" accessibilityState={{ selected: on }} onPress={() => setKind(k)} style={{ flex: 1, minHeight: 52, borderRadius: 14, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'center', backgroundColor: on ? colors.indigo : 'transparent' }}>
              <Text numberOfLines={2} style={{ fontFamily: fonts.bodyBold, fontSize: 14, textAlign: 'center', color: on ? colors.white : colors.cocoa }}>{label}</Text>
            </Pressable>
          );
        })}
      </View>

      {isLoading ? <Loading /> : data?.length ? data.map((c) => (
        <Pressable key={c.id} onPress={() => router.push(`/campaigns/${c.id}`)}>
          <Card style={{ padding: 0, overflow: 'hidden', gap: 0 }}>
            <Banner kind={c.kind} label={bannerLabel(c, t)} />
            <View style={{ padding: 16, gap: 8 }}>
              <View style={s.row}>
                <Text style={[s.h2, { flex: 1 }]}>{c.title}</Text>
                {c.status !== 'OPEN' && <StatusBadge status={c.status === 'CLOSED' ? 'LOCKED' : c.status} />}
              </View>
              <Text style={s.muted}>
                {[c.eventDate ? format(new Date(c.eventDate), 'EEE d MMM') : null, c.venue, c.kind === 'HELP' && c.recipientName ? `For ${c.recipientName}` : null, `Host: ${c.hostName}`].filter(Boolean).join(' · ')}
              </Text>
              {c.kind === 'ASO_EBI' && c.partAmount ? (
                <View style={s.row}><Text style={s.body}>Your part (set by host)</Text><Text style={{ fontFamily: fonts.mono, fontSize: 22, color: colors.cocoa }}>{money(c.partAmount, c.currency)}</Text></View>
              ) : null}
              <ProgressLine c={c} p={c.progress} />
              <Text style={[s.muted, { color: c.myGiftStatus === 'VERIFIED' ? colors.green : colors.muted }]}>
                {c.myGiftStatus === 'VERIFIED' ? '✔ You have given' : c.myGiftStatus === 'PENDING' ? '🕒 Waiting for the host to confirm' : c.isHost ? 'You are the host' : ''}
              </Text>
            </View>
          </Card>
        </Pressable>
      )) : <Text style={s.muted}>{t(kind === 'ASO_EBI' ? 'noAso' : kind === 'HELP' ? 'noHelp' : 'noOther')}</Text>}

      <Button title={t(kind === 'ASO_EBI' ? 'startAso' : kind === 'HELP' ? 'startHelp' : 'startOther')} onPress={() => router.push({ pathname: '/campaigns/new', params: { kind } })} />
    </Screen>
  );
}
