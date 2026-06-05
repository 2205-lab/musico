/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          primary:   '#080810',
          secondary: '#0f0f1a',
          tertiary:  '#161625',
        },
        surface: {
          DEFAULT: '#1a1a2e',
          hover:   '#1f1f38',
          active:  '#242440',
        },
        purple: {
          50:  '#f5f3ff',
          100: '#ede9fe',
          200: '#ddd6fe',
          300: '#c4b5fd',
          400: '#a78bfa',
          500: '#8b5cf6',
          600: '#7c3aed',
          700: '#6d28d9',
          800: '#5b21b6',
          900: '#4c1d95',
        },
        cyan: {
          400: '#22d3ee',
          500: '#06b6d4',
        },
        amber: {
          400: '#fbbf24',
          500: '#f59e0b',
        },
        rose: {
          400: '#fb7185',
          500: '#f43f5e',
        },
        green: {
          400: '#34d399',
          500: '#10b981',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        display: ['Sora', 'Inter', 'system-ui', 'sans-serif'],
      },
      backgroundImage: {
        'purple-glow': 'radial-gradient(circle at 50% 50%, rgba(139, 92, 246, 0.15), transparent 70%)',
        'gradient-brand': 'linear-gradient(135deg, #8b5cf6 0%, #22d3ee 100%)',
        'gradient-warm':  'linear-gradient(135deg, #8b5cf6 0%, #f59e0b 100%)',
      },
      animation: {
        'fade-in':    'fadeIn 0.3s ease-out',
        'slide-up':   'slideUp 0.4s ease-out',
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'spin-slow':  'spin 8s linear infinite',
        'float':      'float 6s ease-in-out infinite',
        'glow':       'glow 2s ease-in-out infinite alternate',
      },
      keyframes: {
        fadeIn:  { from: { opacity: 0 }, to: { opacity: 1 } },
        slideUp: { from: { opacity: 0, transform: 'translateY(16px)' }, to: { opacity: 1, transform: 'translateY(0)' } },
        float:   { '0%,100%': { transform: 'translateY(0)' }, '50%': { transform: 'translateY(-8px)' } },
        glow:    { from: { boxShadow: '0 0 10px rgba(139,92,246,0.3)' }, to: { boxShadow: '0 0 25px rgba(139,92,246,0.6)' } },
      },
      boxShadow: {
        'glow-purple': '0 0 20px rgba(139, 92, 246, 0.4)',
        'glow-cyan':   '0 0 20px rgba(34, 211, 238, 0.4)',
        'card':        '0 4px 24px rgba(0, 0, 0, 0.4)',
        'card-hover':  '0 8px 32px rgba(0, 0, 0, 0.6)',
      },
    },
  },
  plugins: [],
}
