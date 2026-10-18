import * as ImagePicker from 'expo-image-picker';

export interface PickedFile { uri: string; name: string; type: string }

/** Opens the photo library; resolves null if cancelled or permission denied. */
export async function pickImage(): Promise<PickedFile | null> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) return null;
  const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.7 });
  if (res.canceled) return null;
  const a = res.assets[0];
  return { uri: a.uri, name: a.fileName ?? `proof-${Date.now()}.jpg`, type: a.mimeType ?? 'image/jpeg' };
}
