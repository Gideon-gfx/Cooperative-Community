import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { API_URL, getToken } from './api/client';

/** Downloads a protected file (PDF, CSV) with the signed-in token, then opens the phone's share sheet so it can be saved or sent. */
export async function downloadAndShare(path: string, filename: string, mimeType: string) {
  const file = await File.downloadFileAsync(`${API_URL}${path}`, new File(Paths.cache, filename), { headers: { Authorization: `Bearer ${getToken() ?? ''}` }, idempotent: true });
  if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file.uri, { mimeType });
  return file;
}
