import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", ".papi", "node_modules"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    // The classic hooks pairing; the v7 "recommended-latest" adds opinionated rules
    // (set-state-in-effect, incompatible-library) that flag valid patterns here.
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },
  // Tests use `any` for mocks/fixtures and run in node.
  {
    files: ["**/*.test.{ts,tsx}"],
    languageOptions: { globals: globals.node },
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  // Build/tooling config files and node scripts run in node.
  {
    files: ["*.config.ts", "**/*.mjs", "scripts/**"],
    languageOptions: { globals: globals.node },
  },
);
