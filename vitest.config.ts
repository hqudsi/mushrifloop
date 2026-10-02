import { defineConfig } from 'vitest/config';

/**
 * Main-process and shared logic only (CLAUDE.md: "Vitest for main-process logic").
 * The renderer is not covered here — it has no business logic to test.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/shared/**/*.spec.ts', 'src/main/**/*.spec.ts'],
    reporters: ['default'],
  },
});
