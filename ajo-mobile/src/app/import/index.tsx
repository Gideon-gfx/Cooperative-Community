import { useState } from 'react';
import { Text, View } from 'react-native';
import { Alert } from '../../components/feedback';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import * as ImagePicker from 'expo-image-picker';
import { format } from 'date-fns';
import { api, errMsg } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Button, Card, Loading, Screen, Sheet, s } from '../../components/ui';
import { Chips, Field, SectionTitle } from '../../components/widgets';
import { LangToggle, StatusCard, useRefreshModule } from '../../components/igba';
import { colors, fonts } from '../../theme';

type RecordType = 'MEMBERS' | 'CONTRIBUTIONS' | 'PAYOUTS' | 'ARREARS' | 'OPENING_POSITION';
const TYPES: RecordType[] = ['CONTRIBUTIONS', 'PAYOUTS', 'MEMBERS', 'ARREARS', 'OPENING_POSITION'];
interface Group { id: string; name: string; adminId: string }
interface Batch { id: string; recordType: RecordType; status: string; rowCount: number; createdAt: string }
interface Dash { pagesScanned: number; rows: { total: number; reviewed: number; accepted: number }; memberVerified: { verified: number; of: number; pct: number }; disputesOpen: number; duplicatesToResolve: number; peopleToChoose: number; unclaimedPeople: number }

