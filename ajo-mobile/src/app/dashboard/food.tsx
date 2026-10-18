import { Pressable, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { api, money } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Button, Card, Loading, ProgressBar, Screen, StatusBadge, s } from '../../components/ui';
import { colors, fonts } from '../../theme';

interface FoodCard { id: string; status: string; contributionAmt: number; currentMembers: number; targetMembers: number; liveWindowEnd: string; group: { name: string; currency: string }; winningProduct: { name: string } | null }
const fmt = (d: string | null | undefined) => (d ? format(new Date(d), 'd MMM yyyy') : '—');

// Oúnjẹ · Food: group food buys I am part of.
export default function FoodTab() {
  const { t } = useAuth();
  const router = useRouter();
  const food = useQuery({ queryKey: ['my-food'], queryFn: async () => (await api.get<{ pools: FoodCard[] }>('/ccgb/my-pools')).data.pools });
  if (food.isLoading) return <Loading />;
  return (
    <Screen>
      <Text style={[s.muted, { fontFamily: fonts.mono, letterSpacing: 1.5, color: colors.clay }]}>{t('kickerFood')}</Text>
      <Text style={s.h1}>{t('myFood')}</Text>
      {food.data?.length ? food.data.map((p) => (
        <Pressable key={p.id} onPress={() => router.push(`/food/${p.id}`)}>
          <Card>
            <View style={s.row}><Text style={s.h3}>{p.group.name}</Text><StatusBadge status={p.status} /></View>
            <Text style={s.body}><Text style={{ fontFamily: fonts.mono }}>{money(p.contributionAmt, p.group.currency)}</Text> / share</Text>
            <ProgressBar value={p.currentMembers} max={p.targetMembers} color={colors.orange} />
            <Text style={s.muted}>{p.currentMembers} of {p.targetMembers} shares</Text>
            <Text style={s.body}>{p.winningProduct ? `🏆 ${p.winningProduct.name}` : `Closes: ${fmt(p.liveWindowEnd)}`}</Text>
          </Card>
        </Pressable>
      )) : <Text style={s.muted}>{t('noFood')}</Text>}
      <Button title="🌾 Sell to food pools (supplier)" variant="outline" onPress={() => router.push('/supplier')} />
    </Screen>
  );
}
