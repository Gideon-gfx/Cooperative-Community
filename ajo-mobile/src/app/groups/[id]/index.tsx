import { useState } from 'react';
import { FlatList, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { Alert } from '../../../components/feedback';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { AudioModule, RecordingPresets, setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus, useAudioRecorder } from 'expo-audio';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg, money, uploadFile } from '../../../api/client';
import { useAuth } from '../../../auth/AuthContext';
import { postOrQueue } from '../../../offline';
import { Button, Loading, Sheet, STATUS_EMOJI, StatusBadge, s } from '../../../components/ui';
import { Chips, Field, TrustBadge, type Trust } from '../../../components/widgets';
import { pickImage } from '../../../components/pickers';
import { colors, TAP } from '../../../theme';

interface PollOption { id: string; label: string; votes: number }
interface Poll { id: string; title: string; status: string; options: PollOption[]; totalVotes: number; myVoteOptionId: string | null; winner: PollOption | null }
interface Receipt { poolTitle: string; recipientName: string; currency: string; totalCollected: number; platformFee: number; collectorFee: number; netPayout: number; receiptUrl: string | null; payoutMethod: string | null; payoutRef: string | null; recipientConfirmedAt: string | null; status: string }
interface Message {
  id: string; messageType: 'TEXT' | 'AUDIO' | 'RECEIPT' | 'POLL' | 'SYSTEM'; content: string | null; audioUrl: string | null;
  createdAt: string; sender: { id: string; fullName: string } | null; receipt?: Receipt | null; poll?: Poll | null;
}
interface GroupData {
  group: { id: string; name: string; adminId: string; currency: string };
  members: { id: string; fullName: string; memberStatus: string; isAdmin: boolean; accountType: string; trust: Trust }[];
  collector: { verified: boolean; groups: number; completedPayouts: number; confirmedPayouts: number };
  isCollector: boolean;
  messages: Message[]; ajoPools: { id: string; title: string }[]; foodPools: { id: string }[];
}

function ReceiptCard({ r }: { r: Receipt }) {
  const confirmed = !!r.recipientConfirmedAt;
  const disputed = r.status === 'DISPUTED';
  return (
    <View style={{ backgroundColor: '#fff', borderRadius: 16, borderWidth: 2, borderColor: disputed ? colors.warning : colors.primary, padding: 14, width: 300, gap: 4 }}>
      <Text style={[s.body, { color: disputed ? colors.warning : colors.primary, fontWeight: '800' }]}>{disputed ? '⚠️ Payout disputed' : confirmed ? '✅ Payout confirmed by recipient' : '🕒 Payout recorded: waiting for recipient'}</Text>
      <Text style={s.muted}>{r.poolTitle} · {r.recipientName}</Text>
      <Text style={{ fontSize: 30, fontWeight: '800', color: colors.primary }}>{money(r.netPayout, r.currency)}</Text>
      <Text style={s.muted}>Collected {money(r.totalCollected, r.currency)} · Collector fee {money(r.collectorFee, r.currency)}{r.platformFee > 0 ? ` · Service fee ${money(r.platformFee, r.currency)}` : ''}</Text>
      {r.payoutMethod && <Text style={s.muted}>Paid by {r.payoutMethod.toLowerCase()}{r.payoutRef ? ` · ${r.payoutRef}` : ''}</Text>}
      {r.receiptUrl && <Button title="Download Receipt" onPress={() => Linking.openURL(r.receiptUrl!)} style={{ marginTop: 8 }} />}
    </View>
  );
}

