import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "drizzle/**",
  ]),
  {
    // Architectural boundaries from DESIGN.md, enforced rather than documented.
    files: ["src/modules/**/*.ts", "src/modules/**/*.tsx", "src/app/**/*.ts", "src/app/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/core/db/client",
              message:
                "Feature modules must not touch the raw database. Use withSpace()/readInSpace() so every query is space-scoped (DESIGN.md §3.5).",
            },
            {
              name: "pino",
              message: "Use the logger from @/core/logging/logger — it enforces the field allowlist (DESIGN.md §7.1).",
            },
          ],
          patterns: [
            {
              group: ["@/adapters/*"],
              message:
                "Modules depend on ports, never on adapters. Wire the adapter in the composition root instead (DESIGN.md §2).",
            },
            {
              group: ["@/modules/*/internal/*"],
              message: "Reach another module through the event bus or its public index, not its internals.",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
