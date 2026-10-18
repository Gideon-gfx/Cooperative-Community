import { useState } from 'react';
import { Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Alert } from './feedback';
import { api, errMsg } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Button, Card, LinkText, Screen, s } from './ui';
import { useLoader } from './GlobalLoader';
import { Dropdown, Field, PhoneField } from './widgets';
import { colors } from '../theme';

const ROLES = [
  { value: 'MEMBER', label: 'Member' },
  { value: 'COLLECTOR', label: 'Collector' },
  { value: 'TRANSPORTER', label: 'Transporter' },
] as const;

const COUNTRIES = [{ value: 'NG', label: '🇳🇬 Nigeria' }, { value: 'GH', label: '🇬🇭 Ghana' }, { value: 'KE', label: '🇰🇪 Kenya' }] as const;
const DIAL = { NG: '+234', GH: '+233', KE: '+254' } as const;

type AuthFlow = 'login' | 'signup';

export function AuthScreen({ flow }: { flow: AuthFlow }) {
  const isSignup = flow === 'signup';
  const [mode, setMode] = useState<'otp' | 'pin' | 'email'>(isSignup ? 'otp' : 'pin');
  const [role, setRole] = useState<string>('MEMBER');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [sentTo, setSentTo] = useState(false);
  const [otp, setOtp] = useState('');
  const [fullName, setFullName] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [country, setCountry] = useState<'NG' | 'GH' | 'KE'>('NG');
  const [referral, setReferral] = useState('');
  const { login } = useAuth();
  const router = useRouter();

  const withLoader = useLoader();
  // The blurred loader covers the request; a failure is shown only after it has cleared.
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    let failure: unknown;
    try { await withLoader(async () => { try { await fn(); } catch (e) { failure = e; } }); } finally { setBusy(false); }
    if (failure) Alert.alert('Error', errMsg(failure));
  };

  const requestOtp = () => run(async () => {
    await api.post('/auth/request-otp', { phoneNumber: phone, country });
    setSentTo(true);
  });
  const verify = () => run(async () => {
    const body = isSignup
      ? { phoneNumber: phone, country, otp, fullName: fullName.trim(), role, ...(referral.trim() ? { referralCode: referral.trim() } : {}) }
      : { phoneNumber: phone, country, otp };
    const { data } = await api.post('/auth/verify-otp', body);
    await login(data.token, data.user);
    router.replace('/dashboard');
  });
  const loginPin = () => run(async () => {
    const { data } = await api.post('/auth/login-pin', { phoneNumber: phone, country, pin });
    await login(data.token, data.user);
    router.replace(data.mustChangePin ? { pathname: '/settings', params: { mustChange: '1' } } : '/dashboard');
  });
  const submitEmail = () => run(async () => {
    const path = isSignup ? '/auth/register' : '/auth/login-email';
    const body = isSignup
      ? { email: email.trim(), password, fullName: fullName.trim(), role, country, ...(referral.trim() ? { referralCode: referral.trim() } : {}) }
      : { email: email.trim(), password };
    const { data } = await api.post(path, body);
    await login(data.token, data.user);
    router.replace('/dashboard');
  });

  return (
    <Screen>
      <Text style={[s.h1, { color: colors.primary, textAlign: 'center' }]}>ÀJỌ</Text>
      <Text style={[s.h2, { textAlign: 'center' }]}>{isSignup ? 'Create your account' : 'Log in'}</Text>
      <Card style={{ gap: 12 }}>
        {mode === 'email' ? (
          <>
            {isSignup && <Field label="Full name" value={fullName} onChangeText={setFullName} />}
            <Field label="Email address" value={email} onChangeText={setEmail} keyboardType="email-address" placeholder="you@gmail.com" />
            <Field label="Password" value={password} onChangeText={setPassword} secure maxLength={128} />
            {!isSignup && (
              <LinkText align="right" compact onPress={() => router.push('/forgot-password')}>Forgot password?</LinkText>
            )}
            {isSignup && (
              <>
                <Text style={s.muted}>Use at least 8 characters for your password.</Text>
                <Dropdown label="Country" value={country} onChange={setCountry} options={[...COUNTRIES]} />
                <Dropdown label="I am a…" value={role} onChange={setRole} options={[...ROLES]} />
                <Field label="Referral code (optional)" value={referral} onChangeText={(v) => setReferral(v.toUpperCase())} placeholder="AJO-XXXXXX" maxLength={20} />
                {role === 'COLLECTOR' && <Text style={s.muted}>Collector accounts must be approved by the platform before creating groups.</Text>}
                <Text style={s.muted}>You can use the app without a phone number. Phone-based SMS and USSD features require one.</Text>
              </>
            )}
            <Button
              title={isSignup ? 'Create account' : 'Log in'}
              onPress={submitEmail}
              loading={busy}
              disabled={!email.trim() || !password || (isSignup && (fullName.trim().length < 2 || password.length < 8))}
            />
            {!isSignup && <LinkText onPress={() => setMode('pin')}>Use phone number instead</LinkText>}
          </>
        ) : mode === 'pin' ? (
          <>
            <Dropdown label="Country" value={country} onChange={setCountry} options={[...COUNTRIES]} />
            <PhoneField label="Phone number" dial={DIAL[country]} value={phone} onChangeText={setPhone} placeholder="803 123 4567" />
            <Field label="PIN" value={pin} onChangeText={setPin} keyboardType="number-pad" secure maxLength={4} />
            <LinkText align="right" compact onPress={() => { setMode('otp'); setSentTo(false); }}>Forgot PIN? Use SMS code</LinkText>
            <Button title="Log in" onPress={loginPin} loading={busy} disabled={pin.length !== 4 || phone.replace(/\D/g, '').length < 7} />
            <LinkText onPress={() => setMode('email')}>I used an email account</LinkText>
          </>
        ) : (
          <>
            {isSignup && <Field label="Full name" value={fullName} onChangeText={setFullName} />}
            {isSignup && <Dropdown label="Country" value={country} onChange={setCountry} options={[...COUNTRIES]} />}
            <PhoneField label="Phone number" dial={DIAL[country]} value={phone} onChangeText={setPhone} placeholder="803 123 4567" />
            {isSignup && !sentTo && (
              <>
                <Dropdown label="I am a…" value={role} onChange={setRole} options={[...ROLES]} />
                <Field label="Referral code (optional)" value={referral} onChangeText={(v) => setReferral(v.toUpperCase())} placeholder="AJO-XXXXXX" maxLength={20} />
                {role === 'COLLECTOR' && <Text style={s.muted}>Collector accounts must be approved by the platform before creating groups.</Text>}
              </>
            )}

            {!sentTo ? (
              <Button title="Send code" onPress={requestOtp} loading={busy} disabled={phone.replace(/\D/g, '').length < 7 || (isSignup && fullName.trim().length < 2)} />
            ) : (
              <View style={{ gap: 12 }}>
                <Field label="6-digit code" value={otp} onChangeText={setOtp} keyboardType="number-pad" maxLength={6} />
                <Button title={isSignup ? 'Create account' : 'Verify & continue'} onPress={verify} loading={busy} disabled={otp.length !== 6 || (isSignup && fullName.trim().length < 2)} />
                <Button title="Use a different number" variant="outline" onPress={() => { setSentTo(false); setOtp(''); }} />
              </View>
            )}
          </>
        )}
        {isSignup && <LinkText onPress={() => { setMode(mode === 'email' ? 'otp' : 'email'); setSentTo(false); }}>{mode === 'email' ? 'Use phone number instead' : 'Use email instead'}</LinkText>}
      </Card>
      <LinkText onPress={() => router.push(isSignup ? '/login' : '/signup')}>{isSignup ? 'Already have an account? Log in' : "Don't have an account? Create one"}</LinkText>
    </Screen>
  );
}
