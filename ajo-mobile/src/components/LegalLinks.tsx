import { Linking, Pressable, Text, View } from 'react-native';
import { colors, fonts, TAP } from '../theme';

const LINKS = [
  { label: 'Privacy Policy', url: 'https://theccajo.com/privacy-policy' },
  { label: 'Terms of Use', url: 'https://theccajo.com/terms-of-use' },
];

export function LegalLinks() {
  return (
    <View accessibilityLabel="Legal information" style={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 16, paddingVertical: 8 }}>
      {LINKS.map(({ label, url }, index) => (
        <View key={url} style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
          {index > 0 && <Text style={{ color: colors.muted }}>·</Text>}
          <Pressable
            accessibilityRole="link"
            onPress={() => Linking.openURL(url)}
            style={{ minHeight: TAP, justifyContent: 'center' }}
          >
            <Text style={{ color: colors.primary, fontFamily: fonts.bodyBold, fontSize: 13, textDecorationLine: 'underline' }}>
              {label}
            </Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}
