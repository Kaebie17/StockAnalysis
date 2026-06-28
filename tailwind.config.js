/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        navy: { 950: '#060b18', 900: '#0f172a', 800: '#1e293b', 700: '#334155' },
        accent: { DEFAULT: '#6366f1', light: '#818cf8', dark: '#4f46e5' },
        bull: '#22c55e',
        bear: '#ef4444',
        neutral: '#f59e0b'
      }
    }
  },
  plugins: []
}