// Import Center: turn old notebooks into records. Phones only suggest; a person accepts every line before it counts.
export default function ImportCenter() {
  const params = useLocalSearchParams<{ groupId?: string }>();
  const { t, user } = useAuth();
  const router = useRouter();
  const refresh = useRefreshModule();
  const groups = useQuery({ queryKey: ['my-groups'], queryFn: async () => (await api.get<{ groups: Group[] }>('/groups/mine')).data.groups });
  const [groupId, setGroupId] = useState(params.groupId ?? '');
  const mine = (groups.data ?? []).filter((g) => g.adminId === user?.id || user?.role === 'ADMIN');
  const gid = groupId || (mine.length === 1 ? mine[0].id : '');
  const dash = useQuery({ enabled: !!gid, queryKey: ['import-dash', gid], queryFn: async () => (await api.get<Dash>(`/records/dashboard/${gid}`)).data });
  const batches = useQuery({ enabled: !!gid, queryKey: ['import-batches', gid], queryFn: async () => (await api.get<{ batches: Batch[] }>('/records/batches', { params: { groupId: gid } })).data.batches });
  const [type, setType] = useState<RecordType>('CONTRIBUTIONS');
  const [typed, setTyped] = useState(false);
  const [rows, setRows] = useState<{ name: string; date: string; amount: string }[]>([{ name: '', date: '', amount: '' }]);
  const [busy, setBusy] = useState(false);
  const [privacy, setPrivacy] = useState<{ version: number; text: string } | null>(null);
  if (groups.isLoading) return <Loading />;

  // The group's collector must confirm the data-processing notice once before any record is imported.
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); await refresh(); await Promise.all([dash.refetch(), batches.refetch()]); }
    catch (e) {
      if (/PRIVACY_NOTICE/.test(errMsg(e))) { try { setPrivacy((await api.get<{ version: number; text: string }>('/records/privacy/notice')).data); } catch { /* shown below as a plain error */ } }
      else Alert.alert(t('ib_error'), errMsg(e));
    } finally { setBusy(false); }
  };
  const confirmPrivacy = async () => { try { await api.post('/records/privacy/confirm', { groupId: gid }); setPrivacy(null); Alert.alert(t('ib_saved'), t('ib_privacyConfirmed')); } catch (e) { Alert.alert(t('ib_error'), errMsg(e)); } };

  const scan = (camera: boolean) => run(async () => {
    const perm = camera ? await ImagePicker.requestCameraPermissionsAsync() : await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) { Alert.alert(t('ib_error'), t('ib_permissionNeeded')); return; }
    const res = camera ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.8 }) : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true, quality: 0.8 });
    if (res.canceled) return;
    const fd = new FormData();
    fd.append('groupId', gid); fd.append('kind', 'SCAN');
    res.assets.forEach((a, i) => fd.append('files', { uri: a.uri, name: a.fileName ?? `page-${i + 1}.jpg`, type: a.mimeType ?? 'image/jpeg' } as unknown as Blob));
    const src = (await api.post<{ id: string }>('/records/sources', fd, { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 120000 })).data;
    const batch = (await api.post<{ batch: Batch }>('/records/batches', { sourceId: src.id, recordType: type })).data.batch;
    await api.post(`/records/batches/${batch.id}/ocr`, undefined, { timeout: 120000 });
    router.push({ pathname: '/import/batch/[id]', params: { id: batch.id, groupId: gid } });
  });
  const submitTyped = () => run(async () => {
    const clean = rows.filter((r) => r.name.trim() && r.amount.trim()).map((r) => ({ name: r.name.trim(), amount: r.amount.trim(), ...(r.date.trim() ? { date: r.date.trim() } : {}) }));
    const batch = (await api.post<{ batch: Batch }>('/records/batches/typed', { groupId: gid, recordType: type, rows: clean })).data.batch;
    setTyped(false); setRows([{ name: '', date: '', amount: '' }]);
    router.push({ pathname: '/import/batch/[id]', params: { id: batch.id, groupId: gid } });
  });

  return (
    <Screen loaderButtons>
      <LangToggle />
      <StatusCard tone="yellow" title={t('ib_importTitle')} body={t('ib_importIntro')} speakText={t('ib_importIntro')} />
      {mine.length !== 1 && (
        <Chips<string> value={gid} onChange={setGroupId} options={mine.map((g) => ({ value: g.id, label: g.name }))} />
      )}
      {!gid && <Text style={s.muted}>{t('ib_pickGroup')}</Text>}
      {gid && (<>
        {dash.data && (
          <Card>
            <Text style={s.body}>{t('ib_pagesScanned', { n: dash.data.pagesScanned })}</Text>
            <Text style={s.body}>{t('ib_rowsReviewed', { done: dash.data.rows.reviewed, total: dash.data.rows.total })}</Text>
            <Text style={s.body}>{t('ib_memberVerified', { pct: dash.data.memberVerified.pct })}</Text>
            {dash.data.disputesOpen > 0 && <Text style={{ color: colors.red, fontFamily: fonts.bodyBold }}>{t('ib_disputesOpen', { n: dash.data.disputesOpen })}</Text>}
            {dash.data.duplicatesToResolve > 0 && <Text style={s.muted}>{t('ib_duplicatesN', { n: dash.data.duplicatesToResolve })}</Text>}
            {dash.data.peopleToChoose > 0 && <Text style={s.muted}>{t('ib_peopleToChoose', { n: dash.data.peopleToChoose })}</Text>}
          </Card>
        )}
        <Text style={s.h3}>{t('ib_whatIsPage')}</Text>
        <Chips<RecordType> value={type} onChange={setType} options={TYPES.map((x) => ({ value: x, label: t(`ib_rec_${x}`) }))} />
        <Button title={`📷 ${t('ib_scanCamera')}`} loading={busy} onPress={() => scan(true)} />
        <Button title={`🖼️ ${t('ib_scanLibrary')}`} variant="outline" loading={busy} onPress={() => scan(false)} />
        <Button title={`⌨️ ${t('ib_typeIn')}`} variant="outline" onPress={() => setTyped(true)} />
        <Text style={s.muted}>{t('ib_noCleanup')}</Text>

        <SectionTitle>{t('ib_myImports')}</SectionTitle>
        {(batches.data ?? []).length === 0 && <Text style={s.muted}>{t('ib_none')}</Text>}
        {(batches.data ?? []).map((b) => (
          <StatusCard key={b.id} tone={b.status === 'COMMITTED' ? 'green' : b.status === 'REJECTED' ? 'red' : 'yellow'} title={`${t(`ib_rec_${b.recordType}`)} · ${b.rowCount}`} body={`${t(`ib_batch_${b.status}`)} · ${format(new Date(b.createdAt), 'd MMM yyyy')}`} onPress={() => router.push({ pathname: '/import/batch/[id]', params: { id: b.id, groupId: gid } })} />
        ))}
      </>)}
      <Button title={t('ib_myEntries')} variant="outline" onPress={() => router.push('/import/mine')} />

      <Sheet title={t('ib_privacyTitle')} visible={!!privacy} onClose={() => setPrivacy(null)}>
        <View style={{ gap: 12 }}>
          <Text style={s.body}>{privacy?.text}</Text>
          <Button title={t('ib_privacyConfirm')} onPress={confirmPrivacy} />
        </View>
      </Sheet>
      <Sheet title={t('ib_typeIn')} visible={typed} onClose={() => setTyped(false)}>
        <View style={{ gap: 10 }}>
          {rows.map((r, i) => (
            <Card key={i}>
              <Field label={t('ib_personName')} value={r.name} onChangeText={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, name: v } : x)))} />
              {type !== 'MEMBERS' && <Field label={t('ib_amountNaira')} value={r.amount} onChangeText={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, amount: v } : x)))} keyboardType="numeric" />}
              {(type === 'CONTRIBUTIONS' || type === 'PAYOUTS') && <Field label={t('ib_dateLabel')} value={r.date} onChangeText={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, date: v } : x)))} placeholder="2024-03-15" />}
            </Card>
          ))}
          <Button title={`➕ ${t('ib_addRow')}`} variant="outline" onPress={() => setRows([...rows, { name: '', date: '', amount: '' }])} />
          <Button title={t('ib_review')} loading={busy} disabled={!rows.some((r) => r.name.trim() && (type === 'MEMBERS' || r.amount.trim()))} onPress={submitTyped} />
        </View>
      </Sheet>
    </Screen>
  );
}
