import { forwardRef, useContext, useImperativeHandle, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View, type GestureResponderEvent } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { captureRef } from 'react-native-view-shot';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, uploadFile } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { LANGS, type Lang } from '../i18n';
import { colors, fonts, TAP } from '../theme';
import { Card, ScrollLockContext, s } from './ui';
import { ReadAloud } from './widgets';

// ── Shared types ──────────────────────────────────────────────────────────────
export interface Party { id: string; name: string }
export interface Milestone { id: string; order: number; title: string; description: string | null; dueDate: string; status: string; submissionNote: string | null; evidenceUrl: string | null; reviewNote: string | null }
export interface Contract {
  id: string; status: string; statusReason: string | null; tradeCategory: string; durationMonths: number; groupId: string; startDate: string | null; endDate: string | null; pausedDays: number;
  monthlyContribution: string | number; targetSettlement: string | number; monthlyStipend: string | number | null; totalPlannedContributions: number | string; termsAndConditions: string; guardianRequired: boolean;
  parties: { master: Party | null; apprentice: Party | null; guarantor: Party | null; guardian: Party | null };
  myRole: string | null; signatures: { role: string; typedName: string; signedAt: string }[]; waitingFor: string[]; milestones: Milestone[];
}

export const useMyContracts = () => useQuery({ queryKey: ['contracts-mine'], queryFn: async () => (await api.get<{ contracts: Contract[] }>('/contracts/mine')).data.contracts });

// ── Green / Yellow / Red status card (colour is never the only signal: an icon and words go with it) ──
export type Tone = 'green' | 'yellow' | 'red';
const TONE: Record<Tone, { bg: string; edge: string; icon: string }> = {
  green: { bg: '#DCFCE7', edge: colors.green, icon: '🟢' },
  yellow: { bg: '#FEF3C7', edge: colors.gold, icon: '🟡' },
  red: { bg: '#FDE4E1', edge: colors.red, icon: '🔴' },
};
export const toneOfContract = (status: string): Tone => (status === 'ACTIVE' || status === 'GRADUATED' ? 'green' : status === 'TERMINATED' ? 'red' : 'yellow');
export const toneOfDue = (status: string): Tone => (status === 'PAID' ? 'green' : status === 'OVERDUE' ? 'red' : 'yellow');

export function StatusCard({ tone, title, body, onPress, speakText }: { tone: Tone; title: string; body?: string; onPress?: () => void; speakText?: string }) {
  const x = TONE[tone];
  const inner = (
    <Card style={{ backgroundColor: x.bg, borderColor: x.edge, minHeight: TAP }}>
      <View style={[s.row, { alignItems: 'flex-start' }]}>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={s.h3}>{x.icon} {title}</Text>
          {body ? <Text style={s.body}>{body}</Text> : null}
        </View>
        {speakText ? <ReadAloud text={speakText} /> : null}
      </View>
    </Card>
  );
  return onPress ? <Pressable accessibilityRole="button" onPress={onPress}>{inner}</Pressable> : inner;
}

