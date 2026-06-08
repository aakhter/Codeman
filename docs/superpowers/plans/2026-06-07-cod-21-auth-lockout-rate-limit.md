# COD-21 Auth Lockout Rate Limit Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development before implementation and superpowers:verification-before-completion before claiming the fix is complete. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Basic Auth lockout less aggressive without removing brute-force protection. A valid session cookie and correct credentials should recover access even after this client IP has reached the failed-auth threshold. Wrong or missing credentials should still be rate-limited.

**Architecture:** Keep rate limiting in `src/web/middleware/auth.ts`, but move the lockout decision after the checks that prove the request is already authenticated. Add deterministic tests in `test/auth-security.test.ts` so this behavior is covered before changing the middleware.

**Tech Stack:** TypeScript, Fastify hooks, Vitest HTTP integration tests.

**Status:** Implemented and verified on 2026-06-08. Commit and Jira steps pending.

---

## Investigation Summary

- Jira `COD-21` summary: `"Too Many Requests - try again later" is too aggressive`.
- The 429 message comes from `src/web/middleware/auth.ts`, not from a general request-volume limiter.
- Current Basic Auth lockout is keyed by `req.ip` using `AUTH_FAILURE_MAX = 10` and `AUTH_FAILURE_WINDOW_MS = 15 * 60 * 1000`.
- Current middleware checks `authFailures` before session cookies and before Basic Auth credentials.
- Because of that order, an IP that has reached the failure threshold gets `429` even when it presents a valid `codeman_session` cookie or the correct Basic Auth password.
- `test/auth-security.test.ts` currently encodes the aggressive behavior with `should rate-limit even with correct credentials after lockout`.
- QR login rate limiting is separate (`qrAuthFailures`) and should not be changed for COD-21.
- Upload rate limiting is separate (`src/web/routes/session-routes.ts`) and should not be changed for COD-21.

## Desired Behavior

- Existing valid browser sessions should remain usable after failed Basic Auth attempts from the same IP.
- Correct Basic Auth credentials should succeed after lockout and clear the failed-attempt counter.
- Wrong or missing credentials should still return `429` once the IP has reached the failed-attempt threshold.
- The 429 response should include `Retry-After` based on the remaining failure-window TTL.
- The existing failure threshold and 15-minute window should remain unchanged in this first fix.

## File Structure

- Modify: `test/auth-security.test.ts`
- Modify: `src/web/middleware/auth.ts`

## Task 1: Add Deterministic Rate-Limit Coverage

**Files:**

- Modify: `test/auth-security.test.ts`

- [x] **Step 1: Add isolated COD-21 test helpers**

Add a dedicated rate-limit test port that does not conflict with existing fixed ports:

```ts
const AUTH_RATE_LIMIT_PORT = 3220;
```

Add helpers near `basicAuthHeader()`:

```ts
async function startAuthServer(port: number): Promise<{ server: WebServer; baseUrl: string }> {
  process.env.CODEMAN_PASSWORD = TEST_PASS;
  process.env.CODEMAN_USERNAME = TEST_USER;
  const server = new WebServer(port, false, true);
  await server.start();
  return { server, baseUrl: `http://localhost:${port}` };
}

