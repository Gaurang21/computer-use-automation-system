// Regenerates every folder under /evidence: two real discovery runs, the probe
// that taught MEMBER_NOT_FOUND, and the replays (success, business outcome,
// recovered session expiry, hard failure, human handoff, tenant B).
//
// The human in the handoff and approval runs is a scripted operator driving
// the operator console's API. It is labelled as such everywhere.
//
// With --llm fake everything is written to runs/evidence-fake instead, never
// to /evidence: evidence of a real discovery run must come from a real model.

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createApp } from '../../target-app/server.js';
import { TENANTS } from '../../target-app/tenants.js';
import { AnthropicBrain } from '../discovery/anthropic-brain.js';
import type { Brain } from '../discovery/brain.js';
import { discover, type DiscoverResult } from '../discovery/discover.js';
import { FakeBrain } from '../discovery/fake-brain.js';
import { loadGoal } from '../discovery/goal.js';
import { SpendTracker, capFromEnv } from '../discovery/spend.js';
import { OperatorDiscoveryEscalation, OperatorReplayEscalation } from '../operator/escalation.js';
import { OperatorHub } from '../operator/hub.js';
import { loadPolicy } from '../policy/gate.js';
import { replay } from '../replay/engine.js';
import { CapabilityStore } from '../replay/store.js';
import type { RunResult } from '../schema/result.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const llm = process.argv.includes('--llm') ? process.argv[process.argv.indexOf('--llm') + 1] : 'anthropic';
const fake = llm === 'fake';
const OUT = fake ? 'runs/evidence-fake' : 'evidence';
const WORK = fake ? 'runs/evidence-fake-work' : 'runs/evidence-work';
const CAPS = fake ? join(WORK, 'capabilities') : 'capabilities/memberdesk';
const PROJECT_CAP_USD = 5;

interface Tenant {
  baseUrl: string;
  arm: (body: object) => Promise<void>;
  reset: () => Promise<void>;
  close: () => void;
}

async function startTenant(id: 'tenant-a' | 'tenant-b'): Promise<Tenant> {
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = createApp(TENANTS[id]).listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    baseUrl,
    arm: async (body) => {
      await fetch(`${baseUrl}/__chaos`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    },
    reset: async () => {
      await fetch(`${baseUrl}/__chaos`, { method: 'DELETE' });
    },
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** The scripted operator: approves irreversible steps and handles the unknown dialog, through the hub. */
async function scriptedOperator(hub: OperatorHub, stop: { done: boolean }): Promise<void> {
  const handled = new Set<string>();
  while (!stop.done) {
    for (const r of hub.list().filter((i) => i.status === 'open' && !handled.has(i.id))) {
      handled.add(r.id);
      if (r.kind === 'approval') {
        hub.approve(r.id, 'scripted operator: synthetic member, approved for the evidence run');
        continue;
      }
      hub.takeControl(r.id, 'scripted-operator');
      const ack = (await hub.elements(r.id)).find((e) => e.role === 'button' && e.name === 'Acknowledge');
      if (!ack) {
        hub.handBack(r.id, 'abort', 'scripted operator: nothing it knows how to fix');
        continue;
      }
      await hub.humanAct(r.id, { type: 'pointer', x: ack.bbox.x + ack.bbox.w / 2, y: ack.bbox.y + ack.bbox.h / 2 });
      hub.handBack(r.id, 'retry', 'scripted operator: acknowledged the attestation notice');
    }
    await sleep(200);
  }
}

async function main(): Promise<void> {
  if (!fake && !process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set. Evidence needs a real discovery run. Use --llm fake to dry-run into runs/evidence-fake.');
  }
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  const a = await startTenant('tenant-a');
  const b = await startTenant('tenant-b');
  const policy = { ...loadPolicy(), allowedOrigins: [a.baseUrl, b.baseUrl] };
  const hub = new OperatorHub([], 120_000);
  const stop = { done: false };
  const operator = scriptedOperator(hub, stop);
  const spends: SpendTracker[] = [];
  const index: Record<string, string> = {};

  const runDiscovery = async (specFile: string): Promise<DiscoverResult> => {
    const spec = loadGoal(specFile);
    const spent = spends.reduce((s, t) => s + t.totalUsd, 0);
    const spend = new SpendTracker(Math.min(capFromEnv(), PROJECT_CAP_USD - spent));
    spends.push(spend);
    const brain: Brain = fake
      ? new FakeBrain(spec.fake ?? { turns: [], classify: [] })
      : new AnthropicBrain({ model: process.env.CUA_MODEL ?? 'claude-sonnet-5-5', spend });
    const r = await discover({
      spec,
      brain,
      spend,
      policy,
      tenantId: 'tenant-a',
      outDir: CAPS,
      baseUrl: a.baseUrl,
      evidenceDir: WORK,
      escalation: new OperatorDiscoveryEscalation(hub, spec.goal, spec.capabilityId),
    });
    log(`discovery ${spec.capabilityId}: ${r.status}${r.reason ? ` (${r.reason})` : ''}, $${r.spendUsd.toFixed(4)}`);
    return r;
  };

  const lookup = await runDiscovery('goals/member.lookup_savings_balance.json');
  const open = await runDiscovery('goals/member.open_sub_account.json');
  index['discovery-lookup'] = lookup.dir;
  index['discovery-open-sub-account'] = open.dir;
  const probeDir = join(lookup.dir, 'probes');
  if (existsSync(probeDir)) index['probe-not-found'] = probeDir;

  const store = new CapabilityStore('capabilities', 'memberdesk', fake ? [CAPS] : []);
  const replayRun = async (name: string, tenant: Tenant, tenantId: string, inputs: Record<string, string>, chaos?: object): Promise<RunResult> => {
    await tenant.reset();
    if (chaos) await tenant.arm(chaos);
    let dir = '';
    const r = await replay({
      store,
      capabilityId: 'member.lookup_savings_balance',
      tenantId,
      inputs,
      policy,
      baseUrl: tenant.baseUrl,
      allowDraft: true,
      evidenceDir: WORK,
      escalation: new OperatorReplayEscalation(hub),
      onStart: (i) => (dir = i.dir),
    });
    index[name] = dir;
    log(`${name}: ${r.status}${r.status !== 'success' ? ` ${r.code}` : ''}`);
    return r;
  };

  if (lookup.status === 'saved') {
    await replayRun('replay-success', a, 'tenant-a', { memberId: '10001' });
    await replayRun('replay-not-found', a, 'tenant-a', { memberId: '99999' });
    await replayRun('replay-session-expired', a, 'tenant-a', { memberId: '10003' }, { switch: 'expireSession', path: '/app/search' });
    await replayRun('replay-app-error', a, 'tenant-a', { memberId: '10001' }, { switch: 'error500', path: '/app/search' });
    await replayRun('replay-escalation-handoff', a, 'tenant-a', { memberId: '10001' }, { switch: 'unknownDialog', path: '/app/search' });
    await replayRun('replay-tenant-b', b, 'tenant-b', { memberId: '10001' });
  }

  stop.done = true;
  await operator;
  a.close();
  b.close();

  // Publish.
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, 'artifacts'), { recursive: true });
  for (const [name, dir] of Object.entries(index)) if (dir && existsSync(dir)) cpSync(dir, join(OUT, name), { recursive: true });
  cpSync('capabilities/memberdesk/app-profile.json', join(OUT, 'artifacts', 'app-profile.json'));
  cpSync('capabilities/memberdesk/overlays', join(OUT, 'artifacts', 'overlays'), { recursive: true });
  for (const f of readdirSync(CAPS).filter((f) => f.endsWith('.json'))) cpSync(join(CAPS, f), join(OUT, 'artifacts', f));
  const total = spends.reduce((s, t) => s + t.totalUsd, 0);
  writeFileSync(
    join(OUT, 'usage.json'),
    JSON.stringify({ model: fake ? 'fake-llm' : (process.env.CUA_MODEL ?? 'claude-sonnet-5-5'), totalUsd: Number(total.toFixed(6)), runs: spends.map((s) => s.summary()) }, null, 2) + '\n',
  );
  writeFileSync(join(OUT, 'README.md'), readme(fake, total, lookup, open));
  log(`evidence written to ${OUT}/ (model spend $${total.toFixed(4)})`);
}

