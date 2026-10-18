import { Text, View } from 'react-native';
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../auth/AuthContext';
import { NotificationBell } from '../../components/NotificationBell';
import { colors, fonts } from '../../theme';

// Four tabs, labelled only in the language the user picked.
const TABS = [
  { name: 'index', key: 'tabHome', icon: 'home' },
  { name: 'ajo', key: 'tabMoney', icon: 'wallet' },
  { name: 'food', key: 'tabFood', icon: 'basket' },
  { name: 'events', key: 'tabEvents', icon: 'gift' },
] as const;

// Full app name in the header: "CO-OPERATIVE COMMUNITY" over "CC-ÀJỌ".
function BrandTitle() {
  return (
    <View>
      <Text style={{ color: colors.gold, fontFamily: fonts.mono, fontSize: 10, letterSpacing: 1.5 }}>CO-OPERATIVE COMMUNITY</Text>
      <Text style={{ color: colors.cream, fontFamily: fonts.display, fontSize: 18 }}>CC-ÀJỌ</Text>
    </View>
  );
}

export default function DashboardTabs() {
  const { t: tr } = useAuth();
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.cocoaNight },
        headerTintColor: colors.cream,
        headerTitleStyle: { fontFamily: fonts.display, fontSize: 16 },
        headerRight: () => <NotificationBell />,
        tabBarStyle: { backgroundColor: colors.cream, height: 84, paddingTop: 8, paddingBottom: 10, borderWidth: 1.5, borderBottomWidth: 0, borderColor: colors.cocoa, borderTopLeftRadius: 28, borderTopRightRadius: 28, overflow: 'hidden', shadowColor: colors.cocoa, shadowOpacity: 0.15, shadowRadius: 10, shadowOffset: { width: 0, height: -3 }, elevation: 12 },
        tabBarActiveTintColor: colors.zobo,
        tabBarInactiveTintColor: colors.cocoa,
      }}
    >
      {TABS.map((t) => (
        <Tabs.Screen
          key={t.name}
          name={t.name}
          options={{
            title: t.name === 'index' ? 'CC-ÀJỌ' : tr(t.key),
            ...(t.name === 'index' ? { headerTitle: () => <BrandTitle /> } : {}),
            // Filled burgundy icon on the open tab, outline in cocoa on the others.
            tabBarIcon: ({ color, focused }) => <Ionicons name={focused ? t.icon : (`${t.icon}-outline` as typeof t.icon)} size={26} color={color} />,
            tabBarLabel: ({ color }) => (
              <View style={{ alignItems: 'center' }}>
                <Text style={{ color, fontFamily: fonts.bodyBold, fontSize: 13 }}>{tr(t.key)}</Text>
              </View>
            ),
          }}
        />
      ))}
    </Tabs>
  );
}
