import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, StyleSheet, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { DotsLoader } from './DotsLoader';

const MIN_MS = 2000;
type Run = <T>(fn: () => Promise<T> | T, minMs?: number) => Promise<T>;
const Ctx = createContext<Run>(async (fn) => fn());

/**
 * One loader for the whole app: a blurred screen with the hopping dots in the middle. It stays up for at least two
 * seconds (so it never flashes) and for as long as the request takes on a slow connection. Touches are blocked meanwhile.
 */
export function LoaderProvider({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  const active = useRef(0);
  const [fade] = useState(() => new Animated.Value(0));

  const run = useCallback<Run>(async (fn, minMs = MIN_MS) => {
    active.current += 1;
    if (active.current === 1) { setVisible(true); Animated.timing(fade, { toValue: 1, duration: 180, useNativeDriver: true }).start(); }
    const floor = new Promise((r) => setTimeout(r, minMs));
    try {
      const [result] = await Promise.all([Promise.resolve().then(fn), floor]);
      return result;
    } finally {
      // Wait for the floor even when the request failed, so the error does not pop up mid-blink.
      await floor;
      active.current -= 1;
      if (active.current === 0) Animated.timing(fade, { toValue: 0, duration: 160, useNativeDriver: true }).start(() => { if (active.current === 0) setVisible(false); });
    }
  }, [fade]);

  const value = useMemo(() => run, [run]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {visible && (
        <Animated.View pointerEvents="auto" style={[StyleSheet.absoluteFill, { opacity: fade, zIndex: 9999, elevation: 9999 }]} accessibilityViewIsModal>
          <BlurView intensity={45} tint="light" style={StyleSheet.absoluteFill} />
          <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(255,244,230,0.35)', alignItems: 'center', justifyContent: 'center' }]}>
            <DotsLoader size={20} />
          </View>
        </Animated.View>
      )}
    </Ctx.Provider>
  );
}

/** `const withLoader = useLoader(); await withLoader(() => api.post(...))` */
export const useLoader = () => useContext(Ctx);
