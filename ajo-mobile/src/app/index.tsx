import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { LinearGradient } from 'expo-linear-gradient';
import { useAuth } from '../auth/AuthContext';
import { LANGS } from '../i18n';
import { colors, fonts, gradients, TAP } from '../theme';

// Welcome screen: Cocoa Night surface, cream text with Àkàrà Gold accents.
export default function Landing() {
  const { user, lang, setGuestLang, t } = useAuth();
  const router = useRouter();
  const start = () => (user ? router.push('/dashboard') : router.push('/signup'));

  return (
    <View style={{ flex: 1, backgroundColor: colors.cocoaNight }}>
      <StatusBar style="light" />
      <LinearGradient colors={gradients.night} style={StyleSheet.absoluteFill} />
      <ScrollView contentContainerStyle={s.body}>
        <Text style={s.kicker}>CO-OPERATIVE COMMUNITY</Text>

        <Text style={s.title}>CC-<Text style={{ color: colors.orange }}>ÀJỌ</Text></Text>
        <Text style={s.tag}><Text style={s.tagBold}>{t('tagMoney')}</Text></Text>
        <Text style={s.tag}><Text style={s.tagBold}>{t('tagFood')}</Text></Text>

        <Text style={s.label}>{t('chooseLang')}</Text>
        <View style={s.langRow}>
          {LANGS.map((l) => {
            const on = lang === l.code;
            return (
              <Pressable key={l.code} accessibilityRole="button" accessibilityState={{ selected: on }} onPress={() => setGuestLang(l.code)} style={[s.chip, on && { backgroundColor: colors.gold, borderColor: colors.gold }]}>
                <Text style={[s.chipText, { color: on ? colors.cocoa : colors.cream }]}>{l.label}</Text>
              </Pressable>
            );
          })}
        </View>

        <Text style={s.note}>{t('collectorNote')}</Text>
      </ScrollView>

      <View style={s.footer}>
        <Pressable accessibilityRole="button" onPress={start} style={{ borderRadius: 18, overflow: 'hidden' }}>
          <LinearGradient colors={gradients.zobo} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={s.cta}>
            <Text style={s.ctaText}>{user ? t('continue') : t('getStarted')}</Text>
          </LinearGradient>
        </Pressable>
        {!user && (
          <Pressable accessibilityRole="button" onPress={() => router.push('/login')} style={s.ghost}>
            <Text style={s.ghostText}>{t('haveInvite')}</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  body: { padding: 24, paddingTop: 64, gap: 12 },
  kicker: { color: colors.gold, fontFamily: fonts.mono, fontSize: 13, letterSpacing: 2 },
  kickerSub: { color: colors.cream, fontFamily: fonts.mono, fontSize: 12, letterSpacing: 2, opacity: 0.8 },
  title: { color: colors.gold, fontFamily: fonts.displayHeavy, fontSize: 56, marginTop: 24, marginBottom: 8 },
  tag: { color: colors.cream, fontFamily: fonts.body, fontSize: 20, lineHeight: 28 },
  tagBold: { fontFamily: fonts.bodyBold },
  label: { color: colors.cream, fontFamily: fonts.bodyBold, fontSize: 16, marginTop: 28 },
  langRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  chip: { minHeight: TAP, paddingHorizontal: 18, borderRadius: 16, borderWidth: 1.5, borderColor: colors.gold, justifyContent: 'center' },
  chipText: { fontFamily: fonts.bodyBold, fontSize: 16 },
  note: { color: colors.cream, opacity: 0.75, fontFamily: fonts.body, fontSize: 15, lineHeight: 22, marginTop: 24 },
  footer: { padding: 24, paddingBottom: 36, gap: 12 },
  cta: { minHeight: 60, alignItems: 'center', justifyContent: 'center', borderRadius: 18 },
  ctaText: { color: colors.white, fontFamily: fonts.display, fontSize: 18 },
  ghost: { minHeight: 56, borderRadius: 18, borderWidth: 1.5, borderColor: 'rgba(255,244,230,0.4)', alignItems: 'center', justifyContent: 'center' },
  ghostText: { color: colors.cream, fontFamily: fonts.bodyBold, fontSize: 17 },
});
