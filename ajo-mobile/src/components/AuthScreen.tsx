import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { Alert } from './feedback';
import { api, errMsg } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Button, Card, LinkText, Screen, s } from './ui';
import { LegalLinks } from './LegalLinks';
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
  const [role, setRole] = useState<string>('MEMBER');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [fullName, setFullName] = useState('');
  const [busy, setBusy] = useState(false);
  const [country, setCountry] = useState<'NG' | 'GH' | 'KE'>('NG');
  const [referral, setReferral] = useState('');
  const { login } = useAuth();
  const router = useRouter();

  const withLoader = useLoader();
  const passwordStrengthScore = [
    password.length >= 8,
    password.length >= 12,
    /[a-z]/.test(password) && /[A-Z]/.test(password),
    /[0-9]/.test(password) && /[^a-zA-Z0-9]/.test(password),
  ].filter(Boolean).length;
  const passwordStrength = [
    { label: 'Weak', color: colors.red },
    { label: 'Fair', color: colors.clay },
    { label: 'Good', color: colors.cocoaNight2 },
    { label: 'Strong', color: colors.green },
  ][Math.max(passwordStrengthScore - 1, 0)];
  // The blurred loader covers the request; a failure is shown only after it has cleared.
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    let failure: unknown;
    try { await withLoader(async () => { try { await fn(); } catch (e) { failure = e; } }); } finally { setBusy(false); }
    if (failure) Alert.alert('Error', errMsg(failure));
  };

  const submitEmail = () => run(async () => {
    const path = isSignup ? '/auth/register' : '/auth/login-email';
    const body = isSignup
      ? { email: email.trim(), password, fullName: fullName.trim(), phoneNumber: phone.trim(), role, country, ...(referral.trim() ? { referralCode: referral.trim() } : {}) }
      : { email: email.trim(), password };
    const { data } = await api.post(path, body);
    await login(data.token, data.user);
    router.replace('/dashboard');
  });

  return (
    <Screen keyboardAvoiding>
      <Text style={[s.h1, { color: colors.primary, textAlign: 'center' }]}>ÀJỌ</Text>
      <Text style={[s.h2, { textAlign: 'center' }]}>{isSignup ? 'Create your account' : 'Log in'}</Text>
      <Card style={{ gap: 12 }}>
        <>
            {isSignup && <Field label="Full name" value={fullName} onChangeText={setFullName} />}
            <Field label="Email address" value={email} onChangeText={setEmail} keyboardType="email-address" placeholder="you@gmail.com" />
            <View style={{ gap: 4 }}>
              <Text style={[s.body, { fontWeight: '600' }]}>Password</Text>
              <View style={{ position: 'relative', justifyContent: 'center' }}>
                <TextInput
                  style={[s.input, { paddingRight: 54 }]}
                  value={password}
                  onChangeText={setPassword}
                  secureTextEntry={!showPassword}
                  maxLength={128}
                  autoCapitalize="none"
                  autoCorrect={false}
                  textContentType={isSignup ? 'newPassword' : 'password'}
                  autoComplete={isSignup ? 'new-password' : 'current-password'}
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
                  onPress={() => setShowPassword((visible) => !visible)}
                  style={{ position: 'absolute', right: 4, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
                  hitSlop={4}
                >
                  <Ionicons name={showPassword ? 'eye-off-outline' : 'eye-outline'} size={22} color={colors.muted} />
                </Pressable>
              </View>
            </View>
            {isSignup && password.length > 0 && (
              <View accessibilityLabel={`Password strength: ${passwordStrength.label}`} style={{ gap: 4 }}>
                <View style={{ flexDirection: 'row', gap: 4 }}>
                  {[0, 1, 2, 3].map((segment) => (
                    <View key={segment} style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: segment < passwordStrengthScore ? passwordStrength.color : colors.border }} />
                  ))}
                </View>
                <Text style={[s.muted, { color: passwordStrength.color }]}>Password strength: {passwordStrength.label}</Text>
              </View>
            )}
            {!isSignup && (
              <LinkText align="right" compact onPress={() => router.push('/forgot-password')}>Forgot password?</LinkText>
            )}
            {isSignup && (
              <>
                <Dropdown label="Country" value={country} onChange={setCountry} options={[...COUNTRIES]} />
                <PhoneField label="Phone number" dial={DIAL[country]} value={phone} onChangeText={setPhone} placeholder="803 123 4567" />
                <Dropdown label="I am a…" value={role} onChange={setRole} options={[...ROLES]} />
                <Field label="Referral code (optional)" value={referral} onChangeText={(v) => setReferral(v.toUpperCase())} placeholder="AJO-XXXXXX" maxLength={20} />
                {role === 'COLLECTOR' && <Text style={s.muted}>Collector accounts must be approved by the platform before creating groups.</Text>}
                <Text style={s.muted}>No SMS verification code is needed.</Text>
              </>
            )}
            <Button
              title={isSignup ? 'Create account' : 'Log in'}
              onPress={submitEmail}
              loading={busy}
              disabled={!email.trim() || !password || (isSignup && (fullName.trim().length < 2 || password.length < 8 || phone.replace(/\D/g, '').length < 7))}
            />
        </>
      </Card>
      <LinkText onPress={() => router.push(isSignup ? '/login' : '/signup')}>{isSignup ? 'Already have an account? Log in' : "Don't have an account? Create one"}</LinkText>
      <LegalLinks />
    </Screen>
  );
}
