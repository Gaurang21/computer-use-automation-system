// Discovery end to end: preconditions (replayed, no model), the agent loop,
// compilation, probe runs that teach the artifact its business outcomes, and
// a self-check replay with no model before anything is saved.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RunLogger } from '../evidence/logger.js';
import { launchGuardedWeb } from '../policy/launch.js';
import type { GuardedSurface } from '../policy/guarded-surface.js';
import { Redactor } from '../policy/redact.js';
import {
  replay,
  type Escalation,
  type HumanResolution,
  type StuckContext,
} from '../replay/engine.js';
import { matches } from '../replay/matcher.js';
import { EnvSecretProvider } from '../replay/secrets.js';
import { CapabilityStore } from '../replay/store.js';
import type { Capability } from '../schema/capability.js';
import type { Policy } from '../schema/policy.js';
import type { RunResult } from '../schema/result.js';
import { runAgent, type DiscoveryEscalation, type DiscoveryTrace } from './agent.js';
import type { Brain } from './brain.js';
import { compileTrace } from './compiler.js';
import type { GoalSpec } from './goal.js';
import type { SpendTracker } from './spend.js';

export interface DiscoverOptions {
  spec: GoalSpec;
  brain: Brain;
  spend: SpendTracker;
  policy: Policy;
  tenantId: string;
  /** Where the compiled capability is saved (normally capabilities/<appId>). */
  outDir: string;
  capabilitiesRoot?: string;
  evidenceDir?: string;
  baseUrl?: string;
  headless?: boolean;
  escalation?: DiscoveryEscalation;
  /** Hook to share the live session (operator console). */
  onSession?: (s: { surface: GuardedSurface; logger: RunLogger }) => void;
}

export interface DiscoverResult {
  runId: string;
  dir: string;
  trace: DiscoveryTrace;
  status: 'saved' | 'rejected' | 'incomplete';
  capability?: Capability;
  savedTo?: string;
  reason?: string;
  warnings: string[];
  probes: { inputs: Record<string, string>; result: string; added?: string }[];
  selfCheck?: RunResult['status'];
  spendUsd: number;
}

