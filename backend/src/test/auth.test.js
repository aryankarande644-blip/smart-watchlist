// src/test/auth.test.js
// Unit-level tests for the auth primitives that don't need the full HTTP app:
//   - the per-IP login rate limiter actually blocks and recovers
//   - bcryptjs hashing round-trips, rejects wrong passwords, and never throws
//     on input that isn't a bcrypt hash (e.g. our DUMMY_HASH contract)
// The full account contract (signup/login/logout, isolation, 401s) is proven
// end-to-end in e2e.test.js against the real DB — this file only covers the
// parts that take precise control (windows, fake IPs).

const { createLimiter } = require('../auth/rateLimit');
const { hashPassword, verifyPassword } = require('../auth/passwords');
const { createAuthRouter } = require('../routes/auth');

let passed = 0, failed = 0;
function assertTrue(name, condition, detail) {
  if (condition) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}  (${JSON.stringify(detail)})`); }
}

const fakeIp = (ip) => ({ headers: {}, ip });

async function run() {
  // ---- Rate limiter: maxAttempts within a window ----
  {
    const limiter = createLimiter({ maxAttempts: 3, windowMs: 60000 });
    let okCount = 0;
    for (let i = 0; i < 3; i++) if (limiter.check(fakeIp('5.6.7.8'))) okCount++;
    assertTrue('1. Requests under the limit are allowed', okCount === 3, okCount);
    assertTrue('1b. Attempts beyond the limit are refused', limiter.check(fakeIp('5.6.7.8')) === false, '4th attempt refused');
    assertTrue('1c. A different IP is unaffected (keyed per-IP, not global)', limiter.check(fakeIp('9.9.9.9')) === true, 'other IP allowed');
  }

  // ---- Rate limiter: the window expires ----
  {
    const limiter = createLimiter({ maxAttempts: 1, windowMs: 30 });
    assertTrue('2. First attempt allowed', limiter.check(fakeIp('1.1.1.1')) === true);
    assertTrue('2b. Second attempt within the window refused', limiter.check(fakeIp('1.1.1.1')) === false);
    await new Promise((r) => setTimeout(r, 60));
    assertTrue('2c. After the window elapses, the IP is allowed again', limiter.check(fakeIp('1.1.1.1')) === true);
  }

  // ---- Rate limiter: X-Forwarded-For is honored (deployed behind Render proxy) ----
  {
    const limiter = createLimiter({ maxAttempts: 2, windowMs: 60000 });
    limiter.check({ headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }, ip: '127.0.0.1' });
    limiter.check({ headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }, ip: '127.0.0.1' });
    assertTrue(
      '3. Two attempts from the same XFF client IP exhaust that key (first of 3 blocked)',
      limiter.check({ headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }, ip: '127.0.0.1' }) === false
    );
    assertTrue(
      '3b. The XFF client IP and the socket IP are different keys — socket-only request unaffected',
      limiter.check(fakeIp('127.0.0.1')) === true
    );
  }

  // ---- bcryptjs password hashing ----
  {
    const plain = 'correct-horse-battery-staple-2026';
    const hash = await hashPassword(plain);
    assertTrue('4. hashPassword produces a bcrypt hash (not plaintext)', typeof hash === 'string' && hash.startsWith('$2') && !hash.includes(plain), hash);
    assertTrue('4b. Correct password verifies', await verifyPassword(plain, hash) === true);
    assertTrue('4c. Wrong password is rejected', await verifyPassword('wrong', hash) === false);
  }

  // ---- DUMMY_HASH contract: login uses it for unknown emails; it must always
  // reject, and verifyPassword must not throw on comparing against it ----
  {
    const unknown = async () => {
      try { return await verifyPassword('any-password', '$2b$10$C6UzMDM.H6dfI/f/IKcEeOHNhMuNZ4uHlM6tSRzMshNsaE5CmPqVa'); }
      catch (_) { return 'threw'; }
    };
    assertTrue('5. Dummy-hash compare rejects without throwing', (await unknown()) === false);
  }

  // ---- auth router is creatable with default settings (deploy path) ----
  {
    const router = createAuthRouter();
    assertTrue('6. createAuthRouter() wires up with production defaults', typeof router.post === 'function' && typeof router.get === 'function');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(async (err) => {
  console.error('Auth test crashed:', err);
  process.exit(1);
});