function readme(isFake: boolean, total: number, lookup: DiscoverResult, open: DiscoverResult): string {
  const lines = [
    '# Evidence',
    '',
    isFake
      ? '**Dry run with the scripted fake LLM. This is not evidence of a real discovery run.**'
      : `Generated by \`npm run evidence\`. Total model spend: $${total.toFixed(4)}.`,
    '',
    'The "human" in the handoff and approval runs is a scripted operator driving the operator console API (`src/evidence/generate.ts`).',
    '',
    '| Folder | What it proves |',
    '|---|---|',
    '| `artifacts/` | The app profile, both discovered capabilities and the tenant overlays the replays used |',
    `| \`discovery-lookup/\` | A model-driven run found the member, read name and savings balance, and compiled \`member.lookup_savings_balance\` (${lookup.status}). \`run.jsonl\`, \`transcript.redacted.jsonl\`, masked \`screenshots/\`, \`usage.json\`, \`capability.draft.json\` |`,
    `| \`discovery-open-sub-account/\` | A model-driven run filled the form and paused at Submit for human approval (see \`intervention-*.json\`), then compiled \`member.open_sub_account\` (${open.status}) |`,
    '| `probe-not-found/` | Authoring-time replay with member 99999: the unrecognised screen was classified once by the model and became the `MEMBER_NOT_FOUND` outcome |',
    '| `replay-success/` | Deterministic replay with no model: typed outputs, checkpoint verified (`result.json`, `run.jsonl`) |',
    '| `replay-not-found/` | The same capability returns the `MEMBER_NOT_FOUND` business outcome, not a failure |',
    '| `replay-session-expired/` | Session expiry was detected, the flow signed on again and restarted; see `meta.recoveries` |',
    '| `replay-app-error/` | The app error page is a hard failure, with masked screenshot and observation |',
    '| `replay-escalation-handoff/` | An unknown dialog stopped replay; the operator took the live session, clicked Acknowledge, handed back with retry; `intervention-*.json`, human actions in `run.jsonl`, final `success` |',
    '| `replay-tenant-b/` | The tenant A capability replayed on tenant B (v7.2, renamed labels) through the overlay only |',
    '',
  ];
  return lines.join('\n');
}

function log(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});

