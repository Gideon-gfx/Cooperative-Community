import forms from '@tailwindcss/forms';

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: { DEFAULT: '#C2410C', dark: '#9A3412', light: '#FDE8DA' },
        accent: { DEFAULT: '#F26B1D', dark: '#C2410C', light: '#FFF0D2' },
        background: '#FFF4E6',
        cream: '#FFF4E6',
        card: '#FFFAF3',
        cocoa: { DEFAULT: '#2A1712', night: '#1F120D', muted: '#7A5C50' },
        gold: '#F68330',
        zobo: '#9F1D47',
        leaf: '#2E8B57',
        indigo: '#2B3A8C',
        warning: '#B3261E',
      },
      fontSize: { base: ['1.125rem', '1.75rem'] },
      minHeight: { tap: '48px' },
      minWidth: { tap: '48px' },
    },
  },
  plugins: [forms],
};
