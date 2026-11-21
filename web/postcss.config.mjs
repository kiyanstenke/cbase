// The order is load-bearing: Tailwind FIRST, the text scale AFTER. Only behind Tailwind do the
// `text-[…]` classes exist as real declarations — before it the plugin would only see `@import "tailwindcss"`
// and the handwritten rules, and every utility size would stay fixed. Why the plugin exists and
// what it rewrites: web/postcss-text-scale.cjs; latch: web/test/textScale.test.mjs.
export default {
  plugins: {
    "@tailwindcss/postcss": {},
    "./postcss-text-scale.cjs": {},
  },
};
