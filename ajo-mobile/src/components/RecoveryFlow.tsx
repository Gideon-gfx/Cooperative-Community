import { useState } from 'react';
import { Modal, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Alert } from './feedback';
import { api, errMsg } from '../api/client';
import { Button, Card, LinkText, ProgressBar, Screen, s } from './ui';
import { useLoader } from './GlobalLoader';
import { Dropdown, Field, PhoneField } from './widgets';
import { colors } from '../theme';

const COUNTRIES = [{ value: 'NG', label: '🇳🇬 Nigeria' }, { value: 'GH', label: '🇬🇭 Ghana' }, { value: 'KE', label: '🇰🇪 Kenya' }] as const;
const DIAL = { NG: '+234', GH: '+233', KE: '+254' } as const;

/**
 * Forgot password (by email) and forgot PIN (by phone) share one three-step flow:
 * 1. say who you are, 2. type the code we sent, 3. choose a new secret twice. A success card then sends you to log in.
 */
export function RecoveryFlow({ kind }: { kind: 'password' | 'pin' }) {
  const isPin = kind === 'pin';
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [email, setEmail] = useState('');
  const [country, setCountry] = useState<'NG' | 'GH' | 'KE'>('NG');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [secret, setSecret] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const who = isPin ? { phoneNumber: phone, country } : { email: email.trim() };
  const withLoader = useLoader();
  // The blurred loader covers the request; a failure is shown only after it has cleared.
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    let failure: unknown;
    try { await withLoader(async () => { try { await fn(); } catch (e) { failure = e; } }); } finally { setBusy(false); }
    if (failure) Alert.alert('Error', errMsg(failure));
  };

  const sendCode = () => run(async () => { await api.post(isPin ? '/auth/forgot-pin' : '/auth/forgot-password', who); setStep(2); });
  const checkCode = () => run(async () => { await api.post('/auth/verify-reset-code', { ...who, code }); setStep(3); });
  const save = () => run(async () => {
    await api.post(isPin ? '/auth/reset-pin' : '/auth/reset-password', isPin ? { ...who, code, newPin: secret } : { ...who, code, newPassword: secret });
    setDone(true);
  });

  const minLen = isPin ? 4 : 8;
  const mismatch = again.length > 0 && secret !== again;
  const canSave = secret.length >= minLen && secret === again;
  const idOk = isPin ? phone.replace(/\D/g, '').length >= 7 : /\S+@\S+\.\S+/.test(email);

  return (
    <Screen keyboardAvoiding>
      <Text style={[s.h1, { color: colors.primary, textAlign: 'center' }]}>ÀJỌ</Text>
      <Text style={[s.h2, { textAlign: 'center' }]}>{isPin ? 'Reset your PIN' : 'Reset your password'}</Text>
      <ProgressBar value={step} max={3} color={colors.green} />
      <Text style={s.muted}>Step {step} of 3</Text>

      <Card style={{ gap: 12 }}>
        {step === 1 && (
          <>
            <Text style={s.body}>{isPin ? 'Enter the phone number on your account. We will text you a code.' : 'Enter the email on your account. We will send you a code.'}</Text>
            {isPin ? (
              <>
                <Dropdown label="Country" value={country} onChange={setCountry} options={[...COUNTRIES]} />
                <PhoneField label="Phone number" dial={DIAL[country]} value={phone} onChangeText={setPhone} placeholder="803 123 4567" />
              </>
            ) : (
              <Field label="Email address" value={email} onChangeText={setEmail} keyboardType="email-address" placeholder="you@gmail.com" />
            )}
            <Button title="Send code" onPress={sendCode} loading={busy} disabled={!idOk} />
          </>
        )}

        {step === 2 && (
          <>
            <Text style={s.body}>{isPin ? `We sent a 6-digit code to ${DIAL[country]} ${phone}.` : `We sent a 6-digit code to ${email.trim()}.`}</Text>
            <Field label="6-digit code" value={code} onChangeText={(v) => setCode(v.replace(/\D/g, ''))} keyboardType="number-pad" maxLength={6} />
            <Button title="Continue" onPress={checkCode} loading={busy} disabled={code.length !== 6} />
            <LinkText onPress={sendCode}>Send the code again</LinkText>
            <LinkText onPress={() => { setStep(1); setCode(''); }}>{isPin ? 'Use a different number' : 'Use a different email'}</LinkText>
          </>
        )}

        {step === 3 && (
          <>
            <Field label={isPin ? 'New PIN (4 digits)' : 'New password'} value={secret} onChangeText={(v) => setSecret(isPin ? v.replace(/\D/g, '') : v)} secure keyboardType={isPin ? 'number-pad' : 'default'} maxLength={isPin ? 4 : 128} />
            <Field label={isPin ? 'Confirm new PIN' : 'Confirm new password'} value={again} onChangeText={(v) => setAgain(isPin ? v.replace(/\D/g, '') : v)} secure keyboardType={isPin ? 'number-pad' : 'default'} maxLength={isPin ? 4 : 128} />
            {!isPin && <Text style={s.muted}>Use at least 8 characters.</Text>}
            {mismatch && <Text style={{ color: colors.red, fontWeight: '700' }}>{isPin ? 'The PINs do not match.' : 'The passwords do not match.'}</Text>}
            <Button title={isPin ? 'Save new PIN' : 'Save new password'} onPress={save} loading={busy} disabled={!canSave} />
          </>
        )}
      </Card>

      <LinkText onPress={() => router.replace('/login')}>Back to log in</LinkText>

      <Modal visible={done} transparent animationType="fade" statusBarTranslucent onRequestClose={() => undefined}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: 24 }}>
          <View style={{ backgroundColor: colors.white, borderRadius: 20, padding: 24, gap: 12, alignItems: 'center' }}>
            <Text style={{ fontSize: 56 }}>✅</Text>
            <Text style={[s.h2, { textAlign: 'center' }]}>{isPin ? 'PIN changed' : 'Password changed'}</Text>
            <Text style={[s.body, { textAlign: 'center' }]}>{isPin ? 'Your PIN has been changed. Log in with your new PIN.' : 'Your password has been changed. Log in with your new password.'}</Text>
            <Button style={{ alignSelf: 'stretch' }} title="OK" onPress={() => { setDone(false); router.replace('/login'); }} />
          </View>
        </View>
      </Modal>
    </Screen>
  );
}
