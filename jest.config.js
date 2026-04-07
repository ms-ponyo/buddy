const baseConfig = {
  preset: 'ts-jest/presets/default-esm',
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      useESM: true,
      diagnostics: false,
      tsconfig: {
        module: 'Node16',
        moduleResolution: 'Node16',
        esModuleInterop: true,
        target: 'ES2022',
      }
    }]
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  testPathIgnorePatterns: [
    '/node_modules/',
  ],
};

export default {
  projects: [
    { ...baseConfig, displayName: 'unit', testMatch: ['<rootDir>/tests/unit/**/*.test.ts'] },
    { ...baseConfig, displayName: 'integration', testMatch: ['<rootDir>/tests/integration/**/*.test.ts'] },
    {
      ...baseConfig,
      displayName: 'e2e',
      testMatch: ['<rootDir>/tests/e2e/**/*.test.ts'],
      testTimeout: 30000,
    },
  ],
};
