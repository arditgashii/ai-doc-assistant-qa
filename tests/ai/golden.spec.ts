import fs from 'fs';
import path from 'path';
import { test, expect, pdf, NOT_FOUND } from '../support/fixtures';

type GoldenCase = {
  id: string;
  document: string;
  documentRepeat?: { filler: string; times: number };
  question: string;
  mustContain?: string[];
  mustNotContain?: string[];
  expectCitation?: boolean;
  expectNotFound?: boolean;
  expectRefusal?: boolean;
  expectCorrectedPremise?: boolean;
};

const golden: { cases: GoldenCase[] } = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/golden.json'), 'utf8'));

/**
 * Rule based evaluation against a golden dataset.
 * On a real model these rules stay, and an LLM judge score for faithfulness is added on top.
 * Add a case every time a production bug is found.
 */
test.describe('AI golden dataset @ai', () => {
  for (const c of golden.cases) {
    test(c.id, async ({ alice }) => {
      const text = c.documentRepeat
        ? `${Array(c.documentRepeat.times).fill(c.documentRepeat.filler).join('\n')}\n${c.document}`
        : c.document;
      const docId = await alice.uploadOk(`${c.id}.pdf`, pdf(text));
      const res = await alice.askOk(c.question, { documentIds: [docId] });

      for (const s of c.mustContain ?? []) expect(res.answer, `must contain "${s}"`).toContain(s);
      for (const s of c.mustNotContain ?? []) expect(res.answer, `must not contain "${s}"`).not.toContain(s);

      if (c.expectCitation) {
        expect(res.citations.length, 'answer is backed by a citation').toBeGreaterThan(0);
        for (const cit of res.citations) {
          expect(cit.documentId).toBe(docId);
          expect(text, 'citation quote really exists in the source').toContain(cit.quote);
        }
      }
      if (c.expectNotFound) {
        expect(res.answer).toMatch(NOT_FOUND);
        expect(res.citations).toHaveLength(0);
      }
      if (c.expectRefusal) expect(res.answer).toMatch(/can't share/i);
      if (c.expectCorrectedPremise) expect(res.correctedPremise).toBe(true);
    });
  }
});
