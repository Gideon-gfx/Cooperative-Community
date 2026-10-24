import { useState } from 'react';
import { Linking, Platform, Text, View } from 'react-native';
import { Alert } from '../components/feedback';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Location from 'expo-location';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errMsg } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { LANGS, type Lang } from '../i18n';
import { Button, Card, Screen, Sheet, s } from '../components/ui';
import { LegalLinks } from '../components/LegalLinks';
import { Chips, Field, TrustBadge, type Trust } from '../components/widgets';
import { registerIosPushNotifications } from '../notifications/push';
import { useLoader } from '../components/GlobalLoader';
import { colors } from '../theme';

const HOURS = [6, 8, 10, 12, 16, 18, 20].map((h) => ({ value: String(h), label: `${h}:00` }));

export default function Settings() {
  const { user, updateUser, logout, t } = useAuth();
  const withLoader = useLoader();
  const router = useRouter();
  const qc = useQueryClient();
  const { mustChange } = useLocalSearchParams<{ mustChange?: string }>();
  const [pin, setPin] = useState('');
  const [currentPin, setCurrentPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [notificationsBusy, setNotificationsBusy] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const profile = useQuery({ queryKey: ['profile'], queryFn: async () => (await api.get<{ user: { hasPin: boolean }; trust: Trust; collector: { verified: boolean; groups: number; completedPayouts: number; confirmedPayouts: number } | null }>('/auth/profile')).data });

  const patch = async (body: Record<string, unknown>) => {
    try {
      const { data } = await api.post('/auth/update-profile', body);
      await updateUser(data.user);
    } catch (e) { Alert.alert('Error', errMsg(e)); }
  };

  const savePin = async () => {
    setBusy(true);
    try {
      await api.post('/auth/set-pin', { pin, currentPin: currentPin || undefined });
      await updateUser({ hasPin: true });
      setPin(''); setCurrentPin('');
      qc.invalidateQueries({ queryKey: ['profile'] });
      Alert.alert('Saved', 'Your PIN has been saved.');
      if (mustChange) router.replace('/dashboard');
    } catch (e) { Alert.alert('Error', errMsg(e)); } finally { setBusy(false); }
  };

  const saveLocation = async () => {
    const perm = await Location.requestForegroundPermissionsAsync();
    if (!perm.granted) return Alert.alert('Location needed', 'Allow location so food pools can work out the delivery distance.');
    const pos = await Location.getCurrentPositionAsync({});
    await patch({ locationLat: pos.coords.latitude, locationLng: pos.coords.longitude, locationLabel: 'My location' });
    Alert.alert('Saved', 'Your location was saved.');
  };

  const enableNotifications = async () => {
    setNotificationsBusy(true);
    try {
      const token = await registerIosPushNotifications();
      if (token) Alert.alert('Notifications enabled', 'ÀJỌ can now send payment and payout alerts to this iPhone.');
      else Alert.alert('Notifications are off', 'Allow ÀJỌ notifications in iPhone Settings to receive payment and payout alerts.');
    } catch (error) {
      Alert.alert('Could not enable notifications', error instanceof Error ? error.message : errMsg(error));
    } finally {
      setNotificationsBusy(false);
    }
  };

  const confirmAndLogout = async () => {
    setLoggingOut(true);
    try {
      await withLoader(async () => {
        await logout();
        router.replace('/');
      });
    } catch (error) {
      Alert.alert('Could not log out', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setLoggingOut(false);
      setConfirmLogout(false);
    }
  };

  const hasPin = profile.data?.user.hasPin ?? user?.hasPin;
  const needsLocation = user?.role === 'COLLECTOR' || user?.role === 'TRANSPORTER';

  return (
    <Screen>
      <Card>
        <Text style={s.h2}>{user?.fullName}</Text>
        <Text style={s.muted}>{user?.phoneNumber ?? user?.email ?? 'Contact details not set'}{user?.accountType === 'ASSISTED' ? ' · created by your collector' : ''}</Text>
        <TrustBadge trust={profile.data?.trust} />
        {profile.data?.collector && <Text style={s.muted}>{profile.data.collector.verified ? '✅ Verified collector' : 'Collector awaiting approval'} · {profile.data.collector.groups} group(s) · {profile.data.collector.confirmedPayouts}/{profile.data.collector.completedPayouts} payouts confirmed by members</Text>}
      </Card>

      <Card style={{ gap: 10 }}>
        <Text style={s.h3}>{t('language')}</Text>
        <Chips<Lang> value={(user?.preferredLanguage ?? 'EN') as Lang} onChange={(v) => patch({ preferredLanguage: v })} options={LANGS.map((l) => ({ value: l.code, label: l.label }))} />
        <Text style={s.muted}>Yorùbá, Hausa and Igbo texts are still being reviewed by native speakers.</Text>
        <Text style={s.h3}>{t('reminderHour')}</Text>
        <Chips value={String(user?.reminderHour ?? 8)} onChange={(v) => patch({ reminderHour: Number(v) })} options={HOURS} />
      </Card>

      {Platform.OS === 'ios' && (
        <Card style={{ gap: 8 }}>
          <Text style={s.h3}>🔔 Notifications</Text>
          <Text style={s.muted}>Receive payment-due, missed-payment, payout and payment-verification alerts on this iPhone.</Text>
          <Button title="Enable iOS notifications" variant="outline" onPress={enableNotifications} loading={notificationsBusy} />
          <Button title="Open iPhone notification settings" variant="outline" onPress={() => Linking.openSettings()} />
        </Card>
      )}

      <Card style={{ gap: 10 }}>
        <Text style={s.h3}>🔒 {t('setPin')}</Text>
        {mustChange && <Text style={[s.body, { color: '#B45309', fontWeight: '700' }]}>Choose your own PIN to continue.</Text>}
        {hasPin && !mustChange && <Field label="Current PIN" value={currentPin} onChangeText={setCurrentPin} keyboardType="number-pad" secure maxLength={4} />}
        <Field label="New 4-digit PIN" value={pin} onChangeText={setPin} keyboardType="number-pad" secure maxLength={4} />
        <Button title={t('save')} onPress={savePin} loading={busy} disabled={pin.length !== 4} />
      </Card>

      {needsLocation && (
        <Card style={{ gap: 8 }}>
          <Text style={s.h3}>📍 Location</Text>
          <Text style={s.muted}>{user?.role === 'COLLECTOR' ? 'Your location is used as the food collection hub.' : 'Your location is used to find the nearest delivery jobs.'}</Text>
          <Button title="Use my current location" variant="outline" onPress={saveLocation} />
        </Card>
      )}

      <Button title={t('logout')} variant="danger" onPress={() => setConfirmLogout(true)} />
      <Sheet title={t('logout')} visible={confirmLogout} onClose={() => { if (!loggingOut) setConfirmLogout(false); }}>
        <Card style={{ borderColor: colors.border }}>
          <Text style={s.h3}>Are you sure you want to log out?</Text>
          <Text style={s.muted}>You will need to log in again to access your account.</Text>
          <View style={{ gap: 8, marginTop: 8 }}>
            <Button title={t('logout')} variant="danger" onPress={confirmAndLogout} loading={loggingOut} />
            <Button title="Cancel" variant="outline" onPress={() => setConfirmLogout(false)} disabled={loggingOut} />
          </View>
        </Card>
      </Sheet>
      <LegalLinks />
    </Screen>
  );
}
