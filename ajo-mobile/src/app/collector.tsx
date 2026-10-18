import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { Alert } from '../components/feedback';
import { useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Button, Card, Screen, StatusBadge, s } from '../components/ui';
import { Chips, Field, SectionTitle, TrustBadge, type Trust } from '../components/widgets';
import { LinearGradient } from 'expo-linear-gradient';
import { colors, fonts, gradients } from '../theme';

interface GroupRow { id: string; name: string; adminId: string; currency: string }
interface Member { id: string; fullName: string; memberStatus: string; accountType: string; trust: Trust }

const tomorrow = () => new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);

function CreateGroup() {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [country, setCountry] = useState<'NG' | 'GH' | 'KE'>('NG');
  const [busy, setBusy] = useState(false);
  return (
    <Card style={{ gap: 10 }}>
      <Text style={s.h2}>New group</Text>
      <Field label="Group name" value={name} onChangeText={setName} placeholder="e.g. Ikeja Market Women" />
      <Chips value={country} onChange={setCountry} options={[{ value: 'NG', label: '🇳🇬 NGN' }, { value: 'GH', label: '🇬🇭 GHS' }, { value: 'KE', label: '🇰🇪 KES' }]} />
      <Button title="Create group" loading={busy} disabled={name.trim().length < 2} onPress={async () => {
        setBusy(true);
        try { await api.post('/groups/create', { name: name.trim(), country }); setName(''); qc.invalidateQueries({ queryKey: ['my-groups'] }); Alert.alert('Group created'); }
        catch (e) { Alert.alert('Error', errMsg(e)); } finally { setBusy(false); }
      }} />
    </Card>
  );
}

