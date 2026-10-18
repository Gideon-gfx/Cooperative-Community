import { useEffect, useState } from 'react';
import { Animated, Easing, View } from 'react-native';
import { colors } from '../theme';

/** Three brand-coloured dots that hop one after another. Bigger and quicker than the stock spinner. */
export function DotsLoader({ size = 14 }: { size?: number }) {
  const [hops] = useState(() => [new Animated.Value(0), new Animated.Value(0), new Animated.Value(0)]);
  useEffect(() => {
    const loops = hops.map((v, i) => Animated.loop(Animated.sequence([
      Animated.delay(i * 90),
      Animated.timing(v, { toValue: 1, duration: 170, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.timing(v, { toValue: 0, duration: 170, easing: Easing.in(Easing.quad), useNativeDriver: true }),
      Animated.delay((2 - i) * 90),
    ])));
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [hops]);
  return (
    <View accessibilityRole="progressbar" style={{ flexDirection: 'row', alignItems: 'center', gap: size * 0.5, height: size * 2.2 }}>
      {hops.map((v, i) => (
        <Animated.View key={i} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: [colors.zobo, colors.orange, colors.gold][i], transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [0, -size * 0.9] }) }, { scale: v.interpolate({ inputRange: [0, 1], outputRange: [1, 1.25] }) }] }} />
      ))}
    </View>
  );
}

