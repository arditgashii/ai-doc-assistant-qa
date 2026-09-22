# AI Document Assistant: QA Automation

Risk based Playwright suite for an AI-powered document assistant (sign in, upload PDF/DOCX, ask questions, get AI answers, view history, share conversations).

The suite runs against a small mock of the product included in this repo, so it works out of the box. Point `BASE_URL` at a real environment to run the same tests against staging.

## Why these tests

Tests are ordered by release risk, based on the reported issues:

| Reported issue | Covered by |
|---|---|
| Users seeing information from another document | `tests/security/isolation.spec.ts`: canary based cross-user checks, IDOR, sharing, revoke, deletion |
| AI invents information | `tests/ai/golden.spec.ts` + `data/golden.json`, `tests/ai/behavior.spec.ts` |
| Error after submitting a question | `tests/api/question.spec.ts`, `tests/reliability/reliability.spec.ts` |
| Large documents fail to upload | `tests/api/upload.spec.ts`: exact size limit and limit + 1 byte |
| 2 to 30 second responses | p50/p95/p99 report in reliability, loading and double submit checks in E2E |

## Key ideas

- **Canary tokens for data isolation.** Every document gets a unique marker like `ALICE-9F3A12C0`. If it appears anywhere outside its owner's account, the test fails. This is the check that should block a release.
- **Golden dataset for AI answers.** `data/golden.json` holds document, question, what the answer must and must not contain, and whether it should cite, refuse, flag a conflict or correct a false premise. Add a case for every production bug.
- **Citations are verified.** Every quoted citation must exist word for word in the source document. A quote that isn't in the document is a hallucination.
- **Clean errors only.** Every failure path must return JSON with a user facing message and no stack trace. Never a raw 500.
- **Volume over luck.** Intermittent 500s are found by repetition and concurrency, not by rerunning once.
- **No retries.** With AI features, retries hide the bugs we care about. A flaky test is a finding.
- **The suite tests itself.** `npm run test:bugs` switches on known defects in the mock (`leak`, `hallucinate`, `raw500`, `share`) and checks that the suite goes red for each one.

## Structure

```
mock-server/          system under test (zero dependencies)
tests/
  support/            fixtures: logged in users, upload/ask helpers, clean error assertion
  security/           release blockers: isolation, IDOR, sharing, deletion
  api/                auth, upload, question API (functional, negative, boundary, failures)
  ai/                 golden dataset + AI behavior (grounding, contradictions, injection, consistency)
  reliability/        repeated concurrent requests, error rate, latency percentiles
  e2e/                critical UI flow only
data/golden.json      AI evaluation dataset
scripts/prove-bugs.js mutation check: suite must fail when bugs are switched on
```

## Run

```bash
npm install
npx playwright install chromium   # only needed for e2e

npm test                  # everything
npm run test:smoke        # release blockers and happy path
npm run test:api          # API + security
npm run test:ai           # AI evaluation
npm run test:reliability  # 150 concurrent requests, p95 budget
npm run test:e2e          # UI flow
npm run test:bugs         # prove the suite catches known defects
```

Useful env vars: `BASE_URL`, `MOCK_BUGS`, `RELIABILITY_RUNS`, `P95_BUDGET_MS`, `MAX_UPLOAD_BYTES`.

## Current result

- 70 tests, all passing against the mock.
- With defects switched on: `leak` fails 3 isolation tests, `hallucinate` fails 2 AI tests, `raw500` fails the reliability test, `share` fails the sharing test.

## CI

`.github/workflows/qa.yml`

- On every PR: API + security, AI eval, E2E, and the "suite catches bugs" check, as separate jobs so a failure points straight at the area.
- Nightly: reliability with 500 requests.

## What stays manual

Exploratory testing of AI answers, usability, fast changing features, and reviewing failed AI evaluations. A human decides whether a differently worded answer is actually wrong.

## Against a real model

The rule based checks stay the same. On a real LLM I would add an LLM judge score for faithfulness and relevance per golden case (for example with promptfoo, Ragas or DeepEval), run each case several times to measure variance, and compare scores between model versions before approving a model change.

## Notes

- The mock takes uploads as JSON with base64 content and reads text after the file header. Real PDF/DOCX parsing is out of scope; the contract being tested is the same.
- Test users: `alice` (finance), `bob` (engineering), `carol` (hr), password `password123` (mock only).
