import { test as base, expect, APIRequestContext, APIResponse } from '@playwright/test';
import { randomBytes } from 'crypto';

export const PASSWORD = 'password123';

/** Build a minimal file the mock parser accepts. The magic bytes are what matter. */
export const pdf = (text: string) => Buffer.from(`%PDF-1.4\n${text}`, 'utf8');
export const docx = (text: string) => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(text, 'utf8')]);

/** A unique marker that must never appear outside its owner's account. */
export const canary = (label = 'CANARY') => `${label}-${randomBytes(4).toString('hex').toUpperCase()}`;

export class Client {
  constructor(
    public readonly request: APIRequestContext,
    public readonly username: string,
    public token = '',
  ) {}

  static async login(request: APIRequestContext, username: string, opts: { ttlMs?: number } = {}) {
    const res = await request.post('/api/login', { data: { username, password: PASSWORD, ...opts } });
    expect(res.status(), `login as ${username}`).toBe(200);
    return new Client(request, username, (await res.json()).token);
  }

  get headers() {
    return { authorization: `Bearer ${this.token}` };
  }

  upload(name: string, content: Buffer) {
    return this.request.post('/api/documents', {
      headers: this.headers,
      data: { name, contentBase64: content.toString('base64') },
    });
  }

  async uploadOk(name: string, content: Buffer): Promise<string> {
    const res = await this.upload(name, content);
    expect(res.status(), await res.text()).toBe(201);
    return (await res.json()).id;
  }

  ask(question: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
    return this.request.post('/api/questions', {
      headers: { ...this.headers, ...headers },
      data: { question, ...extra },
    });
  }

  async askOk(question: string, extra: Record<string, unknown> = {}) {
    const res = await this.ask(question, extra);
    expect(res.status(), await res.text()).toBe(200);
    return res.json() as Promise<AskResult>;
  }

  getConversation(id: string) {
    return this.request.get(`/api/conversations/${id}`, { headers: this.headers });
  }

  share(conversationId: string, username: string) {
    return this.request.post(`/api/conversations/${conversationId}/share`, { headers: this.headers, data: { username } });
  }

  unshare(conversationId: string, username: string) {
    return this.request.delete(`/api/conversations/${conversationId}/share/${username}`, { headers: this.headers });
  }

  deleteDocument(id: string) {
    return this.request.delete(`/api/documents/${id}`, { headers: this.headers });
  }
}

export type AskResult = {
  conversationId: string;
  answer: string;
  citations: { documentId: string; documentName: string; quote: string }[];
  conflict?: boolean;
  correctedPremise?: boolean;
};

export const NOT_FOUND = /can't find this in your documents/i;

/** Every error should be a clean JSON error, never a stack trace or raw text. */
export async function expectCleanError(res: APIResponse, status: number, code?: string) {
  expect(res.status()).toBe(status);
  expect(res.headers()['content-type']).toContain('application/json');
  const body = await res.json();
  expect(body.error?.message, 'error has a user facing message').toBeTruthy();
  expect(JSON.stringify(body)).not.toMatch(/TypeError|at .*\.js:\d+|stack/i);
  if (code) expect(body.error.code).toBe(code);
  return body;
}

type Users = { alice: Client; bob: Client; carol: Client };

export const test = base.extend<Users>({
  alice: async ({ request }, use) => use(await Client.login(request, 'alice')),
  bob: async ({ request }, use) => use(await Client.login(request, 'bob')),
  carol: async ({ request }, use) => use(await Client.login(request, 'carol')),
});

export { expect };
