// The operator console: a plain page plus a small JSON API, served by the
// process that owns the session. Deliberately minimal (no auth, no streaming
// video, one operator): the control-transfer model behind it is the real part.

import { existsSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type NextFunction, type Request, type Response } from 'express';
import { OperatorError, type OperatorHub } from './hub.js';
import { OPERATOR_PAGE } from './page.js';
import type { HandBackChoice } from './types.js';

export function createOperatorApp(hub: OperatorHub): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  app.get('/', (_req, res) => {
    res.type('html').send(OPERATOR_PAGE);
  });

  app.get('/api/interventions', (_req, res) => {
    res.json(hub.list());
  });

  app.get('/api/interventions/:id', (req, res) => {
    const p = hub.get(param(req));
    res.json({
      ...p.request,
      status: p.status,
      resolution: p.resolution,
      humanActions: p.humanActions,
      state: p.session.sm.state,
      lease: p.session.surface.lease.current,
    });
  });

  /** The masked screenshot saved when the request was raised. */
  app.get('/api/interventions/:id/evidence.png', (req, res) => {
    const file = hub.get(param(req)).request.screenshot;
    if (!file || !existsSync(file)) {
      res.status(404).end();
      return;
    }
    res.type('png').send(readFileSync(file));
  });

  /** The live session, unmasked: the operator is the person being asked to act on it. */
  app.get(
    '/api/interventions/:id/live.png',
    wrap(async (req, res) => {
      res
        .type('png')
        .set('cache-control', 'no-store')
        .send(await hub.liveScreenshot(param(req)));
    }),
  );

  app.get(
    '/api/interventions/:id/elements',
    wrap(async (req, res) => {
      const els = await hub.elements(param(req));
      res.json(
        els.map((e) => ({
          role: e.role,
          name: e.name,
          label: e.nearText?.text,
          framePath: e.framePath,
          bbox: e.bbox,
        })),
      );
    }),
  );

  app.post('/api/interventions/:id/take-control', (req, res) => {
    hub.takeControl(param(req), String(req.body?.operator ?? 'operator'));
    res.json({ ok: true });
  });

  app.post(
    '/api/interventions/:id/pointer',
    wrap(async (req, res) => {
      const { x, y } = req.body as { x: number; y: number };
      res.json(await hub.humanAct(param(req), { type: 'pointer', x: Number(x), y: Number(y) }));
    }),
  );

  app.post(
    '/api/interventions/:id/key',
    wrap(async (req, res) => {
      const { key, text } = req.body as { key?: string; text?: string };
      res.json(
        await hub.humanAct(param(req), {
          type: 'key',
          ...(key ? { key } : {}),
          ...(text ? { text } : {}),
        }),
      );
    }),
  );

  app.post('/api/interventions/:id/hand-back', (req, res) => {
    const { resolution, note } = req.body as { resolution: HandBackChoice; note?: string };
    hub.handBack(param(req), resolution, note);
    res.json({ ok: true });
  });

  for (const verb of ['approve', 'reject', 'abort'] as const) {
    app.post(`/api/interventions/:id/${verb}`, (req, res) => {
      hub[verb](param(req), req.body?.note);
      res.json({ ok: true });
    });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof OperatorError ? err.status : 500;
    res.status(status).json({ error: err instanceof Error ? err.message : String(err) });
  });
  return app;
}

export async function startOperatorServer(
  hub: OperatorHub,
  port = 4100,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = await new Promise((resolve, reject) => {
    const s = createOperatorApp(hub).listen(port, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  const url = `http://localhost:${(server.address() as AddressInfo).port}`;
  hub.consoleUrl = url;
  return {
    url,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function param(req: Request): string {
  return String(req.params.id);
}

function wrap(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}
