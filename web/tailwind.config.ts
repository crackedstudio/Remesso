import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#11151c",
        paper: "#fbfaf7",
        naira: "#0f8a5f",
      },
    },
  },
  plugins: [],
} satisfies Config;
