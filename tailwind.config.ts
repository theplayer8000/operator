import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        base: {
          950: "#0A0C11", // deepest background
          900: "#0F131A", // app background
          800: "#161B24", // surface / card
          700: "#1E2530", // raised surface / hover
          600: "#2A3240", // border
          500: "#3D4859", // muted border / divider
        },
        ink: {
          100: "#F3F5F8", // primary text
          300: "#C7CEDA", // secondary text
          500: "#8892A3", // muted text
          700: "#5C6577", // faint / disabled
        },
        xp: {
          DEFAULT: "#E8B04D", // signature accent — "experience gold"
          soft: "#3A2E17",
          bright: "#F5C567",
        },
        rank: {
          DEFAULT: "#8D7FE0", // secondary accent — "rank violet"
          soft: "#241F3D",
        },
        vital: {
          up: "#4FB477", // positive / streak-alive
          down: "#D9685F", // negative / streak-broken
        },
      },
      fontFamily: {
        display: ["\"Space Grotesk\"", "sans-serif"],
        body: ["\"Inter\"", "sans-serif"],
        mono: ["\"JetBrains Mono\"", "monospace"],
      },
      borderRadius: {
        card: "18px",
        badge: "10px",
      },
      boxShadow: {
        card: "0 1px 0 0 rgba(255,255,255,0.03) inset, 0 8px 24px -12px rgba(0,0,0,0.5)",
        glow: "0 0 0 1px rgba(232,176,77,0.25), 0 0 24px -4px rgba(232,176,77,0.35)",
      },
      backgroundImage: {
        "glass-sheen":
          "linear-gradient(135deg, rgba(255,255,255,0.04) 0%, rgba(255,255,255,0) 40%)",
      },
    },
  },
  plugins: [],
} satisfies Config;
