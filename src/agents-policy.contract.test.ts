import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * DOCUMENTATION_CONTRACT_TEST
 *
 * These tests assert that BOTH controller rule documents (CLAUDE.md and
 * AGENTS.md, which are mirrored) contain the automated-review validation
 * rules that prevent bot notices from being mistaken for real reviews.
 *
 * They are documentation contract tests, NOT ci-monitor behavior tests:
 * this repository has no automated-review parser/router and no CI-monitor
 * implementation. The tests only assert the rule documents instruct a future
 * controller/codex to discriminate real reviews from skipped/quota notices.
 */
const repoRoot = process.cwd();
const ruleDocs: Record<string, string> = {
  'CLAUDE.md': readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf-8'),
  'AGENTS.md': readFileSync(join(repoRoot, 'AGENTS.md'), 'utf-8'),
};

function expectCoreRules(doc: string) {
  // quota exhausted, skipped, disabled, cancelled, timed out → NOT A REVIEW
  expect(doc).toMatch(/Codex quota exhausted/s);
  expect(doc).toMatch(/CodeRabbit review skipped/s);
  expect(doc).toMatch(/Auto reviews disabled/s);
  expect(doc).toMatch(/Cancelled, timed out/s);

  // a skipped SUCCESS is not equal to APPROVE
  expect(doc).toMatch(/SUCCESS.*must not be equated with.*APPROVE/s);

  // an issue-level bot notice without a finding → no address-comments
  expect(doc).toMatch(/Only an issue-level bot notice/s);
  expect(doc).toMatch(/no finding, inline comment, review thread, or formal verdict/s);

  // no unresolved thread → no resolve-thread
  expect(doc).toMatch(/unresolved review threads/s);

  // notices received after the PR is merged are a no-op
  expect(doc).toMatch(/after the PR has already been merged, treat it as a no-op/s);

  // CI, valid review, threads, and exact head SHA are assessed separately
  expect(doc).toMatch(/The merge gate must be assessed separately/s);
  expect(doc).toMatch(/exact head SHA/s);

  // a valid independent reviewer APPROVE still satisfies the review gate when
  // the automated review did not run
  expect(doc).toMatch(/policy-compliant independent reviewer.*APPROVE.*must not block the merge/s);

  // status formats
  expect(doc).toMatch(/CodeRabbit: SKIPPED \/ NOT A REVIEW/s);
  expect(doc).toMatch(/Codex review: NOT RUN — QUOTA EXHAUSTED/s);
  expect(doc).toMatch(/Independent reviewer: APPROVE/s);

  // repository reference
  expect(doc).toMatch(/CodeRabbit auto reviews are currently disabled in this repository\./s);
}

describe('DOCUMENTATION_CONTRACT_TEST: automated-review validation rules in both rule documents', () => {
  for (const [name, doc] of Object.entries(ruleDocs)) {
    describe(name, () => {
      it('contains the core NOT A REVIEW discriminations', () => {
        expectCoreRules(doc);
      });
    });
  }
});
