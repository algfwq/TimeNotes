/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        paper: 'rgb(var(--tn-paper) / <alpha-value>)',
        ink: 'rgb(var(--tn-ink) / <alpha-value>)',
        linen: 'rgb(var(--tn-linen) / <alpha-value>)',
      },
      boxShadow: {
        page: 'var(--tn-shadow-page)',
      },
    },
  },
  plugins: [],
};
