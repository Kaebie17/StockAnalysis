/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        surface: {
          900: '#0f172a',
          800: '#1e293b',
          700: '#273548',
          600: '#334155',
        },
        accent: {
          cyan:   '#22d3ee',
          green:  '#4ade80',
          red:    '#f87171',
          amber:  '#fbbf24',
          indigo: '#818cf8',
        }
      },
      fontFamily: {
        display: ['"DM Sans"', 'sans-serif'],
        mono:    ['"JetBrains Mono"', 'monospace'],
      }
    }
  },
  plugins: []
}
