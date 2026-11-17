import forms from "@tailwindcss/forms";
import defaultTheme from "tailwindcss/defaultTheme";

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{njk,ts,html}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter Variable", ...defaultTheme.fontFamily.sans],
      },
      colors: {
        // Rojo de la bandera de la Comunidad de Madrid
        brand: {
          50: "#fef2f3",
          100: "#fde3e6",
          200: "#fbccd2",
          300: "#f7a3ad",
          400: "#f06e7e",
          500: "#e43f55",
          600: "#c8102e",
          700: "#a80d27",
          800: "#8c1026",
          900: "#761226",
        },
      },
      boxShadow: {
        card: "0 1px 2px rgb(15 23 42 / 0.06), 0 1px 3px rgb(15 23 42 / 0.1)",
        float: "0 10px 30px -10px rgb(15 23 42 / 0.35)",
      },
    },
  },
  plugins: [forms],
};
