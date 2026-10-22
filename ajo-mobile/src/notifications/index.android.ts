import type { MaybeNotificationResponse } from 'expo-notifications';

// Push notifications are iOS-only; avoid loading unavailable native notification modules in Expo Go on Android.
export function useLastNotificationResponse(): MaybeNotificationResponse {
  return null;
}

export async function clearLastNotificationResponseAsync(): Promise<void> {}
