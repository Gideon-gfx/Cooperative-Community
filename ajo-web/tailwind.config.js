import forms from '@tailwindcss/forms';

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        primary: { DEFAULT: '#1E5631', dark: '#153f23', light: '#e6f0e9' },
        accent: { DEFAULT: '#FFB800', dark: '#d99b00', light: '#fff5d6' },
        warning: '#EF4444',
        background: '#F8F9FA',
      },
      fontSize: { base: ['1.125rem', '1.75rem'] },
      minHeight: { tap: '48px' },
      minWidth: { tap: '48px' },
    },
  },
  plugins: [forms],
};
