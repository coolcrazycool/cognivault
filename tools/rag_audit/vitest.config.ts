import { defineConfig } from 'vitest/config';

/**
 * Отдельный конфиг для тестов инструментов аудита.
 *
 * Корневой `vitest.config.ts` намеренно ограничен `src/**\/__tests__`, чтобы `pnpm test`
 * гонял только бэкенд: тесты аудита прогоняют чанкер по синтетическим страницам и
 * основному набору не нужны. Запуск:
 *     npx vitest run --config tools/rag_audit/vitest.config.ts
 */
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['tools/rag_audit/**/*.test.ts'],
    root: new URL('../..', import.meta.url).pathname,
  },
});
