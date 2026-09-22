import { test, expect, pdf, docx, expectCleanError, NOT_FOUND } from '../support/fixtures';

test.describe('Question API: functional @api', () => {
  test('TC1 answer is grounded in the right part of the document @smoke', async ({ alice }) => {
    const docId = await alice.uploadOk('handbook.pdf', pdf('Page 1. Welcome to the company.\nPage 3. The laptop refresh cycle is 36 months.'));
    const res = await alice.askOk('How often is the laptop refresh cycle?', { documentIds: [docId] });
    expect(res.answer).toContain('36 months');
    expect(res.citations).toHaveLength(1);
    expect(res.citations[0]).toMatchObject({ documentId: docId, documentName: 'handbook.pdf' });
    expect(res.citations[0].quote).toContain('36 months');
  });

  test('TC2 DOCX content can be queried', async ({ alice }) => {
    const docId = await alice.uploadOk('onboarding.docx', docx('The onboarding buddy is assigned on the first Monday.'));
    const res = await alice.askOk('When is the onboarding buddy assigned?', { documentIds: [docId] });
    expect(res.answer).toContain('first Monday');
  });

  test('TC3 with three documents the answer comes only from the relevant one', async ({ alice }) => {
    const ids = [
      await alice.uploadOk('one.pdf', pdf('The cafeteria serves lunch from noon.')),
      await alice.uploadOk('two.pdf', pdf('The parking permit costs 40 EUR per month.')),
      await alice.uploadOk('three.pdf', pdf('The gym is on the second floor.')),
    ];
    const res = await alice.askOk('How much does the parking permit cost?', { documentIds: ids });
    expect(res.answer).toContain('40 EUR');
    expect(res.citations.map((c) => c.documentId)).toEqual([ids[1]]);
  });

  test('TC4 conversation history is saved in the correct order', async ({ alice }) => {
    const docId = await alice.uploadOk('history.pdf', pdf('The meeting room is called Everest.\nThe printer is on floor two.'));
    const first = await alice.askOk('What is the meeting room called?', { documentIds: [docId] });
    await alice.askOk('Where is the printer?', { conversationId: first.conversationId });

    const conv = await (await alice.getConversation(first.conversationId)).json();
    expect(conv.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(conv.messages[0].content).toBe('What is the meeting room called?');
    expect(conv.messages[3].content).toContain('floor two');
  });

  test('TC8 question not covered by the document is not guessed', async ({ alice }) => {
    const docId = await alice.uploadOk('scope.pdf', pdf('The dress code is business casual.'));
    const res = await alice.askOk('What is the stock price of the company?', { documentIds: [docId] });
    expect(res.answer).toMatch(NOT_FOUND);
    expect(res.citations).toHaveLength(0);
  });
});

test.describe('Question API: negative and boundary @api', () => {
  test('TC12 empty question is rejected', async ({ alice }) => {
    await expectCleanError(await alice.ask(''), 400, 'VALIDATION_ERROR');
    await expectCleanError(await alice.ask('     '), 400, 'VALIDATION_ERROR');
  });

  test('One character question is accepted', async ({ alice }) => {
    expect((await alice.ask('?')).status()).toBe(200);
  });

  test('TC13 question at max length is accepted, max + 1 is rejected', async ({ alice }) => {
    expect((await alice.ask('a'.repeat(2000))).status()).toBe(200);
    const body = await expectCleanError(await alice.ask('a'.repeat(2001)), 400, 'QUESTION_TOO_LONG');
    expect(body.error.maxChars).toBe(2000);
  });

  test('Missing question field is rejected', async ({ alice }) => {
    const res = await alice.request.post('/api/questions', { headers: alice.headers, data: {} });
    await expectCleanError(res, 400, 'VALIDATION_ERROR');
  });

  test('Invalid JSON is rejected with 400, not 500', async ({ alice }) => {
    const res = await alice.request.post('/api/questions', {
      headers: { ...alice.headers, 'content-type': 'application/json' },
      data: Buffer.from('{"question": '), // raw bytes, so Playwright does not re-encode it
    });
    await expectCleanError(res, 400, 'INVALID_JSON');
  });

  test('Wrong content type is rejected', async ({ alice }) => {
    const res = await alice.request.post('/api/questions', {
      headers: { ...alice.headers, 'content-type': 'text/plain' },
      data: 'question=hello',
    });
    await expectCleanError(res, 415);
  });

  test('Non existent document id returns 404', async ({ alice }) => {
    await expectCleanError(await alice.ask('Anything?', { documentIds: ['doc_does_not_exist'] }), 404, 'DOCUMENT_NOT_FOUND');
  });

  test('Empty documentIds array is rejected', async ({ alice }) => {
    await expectCleanError(await alice.ask('Anything?', { documentIds: [] }), 400);
  });

  test('More than 20 documents in one question is rejected', async ({ alice }) => {
    const ids = Array.from({ length: 21 }, (_, i) => `doc_${i}`);
    await expectCleanError(await alice.ask('Anything?', { documentIds: ids }), 400, 'TOO_MANY_DOCUMENTS');
  });

  test('Special characters and script tags are handled as plain text', async ({ alice }) => {
    const res = await alice.ask('<script>alert(1)</script> émojis 🚀 \u0000 "quotes" \\ backslash');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('application/json');
  });
});

test.describe('Question API: failure handling @api @reliability', () => {
  test('TC17 AI provider timeout returns a clean retryable error, not a 500', async ({ alice }) => {
    const body = await expectCleanError(await alice.ask('Hello?', {}, { 'x-simulate-failure': 'timeout' }), 504, 'AI_TIMEOUT');
    expect(body.error.retryable).toBe(true);
  });

  test('AI provider rate limit is surfaced as 503 with Retry-After', async ({ alice }) => {
    const res = await alice.ask('Hello?', {}, { 'x-simulate-failure': 'rate-limit' });
    const body = await expectCleanError(res, 503, 'AI_BUSY');
    expect(res.headers()['retry-after']).toBeTruthy();
    expect(body.error.retryable).toBe(true);
  });

  test('User can resend the question after a failure', async ({ alice }) => {
    const docId = await alice.uploadOk('retry.pdf', pdf('The retry marker is Kestrel.'));
    await alice.ask('What is the retry marker?', { documentIds: [docId] }, { 'x-simulate-failure': 'timeout' });
    const res = await alice.askOk('What is the retry marker?', { documentIds: [docId] });
    expect(res.answer).toContain('Kestrel');
  });
});
