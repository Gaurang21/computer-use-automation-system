// Minimal in-memory cookie sessions. One map per server, so tenants never
// share state.

import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';

const COOKIE = 'MDSID';

export interface OperatorSession {
  operatorId: string;
  createdAt: number;
}

export class SessionStore {
  private readonly sessions = new Map<string, OperatorSession>();

  get(req: Request): OperatorSession | undefined {
    const sid = readCookie(req, COOKIE);
    return sid ? this.sessions.get(sid) : undefined;
  }

  create(res: Response, operatorId: string): void {
    const sid = randomBytes(16).toString('hex');
    this.sessions.set(sid, { operatorId, createdAt: Date.now() });
    res.setHeader('Set-Cookie', `${COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Lax`);
  }

  destroy(req: Request): void {
    const sid = readCookie(req, COOKIE);
    if (sid) this.sessions.delete(sid);
  }
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return undefined;
}
