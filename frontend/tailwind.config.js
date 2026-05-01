/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: '#fffaf0',
        ink: '#2f2a24',
        linen: '#ece7dc',
      },
      boxShadow: {
        page: '0 30px 90px rgba(87, 70, 45, 0.22)',
      },
    },
  },
  plugins: [],
};
