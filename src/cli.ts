// Command line entry point. Result JSON goes to stdout; progress to stderr.
// Exit codes: 0 success, 10 business outcome, 20 failure.

import { existsSync } from 'node:fs';
import { Command } from 'commander';
import { join } from 'node:path';
import { AnthropicBrain } from './discovery/anthropic-brain.js';
import type { Brain } from './discovery/brain.js';
import { discover } from './discovery/discover.js';
import { FakeBrain } from './discovery/fake-brain.js';
import { loadGoal } from './discovery/goal.js';
import { SpendTracker, capFromEnv } from './discovery/spend.js';
import { loadPolicy } from './policy/gate.js';
import { OperatorDiscoveryEscalation, OperatorReplayEscalation } from './operator/escalation.js';
import { OperatorHub } from './operator/hub.js';
import { startOperatorServer } from './operator/server.js';
import { ConsoleNotifier } from './operator/types.js';
import { approveCapabilityFile } from './replay/approval.js';
import { replay } from './replay/engine.js';
import { isApproved } from './replay/hash.js';
import { CapabilityStore } from './replay/store.js';
import { exitCodeFor } from './schema/result.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const collect = (value: string, previous: string[] = []) => [...previous, value];

/** Starts the operator console in this process, which owns the live session. */
async function withOperator<T>(
  enabled: boolean,
  port: number,
  run: (hub?: OperatorHub) => Promise<T>,
): Promise<T> {
  if (!enabled) return run();
  const hub = new OperatorHub([new ConsoleNotifier()]);
  const server = await startOperatorServer(hub, port);
  process.stderr.write(`operator console: ${server.url}\n`);
  try {
    return await run(hub);
  } finally {
    await server.close();
  }
}

export function parseInputs(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of pairs) {
    const i = pair.indexOf('=');
    if (i <= 0) throw new Error(`--input expects name=value, got "${pair}"`);
    out[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return out;
}

const program = new Command()
  .name('cua')
  .description('Computer-use automation: discover, replay, approve');

program
  .command('replay')
  .description('Replay a saved capability deterministically (no model in the loop)')
  .requiredOption('--capability <id>', 'capability id, e.g. member.lookup_savings_balance')
  .option('--input <name=value>', 'input parameter (repeatable)', collect, [])
  .option('--tenant <id>', 'tenant overlay to apply', 'tenant-a')
  .option('--app <id>', 'vendor product', 'memberdesk')
  .option(
    '--capabilities-dir <dir>',
    'extra capability folder, searched first (repeatable)',
    collect,
    [],
  )
  .option('--policy <file>', 'policy file', 'policy/default.policy.json')
  .option('--evidence-dir <dir>', 'where run folders are written', 'runs')
  .option('--allow-draft', 'allow running a capability that is not approved', false)
  .option('--confirm-irreversible', 'caller confirms irreversible steps may run', false)
  .option('--headed', 'show the browser', false)
  .option('--no-operator', 'fail instead of escalating to a human')
  .option('--operator-port <port>', 'operator console port', '4100')
  .action(async (o) => {
    const result = await withOperator(o.operator, Number(o.operatorPort), (hub) =>
      replay({
        store: new CapabilityStore('capabilities', o.app, o.capabilitiesDir),
        capabilityId: o.capability,
        tenantId: o.tenant,
        inputs: parseInputs(o.input),
        policy: loadPolicy(o.policy),
        evidenceDir: o.evidenceDir,
        allowDraft: o.allowDraft,
        confirmIrreversible: o.confirmIrreversible,
        headless: !o.headed,
        ...(hub ? { escalation: new OperatorReplayEscalation(hub) } : {}),
      }),
    );
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    const where =
      result.status === 'failure'
        ? ` (${result.code} at ${result.atStep ?? 'start'})`
        : result.status === 'business_outcome'
          ? ` (${result.code})`
          : '';
    process.stderr.write(
      `replay ${result.status}${where}; evidence in ${o.evidenceDir}/${result.meta.runId}\n`,
    );
    process.exitCode = exitCodeFor(result);
  });

program
  .command('discover')
  .description('Let a model accomplish a goal once, then compile the run into a capability')
  .requiredOption('--spec <file>', 'goal spec, e.g. goals/member.lookup_savings_balance.json')
  .option('--llm <kind>', 'anthropic (real model) or fake (scripted, no API key)', 'anthropic')
  .option('--tenant <id>', 'tenant to discover against', 'tenant-a')
  .option('--out <dir>', 'where to save the capability (default capabilities/<app>)')
  .option('--policy <file>', 'policy file', 'policy/default.policy.json')
  .option('--evidence-dir <dir>', 'where run folders are written', 'runs')
  .option('--headed', 'show the browser', false)
  .option(
    '--no-operator',
    'stop instead of escalating to a human (irreversible steps are then rejected)',
  )
  .option('--operator-port <port>', 'operator console port', '4100')
  .action(async (o) => {
    const spec = loadGoal(o.spec);
    const spend = new SpendTracker(capFromEnv());
    let brain: Brain;
    if (o.llm === 'fake') {
      if (!spec.fake) throw new Error(`${o.spec} has no "fake" script; use --llm anthropic`);
      brain = new FakeBrain(spec.fake);
    } else {
      brain = new AnthropicBrain({ model: process.env.CUA_MODEL ?? 'claude-sonnet-5-5', spend });
    }
    const result = await withOperator(o.operator, Number(o.operatorPort), (hub) =>
      discover({
        spec,
        brain,
        spend,
        policy: loadPolicy(o.policy),
        tenantId: o.tenant,
        outDir: o.out ?? join('capabilities', spec.appId),
        evidenceDir: o.evidenceDir,
        headless: !o.headed,
        ...(hub
          ? { escalation: new OperatorDiscoveryEscalation(hub, spec.goal, spec.capabilityId) }
          : {}),
      }),
    );
    const { trace: _trace, capability: _cap, ...summary } = result;
    process.stdout.write(
      JSON.stringify(
        { ...summary, traceStatus: result.trace.status, steps: result.trace.steps.length },
        null,
        2,
      ) + '\n',
    );
    process.stderr.write(
      `discovery ${result.status}${result.reason ? ` (${result.reason})` : ''}; spend $${result.spendUsd.toFixed(4)}; evidence in ${result.dir}\n`,
    );
    process.exitCode = result.status === 'saved' ? 0 : 20;
  });

program
  .command('approve')
  .description('Approve a capability: bind reviewer and time to its content hash')
  .requiredOption('--capability <id>', 'capability id')
  .requiredOption('--by <name>', 'reviewer name')
  .option('--app <id>', 'vendor product', 'memberdesk')
  .option('--capabilities-dir <dir>', 'extra capability folder (repeatable)', collect, [])
  .action((o) => {
    const store = new CapabilityStore('capabilities', o.app, o.capabilitiesDir);
    const file = store.fileOf(o.capability);
    if (!file) throw new Error(`no capability ${o.capability}`);
    const cap = approveCapabilityFile(file, o.by);
    process.stderr.write(
      `approved ${cap.id}@${cap.version} by ${o.by} (hash ${cap.approval?.contentHash.slice(0, 12)}) in ${file}\n`,
    );
    if (!isApproved(cap)) process.exitCode = 1;
  });

program.parseAsync().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 2;
});
