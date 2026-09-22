import { test, expect, pdf, docx, expectCleanError } from '../support/fixtures';

const MAX = Number(process.env.MAX_UPLOAD_BYTES || 5 * 1024 * 1024);

/** A valid PDF of an exact byte size. */
const pdfOfSize = (bytes: number) => {
  const head = pdf('Sized document. The size marker is present.\n');
  return Buffer.concat([head, Buffer.alloc(bytes - head.length, 'a')]);
};

test.describe('Document upload @api', () => {
  test('TC1 valid PDF uploads @smoke', async ({ alice }) => {
    const res = await alice.upload('policy.pdf', pdf('Refunds are processed in 14 days.'));
    expect(res.status()).toBe(201);
    expect(await res.json()).toMatchObject({ type: 'pdf', status: 'ready' });
  });

  test('TC2 valid DOCX uploads @smoke', async ({ alice }) => {
    const res = await alice.upload('policy.docx', docx('Refunds are processed in 14 days.'));
    expect(res.status()).toBe(201);
    expect((await res.json()).type).toBe('docx');
  });

  test('TC6 unsupported format is rejected', async ({ alice }) => {
    await expectCleanError(await alice.upload('notes.txt', Buffer.from('plain text')), 415, 'UNSUPPORTED_FORMAT');
  });

  test('TC7 executable renamed to .pdf is rejected by content, not extension', async ({ alice }) => {
    const fakeExe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64)]);
    await expectCleanError(await alice.upload('invoice.pdf', fakeExe), 415, 'UNSUPPORTED_FORMAT');
  });

  test('TC10 file exactly at the size limit uploads', async ({ alice }) => {
    const res = await alice.upload('at-limit.pdf', pdfOfSize(MAX));
    expect(res.status(), await res.text()).toBe(201);
    expect((await res.json()).bytes).toBe(MAX);
  });

  test('TC11 file one byte over the limit is rejected with a size message', async ({ alice }) => {
    const body = await expectCleanError(await alice.upload('over-limit.pdf', pdfOfSize(MAX + 1)), 413, 'FILE_TOO_LARGE');
    expect(body.error.maxBytes).toBe(MAX);
  });

  test('TC14 empty file is rejected cleanly', async ({ alice }) => {
    await expectCleanError(await alice.upload('empty.pdf', Buffer.alloc(0)), 400, 'EMPTY_FILE');
  });

  test('PDF with header but no text is rejected, not stored silently', async ({ alice }) => {
    await expectCleanError(await alice.upload('blank.pdf', pdf('   ')), 422, 'NO_READABLE_TEXT');
  });

  test('TC15 scanned (image only) PDF tells the user text cannot be read', async ({ alice }) => {
    await expectCleanError(await alice.upload('scan.pdf', pdf('[image-only]')), 422, 'NO_READABLE_TEXT');
  });

  test('Password protected PDF is rejected with a clear message', async ({ alice }) => {
    await expectCleanError(await alice.upload('locked.pdf', pdf('[encrypted]')), 422, 'ENCRYPTED_FILE');
  });

  test('Missing fields return a validation error', async ({ alice }) => {
    const res = await alice.request.post('/api/documents', { headers: alice.headers, data: { name: 'x.pdf' } });
    await expectCleanError(res, 400, 'VALIDATION_ERROR');
  });

  test('Very long file name is truncated, not rejected with a 500', async ({ alice }) => {
    const res = await alice.upload(`${'n'.repeat(1000)}.pdf`, pdf('Name length check.'));
    expect(res.status()).toBe(201);
    expect((await res.json()).name.length).toBeLessThanOrEqual(255);
  });

  test('Same file uploaded twice creates two independent documents', async ({ alice }) => {
    const file = pdf('Duplicate upload check.');
    const a = await alice.uploadOk('dup.pdf', file);
    const b = await alice.uploadOk('dup.pdf', file);
    expect(a).not.toBe(b);
  });
});
