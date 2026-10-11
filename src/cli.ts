// Command line entry point. Result JSON goes to stdout; progress to stderr.
// Exit codes: 0 success, 10 business outcome, 20 failure.

import { existsSync } from 'node:fs';
import { Command } from 'commander';
import { loadPolicy } from './policy/gate.js';
import { approveCapabilityFile } from './replay/approval.js';
import { replay } from './replay/engine.js';
import { isApproved } from './replay/hash.js';
import { CapabilityStore } from './replay/store.js';
import { exitCodeFor } from './schema/result.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const collect = (value: string, previous: string[] = []) => [...previous, value];

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
  .action(async (o) => {
    const result = await replay({
      store: new CapabilityStore('capabilities', o.app, o.capabilitiesDir),
      capabilityId: o.capability,
      tenantId: o.tenant,
      inputs: parseInputs(o.input),
      policy: loadPolicy(o.policy),
      evidenceDir: o.evidenceDir,
      allowDraft: o.allowDraft,
      confirmIrreversible: o.confirmIrreversible,
      headless: !o.headed,
    });
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
