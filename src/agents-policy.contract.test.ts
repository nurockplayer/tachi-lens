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
  // quota exhausted、skipped、disabled、cancelled、timed out → NOT A REVIEW
  expect(doc).toMatch(/Codex quota exhausted／額度用盡/s);
  expect(doc).toMatch(/CodeRabbit review skipped/s);
  expect(doc).toMatch(/Auto reviews disabled/s);
  expect(doc).toMatch(/Cancelled、timed out/s);

  // skipped SUCCESS 不等於 APPROVE
  expect(doc).toMatch(/SUCCESS.*不得自行等同.*APPROVE/s);

  // issue-level bot 通知且無 finding → 不觸發 address-comments
  expect(doc).toMatch(/只有 issue-level bot 通知/s);
  expect(doc).toMatch(/沒有 finding、inline comment、review thread 或正式 verdict/s);

  // 無 unresolved thread → 不執行 resolve-thread
  expect(doc).toMatch(/unresolved review threads/s);

  // merged PR 後收到這類通知為 no-op
  expect(doc).toMatch(/已 merged 後才收到此類通知時，判定為 no-op/s);

  // CI、有效 review、threads、exact head SHA 分開判定
  expect(doc).toMatch(/Merge gate 必須分開判定/s);
  expect(doc).toMatch(/exact head SHA/s);

  // automated review 未執行時，有效 independent reviewer APPROVE 仍可滿足 review gate
  expect(doc).toMatch(/已有符合政策的獨立 reviewer 正式.*APPROVE.*不得因此阻擋 merge/s);

  // 狀態格式
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
