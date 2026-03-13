# Deferred Items - Phase 09

## Pre-existing test failures (out of scope)

These test suites fail due to missing OPENAI_API_KEY env var in their setup. Pre-existing issue, not caused by 09-01 changes.

- src/plugins/__tests__/auth.test.ts
- src/plugins/__tests__/db.test.ts
- src/plugins/__tests__/indexer.test.ts
- src/features/health/__tests__/routes.test.ts
- src/features/vault/__tests__/routes.test.ts

Root cause: These tests use `buildApp` which triggers `src/config.ts` parse with `OPENAI_API_KEY` required, but the test files don't set this env var.
