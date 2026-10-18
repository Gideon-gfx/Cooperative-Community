import { useState } from 'react';
import { Text } from 'react-native';
import { Alert } from '../../components/feedback';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { Button, Loading, Screen, s } from '../../components/ui';
import { Chips, Field, SectionTitle } from '../../components/widgets';

const ASO = ['WEDDING', 'BURIAL', 'BIRTHDAY', 'NAMING', 'OTHER'];
const HELP = ['MEDICAL', 'SCHOOL', 'RENT', 'BURIAL', 'OTHER'];
const GENERAL = ['COMMUNITY', 'RELIGIOUS', 'FESTIVAL', 'OTHER'];
const FIRST: Record<Kind, string> = { ASO_EBI: 'WEDDING', HELP: 'MEDICAL', OTHER: 'COMMUNITY' };
type Kind = 'ASO_EBI' | 'HELP' | 'OTHER';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default function NewCampaign() {
  const params = useLocalSearchParams<{ kind?: string }>();
  const router = useRouter();
  const { t } = useAuth();
  const qc = useQueryClient();
  const [kind, setKind] = useState<Kind>(params.kind === 'HELP' || params.kind === 'OTHER' ? params.kind : 'ASO_EBI');
  const [groupId, setGroupId] = useState('');
  const [occasion, setOccasion] = useState(FIRST[params.kind === 'HELP' || params.kind === 'OTHER' ? params.kind : 'ASO_EBI']);
  const [otherName, setOtherName] = useState('');
  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [venue, setVenue] = useState('');
  const [part, setPart] = useState('');
  const [people, setPeople] = useState('');
  const [outfits, setOutfits] = useState(['', '']);
  const [recipient, setRecipient] = useState('');
  const [note, setNote] = useState('');
  const [target, setTarget] = useState('');

  const groups = useQuery({ queryKey: ['my-groups'], queryFn: async () => (await api.get<{ groups: { id: string; name: string }[] }>('/groups/mine')).data.groups });
  const create = useMutation({
    mutationFn: async () => (await api.post<{ campaign: { id: string } }>('/campaigns', {
      groupId: groupId || groups.data?.[0]?.id, kind, occasion, occasionLabel: occasion === 'OTHER' ? otherName.trim() : undefined, title: title.trim(),
      description: kind !== 'ASO_EBI' ? note.trim() || undefined : undefined,
      eventDate: DATE_RE.test(date) ? date : undefined, venue: venue.trim() || undefined,
      ...(kind === 'ASO_EBI'
        ? { partAmount: Number(part), targetPeople: people ? Number(people) : undefined, options: outfits.map((o) => o.trim()).filter(Boolean).map((label) => ({ label })) }
        : { recipientName: kind === 'HELP' ? recipient.trim() : undefined, recipientNote: kind === 'HELP' ? note.trim() || undefined : undefined, targetAmount: target ? Number(target) : undefined }),
    })).data.campaign,
    onSuccess: (c) => { qc.invalidateQueries({ queryKey: ['campaigns'] }); router.replace(`/campaigns/${c.id}`); },
    onError: (e) => Alert.alert('Could not start it', errMsg(e)),
  });

  if (groups.isLoading) return <Loading />;
  if (!groups.data?.length) return <Screen><Text style={s.body}>Join a group first. {t('askCollector')}</Text></Screen>;
  const gid = groupId || groups.data[0].id;
  const valid = title.trim().length >= 3 && (kind === 'ASO_EBI' ? Number(part) > 0 && outfits.some((o) => o.trim().length >= 2) : kind === 'HELP' ? recipient.trim().length >= 2 : true) && (!date || DATE_RE.test(date)) && (occasion !== 'OTHER' || otherName.trim().length >= 2);

  return (
    <Screen>
      <Chips value={kind} onChange={(k) => { setKind(k); setOccasion(FIRST[k]); }} options={[{ value: 'ASO_EBI', label: t('kindAso') }, { value: 'HELP', label: t('kindHelp') }, { value: 'OTHER', label: t('kindOther') }]} />
      {groups.data.length > 1 && (<><SectionTitle>Which group?</SectionTitle><Chips value={gid} onChange={setGroupId} options={groups.data.map((g) => ({ value: g.id, label: g.name }))} /></>)}
      <SectionTitle>What is it for?</SectionTitle>
      <Chips value={occasion} onChange={setOccasion} options={(kind === 'ASO_EBI' ? ASO : kind === 'HELP' ? HELP : GENERAL).map((v) => ({ value: v, label: t(`occ_${v}`) }))} />
      {occasion === 'OTHER' && <Field label={t('nameOccasion')} value={otherName} onChangeText={setOtherName} placeholder={t('occasionHint')} maxLength={40} />}
      <Field label="Name it" value={title} onChangeText={setTitle} placeholder={kind === 'ASO_EBI' ? 'Ade & Tola’s Wedding' : kind === 'HELP' ? 'Help for Mama Ade’s surgery' : 'New borehole for our street'} maxLength={100} />

      {kind === 'ASO_EBI' ? (
        <>
          <Field label="Date (YYYY-MM-DD)" value={date} onChangeText={setDate} placeholder="2026-11-14" keyboardType="numbers-and-punctuation" />
          <Field label="Where?" value={venue} onChangeText={setVenue} placeholder="Badagry Town Hall" />
          <Field label="Each person pays (₦)" value={part} onChangeText={setPart} keyboardType="numeric" />
          <Field label="How many friends? (optional)" value={people} onChangeText={setPeople} keyboardType="numeric" />
          <SectionTitle>Outfit choices</SectionTitle>
          {outfits.map((o, i) => <Field key={i} label={`Outfit ${i + 1}`} value={o} onChangeText={(v) => setOutfits(outfits.map((x, j) => (j === i ? v : x)))} placeholder={i === 0 ? 'Gele + wrapper' : 'Fila + agbada'} />)}
          {outfits.length < 6 && <Button title="＋ Add another outfit" variant="outline" onPress={() => setOutfits([...outfits, ''])} />}
        </>
      ) : (
        <>
          {kind === 'HELP' && <Field label="Who is it for?" value={recipient} onChangeText={setRecipient} placeholder="Mama Ade" />}
          <Field label="Tell people more (optional)" value={note} onChangeText={setNote} multiline maxLength={500} />
          <Field label="Goal in ₦ (optional)" value={target} onChangeText={setTarget} keyboardType="numeric" />
        </>
      )}

      <Text style={s.muted}>You will hold the money and record every gift. Everyone in the group can see the ledger.</Text>
      <Button title="Start it" disabled={!valid} loading={create.isPending} onPress={() => create.mutate()} />
    </Screen>
  );
}
