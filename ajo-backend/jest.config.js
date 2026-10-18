module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src/__tests__'],
  // Only *.test.ts files are tests; helpers live beside them.
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: { rootDir: '.', strict: true, esModuleInterop: true, types: ['jest', 'node'] } }],
  },
};
