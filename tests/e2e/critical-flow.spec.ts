import { test, expect } from '@playwright/test';

const pdfFile = (text: string) => ({ name: 'guide.pdf', mimeType: 'application/pdf', buffer: Buffer.from(`%PDF-1.4\n${text}`) });

test.describe('Critical user flow @e2e', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Username').fill('alice');
    await page.getByLabel('Password').fill('password123');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Signed in as')).toBeVisible();
  });

  test('Sign in, upload a PDF, ask a question, see a grounded answer', async ({ page }) => {
    await page.getByLabel('Choose document').setInputFiles(pdfFile('The support hotline is open until 20:00.'));
    await expect(page.getByText('Uploaded guide.pdf')).toBeVisible();

    await page.getByLabel('Question').fill('Until when is the support hotline open?');
    await page.getByRole('button', { name: 'Ask' }).click();
    await expect(page.locator('#answer')).toContainText('20:00');
  });

  test('Ask button is disabled while waiting, preventing double submit', async ({ page }) => {
    await page.route('**/api/questions', async (route) => {
      await new Promise((r) => setTimeout(r, 800));
      await route.continue();
    });
    await page.getByLabel('Question').fill('Anything?');
    await page.getByRole('button', { name: 'Ask' }).click();
    await expect(page.getByRole('button', { name: 'Ask' })).toBeDisabled();
    await expect(page.getByText('Thinking...')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ask' })).toBeEnabled({ timeout: 10_000 });
  });

  test('Unsupported file shows a readable error', async ({ page }) => {
    await page.getByLabel('Choose document').setInputFiles({ name: 'notes.pdf', mimeType: 'application/pdf', buffer: Buffer.from('not really a pdf') });
    await expect(page.getByText('Only PDF and DOCX files are supported.')).toBeVisible();
  });

  test('AI timeout shows a friendly message, not a crash', async ({ page }) => {
    await page.route('**/api/questions', (route) =>
      route.fulfill({
        status: 504,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'AI_TIMEOUT', message: 'The AI service took too long to respond. Please try again.' } }),
      }),
    );
    await page.getByLabel('Question').fill('Anything?');
    await page.getByRole('button', { name: 'Ask' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'took too long' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ask' })).toBeEnabled();
  });
});
