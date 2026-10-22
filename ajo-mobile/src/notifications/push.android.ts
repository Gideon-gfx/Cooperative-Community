export async function registerIosPushNotifications(): Promise<string | null> {
  throw new Error('Push notifications are currently available in the iOS app only.');
}

export function unregisterPushNotifications(): Promise<void> {
  return Promise.resolve();
}
