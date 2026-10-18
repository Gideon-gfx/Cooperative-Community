import { useState } from 'react';
import { Text, View } from 'react-native';
import { Alert } from '../components/feedback';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Button, Card, Loading, Screen, Sheet, StatusBadge, s } from '../components/ui';
import { Chips, Field, SectionTitle } from '../components/widgets';

interface Dispute { id: string; groupId: string; kind: string; description: string; status: 'OPEN' | 'ESCALATED' | 'RESOLVED'; resolution?: string; raisedById: string; raisedByName?: string; createdAt: string }
interface GroupRow { id: string; name: string; adminId: string }
const KINDS = ['PAYOUT_NOT_RECEIVED', 'PAYMENT_NOT_RECORDED', 'WRONG_AMOUNT', 'FOOD_QUALITY', 'COLLECTOR_CONDUCT', 'OTHER'];
const label = (k: string) => k.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

export default function Disputes() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [resolving, setResolving] = useState<Dispute | null>(null);
  const [resolution, setResolution] = useState('');
  const [creating, setCreating] = useState(false);
  const [groupId, setGroupId] = useState('');
  const [kind, setKind] = useState('OTHER');
  const [text, setText] = useState('');

  const groups = useQuery({ queryKey: ['my-groups'], queryFn: async () => (await api.get<{ groups: GroupRow[] }>('/groups/mine')).data.groups });
  const all = useQuery({
    queryKey: ['disputes', groups.data?.map((g) => g.id).join(',')], enabled: !!groups.data,
    queryFn: async () => (await Promise.all((groups.data ?? []).map((g) => api.get<{ disputes: Dispute[] }>(`/disputes?groupId=${g.id}`)))).flatMap((r) => r.data.disputes),
  });
  if (groups.isLoading || all.isLoading) return <Loading />;
  const gid = groupId || groups.data?.[0]?.id || '';
  const refresh = () => qc.invalidateQueries({ queryKey: ['disputes'] });
  const adminOf = (d: Dispute) => groups.data?.find((g) => g.id === d.groupId)?.adminId === user?.id;

  return (
    <Screen>
      <Button title="Raise a problem" onPress={() => setCreating(true)} />
      <SectionTitle>Problems</SectionTitle>
      {all.data?.length === 0 && <Text style={s.muted}>Nothing raised.</Text>}
      {all.data?.map((d) => (
        <Card key={d.id}>
          <View style={s.row}><Text style={s.h3}>{label(d.kind)}</Text><StatusBadge status={d.status === 'RESOLVED' ? 'COMPLETED' : d.status === 'ESCALATED' ? 'LATE' : 'PENDING'} /></View>
          <Text style={s.muted}>By {d.raisedByName ?? 'a member'} · {groups.data?.find((g) => g.id === d.groupId)?.name}</Text>
          <Text style={s.body}>{d.description}</Text>
          {d.resolution && <Text style={[s.body, { color: '#166534' }]}>✔ {d.resolution}</Text>}
          {d.status !== 'RESOLVED' && d.raisedById === user?.id && d.status === 'OPEN' && (
            <Button title="Take it to a platform admin" variant="outline" onPress={async () => { try { await api.post(`/disputes/${d.id}/escalate`); refresh(); } catch (e) { Alert.alert('Error', errMsg(e)); } }} />
          )}
          {d.status === 'OPEN' && adminOf(d) && <Button title="Resolve" onPress={() => { setResolving(d); setResolution(''); }} />}
          {user?.role === 'ADMIN' && d.status !== 'RESOLVED' && <Button title="Resolve (admin)" onPress={() => { setResolving(d); setResolution(''); }} />}
        </Card>
      ))}

      <Sheet title="Resolve" visible={!!resolving} onClose={() => setResolving(null)}>
        <View style={{ gap: 10 }}>
          <Field label="What was decided?" value={resolution} onChangeText={setResolution} multiline />
          <Button title="Mark resolved" disabled={resolution.trim().length < 3} onPress={async () => {
            try { await api.patch(`/disputes/${resolving!.id}/resolve`, { resolution: resolution.trim() }); setResolving(null); refresh(); } catch (e) { Alert.alert('Error', errMsg(e)); }
          }} />
        </View>
      </Sheet>

      <Sheet title="Raise a problem" visible={creating} onClose={() => setCreating(false)}>
        <View style={{ gap: 10 }}>
          <Chips value={gid} onChange={setGroupId} options={(groups.data ?? []).map((g) => ({ value: g.id, label: g.name }))} />
          <Chips value={kind} onChange={setKind} options={KINDS.map((k) => ({ value: k, label: label(k) }))} />
          <Field label="Tell us what happened" value={text} onChangeText={setText} multiline />
          <Button title="Send" disabled={text.trim().length < 5 || !gid} onPress={async () => {
            try { await api.post('/disputes', { groupId: gid, kind, description: text.trim() }); setCreating(false); setText(''); refresh(); } catch (e) { Alert.alert('Error', errMsg(e)); }
          }} />
        </View>
      </Sheet>
    </Screen>
  );
}
