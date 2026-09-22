import { test, expect, Client, expectCleanError } from '../support/fixtures';

test.describe('Authentication @api @smoke', () => {
  test('Valid credentials return a token', async ({ request }) => {
    const res = await request.post('/api/login', { data: { username: 'alice', password: 'password123' } });
    expect(res.status()).toBe(200);
    expect((await res.json()).token).toMatch(/^[a-f0-9]{48}$/);
  });

  test('Wrong password is rejected without hinting which field was wrong', async ({ request }) => {
    const res = await request.post('/api/login', { data: { username: 'alice', password: 'nope' } });
    const body = await expectCleanError(res, 401, 'INVALID_CREDENTIALS');
    expect(body.error.message).toBe('Wrong username or password.');
  });

  test('Question API without a token returns 401 and no answer', async ({ request }) => {
    const res = await request.post('/api/questions', { data: { question: 'Hello?' } });
    const body = await expectCleanError(res, 401, 'UNAUTHORIZED');
    expect(body.answer).toBeUndefined();
  });

  test('Forged token is rejected', async ({ request }) => {
    const res = await request.post('/api/questions', {
      headers: { authorization: `Bearer ${'0'.repeat(48)}` },
      data: { question: 'Hello?' },
    });
    await expectCleanError(res, 401);
  });

  test('Expired token is rejected with a clear message', async ({ request }) => {
    const shortLived = await Client.login(request, 'bob', { ttlMs: 50 });
    await new Promise((r) => setTimeout(r, 120));
    await expectCleanError(await shortLived.ask('Anything?'), 401, 'TOKEN_EXPIRED');
  });

  test('Logout invalidates the token', async ({ request }) => {
    const c = await Client.login(request, 'carol');
    expect((await request.post('/api/logout', { headers: c.headers })).status()).toBe(204);
    await expectCleanError(await c.ask('Still there?'), 401);
  });
});
