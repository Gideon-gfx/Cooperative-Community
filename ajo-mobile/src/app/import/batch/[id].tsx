import { useState } from 'react';
import { Text, View } from 'react-native';
import { Alert } from '../../../components/feedback';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { api, errMsg } from '../../../api/client';
import { useAuth } from '../../../auth/AuthContext';
import { Button, Card, Loading, Screen, Sheet, s } from '../../../components/ui';
import { Chips, Field } from '../../../components/widgets';
import { LangToggle, StatusCard, useRefreshModule } from '../../../components/igba';
import { colors, fonts } from '../../../theme';

interface Row { id: string; rawFields: Record<string, unknown>; parsedJson: { name?: string; amountKobo?: string | null; date?: string | null; asOf?: string | null; joinDate?: string | null; phone?: string | null }; issues: string[]; status: 'SUGGESTED' | 'EDITED' | 'ACCEPTED' | 'REJECTED'; pageNumber: number | null }
interface Batch { id: string; recordType: string; status: string; rowCount: number }
const naira = (k?: string | null) => (k ? `₦${(Number(k) / 100).toLocaleString('en-NG', { maximumFractionDigits: 2 })}` : '—');
const issueKey = (i: string) => `ib_issue_${i.split(':')[0]}`;

// Review: each line is shown beside its suggestion, and each one needs a person's yes or no before anything is saved.
export default function ReviewBatch() {
  const { id, groupId } = useLocalSearchParams<{ id: string; groupId: string }>();
  const { t, user } = useAuth();
  const router = useRouter();
  const refresh = useRefreshModule();
  const rows = useQuery({ queryKey: ['import-rows', id], queryFn: async () => (await api.get<{ rows: Row[] }>(`/records/batches/${id}/rows`)).data.rows });
  const batch = useQuery({ queryKey: ['import-batch', id], queryFn: async () => (await api.get<{ batches: Batch[] }>('/records/batches', { params: { groupId } })).data.batches.find((b) => b.id === id) ?? null });
  const [edit, setEdit] = useState<Row | null>(null);
  const [f, setF] = useState<{ name: string; date: string; amount: string }>({ name: '', date: '', amount: '' });
  const [only, setOnly] = useState<'ALL' | 'TODO' | 'FLAGGED'>('TODO');
  const [busy, setBusy] = useState(false);
  if (rows.isLoading || batch.isLoading) return <Loading />;
  const b = batch.data, all = rows.data ?? [];
  const todo = all.filter((r) => r.status === 'SUGGESTED').length;
  const shown = all.filter((r) => (only === 'TODO' ? r.status === 'SUGGESTED' : only === 'FLAGGED' ? r.issues.length > 0 : true));

  const act = async (fn: () => Promise<unknown>, msg?: string) => { setBusy(true); try { await fn(); await refresh(); await Promise.all([rows.refetch(), batch.refetch()]); if (msg) Alert.alert(t('ib_done'), msg); } catch (e) { Alert.alert(t('ib_error'), errMsg(e)); } finally { setBusy(false); } };
  const mark = (r: Row, status: 'ACCEPTED' | 'REJECTED') => act(() => api.patch(`/records/rows/${r.id}`, { status }));
  const openEdit = (r: Row) => { setEdit(r); setF({ name: String(r.rawFields.name ?? r.parsedJson.name ?? ''), date: String(r.rawFields.date ?? r.parsedJson.date ?? ''), amount: String(r.rawFields.amount ?? (r.parsedJson.amountKobo ? Number(r.parsedJson.amountKobo) / 100 : '')) }); };
  const saveEdit = () => act(async () => { await api.patch(`/records/rows/${edit!.id}`, { fields: { ...edit!.rawFields, name: f.name, ...(f.date ? { date: f.date } : {}), ...(f.amount ? { amount: f.amount } : {}) } }); setEdit(null); });

  return (
    <Screen loaderButtons>
      <LangToggle />
      {b && <StatusCard tone={b.status === 'COMMITTED' ? 'green' : b.status === 'REJECTED' ? 'red' : 'yellow'} title={`${t(`ib_rec_${b.recordType}`)} · ${t(`ib_batch_${b.status}`)}`} body={b.status === 'IN_REVIEW' ? t('ib_toCheckN', { n: todo }) : undefined} speakText={t('ib_toCheckN', { n: todo })} />}

      {b?.status === 'IN_REVIEW' && (<>
        <Chips<'ALL' | 'TODO' | 'FLAGGED'> value={only} onChange={setOnly} options={[{ value: 'TODO', label: t('ib_filterTodo') }, { value: 'FLAGGED', label: t('ib_filterFlagged') }, { value: 'ALL', label: t('ib_filterAll') }]} />
        {shown.length === 0 && <Text style={s.muted}>{t('ib_none')}</Text>}
        {shown.map((r) => (
          <Card key={r.id} style={r.issues.length ? { borderColor: colors.gold } : undefined}>
            <Text style={s.h3}>{r.parsedJson.name || '—'}</Text>
            <View style={s.row}><Text style={s.money}>{naira(r.parsedJson.amountKobo)}</Text><Text style={s.muted}>{r.parsedJson.date ?? r.parsedJson.asOf ?? r.parsedJson.joinDate ?? ''}</Text></View>
            {r.issues.map((i) => <Text key={i} style={{ color: '#9A3412', fontFamily: fonts.bodyBold, fontSize: 14 }}>⚠️ {t(issueKey(i))}</Text>)}
            <Text style={s.muted}>{t(`ib_row_${r.status}`)}{r.pageNumber ? ` · ${t('ib_page', { n: r.pageNumber })}` : ''}</Text>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              <Button style={{ flex: 1 }} title={`✅`} loading={busy} onPress={() => mark(r, 'ACCEPTED')} />
              <Button style={{ flex: 1 }} title="✏️" variant="outline" onPress={() => openEdit(r)} />
              <Button style={{ flex: 1 }} title="🗑️" variant="danger" loading={busy} onPress={() => mark(r, 'REJECTED')} />
            </View>
          </Card>
        ))}
        <Button title={t('ib_approveBatch')} loading={busy} disabled={todo > 0} onPress={() => act(() => api.post(`/records/batches/${id}/approve`))} />
        {todo > 0 && <Text style={s.muted}>{t('ib_mustCheckAll')}</Text>}
        <Button title={t('ib_rejectBatch')} variant="danger" loading={busy} onPress={() => Alert.alert(t('ib_rejectBatch'), t('ib_rejectBatchBody'), [{ text: t('ib_back'), style: 'cancel' }, { text: t('ib_confirm'), onPress: () => act(async () => { await api.post(`/records/batches/${id}/reject`); router.back(); }) }])} />
      </>)}

      {b?.status === 'DRAFT' && <Button title={t('ib_submitDraft')} loading={busy} onPress={() => act(() => api.post(`/records/batches/${id}/submit`))} />}
      {b?.status === 'OCR_PENDING' && <Button title={t('ib_runReading')} loading={busy} onPress={() => act(() => api.post(`/records/batches/${id}/ocr`, undefined, { timeout: 120000 }))} />}
      {b?.status === 'APPROVED' && (<>
        <StatusCard tone="yellow" title={t('ib_readyToSave')} body={t('ib_readyToSaveBody')} speakText={t('ib_readyToSaveBody')} />
        {b.recordType === 'OPENING_POSITION' && (user?.role === 'BOARD_MEMBER' || user?.role === 'ADMIN') && <Button title={t('ib_boardSignoff')} variant="accent" loading={busy} onPress={() => act(() => api.post(`/records/batches/${id}/board-signoff`))} />}
        {b.recordType === 'OPENING_POSITION' && <Text style={s.muted}>{t('ib_boardSignoffNeeded')}</Text>}
        <Button title={t('ib_saveRecords')} loading={busy} onPress={() => act(() => api.post(`/records/batches/${id}/commit`), t('ib_recordsSaved'))} />
      </>)}
      {b?.status === 'COMMITTED' && <StatusCard tone="green" title={t('ib_recordsSaved')} body={t('ib_savedNote')} />}

      <Sheet title={t('ib_editLine')} visible={!!edit} onClose={() => setEdit(null)}>
        <View style={{ gap: 12 }}>
          <Field label={t('ib_personName')} value={f.name} onChangeText={(v) => setF({ ...f, name: v })} />
          <Field label={t('ib_amountNaira')} value={f.amount} onChangeText={(v) => setF({ ...f, amount: v })} keyboardType="numeric" />
          <Field label={t('ib_dateLabel')} value={f.date} onChangeText={(v) => setF({ ...f, date: v })} placeholder="2024-03-15" />
          <Button title={t('ib_save')} loading={busy} onPress={saveEdit} />
        </View>
      </Sheet>
    </Screen>
  );
}
