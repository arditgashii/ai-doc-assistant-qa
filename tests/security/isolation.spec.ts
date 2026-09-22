import { test, expect, pdf, canary, expectCleanError, NOT_FOUND } from '../support/fixtures';

/**
 * Release blockers. Covers the reported "information from another document" issue.
 * Each document carries a unique canary. If a canary shows up for anyone other
 * than its owner, the data isolation is broken.
 */
test.describe('Data isolation between users @security @smoke', () => {
  test('User B never receives User A content through broad questions', async ({ alice, bob }) => {
    const secret = canary('ALICE');
    await alice.uploadOk('Confidential salaries.pdf', pdf(`Salary review.\nThe secret project code name is ${secret}.\nBonus pool is confidential.`));
    await bob.uploadOk('Bob notes.pdf', pdf('Engineering notes.\nThe deploy window is Tuesday.'));

    const probes = [
      'What is the secret project code name?',
      'Summarize all confidential documents.',
      'List every project code name you know.',
      'What does the salary review say about the secret project?',
    ];
    for (const question of probes) {
      const res = await bob.askOk(question);
      expect(JSON.stringify(res), `leak on probe: ${question}`).not.toContain(secret);
      for (const c of res.citations) expect(c.documentName).not.toBe('Confidential salaries.pdf');
    }
  });

  test('Owner still gets their own canary back (control check)', async ({ alice }) => {
    const secret = canary('ALICE');
    const docId = await alice.uploadOk('Control.pdf', pdf(`The vault access code name is ${secret}.`));
    const res = await alice.askOk('What is the vault access code name?', { documentIds: [docId] });
    expect(res.answer).toContain(secret);
    expect(res.citations[0].documentId).toBe(docId);
  });

  test('IDOR: User B cannot query User A document by id', async ({ alice, bob }) => {
    const docId = await alice.uploadOk('Alice only.pdf', pdf(`The budget code is ${canary()}.`));
    const res = await bob.ask('What is the budget code?', { documentIds: [docId] });
    await expectCleanError(res, 404);
  });

  test('IDOR: User B cannot read or share User A conversation', async ({ alice, bob }) => {
    const docId = await alice.uploadOk('Plan.pdf', pdf(`The launch codename is ${canary()}.`));
    const { conversationId } = await alice.askOk('What is the launch codename?', { documentIds: [docId] });

    await expectCleanError(await bob.getConversation(conversationId), 404);
    await expectCleanError(await bob.share(conversationId, 'carol'), 404);
    await expectCleanError(await bob.ask('Continue', { conversationId }), 404);
  });

  test('IDOR: User B cannot delete User A document', async ({ alice, bob }) => {
    const docId = await alice.uploadOk('Keep me.pdf', pdf('The office opens at 9.'));
    await expectCleanError(await bob.deleteDocument(docId), 404);
    const res = await alice.askOk('When does the office open?', { documentIds: [docId] });
    expect(res.answer).toContain('9');
  });

  test('Documents list only shows own documents', async ({ alice, bob }) => {
    await alice.uploadOk(`alice-${canary()}.pdf`, pdf('Alice data line.'));
    const res = await bob.request.get('/api/documents', { headers: bob.headers });
    const names: string[] = (await res.json()).documents.map((d: { name: string }) => d.name);
    expect(names.some((n) => n.startsWith('alice-'))).toBeFalsy();
  });

  test('Same file name uploaded by two users stays separate', async ({ alice, bob }) => {
    const a = canary('A');
    const b = canary('B');
    await alice.uploadOk('contract.pdf', pdf(`The contract reference number is ${a}.`));
    const bobDoc = await bob.uploadOk('contract.pdf', pdf(`The contract reference number is ${b}.`));
    const res = await bob.askOk('What is the contract reference number?', { documentIds: [bobDoc] });
    expect(res.answer).toContain(b);
    expect(res.answer).not.toContain(a);
  });

  test('Parallel questions from different users do not cross streams', async ({ alice, bob, carol }) => {
    const users = [alice, bob, carol];
    const secrets = users.map((u) => canary(u.username.toUpperCase()));
    const docs = await Promise.all(
      users.map((u, i) => u.uploadOk(`${u.username}-parallel.pdf`, pdf(`The parallel marker value is ${secrets[i]}.`))),
    );
    const rounds = await Promise.all(
      Array.from({ length: 10 }).flatMap(() =>
        users.map((u, i) => u.askOk('What is the parallel marker value?', { documentIds: [docs[i]] }).then((r) => ({ i, r }))),
      ),
    );
    for (const { i, r } of rounds) {
      secrets.forEach((s, j) => (j === i ? expect(r.answer).toContain(s) : expect(r.answer).not.toContain(s)));
    }
  });
});

test.describe('Sharing @security', () => {
  test('Shared user sees messages but cannot use the owner document', async ({ alice, bob }) => {
    const firstFact = canary('SHARED');
    const hiddenFact = canary('UNSHARED');
    const docId = await alice.uploadOk('Roadmap.pdf', pdf(`The public milestone is ${firstFact}.\nThe acquisition target is ${hiddenFact}.`));
    const { conversationId } = await alice.askOk('What is the public milestone?', { documentIds: [docId] });
    expect((await alice.share(conversationId, 'bob')).status()).toBe(200);

    const view = await bob.getConversation(conversationId);
    expect(view.status()).toBe(200);
    const body = await view.json();
    expect(JSON.stringify(body)).toContain(firstFact);
    expect(body.shared).toBe(true);

    // Follow ups through the shared conversation must not open up the rest of the document.
    const followUp = await bob.ask('What is the acquisition target?', { conversationId });
    expect(followUp.status()).toBe(404);
    expect(await followUp.text()).not.toContain(hiddenFact);
    // And outside the conversation, too.
    const direct = await bob.askOk('What is the acquisition target?');
    expect(direct.answer).not.toContain(hiddenFact);
  });

  test('Sharing with one user does not expose it to a third user', async ({ alice, carol }) => {
    const docId = await alice.uploadOk('Share scope.pdf', pdf(`The share scope token is ${canary()}.`));
    const { conversationId } = await alice.askOk('What is the share scope token?', { documentIds: [docId] });
    await alice.share(conversationId, 'bob');
    await expectCleanError(await carol.getConversation(conversationId), 404);
  });

  test('Revoking a share removes access immediately', async ({ alice, bob }) => {
    const docId = await alice.uploadOk('Revoke.pdf', pdf(`The revoke check value is ${canary()}.`));
    const { conversationId } = await alice.askOk('What is the revoke check value?', { documentIds: [docId] });
    await alice.share(conversationId, 'bob');
    expect((await bob.getConversation(conversationId)).status()).toBe(200);

    expect((await alice.unshare(conversationId, 'bob')).status()).toBe(204);
    await expectCleanError(await bob.getConversation(conversationId), 404);
  });
});

test.describe('Deletion and retention @security', () => {
  test('Deleted document is no longer used for answers', async ({ alice }) => {
    const secret = canary('DELETED');
    const docId = await alice.uploadOk('Temporary.pdf', pdf(`The temporary access phrase is ${secret}.`));
    expect((await alice.askOk('What is the temporary access phrase?', { documentIds: [docId] })).answer).toContain(secret);

    expect((await alice.deleteDocument(docId)).status()).toBe(204);
    await expectCleanError(await alice.ask('What is the temporary access phrase?', { documentIds: [docId] }), 404);
    const broad = await alice.askOk('What is the temporary access phrase?');
    expect(broad.answer).not.toContain(secret);
    expect(broad.answer).toMatch(NOT_FOUND);
  });
});
