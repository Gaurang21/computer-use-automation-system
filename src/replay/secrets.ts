// Secrets resolve at run time from the environment, through the tenant
// overlay's mapping. They never appear in an artifact, a log or a result.

import type { TenantOverlay } from '../schema/overlay.js';

export interface SecretProvider {
  get(name: string): string | undefined;
}

export class EnvSecretProvider implements SecretProvider {
  constructor(
    private readonly overlay: TenantOverlay,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  get(name: string): string | undefined {
    const mapping = this.overlay.secrets[name];
    return mapping ? this.env[mapping.env] : undefined;
  }
}
