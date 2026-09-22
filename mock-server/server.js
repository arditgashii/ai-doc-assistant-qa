// Mock of the AI-powered document assistant used as the system under test.
// Zero dependencies. Behaves like a small RAG app: users upload documents,
// ask questions, and get answers grounded in their own documents only.
//
// MOCK_BUGS lets you switch on known defects to prove the suite catches them:
//   MOCK_BUGS=leak         retrieval ignores document ownership (cross-user leak)
//   MOCK_BUGS=hallucinate  answers are invented when nothing relevant is found
//   MOCK_BUGS=raw500       ~5% of questions fail with an unhandled 500
//   MOCK_BUGS=share        shared conversations expose the owner's documents
// Combine with commas, e.g. MOCK_BUGS=leak,raw500

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 3000);
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 5 * 1024 * 1024);
const MAX_QUESTION_CHARS = 2000;
const LATENCY_MS = Number(process.env.SIMULATED_LATENCY_MS || 20);
const BUGS = new Set((process.env.MOCK_BUGS || '').split(',').map((s) => s.trim()).filter(Boolean));

const USERS = {
  alice: { password: 'password123', department: 'finance' },
  bob: { password: 'password123', department: 'engineering' },
  carol: { password: 'password123', department: 'hr' },
};

const sessions = new Map(); // token -> { username, expiresAt }
const documents = new Map(); // id -> { id, owner, name, type, text, status }
const conversations = new Map(); // id -> { id, owner, sharedWith:Set, documentIds, messages }

const id = (prefix) => `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- helpers ----------

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json',
    ...headers,
  });
  res.end(payload);
}

const error = (res, status, code, message, extra = {}) =>
  send(res, status, { error: { code, message, ...extra } });

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req, res, limit = 64 * 1024) {
  let raw;
  try {
    raw = await readBody(req, limit);
  } catch (e) {
    error(res, e.status || 400, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
    return undefined;
  }
  if (!(req.headers['content-type'] || '').includes('application/json')) {
    error(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json.');
    return undefined;
  }
  try {
    return JSON.parse(raw || '{}');
  } catch {
    error(res, 400, 'INVALID_JSON', 'Request body is not valid JSON.');
    return undefined;
  }
}

function auth(req, res) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const session = token && sessions.get(token);
  if (!session) {
    error(res, 401, 'UNAUTHORIZED', 'Missing or invalid token.');
    return null;
  }
  if (session.expiresAt < Date.now()) {
    sessions.delete(token);
    error(res, 401, 'TOKEN_EXPIRED', 'Session expired. Please sign in again.');
    return null;
  }
  return { ...session, token };
}

// ---------- document parsing ----------

function detectType(buf) {
  if (buf.slice(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return 'docx';
  return null;
}

// The mock "parses" documents by reading the text after the file header.
// Real PDF/DOCX parsing is out of scope; the contract under test is the same.
function extractText(buf, type) {
  const raw = buf.toString('utf8');
  const body = type === 'pdf' ? raw.replace(/^%PDF-[\d.]+\s*/, '') : raw.slice(4);
  if (/^\s*\[encrypted\]/i.test(body)) return { error: 'ENCRYPTED' };
  if (/^\s*\[image-only\]/i.test(body)) return { error: 'NO_TEXT' };
  return { text: body.replace(/\u0000/g, '').trim() };
}

// ---------- the "AI" ----------

const STOP = new Set(
  'a an the is are was were be of to in on for and or what which who whom how why when where does do did i you it this that with as by at from about my our your me show tell please can could would should there their they them'.split(
    ' ',
  ),
);

const tokens = (s) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s%.-]/gu, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^[.-]+|[.-]+$/g, ''))
    .filter((t) => t && !STOP.has(t));

const numbersIn = (s) => (s.match(/\d+(?:[.,]\d+)?%?/g) || []);

function sentencesOf(doc) {
  return doc.text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    // Hidden or injected instructions are stored but never treated as knowledge.
    .filter((s) => s && !/^\[hidden\]/i.test(s) && !/ignore (all |previous |the )?instructions/i.test(s))
    .map((s) => ({ text: s, doc }));
}

function retrieve(question, docs) {
  const q = new Set(tokens(question));
  if (!q.size) return [];
  return docs
    .flatMap(sentencesOf)
    .map((s) => {
      const t = new Set(tokens(s.text));
      let hits = 0;
      q.forEach((w) => t.has(w) && hits++);
      return { ...s, score: hits / q.size, hits };
    })
    .filter((s) => s.hits >= 2 || (q.size <= 2 && s.hits >= 1))
    .sort((a, b) => b.score - a.score);
}

const NOT_FOUND = "I can't find this in your documents.";

function answer(question, docs) {
  if (/(system prompt|your instructions|reveal.*prompt|admin mode)/i.test(question)) {
    return { answer: "I can't share my internal instructions. I can help with questions about your documents.", citations: [] };
  }
  const hits = retrieve(question, docs);
  if (!hits.length || hits[0].score < 0.34) {
    if (BUGS.has('hallucinate')) {
      return { answer: 'According to your document, the answer is 42 and it was approved by the board in 2021.', citations: [] };
    }
    return { answer: NOT_FOUND, citations: [] };
  }
  const top = hits.filter((h) => h.score >= hits[0].score - 0.2).slice(0, 3);
  const cite = (h) => ({ documentId: h.doc.id, documentName: h.doc.name, quote: h.text });

  // Contradiction: best matches carry different numbers.
  const nums = [...new Set(top.flatMap((h) => numbersIn(h.text)))];
  if (top.length > 1 && nums.length > 1) {
    const parts = top.map((h) => `"${h.text}" (${h.doc.name})`).join(' but ');
    return { answer: `The documents contain conflicting information: ${parts}.`, citations: top.map(cite), conflict: true };
  }

  // False premise: question states a number the source does not support.
  const qNums = numbersIn(question);
  const srcNums = numbersIn(top[0].text);
  if (qNums.length && srcNums.length && !qNums.some((n) => srcNums.includes(n))) {
    return {
      answer: `That doesn't match the document. It says: "${top[0].text}"`,
      citations: [cite(top[0])],
      correctedPremise: true,
    };
  }

  const best = top[0];
  return { answer: `${best.text} [${best.doc.name}]`, citations: [cite(best)] };
}

