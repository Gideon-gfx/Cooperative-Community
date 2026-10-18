import { useState } from 'react';
import { Text, View } from 'react-native';
import { Alert } from '../components/feedback';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg, money } from '../api/client';
import { Button, Card, Loading, Screen, StatusBadge, s } from '../components/ui';
import { Chips, Field, SectionTitle } from '../components/widgets';

interface Supplier { id: string; businessName: string; supplierType: string; isAdminApproved: boolean; ratingAvg: number; ratingCount: number; products: { id: string; name: string; category: string; unitPrice: number; kgWeightPerUnit: number; isAvailable: boolean }[] }

export default function SupplierScreen() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['supplier-me'], queryFn: async () => (await api.get<{ supplier: Supplier | null }>('/ccgb/suppliers/me')).data.supplier });
  const [name, setName] = useState('');
  const [type, setType] = useState<'FACTORY' | 'LARGE_WHOLESALER' | 'FARMER'>('FARMER');
  const [pName, setPName] = useState('');
  const [pCat, setPCat] = useState('');
  const [pPrice, setPPrice] = useState('');
  const [pKg, setPKg] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['supplier-me'] });
  const run = async (fn: () => Promise<unknown>) => { try { await fn(); refresh(); } catch (e) { Alert.alert('Error', errMsg(e)); } };
  if (me.isLoading) return <Loading />;
  const sup = me.data;

  if (!sup) {
    return (
      <Screen>
        <Card style={{ gap: 10 }}>
          <Text style={s.h3}>Sell to food pools</Text>
          <Text style={s.muted}>Register your business. A platform admin approves suppliers before their products can be voted on.</Text>
          <Field label="Business name" value={name} onChangeText={setName} />
          <Chips value={type} onChange={setType} options={[{ value: 'FARMER', label: 'Farmer' }, { value: 'LARGE_WHOLESALER', label: 'Wholesaler' }, { value: 'FACTORY', label: 'Factory' }]} />
          <Button title="Register" disabled={name.trim().length < 2} onPress={() => run(() => api.post('/ccgb/suppliers/register', { businessName: name.trim(), supplierType: type }))} />
        </Card>
      </Screen>
    );
  }
  return (
    <Screen>
      <Card>
        <View style={s.row}><Text style={s.h2}>{sup.businessName}</Text><StatusBadge status={sup.isAdminApproved ? 'VERIFIED' : 'PENDING'} /></View>
        <Text style={s.muted}>{sup.ratingCount > 0 ? `★ ${sup.ratingAvg} from ${sup.ratingCount} rating(s)` : 'No ratings yet'}{sup.isAdminApproved ? '' : ' · waiting for admin approval'}</Text>
      </Card>
      {sup.isAdminApproved && (
        <Card style={{ gap: 10 }}>
          <Text style={s.h3}>Add a product</Text>
          <Field label="Name (e.g. Rice 50kg bag)" value={pName} onChangeText={setPName} />
          <Field label="Category" value={pCat} onChangeText={setPCat} />
          <Field label="Price per unit" value={pPrice} onChangeText={setPPrice} keyboardType="numeric" />
          <Field label="Weight per unit (kg)" value={pKg} onChangeText={setPKg} keyboardType="numeric" />
          <Button title="Add product" disabled={!pName.trim() || !pCat.trim() || !(Number(pPrice) > 0) || !(Number(pKg) > 0)} onPress={() => run(async () => { await api.post('/ccgb/suppliers/products', { name: pName.trim(), category: pCat.trim(), unitPrice: Number(pPrice), kgWeightPerUnit: Number(pKg) }); setPName(''); setPCat(''); setPPrice(''); setPKg(''); })} />
        </Card>
      )}
      <SectionTitle>My products</SectionTitle>
      {sup.products.map((p) => (
        <Card key={p.id}>
          <View style={s.row}><Text style={s.h3}>{p.name}</Text><StatusBadge status={p.isAvailable ? 'ACTIVE' : 'FAILED'} /></View>
          <Text style={s.muted}>{p.category} · {p.kgWeightPerUnit}kg · {money(p.unitPrice)}</Text>
          <Button title={p.isAvailable ? 'Mark unavailable' : 'Mark available'} variant="outline" onPress={() => run(() => api.patch(`/ccgb/suppliers/products/${p.id}`, { isAvailable: !p.isAvailable }))} />
        </Card>
      ))}
    </Screen>
  );
}
