import { useState } from 'react';
import { Text, View } from 'react-native';
import { Alert } from '../../../components/feedback';
import { useLocalSearchParams } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../../../api/client';
import { Button, Card, Loading, Screen, STATUS_EMOJI, StatusBadge, s } from '../../../components/ui';
import { Chips, Field, SectionTitle, TrustBadge, type Trust } from '../../../components/widgets';
import { LANGS, type Lang } from '../../../i18n';

interface Row { id: string; fullName: string; phoneNumber?: string; memberStatus: string; accountType: 'SELF' | 'ASSISTED'; isAdmin?: boolean; activated?: boolean; trust: Trust }

export default function Members() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [lang, setLang] = useState<Lang>('EN');
  const [busy, setBusy] = useState(false);

  const group = useQuery({ queryKey: ['group-members', id], queryFn: async () => (await api.get<{ members: Row[]; isCollector: boolean; collector: { verified: boolean; groups: number; completedPayouts: number; confirmedPayouts: number } }>(`/groups/${id}`)).data });
  const agent = useQuery({
    queryKey: ['agent-members', id], enabled: !!group.data?.isCollector,
    queryFn: async () => (await api.get<{ members: Row[] }>(`/agent/members?groupId=${id}`)).data.members,
  });
  if (group.isLoading || !group.data) return <Loading />;
  const rows = agent.data ?? group.data.members;

  const add = async () => {
    setBusy(true);
    try {
      const { data } = await api.post('/agent/members', { groupId: id, fullName: name.trim(), phoneNumber: phone, language: lang });
      Alert.alert(data.created ? 'Account created' : 'Member added', data.created ? `${name} will get an SMS with a temporary PIN and how to dial in.` : 'They already have an ÀJỌ account and were added to the group.');
      setName(''); setPhone('');
      qc.invalidateQueries({ queryKey: ['agent-members', id] });
      qc.invalidateQueries({ queryKey: ['group-members', id] });
    } catch (e) { Alert.alert('Error', errMsg(e)); } finally { setBusy(false); }
  };

  return (
    <Screen loaderButtons>
      {group.data.isCollector && (
        <Card style={{ gap: 10 }}>
          <Text style={s.h3}>➕ Add a member</Text>
          <Text style={s.muted}>For someone without a smartphone: they get an SMS with a temporary PIN and can use ÀJỌ by USSD / SMS. You can record their cash payments for them.</Text>
          <Field label="Full name" value={name} onChangeText={setName} />
          <Field label="Phone number" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
          <Text style={[s.body, { fontWeight: '600' }]}>Their language</Text>
          <Chips value={lang} onChange={setLang} options={LANGS.map((l) => ({ value: l.code, label: l.label }))} />
          <Button title="Add member" onPress={add} loading={busy} disabled={name.trim().length < 2 || phone.length < 8} />
        </Card>
      )}

      <SectionTitle>Members ({rows.length})</SectionTitle>
      {rows.map((m) => (
        <Card key={m.id}>
          <View style={s.row}>
            <Text style={s.h3}>{STATUS_EMOJI[m.memberStatus]} {m.fullName}{m.isAdmin ? ' (Collector)' : ''}</Text>
            <StatusBadge status={m.memberStatus} />
          </View>
          <TrustBadge trust={m.trust} />
          {m.accountType === 'ASSISTED' && <Text style={s.muted}>📞 Account created by collector{m.activated === false ? ' · not yet activated' : ''}</Text>}
          {group.data.isCollector && m.accountType === 'ASSISTED' && (
            <Button title="Send a new temporary PIN" variant="outline" onPress={async () => {
              try { await api.post(`/agent/members/${m.id}/reset-pin`); Alert.alert('Sent', 'A new temporary PIN was sent by SMS.'); } catch (e) { Alert.alert('Error', errMsg(e)); }
            }} />
          )}
        </Card>
      ))}
    </Screen>
  );
}
