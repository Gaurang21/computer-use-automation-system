// What a human operator is asked, and how they are told.

export type InterventionKind = 'stuck' | 'approval';
export type OperatorAction = 'take_control' | 'approve' | 'reject' | 'abort';
export type HandBackChoice = 'retry' | 'continue' | 'abort';

export interface InterventionRequest {
  id: string;
  runId: string;
  mode: 'discovery' | 'replay';
  kind: InterventionKind;
  capabilityId?: string;
  goal?: string;
  stepId?: string;
  stepIntent?: string;
  reasonCode: string;
  reason: string;
  expected?: string;
  observed: string;
  location: string;
  /** Path to the masked screenshot saved in the run's evidence folder. */
  screenshot?: string;
  allowed: OperatorAction[];
  handBackChoices: HandBackChoice[];
  createdAt: string;
}

export interface Notifier {
  notify(request: InterventionRequest, consoleUrl: string): void | Promise<void>;
}

/** Prints the request to stderr. The CLI's default. */
export class ConsoleNotifier implements Notifier {
  notify(r: InterventionRequest, consoleUrl: string): void {
    process.stderr.write(
      `\n[intervention ${r.id}] ${r.kind === 'approval' ? 'APPROVAL NEEDED' : 'STUCK'} in ${r.mode} of ${r.capabilityId ?? r.goal ?? '?'}` +
        `${r.stepId ? ` at ${r.stepId} (${r.stepIntent ?? ''})` : ''}\n  ${r.reasonCode}: ${r.reason}\n` +
        `  expected: ${r.expected ?? '-'}\n  observed: ${r.observed}\n  open ${consoleUrl}\n\n`,
    );
  }
}

/**
 * Posts the request to a webhook (a chat channel, a paging tool, a ticket
 * queue). Not wired by default: the console notifier and the operator page are
 * enough for a single-process demo. The screenshot path is local, so a real
 * deployment would upload the masked screenshot and send its URL instead.
 */
export class WebhookNotifier implements Notifier {
  constructor(private readonly url: string) {}
  async notify(r: InterventionRequest, consoleUrl: string): Promise<void> {
    await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...r, consoleUrl }),
    });
  }
}
