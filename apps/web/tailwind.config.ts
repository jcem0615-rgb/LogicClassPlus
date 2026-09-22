import type { Config } from 'tailwindcss';

/**
 * Colours are CSS custom properties defined in globals.css, not literals here.
 * One definition drives light, dark and the explicit theme toggle, and nothing
 * in a component can pick a colour that only works in one of them.
 */
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        paper: 'var(--paper)',
        card: 'var(--card)',
        'card-2': 'var(--card-2)',
        sunk: 'var(--sunk)',
        ink: 'var(--ink)',
        'ink-2': 'var(--ink-2)',
        'ink-3': 'var(--ink-3)',
        line: 'var(--line)',
        'line-2': 'var(--line-2)',
        brand: 'var(--brand)',
        'brand-soft': 'var(--brand-soft)',
        'brand-ink': 'var(--brand-ink)',
        'on-brand': 'var(--on-brand)',
        math: 'var(--math)',
        'math-soft': 'var(--math-soft)',
        english: 'var(--english)',
        'english-soft': 'var(--english-soft)',
        ok: 'var(--ok)',
        'ok-soft': 'var(--ok-soft)',
        warn: 'var(--warn)',
        'warn-soft': 'var(--warn-soft)',
        crit: 'var(--crit)',
        'crit-soft': 'var(--crit-soft)',
      },
      fontFamily: {
        display: ['var(--font-display)'],
        ui: ['var(--font-ui)'],
        mono: ['var(--font-mono)'],
      },
      borderRadius: { sm: '6px', md: '10px', lg: '16px' },
      boxShadow: {
        1: 'var(--shadow-1)',
        2: 'var(--shadow-2)',
      },
    },
  },
  plugins: [],
};
export default config;
