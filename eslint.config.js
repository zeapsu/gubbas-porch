import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
      "docs/**",
      ".github/scripts/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports" },
      ],
    },
  },
  // Global rule: `three` may only be imported in src/render/** and src/main.ts
  {
    files: ["src/**/*.ts"],
    ignores: ["src/render/**/*.ts", "src/main.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["three", "three/*"],
              message: "three may only be imported inside src/render/** or src/main.ts",
            },
          ],
        },
      ],
    },
  },
  // src/sand/ imports nothing from other src/ modules
  {
    files: ["src/sand/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["three", "three/*", "../*"],
              message: "src/sand/ must remain pure and import no other modules.",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        { name: "window", message: "Pure module cannot read window." },
        { name: "document", message: "Pure module cannot read document." },
        { name: "performance", message: "Pure module cannot read wall-clock time." },
      ],
      "no-restricted-properties": [
        "error",
        { object: "Math", property: "random", message: "Pure module cannot call Math.random()." },
        { object: "Date", property: "now", message: "Pure module cannot read Date.now()." },
      ],
    },
  },
  // src/rakes/ imports only src/sand/
  {
    files: ["src/rakes/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "three",
                "three/*",
                "../state*",
                "../gubba*",
                "../audio*",
                "../render*",
                "../ui*",
                "../main*",
              ],
              message: "src/rakes/ may only import from src/sand/.",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        { name: "window", message: "Pure module cannot read window." },
        { name: "document", message: "Pure module cannot read document." },
        { name: "performance", message: "Pure module cannot read wall-clock time." },
      ],
      "no-restricted-properties": [
        "error",
        { object: "Math", property: "random", message: "Pure module cannot call Math.random()." },
        { object: "Date", property: "now", message: "Pure module cannot read Date.now()." },
      ],
    },
  },
  // src/state/ imports only src/sand/ and src/rakes/
  {
    files: ["src/state/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "three",
                "three/*",
                "../gubba*",
                "../audio*",
                "../render*",
                "../ui*",
                "../main*",
              ],
              message: "src/state/ may only import from src/sand/ and src/rakes/.",
            },
          ],
        },
      ],
    },
  },
  // src/gubba/ imports only src/state/ (types) and is pure
  {
    files: ["src/gubba/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "three",
                "three/*",
                "../sand*",
                "../rakes*",
                "../audio*",
                "../render*",
                "../ui*",
                "../main*",
              ],
              message: "src/gubba/ may only import types from src/state/.",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        { name: "window", message: "Pure module cannot read window." },
        { name: "document", message: "Pure module cannot read document." },
        { name: "performance", message: "Pure module cannot read wall-clock time." },
      ],
      "no-restricted-properties": [
        "error",
        { object: "Math", property: "random", message: "Pure module cannot call Math.random()." },
        { object: "Date", property: "now", message: "Pure module cannot read Date.now()." },
      ],
    },
  },
  // src/audio/ imports only src/state/ and src/rakes/
  {
    files: ["src/audio/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "three",
                "three/*",
                "../sand*",
                "../gubba*",
                "../render*",
                "../ui*",
                "../main*",
              ],
              message: "src/audio/ may only import from src/state/ and src/rakes/.",
            },
          ],
        },
      ],
    },
  },
  // Pure composer & camera math checks
  {
    files: ["src/audio/composer.ts", "src/render/camera/**/*.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "window", message: "Pure module cannot read window." },
        { name: "document", message: "Pure module cannot read document." },
        { name: "performance", message: "Pure module cannot read wall-clock time." },
      ],
      "no-restricted-properties": [
        "error",
        { object: "Math", property: "random", message: "Pure module cannot call Math.random()." },
        { object: "Date", property: "now", message: "Pure module cannot read Date.now()." },
      ],
    },
  },
  // src/render/ cannot import src/ui/ or src/audio/
  {
    files: ["src/render/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["../ui*", "../../ui*", "../audio*", "../../audio*", "../main*", "../../main*"],
              message: "src/render/ may not import src/ui/, src/audio/, or src/main.ts.",
            },
          ],
        },
      ],
    },
  },
  // src/ui/ cannot import three
  {
    files: ["src/ui/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["three", "three/*"],
              message: "src/ui/ must not import three.",
            },
          ],
        },
      ],
    },
  },
);
