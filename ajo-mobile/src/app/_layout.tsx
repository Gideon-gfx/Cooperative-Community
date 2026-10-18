import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { QueryClient, useQueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister';
import { Image, View } from 'react-native';
import { useFonts } from 'expo-font';
import { Unbounded_700Bold, Unbounded_800ExtraBold } from '@expo-google-fonts/unbounded';
import { PlusJakartaSans_500Medium, PlusJakartaSans_700Bold } from '@expo-google-fonts/plus-jakarta-sans';
import { JetBrainsMono_700Bold } from '@expo-google-fonts/jetbrains-mono';
import { AuthProvider, useAuth } from '../auth/AuthContext';
import { FeedbackHost } from '../components/feedback';
import { LoaderProvider } from '../components/GlobalLoader';
import { OfflineBanner } from '../components/widgets';
import { useOutboxFlusher } from '../offline';
import { colors, fonts } from '../theme';

// Screens are cached on the phone for a day, so schedules and balances still open without network.
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, gcTime: 24 * 3600 * 1000, networkMode: 'offlineFirst' } } });
const persister = createAsyncStoragePersister({ storage: AsyncStorage, key: 'ajo_query_cache_v1' });

// Shown while the saved login and fonts load, so the first thing in the app is the CC-ÀJỌ wordmark.
function BrandSplash() {
  return (
    <View style={{ flex: 1, backgroundColor: colors.cream, alignItems: 'center', justifyContent: 'center' }}>
      <Image source={require('../../assets/splash-logo.jpg')} style={{ width: 320, height: 359 }} resizeMode="contain" />
    </View>
  );
}

function Routes() {
  const { user, ready, t } = useAuth();
  const qc = useQueryClient();
  useOutboxFlusher(!!user, () => qc.invalidateQueries());
  const [fontsReady] = useFonts({ Unbounded_700Bold, Unbounded_800ExtraBold, PlusJakartaSans_500Medium, PlusJakartaSans_700Bold, JetBrainsMono_700Bold });
  if (!ready || !fontsReady) return <BrandSplash />;
  const head = { headerStyle: { backgroundColor: colors.cocoaNight }, headerTintColor: colors.cream, headerTitleStyle: { fontFamily: fonts.display, fontSize: 16 } };
  return (
    <View style={{ flex: 1 }}>
      <OfflineBanner />
      <Stack screenOptions={head}>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="auth" options={{ title: 'Create account' }} />
        <Stack.Screen name="signup" options={{ title: 'Create account' }} />
        <Stack.Screen name="forgot-password" options={{ title: 'Reset password' }} />
        <Stack.Screen name="forgot-pin" options={{ title: 'Reset PIN' }} />
        <Stack.Screen name="login" options={{ title: 'Log in' }} />
        <Stack.Protected guard={!!user}>
          <Stack.Screen name="dashboard" options={{ headerShown: false }} />
          <Stack.Screen name="settings" options={{ title: t('settings') }} />
          <Stack.Screen name="collector" options={{ title: t('collectorTools') }} />
          <Stack.Screen name="disputes" options={{ title: t('disputes') }} />
          <Stack.Screen name="jobs" options={{ title: 'Delivery jobs' }} />
          <Stack.Screen name="supplier" options={{ title: 'Supplier' }} />
          <Stack.Screen name="groups/[id]/index" options={{ title: 'Group' }} />
          <Stack.Screen name="groups/[id]/members" options={{ title: 'Members' }} />
          <Stack.Screen name="ajo/[poolId]/index" options={{ title: t('tabMoney') }} />
          <Stack.Screen name="ajo/[poolId]/ledger" options={{ title: t('ledger') }} />
          <Stack.Screen name="food/[poolId]/index" options={{ title: t('tabFood') }} />
          <Stack.Screen name="food/[poolId]/ledger" options={{ title: t('ledger') }} />
          <Stack.Screen name="campaigns/new" options={{ title: 'Start a contribution' }} />
          <Stack.Screen name="campaigns/[id]/index" options={{ title: t('tabEvents') }} />
          <Stack.Screen name="campaigns/[id]/ledger" options={{ title: t('ledger') }} />
          <Stack.Screen name="igba/index" options={{ title: t('ib_myApprenticeship') }} />
          <Stack.Screen name="igba/new" options={{ title: t('ib_newAgreement') }} />
          <Stack.Screen name="igba/review" options={{ title: t('ib_reviewQueue') }} />
          <Stack.Screen name="igba/[id]/index" options={{ title: t('ib_agreement') }} />
          <Stack.Screen name="igba/[id]/sign" options={{ title: t('ib_signNow') }} />
          <Stack.Screen name="igba/[id]/conduct" options={{ title: t('ib_conduct') }} />
          <Stack.Screen name="igba/[id]/fund" options={{ title: t('ib_settlementFund') }} />
          <Stack.Screen name="trust/index" options={{ title: t('ib_trustBoard') }} />
          <Stack.Screen name="trust/boards" options={{ title: t('ib_boardsTitle') }} />
          <Stack.Screen name="facilitator" options={{ title: t('ib_facilitator') }} />
          <Stack.Screen name="consent/[type]" options={{ title: t('ib_consent') }} />
          <Stack.Screen name="billing" options={{ title: t('ib_billing') }} />
          <Stack.Screen name="fees" options={{ title: t('ib_feePreview') }} />
          <Stack.Screen name="import/index" options={{ title: t('ib_importCenter') }} />
          <Stack.Screen name="import/batch/[id]" options={{ title: t('ib_importReview') }} />
          <Stack.Screen name="import/mine" options={{ title: t('ib_myEntries') }} />
        </Stack.Protected>
      </Stack>
      <FeedbackHost />
    </View>
  );
}

export default function RootLayout() {
  return (
    <PersistQueryClientProvider client={queryClient} persistOptions={{ persister, maxAge: 24 * 3600 * 1000 }}>
      <AuthProvider>
        <StatusBar style="light" />
        <LoaderProvider>
          <Routes />
        </LoaderProvider>
      </AuthProvider>
    </PersistQueryClientProvider>
  );
}
