import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

// Layering, enforced statically rather than by convention:
//
//   src/rules/     domain. Pure functions. No AWS, no I/O, no clock.
//   src/collector/ adapters + composition root for the scheduled Lambda.
//   src/api/       adapters + composition root for the HTTP Lambda.
//   lib/, bin/     infrastructure (CDK). Never imported by src/.
//
// The domain is the valuable part and the part worth testing in milliseconds,
// so the rules below make it impossible to accidentally reach for the AWS SDK
// or a wall clock from inside it.
//
// NOTE ON ORDER: flat config blocks replace a rule's options rather than
// merging them, and the last matching block wins. So the broad src/** block
// comes first and the stricter src/rules/** block after it - and the latter
// must restate every pattern it wants, including the ones above.

const NO_CDK = {
  group: ["aws-cdk-lib*", "constructs"],
  message: "CDK is infrastructure. It belongs in lib/ and bin/.",
};

const NO_AWS_SDK = {
  group: ["@aws-sdk/*"],
  message: "Domain must stay free of AWS. Inject an adapter instead.",
};

const NO_ADAPTERS = {
  group: ["**/collector/**", "**/api/**"],
  message: "Domain must not depend on adapters. Dependencies point inward.",
};

const NO_NODE_IO = {
  group: ["node:fs", "node:http", "node:https", "node:net", "node:child_process"],
  message: "Domain must be pure. Inject I/O instead.",
};

const CLOCK_MESSAGE = "Domain must not read the clock. Accept `now: Date` as a parameter so tests can control time.";

export default tseslint.config(
  { ignores: ["cdk.out/**", "node_modules/**", "coverage/**", "**/__snapshots__/**"] },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    files: ["**/*.ts", "**/*.mts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/explicit-function-return-type": ["error", { allowExpressions: true }],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },

  // Runtime code must never import the CDK.
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [NO_CDK] }],
    },
  },

  // Domain: no AWS, no adapters, no I/O, no ambient clock.
  // Restates NO_CDK because this block replaces the one above.
  {
    files: ["src/rules/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [NO_CDK, NO_AWS_SDK, NO_ADAPTERS, NO_NODE_IO] }],
      "no-restricted-globals": ["error", { name: "fetch", message: "Domain must be pure. Inject a fetcher instead." }],
      "no-restricted-syntax": [
        "error",
        { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: CLOCK_MESSAGE },
        { selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']", message: CLOCK_MESSAGE },
      ],
    },
  },

  // Infrastructure must not import runtime code. NodejsFunction references
  // handlers by file path, not by import, so there is never a need.
  {
    files: ["lib/**/*.ts", "bin/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["**/src/**"], message: "Infrastructure references handlers by entry path, not by import." },
          ],
        },
      ],
    },
  },

  // Config files live outside tsconfig, so type-aware rules cannot run on them.
  { files: ["**/*.mjs", "**/*.cjs", "**/*.js"], ...tseslint.configs.disableTypeChecked },

  // Tests may reach anywhere.
  {
    files: ["**/*.test.ts", "test/**/*.ts"],
    rules: {
      "no-restricted-imports": "off",
      "no-restricted-syntax": "off",
      "no-restricted-globals": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
    },
  },

  prettier,
);
