import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../../target-app/server.js';
import { TENANTS } from '../../target-app/tenants.js';
import type { ChaosArm } from '../../target-app/chaos.js';

export interface RunningTenant {
  baseUrl: string;
  operator: { id: string; password: string };
  arm(arm: ChaosArm): Promise<void>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** Starts one MemberDesk tenant on a free port. */
export async function startTenant(id: keyof typeof TENANTS = 'tenant-a'): Promise<RunningTenant> {
  const tenant = TENANTS[id];
  const server: Server = await new Promise((resolve) => {
    const s = createApp(tenant).listen(0, '127.0.0.1', () => resolve(s));
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    baseUrl,
    operator: tenant.operator,
    async arm(arm) {
      const res = await fetch(`${baseUrl}/__chaos`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(arm),
      });
      if (!res.ok) throw new Error(`chaos arm failed: ${await res.text()}`);
    },
    async reset() {
      await fetch(`${baseUrl}/__chaos`, { method: 'DELETE' });
    },
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** A tiny HTTP client with a cookie jar, standing in for a browser in smoke tests. */
export class HttpOperator {
  private cookie = '';
  constructor(private readonly baseUrl: string) {}

  async get(path: string): Promise<{ status: number; html: string }> {
    return this.request('GET', path);
  }

  async post(
    path: string,
    form: Record<string, string>,
  ): Promise<{ status: number; html: string }> {
    return this.request('POST', path, form);
  }

  async signOn(id: string, password: string): Promise<void> {
    const res = await this.post('/app/login', { f1: id, f2: password });
    if (res.status !== 303) throw new Error(`sign-on failed: ${res.status}`);
  }

  private async request(method: string, path: string, form?: Record<string, string>) {
    const res = await fetch(this.baseUrl + path, {
      method,
      redirect: 'manual',
      headers: { cookie: this.cookie },
      ...(form ? { body: new URLSearchParams(form) } : {}),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0] ?? '';
    return { status: res.status, html: await res.text() };
  }
}
