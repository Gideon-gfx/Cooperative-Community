import { useMemo, useRef, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { Alert } from '../../components/feedback';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { api, errMsg } from '../../api/client';
import { useAuth } from '../../auth/AuthContext';
import { speak, stopSpeaking } from '../../speech';
import { Button, Card, Loading, Screen, s } from '../../components/ui';
import { Chips, Field } from '../../components/widgets';
import { LangToggle, SignaturePad, StatusCard, useRefreshModule, type SignaturePadHandle } from '../../components/igba';
import { colors, fonts, TAP } from '../../theme';
import type { Lang } from '../../i18n';

interface LangItem { code: string; name: string; native: string; witnessRecommended: boolean; readAloudLikely: boolean }
interface Question { q: string; options: string[] }
interface View_ {
  documentId: string; title: string; version: number; language: { code: string; label: string; custom?: boolean };
  original: { body: string; sha256: string }; shown: { documentId: string; body: string; sha256: string; translationStatus: string } | null;
  banner: string | null; witnessRecommended: boolean; witnessRequired: boolean; needsComprehension: boolean;
  audio: { supported: boolean; script: string; message: string | null }; demo: { watermark: string } | null;
  ui: { viewOriginal: string; sideBySide: string; listen: string; witnessNote: string; witnessRequired: string; questionsTitle: string; questions: Question[]; signButton: string; typedNameLabel: string; otpLabel: string; witnessTitle: string; witnessExplained: string; thankYou: string; draftBanner: string };
}
const APP_TO_CODE: Record<Lang, string> = { EN: 'en', PCM: 'pcm', YO: 'yo', HA: 'ha', IG: 'ig' };
// Markdown to plain reading text.
const plain = (md: string) => md.replace(/^#+\s*/gm, '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/^[-*]\s+/gm, '• ');

// Consent and disclaimers. The English original is what is signed; a translation only helps people understand. The page text itself comes in the language chosen here.
export default function Consent() {
  const { type, groupId } = useLocalSearchParams<{ type: string; groupId?: string }>();
  const { t, lang, user } = useAuth();
  const router = useRouter();
  const refresh = useRefreshModule();
  const pad = useRef<SignaturePadHandle>(null);
  const [code, setCode] = useState(APP_TO_CODE[lang]);
  const [custom, setCustom] = useState('');
  const [picking, setPicking] = useState(false);
  const [search, setSearch] = useState('');
  const [view, setView] = useState<'translated' | 'original' | 'both'>('translated');
  const [answers, setAnswers] = useState<(number | undefined)[]>([]);
  const [name, setName] = useState(user?.fullName ?? '');
  const [method, setMethod] = useState<'DRAW' | 'OTP' | 'WITNESS'>('DRAW');
  const [ink, setInk] = useState(false);
  const [otp, setOtp] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [wName, setWName] = useState(''); const [wPhone, setWPhone] = useState(''); const [wSig, setWSig] = useState(''); const [wExplained, setWExplained] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const langs = useQuery({ queryKey: ['consent-langs'], queryFn: async () => (await api.get<{ languages: LangItem[] }>('/consent/languages')).data.languages });
  const doc = useQuery({
    queryKey: ['consent-doc', type, code, custom],
    queryFn: async () => (await api.get<View_>('/consent/document', { params: { type, ...(custom ? { language: custom, languageLabel: custom } : { language: code }) } })).data,
  });
  const filtered = useMemo(() => (langs.data ?? []).filter((l) => `${l.name} ${l.native}`.toLowerCase().includes(search.toLowerCase())), [langs.data, search]);

  if (doc.isLoading && !doc.data) return <Loading />;
  const d = doc.data;
  if (!d) return <Screen><StatusCard tone="red" title={t('ib_error')} body={errMsg(doc.error)} /></Screen>;
  const ui = d.ui;
  const witnessMode = d.witnessRequired || method === 'WITNESS';
  const questionsOk = !d.needsComprehension || (answers.length === ui.questions.length && ui.questions.every((_, i) => answers[i] !== undefined));
  const translated = d.language.code !== 'en' && d.shown && d.shown.documentId !== d.documentId;
  const body = d.shown ? plain(d.shown.body) : '';
  const signOk = name.trim().length >= 2 && questionsOk && (witnessMode ? wName.trim().length >= 2 && wPhone.length >= 6 && wSig.trim().length >= 2 && wExplained : method === 'DRAW' ? ink : /^\d{6}$/.test(otp));

  const sendOtp = async () => { try { await api.post('/consent/otp'); setOtpSent(true); } catch (e) { Alert.alert(t('ib_error'), errMsg(e)); } };
  const sign = async () => {
    setBusy(true);
    try {
      let signatureImageUrl: string | undefined;
      if (!witnessMode && method === 'DRAW') { signatureImageUrl = (await pad.current?.save()) ?? undefined; if (!signatureImageUrl) throw new Error(t('ib_drawFirst')); }
      await api.post('/consent/sign', {
        type, documentId: d.documentId, ...(groupId ? { groupId } : {}), ...(custom ? { language: custom, languageLabel: custom } : { language: d.language.code }), ...(translated ? { translationHash: d.shown!.sha256 } : {}),
        typedName: name.trim(), ...(signatureImageUrl ? { signatureImageUrl } : {}), ...(!witnessMode && method === 'OTP' ? { otp } : {}),
        ...(d.needsComprehension ? { answers: answers as number[] } : {}),
        ...(witnessMode ? { witness: { name: wName.trim(), phone: wPhone.trim(), signature: wSig.trim(), explained: wExplained } } : {}),
      });
      stopSpeaking(); await refresh(); setDone(true);
    } catch (e) { Alert.alert(t('ib_error'), e instanceof Error && !('response' in e) ? e.message : errMsg(e)); } finally { setBusy(false); }
  };

  if (done) return (
    <Screen>
      <StatusCard tone="green" title={ui.thankYou} speakText={ui.thankYou} />
      <Button title={t('ib_done')} onPress={() => router.back()} />
    </Screen>
  );

  return (
    <Screen>
      <LangToggle />
      <Text style={s.h2}>{d.title}</Text>
      {d.demo && <StatusCard tone="yellow" title={d.demo.watermark} body={ui.draftBanner} />}

      <Pressable onPress={() => setPicking(!picking)} style={{ minHeight: TAP, borderRadius: 12, borderWidth: 2, borderColor: colors.zobo, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Text style={[s.body, { fontFamily: fonts.bodyBold }]}>🌍 {d.language.label}</Text><Text style={s.body}>{picking ? '▲' : '▼'}</Text>
      </Pressable>
      {picking && (
        <Card>
          <TextInput value={search} onChangeText={setSearch} placeholder="🔍" style={s.input} />
          {filtered.map((l) => (
            <Pressable key={l.code} onPress={() => { setCode(l.code); setCustom(''); setPicking(false); setAnswers([]); }} style={{ minHeight: TAP, justifyContent: 'center' }}>
              <Text style={[s.body, l.code === code && !custom && { fontFamily: fonts.bodyBold, color: colors.zobo }]}>{l.native} · {l.name}</Text>
            </Pressable>
          ))}
          <Field label={t('ib_otherLanguage')} value={custom} onChangeText={setCustom} placeholder={t('ib_otherLanguageHint')} />
          {custom.trim().length >= 2 && <Button title={t('ib_useThisLanguage')} variant="outline" onPress={() => { setPicking(false); setAnswers([]); doc.refetch(); }} />}
        </Card>
      )}

      {d.banner && <StatusCard tone="yellow" title={d.banner} />}
      {d.witnessRequired && <StatusCard tone="red" title={ui.witnessRequired} speakText={ui.witnessRequired} />}
      {!d.witnessRequired && d.witnessRecommended && <StatusCard tone="yellow" title={ui.witnessNote} />}

      {translated && (
        <Chips<'translated' | 'original' | 'both'> value={view} onChange={setView} options={[{ value: 'translated', label: d.language.label }, { value: 'original', label: ui.viewOriginal }, { value: 'both', label: ui.sideBySide }]} />
      )}
      {(view !== 'original' || !translated) && !d.witnessRequired && <Card><Text style={s.body}>{body}</Text></Card>}
      {(view !== 'translated' || !translated) && (translated || d.witnessRequired) && <Card><Text style={[s.muted, { marginBottom: 4 }]}>{ui.viewOriginal}</Text><Text style={s.body}>{plain(d.original.body)}</Text></Card>}

      {d.audio.supported
        ? <Button title={`🔊 ${ui.listen}`} variant="outline" onPress={() => speak(d.audio.script, lang)} />
        : d.audio.message && <Text style={s.muted}>🔇 {d.audio.message}</Text>}

      {d.needsComprehension && (
        <Card>
          <Text style={s.h3}>{ui.questionsTitle}</Text>
          {ui.questions.map((q, qi) => (
            <View key={qi} style={{ gap: 8, marginTop: 8 }}>
              <Text style={s.body}>{q.q}</Text>
              {q.options.map((o, oi) => {
                const on = answers[qi] === oi;
                return <Pressable key={oi} onPress={() => setAnswers((a) => { const n = [...a]; n[qi] = oi; return n; })} style={{ minHeight: TAP, borderRadius: 12, borderWidth: 2, paddingHorizontal: 14, justifyContent: 'center', borderColor: on ? colors.zobo : colors.border, backgroundColor: on ? colors.primaryLight : colors.white }}><Text style={s.body}>{on ? '● ' : '○ '}{o}</Text></Pressable>;
              })}
            </View>
          ))}
        </Card>
      )}

      <Field label={ui.typedNameLabel} value={name} onChangeText={setName} />
      {!d.witnessRequired && (
        <Chips<'DRAW' | 'OTP' | 'WITNESS'> value={method} onChange={setMethod} options={[{ value: 'DRAW', label: `✍️ ${t('ib_methodDraw')}` }, { value: 'OTP', label: `📱 ${t('ib_methodOtp')}` }, { value: 'WITNESS', label: `👥 ${ui.witnessTitle}` }]} />
      )}
      {!witnessMode && method === 'DRAW' && <SignaturePad ref={pad} onInk={setInk} />}
      {!witnessMode && method === 'OTP' && (
        <View style={{ gap: 8 }}>
          <Button title={otpSent ? t('ib_resendCode') : t('ib_sendCode')} variant="outline" onPress={sendOtp} />
          <Field label={ui.otpLabel} value={otp} onChangeText={setOtp} keyboardType="number-pad" maxLength={6} />
        </View>
      )}
      {witnessMode && (
        <Card>
          <Text style={s.h3}>{ui.witnessTitle}</Text>
          <Field label={t('ib_witnessName')} value={wName} onChangeText={setWName} />
          <Field label={t('ib_witnessPhone')} value={wPhone} onChangeText={setWPhone} keyboardType="phone-pad" />
          <Field label={t('ib_witnessSignature')} value={wSig} onChangeText={setWSig} />
          <Pressable onPress={() => setWExplained(!wExplained)} style={{ minHeight: TAP, flexDirection: 'row', alignItems: 'center', gap: 10 }}><Text style={{ fontSize: 26 }}>{wExplained ? '☑️' : '⬜'}</Text><Text style={[s.body, { flex: 1 }]}>{ui.witnessExplained}</Text></Pressable>
        </Card>
      )}
      <Button title={ui.signButton} loading={busy} disabled={!signOk || (d.witnessRequired && !wExplained)} onPress={sign} />
    </Screen>
  );
}
