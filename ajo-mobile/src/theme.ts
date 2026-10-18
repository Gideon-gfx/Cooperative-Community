// CC-ÀJỌ brand foundations: palm oil, àkàrà, clay pots, zobo and cocoa.
// Contrast rule: white text only on clay, zobo, cocoa, green, red or indigo. On orange, gold or cream use cocoa.
export const colors = {
  clay: '#C2410C',
  orange: '#F26B1D',
  gold: '#F6B33D',
  zobo: '#9F1D47',
  cocoa: '#2A1712',
  cocoaNight: '#1F120D',
  cocoaNight2: '#4A2618',
  cream: '#FFF4E6',
  green: '#2E8B57',
  red: '#B3261E',
  indigo: '#2B3A8C',
  glow: '#FF8A3D',

  // Semantic aliases used across the screens.
  primary: '#C2410C',
  primaryLight: '#FDE8DA',
  accent: '#F6B33D',
  accentLight: '#FFF0D2',
  warning: '#B3261E',
  background: '#FFF4E6',
  text: '#2A1712',
  muted: '#7A5C50',
  border: '#E8D5C0',
  white: '#FFFFFF',
  card: '#FFFAF3',
};

export const gradients = {
  sunrise: ['#C2410C', '#F26B1D', '#F6B33D'] as const,
  zobo: ['#9F1D47', '#C43D0A'] as const,
  night: ['#1F120D', '#4A2618'] as const,
};

export const fonts = {
  display: 'Unbounded_700Bold',
  displayHeavy: 'Unbounded_800ExtraBold',
  body: 'PlusJakartaSans_500Medium',
  bodyBold: 'PlusJakartaSans_700Bold',
  mono: 'JetBrainsMono_700Bold',
};

export const TAP = 48; // minimum tap target
