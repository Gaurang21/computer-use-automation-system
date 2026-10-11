import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { discover } from '../../src/discovery/discover.js';
import { FakeBrain } from '../../src/discovery/fake-brain.js';
import { loadGoal } from '../../src/discovery/goal.js';
import { SpendTracker } from '../../src/discovery/spend.js';
import { loadPolicy } from '../../src/policy/gate.js';
import {
  OperatorDiscoveryEscalation,
  OperatorReplayEscalation,
} from '../../src/operator/escalation.js';
import { OperatorHub } from '../../src/operator/hub.js';
import { startOperatorServer } from '../../src/operator/server.js';
import { Capability } from '../../src/schema/capability.js';
import { startTenant, type RunningTenant } from '../support/memberdesk.js';
import { runReplay } from '../support/replay.js';

/** A scripted operator: it only uses the console's HTTP API, like the page does. */
class ScriptedOperator {
  constructor(private readonly url: string) {}
  async get<T>(path: string): Promise<T> {
    const r = await fetch(`${this.url}/api/interventions${path}`);
    return (await r.json()) as T;
  }
  async post(path: string, body: object = {}): Promise<{ status: number; json: unknown }> {
    const r = await fetch(`${this.url}/api/interventions${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json() };
  }
  async waitForOpen(timeoutMs = 30_000): Promise<Record<string, unknown> & { id: string }> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const open = (await this.get<{ id: string; status: string }[]>('')).filter(
        (i) => i.status === 'open',
      );
      if (open[0]) return open[0] as Record<string, unknown> & { id: string };
      await sleep(200);
    }
    throw new Error('no intervention opened');
  }
}

describe('human handoff through the operator console', () => {
  let app: RunningTenant;
  let hub: OperatorHub;
  let console_: { url: string; close: () => Promise<void> };
  let op: ScriptedOperator;

  beforeAll(async () => {
    app = await startTenant('tenant-a');
    hub = new OperatorHub([], 60_000);
    console_ = await startOperatorServer(hub, 0);
    op = new ScriptedOperator(console_.url);
  });
  afterAll(async () => {
    await console_.close();
    await app.close();
  });
  beforeEach(() => app.reset());

  it('operator takes the live session, clicks Acknowledge, hands back with retry, and the run succeeds', async () => {
    await app.arm({ switch: 'unknownDialog', path: '/app/search' });
    let dir = '';
    const running = runReplay(
      app,
      'member.lookup_savings_balance',
      { memberId: '10001' },
      {
        escalation: new OperatorReplayEscalation(hub),
        onStart: (i) => (dir = i.dir),
      },
    );

    const req = await op.waitForOpen();
    expect(req).toMatchObject({
      mode: 'replay',
      kind: 'stuck',
      reasonCode: 'UNEXPECTED_STATE',
      stepId: 's1',
      state: 'PAUSED_AWAITING_HUMAN',
      lease: 'none',
    });
    expect(String(req.observed)).toContain('Compliance Attestation');
    expect(existsSync(String(req.screenshot))).toBe(true);
    expect(req.handBackChoices).toEqual(['retry', 'continue', 'abort']);

    // Nobody holds the lease while paused: the operator must take control before acting.
    expect((await op.post(`/${req.id}/pointer`, { x: 1, y: 1 })).status).toBe(409);
    expect(
      (await op.post(`/${req.id}/take-control`, { operator: 'scripted-operator' })).status,
    ).toBe(200);
    expect((await op.get<{ lease: { owner: string } }>(`/${req.id}`)).lease.owner).toBe('human');

    const live = await fetch(`${console_.url}/api/interventions/${req.id}/live.png`);
    expect(live.headers.get('content-type')).toContain('image/png');

    const els = await op.get<
      { role: string; name: string; bbox: { x: number; y: number; w: number; h: number } }[]
    >(`/${req.id}/elements`);
    const ack = els.find((e) => e.role === 'button' && e.name === 'Acknowledge');
    expect(ack).toBeDefined();
    const b = ack?.bbox ?? { x: 0, y: 0, w: 0, h: 0 };
    const click = await op.post(`/${req.id}/pointer`, { x: b.x + b.w / 2, y: b.y + b.h / 2 });
    expect(click.json).toMatchObject({ action: 'pointer', element: 'button "Acknowledge"' });
    await op.post(`/${req.id}/key`, { text: 'not-a-secret' });

    expect(
      (
        await op.post(`/${req.id}/hand-back`, {
          resolution: 'retry',
          note: 'acknowledged the attestation',
        })
      ).status,
    ).toBe(200);

    const result = await running;
    expect(result.status).toBe('success');
    expect(result.meta.humanInterventions).toEqual([
      { interventionId: req.id, atStep: 's1', resolution: 'retry' },
    ]);

    const log = readFileSync(join(dir, 'run.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const human = log.filter((e) => e.actor === 'human' && e.type === 'act');
    expect(human.map((e) => e.detail.element ?? e.detail.detail)).toEqual([
      'button "Acknowledge"',
      { textLength: 12 },
    ]);
    expect(readFileSync(join(dir, 'run.jsonl'), 'utf8')).not.toContain('not-a-secret');
    const control = log
      .filter((e) => e.type === 'control')
      .map((e) => e.detail.event ?? e.detail.resumeCheck)
      .filter(Boolean);
    expect(control).toEqual(
      expect.arrayContaining(['take_control', 'hand_back', 'passed', 'resume_ok']),
    );
    expect(existsSync(join(dir, `intervention-${req.id}.json`))).toBe(true);
    expect(existsSync(join(dir, `intervention-${req.id}.resolution.json`))).toBe(true);
  }, 60_000);

  it('a failed resume check goes back to the human once, then the run fails', async () => {
    await app.arm({ switch: 'unknownDialog', path: '/app/search', persist: true });
    const running = runReplay(
      app,
      'member.lookup_savings_balance',
      { memberId: '10001' },
      { escalation: new OperatorReplayEscalation(hub) },
    );
    for (let round = 0; round < 2; round++) {
      const req = await op.waitForOpen();
      await op.post(`/${req.id}/take-control`);
      // Claim the step is done without fixing anything.
      await op.post(`/${req.id}/hand-back`, { resolution: 'continue' });
    }
    const result = await running;
    expect(result).toMatchObject({ status: 'failure', code: 'UNEXPECTED_STATE', atStep: 's1' });
    if (result.status === 'failure') expect(result.observed).toContain('after handback');
    expect(result.meta.humanInterventions).toHaveLength(2);
  }, 60_000);

  it('aborting from the console ends the run with ABORTED_BY_OPERATOR', async () => {
    await app.arm({ switch: 'unknownDialog', path: '/app/search' });
    const running = runReplay(
      app,
      'member.lookup_savings_balance',
      { memberId: '10001' },
      { escalation: new OperatorReplayEscalation(hub) },
    );
    const req = await op.waitForOpen();
    await op.post(`/${req.id}/abort`, { note: 'not today' });
    expect(await running).toMatchObject({
      status: 'failure',
      code: 'ABORTED_BY_OPERATOR',
      observed: 'not today',
    });
  }, 60_000);

  it('an unanswered request times out with ESCALATION_TIMEOUT', async () => {
    await app.arm({ switch: 'unknownDialog', path: '/app/search' });
    const quick = new OperatorHub([], 300);
    const result = await runReplay(
      app,
      'member.lookup_savings_balance',
      { memberId: '10001' },
      { escalation: new OperatorReplayEscalation(quick) },
    );
    expect(result).toMatchObject({ status: 'failure', code: 'ESCALATION_TIMEOUT' });
  }, 60_000);

  it('discovery pauses at the irreversible Submit until a human approves it', async () => {
    const spec = loadGoal('goals/member.open_sub_account.json');
    const outDir = mkdtempSync(join(tmpdir(), 'caps-'));
    const running = discover({
      spec,
      brain: new FakeBrain(spec.fake ?? { turns: [], classify: [] }),
      spend: new SpendTracker(1),
      policy: { ...loadPolicy(), allowedOrigins: [app.baseUrl] },
      tenantId: 'tenant-a',
      outDir,
      baseUrl: app.baseUrl,
      evidenceDir: mkdtempSync(join(tmpdir(), 'runs-')),
      escalation: new OperatorDiscoveryEscalation(hub, spec.goal, spec.capabilityId),
    });
    const req = await op.waitForOpen();
    expect(req).toMatchObject({
      mode: 'discovery',
      kind: 'approval',
      reasonCode: 'IRREVERSIBLE_STEP',
      allowed: ['approve', 'reject'],
    });
    expect(String(req.reason)).toContain('Submit');
    await op.post(`/${req.id}/approve`, { note: 'synthetic member, fine to open' });

    const result = await running;
    expect(result.trace.status).toBe('done');
    expect(result.status).toBe('saved');
    const cap = Capability.parse(JSON.parse(readFileSync(result.savedTo ?? '', 'utf8')));
    const submit = cap.steps.find((s) => s.intent.includes('Submit'));
    expect(submit).toMatchObject({ risk: 'irreversible', retrySafe: false });
    expect(cap.risk).toBe('irreversible');
    expect(cap.outcomes.map((o) => o.code)).toContain('DEPOSIT_BELOW_MINIMUM');
    expect(result.warnings.join(' ')).toContain('irreversible step');
  }, 120_000);
});