function CreateAjoPool({ groups }: { groups: GroupRow[] }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [groupId, setGroupId] = useState(groups[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [freq, setFreq] = useState<'DAILY' | 'WEEKLY' | 'MONTHLY'>('WEEKLY');
  const [fee, setFee] = useState('2');
  const [lateFee, setLateFee] = useState('0');
  const [grace, setGrace] = useState('1');
  const [start, setStart] = useState(tomorrow());
  const [rules, setRules] = useState('');
  const [keepOrder, setKeepOrder] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [hands, setHands] = useState<Record<string, number>>({});
  const [guarantors, setGuarantors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const members = useQuery({
    queryKey: ['group-members', groupId], enabled: !!groupId,
    queryFn: async () => (await api.get<{ members: Member[] }>(`/groups/${groupId}`)).data.members,
  });
  const clean = useMemo(() => (members.data ?? []).filter((m) => picked.includes(m.id) && m.memberStatus === 'CLEAN'), [members.data, picked]);

  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const submit = async () => {
    const startDate = new Date(`${start}T09:00:00`);
    if (isNaN(startDate.getTime())) return Alert.alert('Start date must look like 2026-11-01');
    setBusy(true);
    try {
      const { data } = await api.post('/ajo/pools/create', {
        groupId, title: title.trim(), amountPerMember: Number(amount), cycleFrequency: freq, collectorFeePct: Number(fee), memberIds: picked,
        startDate: startDate.toISOString(), preserveOrder: keepOrder, rulesText: rules.trim() || undefined, lateFeeAmount: Number(lateFee) || 0, graceDays: Number(grace) || 0,
        hands: Object.fromEntries(Object.entries(hands).filter(([id, h]) => h > 1 && picked.includes(id))),
        guarantors: Object.keys(guarantors).length ? guarantors : undefined,
      });
      qc.invalidateQueries();
      Alert.alert('Pool created', 'Every member has been told by SMS.', [{ text: 'Open', onPress: () => router.push(`/ajo/${data.pool.id}`) }]);
    } catch (e) { Alert.alert('Error', errMsg(e)); } finally { setBusy(false); }
  };

  if (!groups.length) return <Text style={s.muted}>Create a group first.</Text>;
  return (
    <Card style={{ gap: 10 }}>
      <Text style={s.h2}>New Àjọ pool</Text>
      <Chips value={groupId} onChange={(v) => { setGroupId(v); setPicked([]); }} options={groups.map((g) => ({ value: g.id, label: g.name }))} />
      <Field label="Pool name" value={title} onChangeText={setTitle} placeholder="e.g. Weekly Àjọ" />
      <Field label="Amount each member pays per round" value={amount} onChangeText={setAmount} keyboardType="numeric" />
      <Chips value={freq} onChange={setFreq} options={[{ value: 'DAILY', label: 'Daily' }, { value: 'WEEKLY', label: 'Weekly' }, { value: 'MONTHLY', label: 'Monthly' }]} />
      <Field label="First round starts (YYYY-MM-DD)" value={start} onChangeText={setStart} />
      <Field label="Your fee (% of each payout)" value={fee} onChangeText={setFee} keyboardType="numeric" />
      <Field label="Late fee (amount, 0 for none)" value={lateFee} onChangeText={setLateFee} keyboardType="numeric" />
      <Field label="Grace days before a member is marked late" value={grace} onChangeText={setGrace} keyboardType="numeric" />
      <Field label="Pool rules (members must accept)" value={rules} onChangeText={setRules} multiline placeholder="e.g. Pay by 5pm on the due date. Late payers pay the late fee." />

      <Text style={[s.body, { fontWeight: '700' }]}>Members ({picked.length} selected)</Text>
      {members.data?.map((m) => {
        const on = picked.includes(m.id);
        return (
          <View key={m.id} style={{ borderRadius: 12, borderWidth: 2, borderColor: on ? colors.primary : colors.border, padding: 8, gap: 6 }}>
            <Pressable onPress={() => toggle(m.id)} style={[s.row, { minHeight: 40 }]}>
              <Text style={[s.body, { fontWeight: on ? '800' : '500' }]}>{on ? '☑' : '☐'} {m.fullName}{m.accountType === 'ASSISTED' ? ' 📞' : ''}</Text>
              <TrustBadge trust={m.trust} compact />
            </Pressable>
            {on && (
              <Chips value={String(hands[m.id] ?? 1)} onChange={(v) => setHands((h) => ({ ...h, [m.id]: Number(v) }))} options={[{ value: '1', label: '1 hand' }, { value: '2', label: '2 hands' }]} />
            )}
            {on && m.memberStatus === 'DEFAULTER' && (
              <View style={{ gap: 4 }}>
                <Text style={{ color: colors.warning, fontWeight: '700' }}>Flagged defaulter: choose a guarantor</Text>
                <Chips value={guarantors[m.id] ?? ''} onChange={(v) => setGuarantors((g) => ({ ...g, [m.id]: v }))} options={clean.map((c) => ({ value: c.id, label: c.fullName }))} />
              </View>
            )}
          </View>
        );
      })}
      <Chips value={keepOrder ? 'keep' : 'random'} onChange={(v) => setKeepOrder(v === 'keep')} options={[{ value: 'random', label: '🎲 Random order' }, { value: 'keep', label: 'As I picked them' }]} />
      <Button title="Create pool" loading={busy} disabled={!title.trim() || !(Number(amount) > 0) || picked.length < 2} onPress={submit} />
    </Card>
  );
}

function CreateFoodPool({ groups }: { groups: GroupRow[] }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [groupId, setGroupId] = useState(groups[0]?.id ?? '');
  const [amount, setAmount] = useState('');
  const [target, setTarget] = useState('10');
  const [hub, setHub] = useState('');
  const [hours, setHours] = useState('48');
  const [deposit, setDeposit] = useState('50');
  const [busy, setBusy] = useState(false);
  if (!groups.length) return null;
  return (
    <Card style={{ gap: 10 }}>
      <Text style={s.h2}>New food pool</Text>
      <Chips value={groupId} onChange={setGroupId} options={groups.map((g) => ({ value: g.id, label: g.name }))} />
      <Field label="Price of one share" value={amount} onChangeText={setAmount} keyboardType="numeric" />
      <Field label="Members needed" value={target} onChangeText={setTarget} keyboardType="numeric" />
      <Field label="Collection point (address)" value={hub} onChangeText={setHub} />
      <Field label="Open for how many hours?" value={hours} onChangeText={setHours} keyboardType="numeric" />
      <Field label="Deposit to supplier before delivery (%)" value={deposit} onChangeText={setDeposit} keyboardType="numeric" />
      <Button title="Open food pool" loading={busy} disabled={!(Number(amount) > 0) || hub.trim().length < 3} onPress={async () => {
        setBusy(true);
        try {
          const { data } = await api.post('/ccgb/pools/create', { groupId, contributionAmt: Number(amount), targetMembers: Number(target), communityHubAddr: hub.trim(), liveWindowHours: Number(hours), supplierDepositPct: Number(deposit) });
          qc.invalidateQueries();
          router.push(`/food/${data.pool.id}`);
        } catch (e) { Alert.alert('Error', errMsg(e)); } finally { setBusy(false); }
      }} />
    </Card>
  );
}

const initials = (name: string) => name.split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('');

const TILES = [
  { key: 'group', icon: '👥', title: 'Create a group', sub: 'Gather your members in one place', tint: colors.indigo },
  { key: 'ajo', icon: '💰', title: 'Start an Àjọ pool', sub: 'Rotating savings with a clear order', tint: colors.zobo },
  { key: 'food', icon: '🛒', title: 'Open a food pool', sub: 'Buy in bulk together and share the cost', tint: colors.green },
] as const;

export default function CollectorHub() {
  const { user } = useAuth();
  const router = useRouter();
  const [open, setOpen] = useState<'group' | 'ajo' | 'food' | null>(null);
  const groups = useQuery({ queryKey: ['my-groups'], queryFn: async () => (await api.get<{ groups: GroupRow[] }>('/groups/mine')).data.groups });
  const mine = (groups.data ?? []).filter((g) => g.adminId === user?.id);
  const waiting = !user?.collectorApproved && user?.role === 'COLLECTOR';

  return (
    <Screen loaderButtons>
      <LinearGradient colors={[...gradients.zobo]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ borderRadius: 20, padding: 20, gap: 6, borderWidth: 1.5, borderColor: colors.cocoa }}>
        <Text style={{ fontFamily: fonts.mono, fontSize: 12, letterSpacing: 1.5, color: colors.gold }}>COLLECTOR</Text>
        <Text style={{ fontFamily: fonts.displayHeavy, fontSize: 24, color: colors.white }}>Collector tools</Text>
        <Text style={{ fontFamily: fonts.body, fontSize: 15, color: colors.cream }}>Run your groups, pools and members from here.</Text>
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 10 }}>
          <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.25)', borderRadius: 14, padding: 12 }}>
            <Text style={{ fontFamily: fonts.mono, fontSize: 26, color: colors.gold }}>{mine.length}</Text>
            <Text style={{ fontFamily: fonts.body, fontSize: 13, color: colors.cream }}>{mine.length === 1 ? 'group' : 'groups'}</Text>
          </View>
          <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.25)', borderRadius: 14, padding: 12 }}>
            <Text style={{ fontFamily: fonts.mono, fontSize: 26, color: colors.gold }}>{waiting ? '⏳' : '✓'}</Text>
            <Text style={{ fontFamily: fonts.body, fontSize: 13, color: colors.cream }}>{waiting ? 'awaiting approval' : 'collector approved'}</Text>
          </View>
        </View>
      </LinearGradient>

      {waiting && (
        <Card style={{ backgroundColor: colors.accentLight, borderColor: colors.accent }}>
          <Text style={[s.body, { fontFamily: fonts.bodyBold }]}>⏳ Waiting for approval</Text>
          <Text style={s.muted}>A platform admin must approve your collector account before you can create groups.</Text>
        </Card>
      )}

      <SectionTitle>Create something new</SectionTitle>
      {TILES.map((t) => {
        const on = open === t.key;
        return (
          <View key={t.key} style={{ gap: 8 }}>
            <Pressable accessibilityRole="button" accessibilityState={{ expanded: on }} onPress={() => setOpen(on ? null : t.key)} style={{ minHeight: 76, flexDirection: 'row', alignItems: 'center', gap: 14, borderRadius: 18, borderWidth: 1.5, borderColor: colors.cocoa, backgroundColor: on ? t.tint : colors.card, padding: 14, shadowColor: colors.cocoa, shadowOffset: { width: 3, height: 3 }, shadowOpacity: 1, shadowRadius: 0, elevation: 3 }}>
              <View style={{ width: 48, height: 48, borderRadius: 14, backgroundColor: on ? 'rgba(255,255,255,0.2)' : t.tint, alignItems: 'center', justifyContent: 'center' }}><Text style={{ fontSize: 24 }}>{t.icon}</Text></View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontFamily: fonts.display, fontSize: 16, color: on ? colors.white : colors.text }}>{t.title}</Text>
                <Text style={{ fontFamily: fonts.body, fontSize: 13, color: on ? colors.cream : colors.muted }}>{t.sub}</Text>
              </View>
              <Text style={{ fontSize: 22, color: on ? colors.white : colors.muted }}>{on ? '▾' : '›'}</Text>
            </Pressable>
            {on && t.key === 'group' && <CreateGroup />}
            {on && t.key === 'ajo' && <CreateAjoPool groups={mine} />}
            {on && t.key === 'food' && <CreateFoodPool groups={mine} />}
          </View>
        );
      })}

      <SectionTitle>My groups</SectionTitle>
      {mine.length === 0 && <Card><Text style={s.muted}>You have not created a group yet. Tap “Create a group” above to start.</Text></Card>}
      {mine.map((g) => (
        <Card key={g.id} style={{ gap: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: colors.orange, borderWidth: 2, borderColor: colors.cocoa, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ fontFamily: fonts.display, fontSize: 16, color: colors.cocoa }}>{initials(g.name)}</Text>
            </View>
            <Text style={[s.h3, { flex: 1 }]} numberOfLines={2}>{g.name}</Text>
            <StatusBadge status={g.currency} />
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button style={{ flex: 1 }} title="💬 Chat" variant="outline" onPress={() => router.push(`/groups/${g.id}`)} />
            <Button style={{ flex: 2 }} title="👥 Members & accounts" variant="accent" onPress={() => router.push(`/groups/${g.id}/members`)} />
          </View>
        </Card>
      ))}
    </Screen>
  );
}