// ---------- routes ----------

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean);
  const route = `${req.method} /${parts.map((p, i) => (i > 1 && /^(doc|conv)_/.test(p) ? ':id' : p)).join('/')}`;

  if (req.method === 'GET' && url.pathname === '/') {
    return send(res, 200, fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8'));
  }
  if (route === 'GET /health') return send(res, 200, { status: 'ok', bugs: [...BUGS] });

  if (route === 'POST /api/login') {
    const body = await readJson(req, res);
    if (!body) return;
    const user = USERS[body.username];
    if (!user || user.password !== body.password) return error(res, 401, 'INVALID_CREDENTIALS', 'Wrong username or password.');
    const token = crypto.randomBytes(24).toString('hex');
    const ttl = Math.min(Number(body.ttlMs) || 60 * 60 * 1000, 60 * 60 * 1000);
    sessions.set(token, { username: body.username, expiresAt: Date.now() + ttl });
    return send(res, 200, { token, username: body.username, expiresInMs: ttl });
  }

  const me = auth(req, res);
  if (!me) return;

  if (route === 'POST /api/logout') {
    sessions.delete(me.token);
    return send(res, 204, '');
  }

  if (route === 'POST /api/documents') {
    // base64 inflates size by ~4/3, so the raw body limit is a bit larger than the file limit
    const body = await readJson(req, res, Math.ceil(MAX_UPLOAD_BYTES * 1.4) + 4096);
    if (!body) return;
    if (!body.name || typeof body.contentBase64 !== 'string') {
      return error(res, 400, 'VALIDATION_ERROR', 'name and contentBase64 are required.');
    }
    const buf = Buffer.from(body.contentBase64, 'base64');
    if (buf.length === 0) return error(res, 400, 'EMPTY_FILE', 'The file is empty.');
    if (buf.length > MAX_UPLOAD_BYTES) {
      return error(res, 413, 'FILE_TOO_LARGE', `File exceeds the ${MAX_UPLOAD_BYTES} byte limit.`, { maxBytes: MAX_UPLOAD_BYTES });
    }
    const type = detectType(buf);
    if (!type) return error(res, 415, 'UNSUPPORTED_FORMAT', 'Only PDF and DOCX files are supported.');
    const parsed = extractText(buf, type);
    if (parsed.error === 'ENCRYPTED') return error(res, 422, 'ENCRYPTED_FILE', 'Password protected files are not supported.');
    if (parsed.error === 'NO_TEXT' || !parsed.text) {
      return error(res, 422, 'NO_READABLE_TEXT', "We couldn't read any text in this file.");
    }
    const doc = { id: id('doc'), owner: me.username, name: String(body.name).slice(0, 255), type, text: parsed.text, status: 'ready' };
    documents.set(doc.id, doc);
    return send(res, 201, { id: doc.id, name: doc.name, type, status: doc.status, bytes: buf.length });
  }

  if (route === 'GET /api/documents') {
    const mine = [...documents.values()].filter((d) => d.owner === me.username).map(({ id, name, type, status }) => ({ id, name, type, status }));
    return send(res, 200, { documents: mine });
  }

  if (route === 'DELETE /api/documents/:id') {
    const doc = documents.get(parts[2]);
    if (!doc || doc.owner !== me.username) return error(res, 404, 'NOT_FOUND', 'Document not found.');
    documents.delete(doc.id);
    return send(res, 204, '');
  }

  if (route === 'POST /api/questions') {
    const body = await readJson(req, res);
    if (!body) return;
    const question = typeof body.question === 'string' ? body.question.trim() : '';
    if (!question) return error(res, 400, 'VALIDATION_ERROR', 'Question must not be empty.');
    if (body.question.length > MAX_QUESTION_CHARS) {
      return error(res, 400, 'QUESTION_TOO_LONG', `Question must be at most ${MAX_QUESTION_CHARS} characters.`, { maxChars: MAX_QUESTION_CHARS });
    }

    let conv = body.conversationId ? conversations.get(body.conversationId) : null;
    if (body.conversationId && (!conv || conv.owner !== me.username)) {
      const canUseShared = BUGS.has('share') && conv && conv.sharedWith.has(me.username);
      if (!canUseShared) return error(res, 404, 'NOT_FOUND', 'Conversation not found.');
    }

    const requested = body.documentIds || (conv ? conv.documentIds : null);
    let docs;
    if (requested) {
      if (!Array.isArray(requested) || requested.length === 0) return error(res, 400, 'VALIDATION_ERROR', 'documentIds must be a non-empty array.');
      if (requested.length > 20) return error(res, 400, 'TOO_MANY_DOCUMENTS', 'At most 20 documents per question.');
      docs = requested.map((d) => documents.get(d));
      const allowed = (d) => d && (d.owner === me.username || BUGS.has('leak') || (BUGS.has('share') && conv));
      if (docs.some((d) => !allowed(d))) return error(res, 404, 'DOCUMENT_NOT_FOUND', 'One or more documents were not found.');
    } else {
      docs = [...documents.values()].filter((d) => BUGS.has('leak') || d.owner === me.username);
    }

    // Controlled failure simulation, used by reliability tests.
    const simulate = req.headers['x-simulate-failure'];
    await sleep(LATENCY_MS + Math.floor(Math.random() * LATENCY_MS));
    if (simulate === 'timeout') {
      return error(res, 504, 'AI_TIMEOUT', 'The AI service took too long to respond. Please try again.', { retryable: true });
    }
    if (simulate === 'rate-limit') {
      res.setHeader('retry-after', '2');
      return error(res, 503, 'AI_BUSY', 'The AI service is busy. Please try again shortly.', { retryable: true });
    }
    if (BUGS.has('raw500') && Math.random() < 0.05) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      return res.end('TypeError: Cannot read properties of undefined (reading "chunks")');
    }

    const result = answer(question, docs);
    if (!conv) {
      conv = { id: id('conv'), owner: me.username, sharedWith: new Set(), documentIds: docs.filter((d) => d.owner === me.username).map((d) => d.id), messages: [] };
      conversations.set(conv.id, conv);
    }
    conv.messages.push({ role: 'user', content: question, at: Date.now() }, { role: 'assistant', content: result.answer, citations: result.citations, at: Date.now() });
    return send(res, 200, { conversationId: conv.id, ...result });
  }

  if (route === 'GET /api/conversations') {
    const list = [...conversations.values()]
      .filter((c) => c.owner === me.username || c.sharedWith.has(me.username))
      .map((c) => ({ id: c.id, owner: c.owner, messageCount: c.messages.length }));
    return send(res, 200, { conversations: list });
  }

  if (route === 'GET /api/conversations/:id') {
    const conv = conversations.get(parts[2]);
    if (!conv || (conv.owner !== me.username && !conv.sharedWith.has(me.username))) return error(res, 404, 'NOT_FOUND', 'Conversation not found.');
    return send(res, 200, { id: conv.id, owner: conv.owner, messages: conv.messages, shared: conv.owner !== me.username });
  }

  if (route === 'POST /api/conversations/:id/share') {
    const conv = conversations.get(parts[2]);
    if (!conv || conv.owner !== me.username) return error(res, 404, 'NOT_FOUND', 'Conversation not found.');
    const body = await readJson(req, res);
    if (!body) return;
    if (!USERS[body.username] || body.username === me.username) return error(res, 400, 'VALIDATION_ERROR', 'Invalid user to share with.');
    conv.sharedWith.add(body.username);
    return send(res, 200, { id: conv.id, sharedWith: [...conv.sharedWith] });
  }

  if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'conversations' && parts[3] === 'share' && parts[4]) {
    const conv = conversations.get(parts[2]);
    if (!conv || conv.owner !== me.username) return error(res, 404, 'NOT_FOUND', 'Conversation not found.');
    conv.sharedWith.delete(parts[4]);
    return send(res, 204, '');
  }

  return error(res, 404, 'NOT_FOUND', 'Route not found.');
}

http
  .createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) error(res, 500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.', { retryable: true });
    });
  })
  .listen(PORT, () => console.log(`Mock AI document assistant on http://localhost:${PORT} bugs=[${[...BUGS]}]`));