export async function discover(o: DiscoverOptions): Promise<DiscoverResult> {
  const { spec } = o;
  const root = o.capabilitiesRoot ?? 'capabilities';
  const store = new CapabilityStore(root, spec.appId);
  const overlay = store.overlay(o.tenantId);
  const baseUrl = o.baseUrl ?? overlay.baseUrl;

  const redactor = new Redactor();
  for (const i of Object.values(spec.inputs)) redactor.addKnown(i.value, i.spec.sensitivity);
  for (const p of spec.probes)
    for (const [k, v] of Object.entries(p))
      redactor.addKnown(v, spec.inputs[k]?.spec.sensitivity ?? 'pii');
  const secrets = new EnvSecretProvider(overlay);
  const secretNames = Object.keys(overlay.secrets);
  for (const name of secretNames) redactor.addKnown(secrets.get(name), 'secret');

  const logger = RunLogger.create(
    o.evidenceDir ?? 'runs',
    'discovery',
    redactor,
    o.policy.sensitiveLabels,
  );
  o.spend.setFile(join(logger.dir, 'usage.json'));
  o.brain.setTranscript?.((e) => logger.appendJsonl('transcript.redacted.jsonl', e));
  logger.event({
    actor: 'system',
    type: 'run',
    detail: {
      capability: spec.capabilityId,
      goal: spec.goal,
      tenant: o.tenantId,
      model: o.brain.model,
    },
  });

  const { surface } = await launchGuardedWeb(
    o.policy,
    { mode: 'discovery' },
    {
      onDecision: (req, d) =>
        logger.event({
          actor: req.actor,
          type: 'policy',
          detail: { action: req.action.type, ...d },
        }),
      onBlockedRequest: (url, reason) =>
        logger.event({
          actor: 'system',
          type: 'policy',
          detail: { verdict: 'block', network: true, url, reason },
        }),
    },
    { headless: o.headless ?? true },
  );
  o.onSession?.({ surface, logger });

  const result: DiscoverResult = {
    runId: logger.runId,
    dir: logger.dir,
    trace: { status: 'aborted', steps: [], outputs: {} },
    status: 'incomplete',
    warnings: [],
    probes: [],
    spendUsd: 0,
  };

  try {
    // Preconditions are replayed deterministically: the model never spends tokens signing on.
    for (const pre of spec.preconditions) {
      const r = await replay({
        store,
        capabilityId: pre,
        tenantId: o.tenantId,
        inputs: {},
        policy: o.policy,
        baseUrl,
        surface,
        allowDraft: true,
        evidenceDir: join(logger.dir, 'preconditions'),
      });
      surface.setRunContext({ mode: 'discovery' });
      logger.event({
        actor: 'automation',
        type: 'classify',
        detail: { precondition: pre, status: r.status },
      });
      if (r.status !== 'success') {
        result.reason = `precondition ${pre} ended with ${r.status}`;
        return finish(result, o, logger);
      }
    }
    if (spec.preconditions.length === 0 || spec.startPath !== '/') {
      await surface.act(
        { type: 'goto', url: new URL(spec.startPath, baseUrl).toString() },
        'automation',
      );
    }

    result.trace = await runAgent({
      goal: spec.goal,
      brain: o.brain,
      surface,
      logger,
      inputs: spec.inputs,
      outputs: spec.outputs,
      secrets,
      secretNames,
      maxSteps: spec.maxSteps,
      maxMs: spec.maxMinutes * 60_000,
      ...(o.escalation ? { escalation: o.escalation } : {}),
    });
  } finally {
    await surface.close();
  }
  if (result.trace.status !== 'done') {
    result.reason = result.trace.reason ?? result.trace.status;
    return finish(result, o, logger);
  }

  // Compile.
  // Enum values are part of the input contract (the list of allowed options), so they may appear.
  const isEnum = (name: string) => spec.inputs[name]?.spec.type === 'enum';
  const forbidden = [
    ...Object.entries(spec.inputs)
      .filter(([k]) => !isEnum(k))
      .map(([, i]) => i.value),
    ...spec.probes.flatMap((p) =>
      Object.entries(p)
        .filter(([k]) => !isEnum(k))
        .map(([, v]) => v),
    ),
    ...secretNames.map((n) => secrets.get(n) ?? '').filter(Boolean),
    ...Object.values(result.trace.outputs).flatMap((v) =>
      typeof v === 'object' ? [] : [String(v)],
    ),
  ];
  const compiled = await compileTrace({
    trace: result.trace,
    spec,
    brain: o.brain,
    policy: o.policy,
    runId: logger.runId,
    forbidden,
  });
  result.warnings.push(...compiled.warnings);
  if (!compiled.capability) {
    result.status = 'rejected';
    result.reason = compiled.rejected ?? 'compile failed';
    return finish(result, o, logger);
  }
  let cap = compiled.capability;
  logger.writeJson('capability.draft.json', cap);

  // Probes: replay the draft with other inputs; ask the model once about any screen it does not recognise.
  const draftDir = join(logger.dir, 'draft');
  const writeDraft = (c: Capability) => {
    mkdirSync(draftDir, { recursive: true });
    writeFileSync(join(draftDir, `${c.id}.json`), JSON.stringify(c, null, 2) + '\n');
  };
  writeDraft(cap);
  const draftStore = () => new CapabilityStore(root, spec.appId, [draftDir]);
  const happyInputs = Object.fromEntries(Object.entries(spec.inputs).map(([k, v]) => [k, v.value]));

  for (const probe of spec.probes) {
    const inputs = { ...happyInputs, ...probe };
    const capture = new CapturingEscalation();
    const r = await replay({
      store: draftStore(),
      capabilityId: cap.id,
      tenantId: o.tenantId,
      inputs,
      policy: o.policy,
      baseUrl,
      allowDraft: true,
      escalation: capture,
      evidenceDir: join(logger.dir, 'probes'),
      headless: o.headless ?? true,
    });
    cap = {
      ...cap,
      provenance: { ...cap.provenance, probeRunIds: [...cap.provenance.probeRunIds, r.meta.runId] },
    };
    const entry: DiscoverResult['probes'][number] = {
      inputs: probe,
      result: capture.seen
        ? `${capture.seen.reasonCode} at ${capture.seen.stepId}`
        : r.status === 'failure'
          ? `${r.code} at ${r.atStep}`
          : r.status,
    };
    const seen = capture.seen;
    if (seen && seen.stepId && !seen.stepId.includes(':')) {
      const stepId = seen.stepId;
      const happyAfter = compiled.screens[stepId]?.after;
      const verdict = await o.brain.classify(spec.goal, seen.stepIntent ?? '', seen.obs);
      logger.event({ actor: 'model', type: 'classify', stepId, detail: { probe: true, verdict } });
      if (verdict.kind === 'business_outcome' && verdict.code && verdict.textPresent) {
        const detect = { textPresent: verdict.textPresent };
        const valid = matches(seen.obs, detect) && (!happyAfter || !matches(happyAfter, detect));
        const leaks = Object.values(inputs).some((v) => verdict.textPresent?.includes(v));
        if (valid && !leaks) {
          cap = {
            ...cap,
            outcomes: [
              ...cap.outcomes.filter((x) => x.code !== verdict.code),
              {
                code: verdict.code,
                ...(verdict.message ? { message: verdict.message } : {}),
                afterSteps: [stepId],
                detect,
                source: 'probe',
              },
            ],
          };
          entry.added = verdict.code;
        } else {
          result.warnings.push(
            `probe ${JSON.stringify(probe)}: proposed matcher for ${verdict.code} did not verify`,
          );
        }
      }
    }
    result.probes.push(entry);
    writeDraft(cap);
  }

  // Self-check: the draft must replay with the original inputs and no model.
  const check = await replay({
    store: draftStore(),
    capabilityId: cap.id,
    tenantId: o.tenantId,
    inputs: happyInputs,
    policy: o.policy,
    baseUrl,
    allowDraft: true,
    evidenceDir: join(logger.dir, 'self-check'),
    headless: o.headless ?? true,
  });
  result.selfCheck = check.status;
  result.capability = cap;
  logger.writeJson('capability.draft.json', cap);
  mkdirSync(o.outDir, { recursive: true });
  // Policy blocks an unapproved irreversible step in replay; reaching it is as far as a self-check can go.
  const blockedAtIrreversible =
    check.status === 'failure' &&
    check.code === 'POLICY_BLOCKED' &&
    cap.steps.find((s) => s.id === check.atStep)?.risk === 'irreversible';
  if (check.status === 'success' || blockedAtIrreversible) {
    result.status = 'saved';
    result.savedTo = join(o.outDir, `${cap.id}.json`);
    if (blockedAtIrreversible)
      result.warnings.push(
        'self-check stopped at the irreversible step (needs approval to replay past it)',
      );
  } else {
    result.status = 'rejected';
    result.reason = `self-check ${check.status}${check.status === 'failure' ? ` ${check.code} at ${check.atStep}: ${check.observed}` : ''}`;
    result.savedTo = join(o.outDir, `${cap.id}.rejected.json`);
  }
  writeFileSync(
    result.savedTo,
    JSON.stringify(
      result.status === 'saved' ? cap : { reason: result.reason, capability: cap },
      null,
      2,
    ) + '\n',
  );
  return finish(result, o, logger);
}

function finish(result: DiscoverResult, o: DiscoverOptions, logger: RunLogger): DiscoverResult {
  result.spendUsd = o.spend.totalUsd;
  logger.writeJson('discovery-result.json', {
    status: result.status,
    reason: result.reason,
    traceStatus: result.trace.status,
    steps: result.trace.steps.length,
    probes: result.probes,
    selfCheck: result.selfCheck,
    savedTo: result.savedTo,
    warnings: result.warnings,
    spendUsd: result.spendUsd,
  });
  o.spend.flush();
  return result;
}

/** Used by probe runs: records the screen replay could not recognise, then aborts. */
class CapturingEscalation implements Escalation {
  seen: StuckContext | undefined;
  async request(ctx: StuckContext): Promise<HumanResolution> {
    this.seen ??= ctx;
    return {
      kind: 'abort',
      interventionId: 'probe',
      note: 'probe run: captured for classification',
    };
  }
}
