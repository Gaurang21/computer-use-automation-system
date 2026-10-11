import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RunLogger } from '../../src/evidence/logger.js';
import { Redactor } from '../../src/policy/redact.js';

describe('RunLogger', () => {
  it('writes ordered, redacted events to run.jsonl', () => {
    const redactor = new Redactor();
    redactor.addKnown('10001', 'identifier');
    redactor.addKnown('change-me-local-only', 'secret');
    const log = RunLogger.create(mkdtempSync(join(tmpdir(), 'runs-')), 'replay', redactor);
    log.event({ actor: 'automation', type: 'act', stepId: 's2', intent: 'Enter the member ID', detail: { text: '10001' } });
    log.event({ actor: 'automation', type: 'act', stepId: 'login', detail: { typed: 'change-me-local-only' } });
    log.event({ actor: 'system', type: 'result', detail: { balance: '$12,540.32' } });

    const lines = readFileSync(log.logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.seq)).toEqual([1, 2, 3]);
    expect(lines[0]).toMatchObject({ runId: log.runId, actor: 'automation', type: 'act', stepId: 's2' });
    const raw = readFileSync(log.logPath, 'utf8');
    expect(raw).not.toMatch(/10001|change-me-local-only|12,540/);
    expect(raw).toContain('***01');
    expect(raw).toContain('[SECRET]');
  });

  it('redacts JSON documents written into the run folder', () => {
    const redactor = new Redactor();
    redactor.addKnown('Avery Lindqvist', 'pii');
    const log = RunLogger.create(mkdtempSync(join(tmpdir(), 'runs-')), 'replay', redactor);
    const path = log.writeJson('result.json', { outputs: { memberName: 'Avery Lindqvist' } });
    expect(readFileSync(path, 'utf8')).toContain('[REDACTED:pii]');
  });
});
