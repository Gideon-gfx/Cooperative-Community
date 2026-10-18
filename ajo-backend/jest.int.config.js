// Integration tests: real services against an in-memory MongoDB replica set (needs a one-time ~60 MB download).
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src/__tests__'],
  testMatch: ['**/*.int.test.ts'],
  testTimeout: 300000,
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: { rootDir: '.', strict: true, esModuleInterop: true, types: ['jest', 'node'] } }] },
};
