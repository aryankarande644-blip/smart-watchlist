// Runs all test suites in sequence, stops on first failure.
const { execSync } = require('child_process');
const suites = [
  'src/test/diffEngine.test.js',
  'src/test/computeBaseline.test.js',
  'src/test/realProvider.test.js',
  'src/test/repository.test.js',
  'src/test/marketDataClient.test.js',
  'src/test/poller.test.js',
  'src/test/refreshBaselines.test.js',
  'src/test/auth.test.js',
  'src/test/e2e.test.js',
];
for (const suite of suites) {
  console.log(`\n=== ${suite} ===`);
  execSync(`node ${suite}`, { stdio: 'inherit' });
}
