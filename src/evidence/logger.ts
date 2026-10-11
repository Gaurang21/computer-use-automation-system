// Run evidence: one folder per run with run.jsonl (one event per line), any
// JSON documents, observation snapshots and masked screenshots. Everything
// passes through the run's Redactor on the way to disk.

import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { maskPng, sensitiveBoxes, type Redactor } from '../policy/redact.js';
import { renderObservation } from '../surface/describe.js';
import type { Observation } from '../surface/types.js';

export type EventType =
  | 'run'
  | 'observe'
  | 'decide'
  | 'policy'
  | 'act'
  | 'classify'
  | 'recover'
  | 'escalate'
  | 'control'
  | 'result';

export type EventActor = 'automation' | 'human' | 'model' | 'system';

export interface RunEvent {
  ts: string;
  runId: string;
  seq: number;
  actor: EventActor;
  type: EventType;
  stepId?: string;
  intent?: string;
  detail: Record<string, unknown>;
}

export function newRunId(kind: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  return `${stamp}-${kind}-${randomBytes(3).toString('hex')}`;
}

export class RunLogger {
  private seq = 0;
  readonly logPath: string;

  constructor(
    readonly dir: string,
    readonly runId: string,
    readonly redactor: Redactor,
    private readonly sensitiveLabels: readonly string[] = [],
  ) {
    mkdirSync(join(dir, 'screenshots'), { recursive: true });
    this.logPath = join(dir, 'run.jsonl');
    writeFileSync(this.logPath, '');
  }

  static create(baseDir: string, kind: string, redactor: Redactor, sensitiveLabels: readonly string[] = []) {
    const runId = newRunId(kind);
    return new RunLogger(join(baseDir, runId), runId, redactor, sensitiveLabels);
  }

  event(e: Omit<RunEvent, 'ts' | 'runId' | 'seq'>): RunEvent {
    const event: RunEvent = this.redactor.redactDeep({
      ts: new Date().toISOString(),
      runId: this.runId,
      seq: ++this.seq,
      ...e,
    });
    appendFileSync(this.logPath, JSON.stringify(event) + '\n');
    return event;
  }

  /** Writes a redacted JSON document into the run folder. Returns its path. */
  writeJson(name: string, data: unknown): string {
    const path = join(this.dir, name);
    writeFileSync(path, JSON.stringify(this.redactor.redactDeep(data), null, 2) + '\n');
    return path;
  }

  /** Writes text as is (caller is responsible for redaction). */
  writeText(name: string, text: string): string {
    const path = join(this.dir, name);
    writeFileSync(path, text);
    return path;
  }

  /** Saves the element list as text, scrubbed. */
  saveObservation(name: string, obs: Observation): string {
    const path = join(this.dir, `${name}.observation.txt`);
    writeFileSync(path, this.redactor.scrub(renderObservation(obs, 400)) + '\n');
    return path;
  }

  /** Saves a screenshot with sensitive elements boxed out. */
  saveScreenshot(name: string, png: Buffer, obs?: Observation): string {
    const masked = obs ? maskPng(png, sensitiveBoxes(obs, this.sensitiveLabels, this.redactor)) : png;
    const path = join(this.dir, 'screenshots', `${name}.png`);
    writeFileSync(path, masked);
    return path;
  }
}
