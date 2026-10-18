import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { api, money } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Card, Loading, Screen, StatusBadge, s } from '../../components/ui';
import { colors, fonts } from '../../theme';

interface AjoCard { id: string; title: string; groupName: string; currency: string; status: string; amountPerMember: number; myCollectionDate: string | null; nextDueAt: string | null }
const fmt = (d: string | null | undefined) => (d ? format(new Date(d), 'd MMM yyyy') : '—');

// Àjọ · Money: the rotating-savings pools I am in.
export default function AjoTab() {
  const { t } = useAuth();
  const router = useRouter();
  const ajo = useQuery({ queryKey: ['my-ajo'], queryFn: async () => (await api.get<{ pools: AjoCard[] }>('/ajo/my-pools')).data });
  if (ajo.isLoading) return <Loading />;
  const pools = ajo.data?.pools ?? [];
  return (
    <Screen>
      <Text style={[s.muted, { fontFamily: fonts.mono, letterSpacing: 1.5, color: colors.clay }]}>{t('kickerMoney')}</Text>
      <Text style={s.h1}>{t('myAjo')}</Text>
      {pools.length ? pools.map((p) => (
        <Pressable key={p.id} onPress={() => router.push(`/ajo/${p.id}`)}>
          <Card>
            <View style={s.row}><Text style={s.h3}>{p.title}</Text><StatusBadge status={p.status} /></View>
            <Text style={s.muted}>{p.groupName}</Text>
            <Text style={{ fontFamily: fonts.mono, fontSize: 22, color: colors.cocoa }}>{money(p.amountPerMember, p.currency)}</Text>
            <Text style={s.body}>{t('nextDue')}: <Text style={{ fontFamily: fonts.bodyBold }}>{fmt(p.nextDueAt)}</Text></Text>
            <Text style={s.body}>{t('youCollect')}: <Text style={{ fontFamily: fonts.bodyBold }}>{fmt(p.myCollectionDate)}</Text></Text>
          </Card>
        </Pressable>
      )) : <Text style={s.muted}>{t('noAjo')}</Text>}
    </Screen>
  );
}
