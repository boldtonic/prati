/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        bg:     '#08080a',
        s0:     '#0d1117',
        s1:     '#111827',
        s2:     '#161d2b',
        bd:     '#1e2d45',
        b2:     '#0e1623',
        t1:     '#e2e8f0',
        t2:     '#64748b',
        t3:     '#334155',
        green:  '#22c55e',
        red:    '#ef4444',
        amber:  '#f59e0b',
        blue:   '#38bdf8',
        purple: '#818cf8',
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', "'SF Pro Text'", 'system-ui', 'sans-serif'],
        mono: ["'SF Mono'", "'Cascadia Code'", 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
}