function PollCard({ poll, groupId }: { poll: Poll; groupId: string }) {
  const qc = useQueryClient();
  const [choice, setChoice] = useState<string | null>(null);
  const vote = useMutation({
    mutationFn: () => api.post(`/groups/polls/${poll.id}/vote`, { pollOptionId: choice }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['group', groupId] }),
    onError: (e) => Alert.alert('Vote failed', errMsg(e)),
  });
  const open = poll.status === 'OPEN';
  const canVote = open && !poll.myVoteOptionId;
  return (
    <View style={{ backgroundColor: '#fff', borderRadius: 16, borderWidth: 2, borderColor: colors.accent, padding: 14, width: 300, gap: 8 }}>
      <Text style={s.h3}>📊 {poll.title}</Text>
      {poll.options.map((o) => {
        const pct = poll.totalVotes ? Math.round((o.votes / poll.totalVotes) * 100) : 0;
        const selected = choice === o.id || poll.myVoteOptionId === o.id;
        return (
          <Pressable key={o.id} disabled={!canVote} onPress={() => setChoice(o.id)} style={{ minHeight: TAP, borderRadius: 12, borderWidth: 2, borderColor: selected ? colors.primary : colors.border, overflow: 'hidden', justifyContent: 'center' }}>
            <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${pct}%`, backgroundColor: colors.accentLight }} />
            <View style={[s.row, { paddingHorizontal: 12 }]}><Text style={s.body}>{o.label}</Text><Text style={{ fontWeight: '700' }}>{pct}% ({o.votes})</Text></View>
          </Pressable>
        );
      })}
      {canVote && <Button title="Vote" disabled={!choice} loading={vote.isPending} onPress={() => vote.mutate()} />}
      {poll.myVoteOptionId && open && <Text style={s.muted}>You voted ✔</Text>}
      {!open && poll.winner && <Text style={[s.body, { color: colors.primary, fontWeight: '700' }]}>Winner: {poll.winner.label}</Text>}
    </View>
  );
}

function VoiceNote({ url, mine }: { url: string; mine: boolean }) {
  const player = useAudioPlayer(url);
  const status = useAudioPlayerStatus(player);
  return (
    <Pressable onPress={() => (status.playing ? player.pause() : player.play())} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: TAP }}>
      <Text style={{ fontSize: 26 }}>{status.playing ? '⏸️' : '▶️'}</Text>
      <Text style={{ color: mine ? '#fff' : colors.text, fontSize: 16 }}>Voice note{status.duration ? ` · ${Math.round(status.duration)}s` : ''}</Text>
    </Pressable>
  );
}

function Bubble({ m, mine, groupId }: { m: Message; mine: boolean; groupId: string }) {
  if (m.messageType === 'SYSTEM') {
    return <View style={{ alignSelf: 'center', maxWidth: '90%', backgroundColor: '#E5E7EB', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8 }}><Text style={{ textAlign: 'center', color: '#374151' }}>{m.content}</Text></View>;
  }
  const isLink = /^https?:\/\/\S+$/.test(m.content ?? '');
  const fg = mine ? '#fff' : colors.text;
  return (
    <View style={{ alignItems: mine ? 'flex-end' : 'flex-start' }}>
      {!mine && <Text style={{ color: colors.primary, fontWeight: '700', marginBottom: 2 }}>{m.sender?.fullName ?? 'ÀJỌ'}</Text>}
      {m.messageType === 'RECEIPT' && m.receipt ? <ReceiptCard r={m.receipt} />
        : m.messageType === 'POLL' && m.poll ? <PollCard poll={m.poll} groupId={groupId} />
        : (
          <View style={{ maxWidth: '85%', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: mine ? colors.primary : '#fff', borderWidth: mine ? 0 : 1, borderColor: colors.border }}>
            {m.messageType === 'AUDIO' && m.audioUrl ? <VoiceNote url={m.audioUrl} mine={mine} />
              : isLink ? <Text onPress={() => Linking.openURL(m.content!)} style={{ color: fg, textDecorationLine: 'underline', fontSize: 17 }}>📎 Attachment</Text>
              : <Text style={{ color: fg, fontSize: 17 }}>{m.content}</Text>}
          </View>
        )}
      <Text style={{ fontSize: 12, color: colors.muted, marginTop: 2 }}>{new Date(m.createdAt).toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' })}</Text>
    </View>
  );
}

const POLL_TYPES = [
  { value: 'AJO_AMOUNT', label: 'Àjọ amount' }, { value: 'AJO_SCHEDULE', label: 'Àjọ schedule' },
  { value: 'FOOD_BUDGET', label: 'Food budget' }, { value: 'FOOD_ITEMS', label: 'Food items' },
] as const;

export default function GroupChat() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user, t } = useAuth();
  const router = useRouter();
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [members, setMembers] = useState(false);
  const [pollOpen, setPollOpen] = useState(false);
  const [pollTitle, setPollTitle] = useState('');
  const [pollType, setPollType] = useState<(typeof POLL_TYPES)[number]['value']>('FOOD_ITEMS');
  const [pollOpts, setPollOpts] = useState(['', '']);
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const [recording, setRecording] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['group', id],
    queryFn: async () => (await api.get<GroupData>(`/groups/${id}`)).data,
    refetchInterval: 6000,
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['group', id] });
  const send = useMutation({
    mutationFn: (body: { content?: string; audioUrl?: string; messageType: 'TEXT' | 'AUDIO' }) => postOrQueue('post', `/groups/${id}/messages`, body, 'message'),
    onSuccess: (r) => { if (r.queued) Alert.alert(t('queued')); refresh(); },
    onError: (e) => Alert.alert('Not sent', errMsg(e)),
  });

  if (isLoading || !data) return <Loading />;

  const submit = () => { if (text.trim()) { send.mutate({ content: text.trim(), messageType: 'TEXT' }); setText(''); } };
  const attach = async () => {
    const file = await pickImage();
    if (!file) return;
    try { send.mutate({ content: await uploadFile(file), messageType: 'TEXT' }); } catch (e) { Alert.alert('Upload failed', errMsg(e)); }
  };
  const toggleRecord = async () => {
    try {
      if (!recording) {
        const perm = await AudioModule.requestRecordingPermissionsAsync();
        if (!perm.granted) return Alert.alert('Microphone needed', 'Allow the microphone to send voice notes.');
        await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
        await recorder.prepareToRecordAsync();
        recorder.record();
        setRecording(true);
      } else {
        await recorder.stop();
        setRecording(false);
        await setAudioModeAsync({ allowsRecording: false });
        if (recorder.uri) send.mutate({ audioUrl: await uploadFile({ uri: recorder.uri, name: 'voice.m4a', type: 'audio/mp4' }), messageType: 'AUDIO' });
      }
    } catch (e) { setRecording(false); Alert.alert('Voice note failed', errMsg(e)); }
  };
  const createPoll = async () => {
    const options = pollOpts.map((o) => o.trim()).filter(Boolean).map((o) => ({ label: o, value: o }));
    try {
      await api.post('/groups/polls/create', { groupId: id, title: pollTitle.trim(), pollType, options });
      setPollOpen(false); setPollTitle(''); setPollOpts(['', '']); refresh();
    } catch (e) { Alert.alert('Error', errMsg(e)); }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: '#EFEAE2' }} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
      <View style={{ backgroundColor: colors.primary, padding: 10, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: '#fff', fontSize: 18, fontWeight: '800' }} numberOfLines={1}>{data.group.name}</Text>
          <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 13 }}>{data.collector.verified ? '✅ Verified collector' : 'Collector'} · {data.collector.confirmedPayouts}/{data.collector.completedPayouts} payouts confirmed</Text>
        </View>
        <Pressable onPress={() => setMembers(true)} style={{ minHeight: 40, paddingHorizontal: 12, justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 10 }}><Text style={{ color: '#fff', fontWeight: '700' }}>👥 {data.members.length}</Text></Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ padding: 8, gap: 8 }}>
        {data.ajoPools.map((p) => <Pressable key={p.id} onPress={() => router.push(`/ajo/${p.id}`)} style={chip}><Text style={chipText}>🪙 {p.title}</Text></Pressable>)}
        {data.foodPools.map((p) => <Pressable key={p.id} onPress={() => router.push(`/food/${p.id}`)} style={chip}><Text style={chipText}>🛒 Food pool</Text></Pressable>)}
        <Pressable onPress={() => router.push('/disputes')} style={chip}><Text style={chipText}>⚖️ {t('disputes')}</Text></Pressable>
        {data.isCollector && <Pressable onPress={() => setPollOpen(true)} style={chip}><Text style={chipText}>📊 New poll</Text></Pressable>}
      </ScrollView>

      <FlatList
        inverted
        data={data.messages}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ padding: 12, gap: 12 }}
        renderItem={({ item }) => <Bubble m={item} groupId={data.group.id} mine={item.sender?.id === user?.id} />}
      />

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, padding: 8, backgroundColor: '#fff' }}>
        <Pressable onPress={attach} accessibilityLabel="Attach" style={iconBtn}><Text style={{ fontSize: 24 }}>📎</Text></Pressable>
        <TextInput style={[s.input, { flex: 1 }]} placeholder="Type a message" value={text} onChangeText={setText} onSubmitEditing={submit} returnKeyType="send" />
        {text.trim() ? <Button title={t('send')} onPress={submit} loading={send.isPending} /> : (
          <Pressable onPress={toggleRecord} accessibilityLabel="Voice note" style={[iconBtn, { backgroundColor: recording ? colors.warning : colors.primary, borderRadius: 24 }]}>
            <Text style={{ fontSize: 24 }}>{recording ? '⏹️' : '🎤'}</Text>
          </Pressable>
        )}
      </View>

      <Sheet title={`Members (${data.members.length})`} visible={members} onClose={() => setMembers(false)}>
        <ScrollView style={{ maxHeight: 420 }}>
          {data.members.map((m) => (
            <View key={m.id} style={{ minHeight: TAP, paddingVertical: 6, gap: 4 }}>
              <View style={s.row}>
                <Text style={s.body}>{STATUS_EMOJI[m.memberStatus]} {m.fullName}{m.isAdmin ? ' (Collector)' : ''}{m.accountType === 'ASSISTED' ? ' 📞' : ''}</Text>
                <StatusBadge status={m.memberStatus} />
              </View>
              <TrustBadge trust={m.trust} />
            </View>
          ))}
        </ScrollView>
        {data.isCollector && <Button title="Manage members" variant="outline" onPress={() => { setMembers(false); router.push(`/groups/${id}/members`); }} />}
      </Sheet>

      <Sheet title="New poll" visible={pollOpen} onClose={() => setPollOpen(false)}>
        <ScrollView style={{ maxHeight: 460 }} contentContainerStyle={{ gap: 10 }}>
          <Field label="Question" value={pollTitle} onChangeText={setPollTitle} />
          <Chips value={pollType} onChange={setPollType} options={[...POLL_TYPES]} />
          {pollOpts.map((o, i) => <Field key={i} label={`Option ${i + 1}`} value={o} onChangeText={(v) => setPollOpts((p) => p.map((x, j) => (j === i ? v : x)))} />)}
          {pollOpts.length < 5 && <Button title="+ Add option" variant="outline" onPress={() => setPollOpts((p) => [...p, ''])} />}
          <Button title="Post poll" disabled={pollTitle.trim().length < 3 || pollOpts.filter((o) => o.trim()).length < 2} onPress={createPoll} />
        </ScrollView>
      </Sheet>
    </KeyboardAvoidingView>
  );
}

const chip = { minHeight: 40, paddingHorizontal: 14, justifyContent: 'center' as const, backgroundColor: colors.accent, borderRadius: 10 };
const chipText = { fontWeight: '700' as const };
const iconBtn = { width: TAP, height: TAP, alignItems: 'center' as const, justifyContent: 'center' as const };
