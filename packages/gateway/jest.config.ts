export default {
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
      },
    }],
  },
  // Allow ts-jest to transform workspace packages (symlinked under node_modules)
  transformIgnorePatterns: [
    'node_modules/(?!@buddy/)',
  ],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  roots: ['<rootDir>/src/', '<rootDir>/tests/'],
  testMatch: ['**/*.test.ts'],
};
