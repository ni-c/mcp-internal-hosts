import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // Lines and functions are complete. Statements and branches stop short of
      // 100 for one reason, and it is worth writing down rather than chasing:
      // `noUncheckedIndexedAccess` forces destructuring defaults (`const [a = 0,
      // …]`) onto array elements that the regex or the length check immediately
      // above has already guaranteed. Those defaults cannot be reached, and the
      // ways to make the counter round — a cast, or restructuring — are worse
      // trades in a classifier this one is copied verbatim from nine servers
      // where it has been correct for months.
      thresholds: {
        statements: 96,
        branches: 94,
        functions: 100,
        lines: 100,
      },
    },
  },
});
