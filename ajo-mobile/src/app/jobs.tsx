import { useState } from 'react';
import { Text, View } from 'react-native';
import { Alert } from '../components/feedback';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg, money, uploadFile } from '../api/client';
import { Button, Card, Loading, Screen, Sheet, StatusBadge, s } from '../components/ui';
import { pickImage, type PickedFile } from '../components/pickers';
import { Field } from '../components/widgets';

interface Job { poolId: string; status: string; groupName: string; currency: string; hub: string | null; pickup?: string; product?: string; orderUnits: number | null; orderKg: number | null; fee: number; deliveredAt?: string; receivedKg: number | null }

export default function Jobs() {
  const qc = useQueryClient();
  const [job, setJob] = useState<Job | null>(null);
  const [photo, setPhoto] = useState<PickedFile | null>(null);
  const [kg, setKg] = useState('');
  const [busy, setBusy] = useState(false);
  const jobs = useQuery({ queryKey: ['jobs'], queryFn: async () => (await api.get<{ jobs: Job[] }>('/ccgb/jobs')).data.jobs });
  if (jobs.isLoading) return <Loading />;

  const confirm = async () => {
    if (!job || !photo) return;
    setBusy(true);
    try {
      const { data } = await api.post(`/ccgb/pools/${job.poolId}/confirm-delivery`, { proofUrl: await uploadFile(photo), receivedKg: kg ? Number(kg) : undefined });
      Alert.alert(data.short ? 'Delivered: short' : 'Delivered', data.short ? 'The weight is below the order. The supplier will be paid for what arrived.' : 'Thank you. The collector will pay your fee.');
      setJob(null); setPhoto(null); setKg('');
      qc.invalidateQueries({ queryKey: ['jobs'] });
    } catch (e) { Alert.alert('Error', errMsg(e)); } finally { setBusy(false); }
  };

  return (
    <Screen>
      {jobs.data?.length === 0 && <Text style={s.muted}>No delivery jobs yet. Keep your location saved in Settings so we can find you.</Text>}
      {jobs.data?.map((j) => (
        <Card key={j.poolId}>
          <View style={s.row}><Text style={s.h3}>{j.groupName}</Text><StatusBadge status={j.status} /></View>
          <Text style={s.body}>Pick up: <Text style={{ fontWeight: '700' }}>{j.pickup}</Text></Text>
          <Text style={s.body}>Deliver to: <Text style={{ fontWeight: '700' }}>{j.hub}</Text></Text>
          <Text style={s.body}>{j.orderUnits} × {j.product} ({j.orderKg} kg)</Text>
          <Text style={s.body}>Fee: <Text style={{ fontWeight: '800' }}>{money(j.fee, j.currency)}</Text> (paid by the collector after delivery)</Text>
          {j.status !== 'DELIVERED' && <Button title="Confirm delivery" onPress={() => setJob(j)} />}
        </Card>
      ))}
      <Sheet title="Confirm delivery" visible={!!job} onClose={() => setJob(null)}>
        <View style={{ gap: 10 }}>
          <Text style={s.body}>Take a photo of the delivered goods at the collection point.</Text>
          <Button title={photo ? `📷 ${photo.name}` : '📷 Choose photo'} variant="outline" onPress={async () => setPhoto(await pickImage())} />
          <Field label={`Weight received in kg (ordered ${job?.orderKg ?? ''} kg)`} value={kg} onChangeText={setKg} keyboardType="numeric" />
          <Button title="Confirm" loading={busy} disabled={!photo} onPress={confirm} />
        </View>
      </Sheet>
    </Screen>
  );
}
