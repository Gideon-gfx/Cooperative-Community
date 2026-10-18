import { useState } from 'react';
import { Text, View } from 'react-native';
import { Alert } from '../../components/feedback';
import { useQuery } from '@tanstack/react-query';
import { api, errMsg } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Button, Card, Loading, Screen, Sheet, s } from '../../components/ui';
import { Chips, Field, SectionTitle } from '../../components/widgets';
import { LangToggle, StatusCard } from '../../components/igba';

interface Member { id: string; name: string; title: string; status: 'PENDING' | 'APPROVED' | 'REMOVED' }
interface Board { id: string; name: string; community: string; members: Member[] }
interface GroupRow { id: string; name: string; boardId: string | null }

// Admin only: make a Trust Board for a community, add and approve its members, and give it the groups it oversees.
export default function Boards() {
  const { t, user } = useAuth();
  const boards = useQuery({ queryKey: ['trust-boards'], queryFn: async () => (await api.get<{ boards: Board[] }>('/trust/boards')).data.boards });
  const groups = useQuery({ enabled: user?.role === 'ADMIN', queryKey: ['trust-groups'], queryFn: async () => (await api.get<{ groups: GroupRow[] }>('/trust/groups')).data.groups });
  const [create, setCreate] = useState(false);
  const [name, setName] = useState(''); const [community, setCommunity] = useState('');
  const [addTo, setAddTo] = useState<Board | null>(null);
  const [phone, setPhone] = useState(''); const [title, setTitle] = useState('');
  const [assign, setAssign] = useState<Board | null>(null);
  const [busy, setBusy] = useState(false);
  if (boards.isLoading) return <Loading />;
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); try { await fn(); await Promise.all([boards.refetch(), groups.refetch()]); } catch (e) { Alert.alert(t('ib_error'), errMsg(e)); } finally { setBusy(false); } };
  const admin = user?.role === 'ADMIN';

  return (
    <Screen>
      <LangToggle />
      <StatusCard tone="yellow" title={t('ib_boardsTitle')} body={t('ib_boardsIntro')} speakText={t('ib_boardsIntro')} />
      {admin && <Button title={`➕ ${t('ib_newBoard')}`} onPress={() => setCreate(true)} />}
      {(boards.data ?? []).map((b) => (
        <Card key={b.id}>
          <Text style={s.h3}>{b.name}</Text>
          <Text style={s.muted}>{b.community}</Text>
          {b.members.filter((m) => m.status !== 'REMOVED').map((m) => (
            <View key={m.id} style={{ gap: 6, paddingVertical: 6 }}>
              <Text style={s.body}>{m.name} · {m.title} · {t(`ib_member_${m.status}`)}</Text>
              {admin && (
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  {m.status === 'PENDING' && <Button style={{ flex: 1 }} title={`✅ ${t('ib_approve')}`} loading={busy} onPress={() => run(() => api.patch(`/trust/board-members/${m.id}`, { approve: true }))} />}
                  <Button style={{ flex: 1 }} title={t('ib_removeMember')} variant="danger" loading={busy} onPress={() => run(() => api.patch(`/trust/board-members/${m.id}`, { approve: false }))} />
                </View>
              )}
            </View>
          ))}
          {admin && <Button title={t('ib_addMember')} variant="outline" onPress={() => setAddTo(b)} />}
          {admin && <Button title={t('ib_assignGroups')} variant="outline" onPress={() => setAssign(b)} />}
        </Card>
      ))}
      {!boards.data?.length && <Text style={s.muted}>{t('ib_none')}</Text>}

      <Sheet title={t('ib_newBoard')} visible={create} onClose={() => setCreate(false)}>
        <View style={{ gap: 12 }}>
          <Field label={t('ib_boardName')} value={name} onChangeText={setName} />
          <Field label={t('ib_community')} value={community} onChangeText={setCommunity} />
          <Button title={t('ib_save')} loading={busy} disabled={name.trim().length < 3 || community.trim().length < 2} onPress={() => run(async () => { await api.post('/trust/boards', { name: name.trim(), community: community.trim() }); setCreate(false); setName(''); setCommunity(''); })} />
        </View>
      </Sheet>
      <Sheet title={t('ib_addMember')} visible={!!addTo} onClose={() => setAddTo(null)}>
        <View style={{ gap: 12 }}>
          <Text style={s.muted}>{t('ib_addMemberHint')}</Text>
          <Field label={t('ib_phone')} value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
          <Field label={t('ib_memberTitle')} value={title} onChangeText={setTitle} placeholder={t('ib_memberTitleHint')} />
          <Button title={t('ib_save')} loading={busy} disabled={phone.length < 6 || title.trim().length < 3} onPress={() => run(async () => { await api.post(`/trust/boards/${addTo!.id}/members`, { phone: phone.trim(), title: title.trim() }); setAddTo(null); setPhone(''); setTitle(''); })} />
        </View>
      </Sheet>
      <Sheet title={t('ib_assignGroups')} visible={!!assign} onClose={() => setAssign(null)}>
        <View style={{ gap: 8 }}>
          {(groups.data ?? []).map((g) => (
            <View key={g.id} style={{ gap: 4 }}>
              <Text style={s.body}>{g.name}</Text>
              <Chips<string> value={g.boardId === assign?.id ? 'Y' : 'N'} onChange={(v) => v === 'Y' && run(() => api.post(`/trust/boards/${assign!.id}/groups`, { groupId: g.id }))} options={[{ value: 'Y', label: t('ib_oversees') }, { value: 'N', label: g.boardId ? t('ib_otherBoard') : t('ib_noBoard') }]} />
            </View>
          ))}
        </View>
      </Sheet>
    </Screen>
  );
}