async function getSessionCookie(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/status`, {
    headers: { Authorization: basicAuthHeader(TEST_USER, TEST_PASS) },
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get('set-cookie');
  expect(setCookie).toBeTruthy();
  const cookieMatch = setCookie!.match(/codeman_session=([^;]+)/);
  expect(cookieMatch).toBeTruthy();
  return `codeman_session=${cookieMatch![1]}`;
}

async function exhaustAuthFailures(baseUrl: string, prefix: string): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const res = await fetch(`${baseUrl}/api/status`, {
      headers: { Authorization: basicAuthHeader(TEST_USER, `${prefix}-${i}`) },
    });
    expect(res.status).toBe(401);
  }
}
```

Expected notes:

- The helper should assert the first 10 failed attempts are `401`.
- The 11th wrong or unauthenticated request is where `429` should appear.
- Keep these helpers local to `test/auth-security.test.ts`; no shared test utility is needed for this small fix.

- [x] **Step 2: Replace the state-dependent rate limit tests**

Replace the current `describe('Rate Limiting')` body with isolated tests using a fresh server in `beforeEach` and `afterEach`:

```ts
describe('Rate Limiting', () => {
  let rateServer: WebServer;
  let rateBaseUrl: string;

  beforeEach(async () => {
    ({ server: rateServer, baseUrl: rateBaseUrl } = await startAuthServer(AUTH_RATE_LIMIT_PORT));
  });

  afterEach(async () => {
    await rateServer.stop();
  });

  // tests below
});
```

Update the import to include `beforeEach` and `afterEach` from `vitest`.

- [x] **Step 3: Write RED test for Retry-After on lockout**

Add:

```ts
it('should rate-limit wrong credentials after too many failed attempts', async () => {
  await exhaustAuthFailures(rateBaseUrl, 'cod21-wrong');

  const res = await fetch(`${rateBaseUrl}/api/status`, {
    headers: { Authorization: basicAuthHeader(TEST_USER, 'wrong-again') },
  });

  expect(res.status).toBe(429);
  expect(res.headers.get('retry-after')).toMatch(/^\d+$/);
});
```

Run:

```bash
npm run test -- test/auth-security.test.ts
```

Expected: fail because `Retry-After` is not currently set.

- [x] **Step 4: Write RED test for valid cookie during lockout**

Add:

```ts
it('should allow an existing valid session cookie during auth failure lockout', async () => {
  const cookie = await getSessionCookie(rateBaseUrl);
  await exhaustAuthFailures(rateBaseUrl, 'cod21-cookie');

  const res = await fetch(`${rateBaseUrl}/api/status`, {
    headers: { Cookie: cookie },
  });

  expect(res.status).toBe(200);
});
```

Run:

```bash
npm run test -- test/auth-security.test.ts
```

Expected: fail because the current middleware returns `429` before checking the cookie.

- [x] **Step 5: Write RED test for correct credentials recovery**

Add:

```ts
it('should allow correct credentials to recover from auth failure lockout', async () => {
  await exhaustAuthFailures(rateBaseUrl, 'cod21-recover');

  const res = await fetch(`${rateBaseUrl}/api/status`, {
    headers: { Authorization: basicAuthHeader(TEST_USER, TEST_PASS) },
  });

  expect(res.status).toBe(200);
  expect(res.headers.get('set-cookie')).toContain('codeman_session=');
});
```

Run:

```bash
npm run test -- test/auth-security.test.ts
```

Expected: fail because the current middleware returns `429` before checking correct credentials.

- [x] **Step 6: Write RED test for failure-counter reset after recovery**

Add:

```ts
it('should clear failed attempt count after correct credentials recover access', async () => {
  await exhaustAuthFailures(rateBaseUrl, 'cod21-clear');

  const recoveryRes = await fetch(`${rateBaseUrl}/api/status`, {
    headers: { Authorization: basicAuthHeader(TEST_USER, TEST_PASS) },
  });
  expect(recoveryRes.status).toBe(200);

  const wrongAfterRecovery = await fetch(`${rateBaseUrl}/api/status`, {
    headers: { Authorization: basicAuthHeader(TEST_USER, 'wrong-after-recovery') },
  });

  expect(wrongAfterRecovery.status).toBe(401);
});
```

Run:

```bash
npm run test -- test/auth-security.test.ts
```

Expected: fail until correct-credential recovery clears the failed-attempt counter.

## Task 2: Fix Basic Auth Lockout Order

**Files:**

- Modify: `src/web/middleware/auth.ts`

- [x] **Step 1: Add a small 429 response helper**

Update the Fastify import:

```ts
import { FastifyInstance, FastifyReply } from 'fastify';
```

Add a local helper inside `registerAuthMiddleware()` after `const authFailures = state.authFailures;`:

```ts
function sendAuthRateLimit(reply: FastifyReply, clientIp: string): void {
  const remainingMs = authFailures.getRemainingTtl(clientIp) ?? AUTH_FAILURE_WINDOW_MS;
  const retryAfterSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
  reply.header('Retry-After', String(retryAfterSeconds));
  reply.code(429).send('Too Many Requests — try again later');
}
```

- [x] **Step 2: Check session cookie before lockout**

Move this block before the failure-threshold check:

```ts
const sessionToken = req.cookies[AUTH_COOKIE_NAME];
if (sessionToken && authSessions.get(sessionToken) !== undefined) {
  done();
  return;
}
```

Expected effect: an already-authenticated browser tab is not locked out by failed Basic Auth attempts from the same IP.

- [x] **Step 3: Check correct Basic Auth before lockout**

Move the Basic Auth timing-safe comparison before the failure-threshold check. On success, keep the existing behavior:

- issue a new `codeman_session` cookie
- call `authFailures.delete(clientIp)`
- `done()`

Expected effect: correct credentials recover access and reset the counter.

- [x] **Step 4: Apply lockout only to unauthenticated requests**

After session and correct Basic Auth checks, compute:

```ts
const failures = authFailures.get(clientIp) ?? 0;
if (failures >= AUTH_FAILURE_MAX) {
  sendAuthRateLimit(reply, clientIp);
  return;
}
```

Then leave the existing failed-auth increment and `401 Unauthorized` response in place:

```ts
authFailures.set(clientIp, failures + 1);

reply.header('WWW-Authenticate', 'Basic realm="Codeman"');
reply.code(401).send('Unauthorized');
```

Expected effect:

- attempts 1 through 10 with wrong credentials return `401`
- attempt 11 with wrong or missing credentials returns `429`
- correct credentials and valid session cookies return `200`

## Task 3: Verification

- [x] **Step 1: Run focused auth tests**

Run:

```bash
npm run test -- test/auth-security.test.ts
```

Expected: pass.

- [x] **Step 2: Run adjacent auth tests**

Run:

```bash
npm run test -- test/qr-auth.test.ts test/auth-security.test.ts
```

Expected: pass. QR auth rate limiting should remain unchanged.

- [x] **Step 3: Run static checks**

Run:

```bash
npm run typecheck
npm run lint
npm run format:check
```

Expected: all pass.

## Task 4: Commit And Jira

- [ ] **Step 1: Commit**

Commit implementation and test changes:

```bash
git add -- src/web/middleware/auth.ts test/auth-security.test.ts docs/superpowers/plans/2026-06-07-cod-21-auth-lockout-rate-limit.md
git commit -m "fix(auth): COD-21 relax auth lockout recovery"
```

- [ ] **Step 2: Update Jira**

Update `COD-21` with:

- summary of the behavior change
- the focused verification commands and results
- the git commit hash
- a Bitbucket commit URL if available

## Non-Goals

- Do not change QR token rate limiting.
- Do not change upload rate limiting.
- Do not change `AUTH_FAILURE_MAX` or `AUTH_FAILURE_WINDOW_MS` in this first fix.
- Do not add a new auth endpoint or frontend UI.
