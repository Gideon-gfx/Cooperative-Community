import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { Linking, Platform } from 'react-native';
import { api } from '../api/client';

const PUSH_TOKEN_KEY = 'ajo_expo_push_token';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

export async function registerIosPushNotifications(): Promise<string | null> {
  if (Platform.OS !== 'ios') throw new Error('Push notifications are currently available in the iOS app only.');

  const projectId = Constants.expoConfig?.extra?.eas?.projectId;
  if (!projectId) throw new Error('This app is not linked to an EAS project yet. Run `npx eas-cli init` in ajo-mobile first.');

  let permission = await Notifications.getPermissionsAsync();
  if (!permission.granted) permission = await Notifications.requestPermissionsAsync();
  if (!permission.granted) {
    if (!permission.canAskAgain) await Linking.openSettings();
    return null;
  }

  const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  const previousToken = await SecureStore.getItemAsync(PUSH_TOKEN_KEY);
  if (previousToken && previousToken !== token) {
    try {
      await api.delete('/push/token', { data: { token: previousToken } });
    } catch (error) {
      console.error('[notifications] Could not remove the previous push token:', error instanceof Error ? error.message : error);
    }
  }

  await api.post('/push/token', { token });
  await SecureStore.setItemAsync(PUSH_TOKEN_KEY, token);
  return token;
}

export async function unregisterPushNotifications(): Promise<void> {
  const token = await SecureStore.getItemAsync(PUSH_TOKEN_KEY);
  if (!token) return;

  try {
    await api.delete('/push/token', { data: { token } });
  } catch (error) {
    console.error('[notifications] Could not unregister the push token:', error instanceof Error ? error.message : error);
  } finally {
    await SecureStore.deleteItemAsync(PUSH_TOKEN_KEY);
  }
}