// ── 1–5 faces for the conduct form: no reading needed ──
const FACES = ['😠', '🙁', '😐', '🙂', '😄'];
export function FaceRating({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const { t } = useAuth();
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 6 }}>
      {FACES.map((f, i) => {
        const on = value === i + 1;
        return (
          <Pressable key={f} onPress={() => onChange(i + 1)} accessibilityRole="button" accessibilityLabel={`${i + 1} ${t('ib_outOf5')}`} style={{ flex: 1, minHeight: 56, borderRadius: 14, borderWidth: 2, alignItems: 'center', justifyContent: 'center', borderColor: on ? colors.zobo : colors.border, backgroundColor: on ? colors.primaryLight : colors.white }}>
            <Text style={{ fontSize: 28 }}>{f}</Text>
            <Text style={{ fontSize: 11, fontFamily: fonts.mono, color: colors.muted }}>{i + 1}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ── Progress ring ──
export function ProgressRing({ value, max, size = 96, label }: { value: number; max: number; size?: number; label?: string }) {
  const stroke = 10, r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const pct = max <= 0 ? 0 : Math.max(0, Math.min(1, value / max));
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={{ position: 'absolute' }}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke="#F0E2CC" strokeWidth={stroke} fill="none" />
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={colors.green} strokeWidth={stroke} fill="none" strokeDasharray={`${c * pct} ${c}`} strokeLinecap="round" rotation={-90} origin={`${size / 2}, ${size / 2}`} />
      </Svg>
      <Text style={{ fontFamily: fonts.mono, fontSize: 18, color: colors.text }}>{value}/{max}</Text>
      {label ? <Text style={{ fontFamily: fonts.body, fontSize: 11, color: colors.muted }}>{label}</Text> : null}
    </View>
  );
}

// ── Trust tier: a tier word and colour, never a number, for anyone but the person and the board ──
const TIER_STYLE: Record<string, [string, string]> = {
  EXEMPLARY: ['#DCFCE7', '#166534'], HIGH_TRUST: ['#DCFCE7', '#166534'], FAIR: ['#FEF3C7', '#854D0E'], AT_RISK: ['#FFEDD5', '#9A3412'], CRITICAL: ['#FEE2E2', '#B91C1C'], UNRATED: ['#E5E7EB', '#374151'],
};
export function TierBadge({ tier }: { tier: string }) {
  const { t } = useAuth();
  const [bg, fg] = TIER_STYLE[tier] ?? TIER_STYLE.UNRATED;
  return <View style={{ alignSelf: 'flex-start', backgroundColor: bg, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, minHeight: 32 }}><Text style={{ color: fg, fontFamily: fonts.bodyBold, fontSize: 14 }}>{t(`ib_tier_${tier}`)}</Text></View>;
}

// ── Language toggle: the whole interface follows it, one language at a time ──
export function LangToggle({ langs = ['EN', 'PCM', 'YO'] as Lang[] }: { langs?: Lang[] }) {
  const { user, lang, setGuestLang, updateUser } = useAuth();
  const choose = async (l: Lang) => {
    if (!user) return setGuestLang(l);
    try { const { data } = await api.post('/auth/update-profile', { preferredLanguage: l }); await updateUser(data.user); } catch { await updateUser({ preferredLanguage: l }); }
  };
  return (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      {LANGS.filter((l) => langs.includes(l.code)).map((l) => {
        const on = l.code === lang;
        return (
          <Pressable key={l.code} onPress={() => choose(l.code)} accessibilityRole="button" accessibilityState={{ selected: on }} style={{ minHeight: TAP, minWidth: TAP, paddingHorizontal: 14, borderRadius: 12, borderWidth: 2, alignItems: 'center', justifyContent: 'center', borderColor: on ? colors.zobo : colors.border, backgroundColor: on ? colors.zobo : colors.white }}>
            <Text style={{ fontFamily: fonts.bodyBold, fontSize: 15, color: on ? colors.white : colors.text }}>{l.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ── Mode badge with the group's wording in the viewer's language ──
export function ModeLabel({ mode }: { mode?: string }) {
  const { t } = useAuth();
  if (!mode) return null;
  const escrow = mode === 'ESCROW';
  return (
    <View style={{ alignSelf: 'flex-start', backgroundColor: escrow ? '#DCFCE7' : colors.accentLight, borderColor: escrow ? colors.green : colors.gold, borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, minHeight: 32, justifyContent: 'center' }}>
      <Text style={{ color: escrow ? '#166534' : '#92400E', fontFamily: fonts.bodyBold, fontSize: 13 }}>{escrow ? '🛡️ ' : '🤝 '}{t(escrow ? 'ib_modeEscrow' : 'ib_modeCustody')}</Text>
    </View>
  );
}

// ── Read-only banner for an organiser whose plan has lapsed: nothing already recorded is hidden or locked ──
export function ReadOnlyBanner() {
  const { t, user } = useAuth();
  const organizer = user?.role === 'COLLECTOR' || user?.role === 'FACILITATOR' || user?.role === 'ADMIN';
  const q = useQuery({ enabled: organizer, queryKey: ['billing-me'], queryFn: async () => (await api.get<{ organizer: { newCyclesBlocked: boolean; reason: string | null } }>('/billing/me')).data });
  if (!organizer || !q.data?.organizer.newCyclesBlocked) return null;
  return <StatusCard tone="yellow" title={t('ib_readOnlyTitle')} body={t(q.data.organizer.reason === 'COMMISSION_OVERDUE' ? 'ib_readOnlyCommission' : 'ib_readOnlyPlan')} speakText={t('ib_readOnlyTitle')} />;
}

// ── Signature pad: finger-drawn, saved as a PNG and uploaded; the caller gets a URL ──
export interface SignaturePadHandle { save: () => Promise<string | null>; clear: () => void; isEmpty: () => boolean }
export const SignaturePad = forwardRef<SignaturePadHandle, { height?: number; onInk?: (hasInk: boolean) => void }>(function SignaturePad({ height = 180, onInk }, ref) {
  const { t } = useAuth();
  const [paths, setPaths] = useState<string[]>([]);
  const current = useRef('');
  const box = useRef<View>(null);
  const [live, setLive] = useState('');
  const set = (next: string[]) => { setPaths(next); onInk?.(next.length > 0); };
  const lock = useContext(ScrollLockContext);
  const grant = (e: GestureResponderEvent) => { current.current = `M${e.nativeEvent.locationX.toFixed(1)},${e.nativeEvent.locationY.toFixed(1)}`; setLive(current.current); };
  const move = (e: GestureResponderEvent) => { current.current += ` L${e.nativeEvent.locationX.toFixed(1)},${e.nativeEvent.locationY.toFixed(1)}`; setLive(current.current); };
  const release = () => {
    const done = current.current; current.current = ''; setLive('');
    if (done.includes('L')) set([...paths, done]);
    lock(false);
  };
  useImperativeHandle(ref, () => ({
    isEmpty: () => paths.length === 0,
    clear: () => set([]),
    save: async () => {
      if (!box.current || paths.length === 0) return null;
      const uri = await captureRef(box, { format: 'png', quality: 1 });
      return uploadFile({ uri, name: `signature-${Date.now()}.png`, type: 'image/png' });
    },
  }), [paths]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <View style={{ gap: 8 }}>
      <View ref={box} collapsable={false} style={{ height, borderRadius: 14, borderWidth: 2, borderColor: colors.cocoa, backgroundColor: colors.white, overflow: 'hidden' }}>
        <Svg width="100%" height="100%" pointerEvents="none">
          {paths.map((d, i) => <Path key={i} d={d} stroke={colors.cocoa} strokeWidth={3} fill="none" strokeLinecap="round" strokeLinejoin="round" />)}
          {live ? <Path d={live} stroke={colors.cocoa} strokeWidth={3} fill="none" strokeLinecap="round" strokeLinejoin="round" /> : null}
        </Svg>
        {paths.length === 0 && !live ? <Text pointerEvents="none" style={{ position: 'absolute', alignSelf: 'center', top: height / 2 - 10, color: colors.muted, fontFamily: fonts.body }}>{t('ib_signHere')}</Text> : null}
        {/* A transparent layer on top takes every touch, so the coordinates are always relative to the board, and the page does not scroll under the finger. */}
        <View
          style={StyleSheet.absoluteFill}
          onTouchStart={() => lock(true)}
          onTouchEnd={() => lock(false)}
          onTouchCancel={() => lock(false)}
          onStartShouldSetResponder={() => true}
          onMoveShouldSetResponder={() => true}
          onResponderTerminationRequest={() => false}
          onResponderGrant={grant}
          onResponderMove={move}
          onResponderRelease={release}
          onResponderTerminate={release}
        />
      </View>
      <Pressable onPress={() => set([])} accessibilityRole="button" style={{ minHeight: TAP, alignSelf: 'flex-start', justifyContent: 'center', paddingHorizontal: 8 }}><Text style={{ color: colors.clay, fontFamily: fonts.bodyBold, fontSize: 16 }}>{t('ib_clearSignature')}</Text></Pressable>
    </View>
  );
});

/** Refresh everything the module shows after a change. */
export function useRefreshModule() {
  const qc = useQueryClient();
  return () => Promise.all(['contracts-mine', 'contract', 'fund', 'trust-me', 'trust-board', 'billing-me', 'conduct'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
}
