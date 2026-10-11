import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppProfile } from '../src/schema/app-profile.js';
import { Capability } from '../src/schema/capability.js';
import { StateMatcher } from '../src/schema/matcher.js';
import { TenantOverlay } from '../src/schema/overlay.js';
import { EXPORTED, toJsonSchema } from '../src/schema/export.js';
import { RunResult, exitCodeFor } from '../src/schema/result.js';

const read = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));
const capDirs = ['capabilities/memberdesk', 'tests/fixtures/capabilities'];
const capabilityFiles = capDirs.flatMap((d) =>
  readdirSync(d)
    .filter((f) => f.endsWith('.json') && f !== 'app-profile.json')
    .map((f) => join(d, f)),
);

describe('artifact schemas', () => {
  it('validates the MemberDesk app profile', () => {
    expect(() => AppProfile.parse(read('capabilities/memberdesk/app-profile.json'))).not.toThrow();
  });

  it('validates both tenant overlays', () => {
    for (const t of ['tenant-a', 'tenant-b']) {
      expect(() =>
        TenantOverlay.parse(read(`capabilities/memberdesk/overlays/${t}.json`)),
      ).not.toThrow();
    }
  });

  it.each(capabilityFiles)('validates capability %s', (file) => {
    const parsed = Capability.safeParse(read(file));
    expect(parsed.error?.issues ?? []).toEqual([]);
  });

  it('rejects a step that binds an undeclared input', () => {
    const cap = read('tests/fixtures/capabilities/member.lookup_savings_balance.json') as {
      inputs: Record<string, unknown>;
    };
    cap.inputs = {};
    const r = Capability.safeParse(cap);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('undeclared input memberId');
  });

  it('rejects a click without a target and a literal value binding to a non-input', () => {
    const base = read('tests/fixtures/capabilities/member.lookup_savings_balance.json') as {
      steps: Record<string, unknown>[];
    };
    const noTarget = structuredClone(base);
    delete noTarget.steps[0]?.target;
    expect(JSON.stringify(Capability.safeParse(noTarget).error?.issues)).toContain(
      'click needs a target',
    );

    const badBinding = structuredClone(base);
    if (badBinding.steps[1]) badBinding.steps[1].value = { from: 'transcript.step3' };
    expect(Capability.safeParse(badBinding).success).toBe(false);
  });

  it('accepts nested state matchers and rejects unknown keys', () => {
    expect(
      StateMatcher.safeParse({
        all: [{ textPresent: 'Member Detail' }, { not: { textPresent: 'Savings' } }],
      }).success,
    ).toBe(true);
    expect(StateMatcher.safeParse({ textPresent: 'x', css: '#id' }).success).toBe(false);
  });

  it.each(Object.entries(EXPORTED))(
    'committed JSON Schema for %s is up to date (npm run schemas)',
    (name, schema) => {
      const committed = read(`schemas/${name}.schema.json`);
      expect(committed).toEqual(JSON.parse(JSON.stringify(toJsonSchema(schema))));
    },
  );

  it('maps result statuses to CLI exit codes 0, 10, 20', () => {
    const meta = {
      runId: 'r',
      capabilityId: 'c',
      version: '1.0.0',
      effectiveHash: 'h',
      tenantId: 't',
      startedAt: new Date().toISOString(),
      durationMs: 1,
      warnings: [],
      recoveries: [],
      locatorDrift: [],
      humanInterventions: [],
    };
    const ok = RunResult.parse({ status: 'success', outputs: {}, meta });
    const biz = RunResult.parse({
      status: 'business_outcome',
      code: 'X',
      message: 'm',
      atStep: 's1',
      meta,
    });
    const fail = RunResult.parse({
      status: 'failure',
      code: 'APP_ERROR',
      atStep: 's1',
      expected: 'e',
      observed: 'o',
      retryable: false,
      evidence: { log: 'run.jsonl' },
      meta,
    });
    expect([ok, biz, fail].map(exitCodeFor)).toEqual([0, 10, 20]);
  });
});
