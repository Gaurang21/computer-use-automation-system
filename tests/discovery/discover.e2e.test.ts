import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { discover } from '../../src/discovery/discover.js';
import { FakeBrain } from '../../src/discovery/fake-brain.js';
import { loadGoal } from '../../src/discovery/goal.js';
import { SpendTracker } from '../../src/discovery/spend.js';
import { loadPolicy } from '../../src/policy/gate.js';
import { replay } from '../../src/replay/engine.js';
import { CapabilityStore } from '../../src/replay/store.js';
import { Capability } from '../../src/schema/capability.js';
import { startTenant, type RunningTenant } from '../support/memberdesk.js';

describe('discovery with the fake LLM, then replay of what it produced', () => {
  let app: RunningTenant;
  let outDir: string;
  let result: Awaited<ReturnType<typeof discover>>;
  const spec = loadGoal('goals/member.lookup_savings_balance.json');

  beforeAll(async () => {
    app = await startTenant('tenant-a');
    outDir = mkdtempSync(join(tmpdir(), 'caps-'));
    const spend = new SpendTracker(1);
    result = await discover({
      spec,
      brain: new FakeBrain(spec.fake ?? { turns: [], classify: [] }),
      spend,
      policy: { ...loadPolicy(), allowedOrigins: [app.baseUrl] },
      tenantId: 'tenant-a',
      outDir,
      baseUrl: app.baseUrl,
      evidenceDir: mkdtempSync(join(tmpdir(), 'runs-')),
    });
  }, 120_000);
  afterAll(() => app.close());

  it('finishes the loop, passes the self-check and saves the capability', () => {
    expect(result.trace.status).toBe('done');
    expect(result.selfCheck).toBe('success');
    expect(result.status).toBe('saved');
    expect(existsSync(result.savedTo ?? '')).toBe(true);
  });

  it('compiles bindings and robust targets, never literal values', () => {
    const raw = readFileSync(result.savedTo ?? '', 'utf8');
    const cap = Capability.parse(JSON.parse(raw));
    expect(cap.provenance).toMatchObject({
      source: 'discovery',
      discoveryRunId: result.runId,
      model: 'fake-llm',
    });
    expect(cap.steps.map((s) => s.action)).toEqual(['click', 'type', 'click', 'read', 'read']);
    expect(cap.steps[1]?.value).toEqual({ from: 'inputs.memberId' });
    const s2 = cap.steps[1]?.target;
    expect(s2 && 'locators' in s2 ? s2.locators[0] : undefined).toMatchObject({
      kind: 'label_anchor',
      label: 'Member ID',
    });
    expect(cap.steps[4]?.target).toMatchObject({
      kind: 'table_cell',
      rowWhere: { column: 'Type', equals: 'Savings' },
      column: 'Balance',
    });
    // The model proposed nothing for s1, so the expectation came from a verified text diff.
    expect(cap.steps[0]?.expect).toEqual({ textPresent: 'Find a member' });
    for (const literal of [
      '10001',
      '99999',
      'Avery Lindqvist',
      '12,540.32',
      'change-me-local-only',
      'teller01',
    ]) {
      expect(raw).not.toContain(literal);
    }
  });

  it('learns MEMBER_NOT_FOUND from a probe run', () => {
    const cap = Capability.parse(JSON.parse(readFileSync(result.savedTo ?? '', 'utf8')));
    expect(cap.outcomes).toEqual([
      expect.objectContaining({
        code: 'MEMBER_NOT_FOUND',
        afterSteps: ['s3'],
        detect: { textPresent: 'No member found' },
        source: 'probe',
      }),
    ]);
    expect(cap.provenance.probeRunIds).toHaveLength(1);
  });

  it('writes the evidence a reviewer needs, with spend recorded', () => {
    for (const f of [
      'run.jsonl',
      'usage.json',
      'capability.draft.json',
      'discovery-result.json',
      'screenshots/step-01.png',
    ]) {
      expect(existsSync(join(result.dir, f))).toBe(true);
    }
    expect(JSON.parse(readFileSync(join(result.dir, 'usage.json'), 'utf8'))).toMatchObject({
      totalUsd: 0,
      calls: 0,
    });
    expect(readFileSync(join(result.dir, 'run.jsonl'), 'utf8')).not.toMatch(/10001|Avery|12,540/);
    // The transcript holds the full screens shown to the model, written after every value is known.
    const transcript = readFileSync(join(result.dir, 'transcript.redacted.jsonl'), 'utf8');
    expect(transcript).toContain('Member Detail');
    expect(transcript).not.toMatch(/10001|Avery Lindqvist|12,540/);
  });

  it('replays the discovered capability: success, and the probed business outcome', async () => {
    const store = new CapabilityStore('capabilities', 'memberdesk', [outDir]);
    const run = (memberId: string) =>
      replay({
        store,
        capabilityId: spec.capabilityId,
        tenantId: 'tenant-a',
        inputs: { memberId },
        policy: { ...loadPolicy(), allowedOrigins: [app.baseUrl] },
        baseUrl: app.baseUrl,
        allowDraft: true,
        evidenceDir: mkdtempSync(join(tmpdir(), 'runs-')),
      });
    const ok = await run('10003');
    expect(ok.status === 'success' && ok.outputs).toEqual({
      memberName: 'Riley Castellanos',
      savingsBalance: { amountMinor: 3120450, currency: 'USD' },
    });
    expect(await run('99999')).toMatchObject({
      status: 'business_outcome',
      code: 'MEMBER_NOT_FOUND',
    });
  });
});
