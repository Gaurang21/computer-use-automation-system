// Failure switches. POST /__chaos arms a runtime condition on the next
// eligible request (or every one, with persist). It lives outside the frameset
// and the policy blocks it, so the agent can never reach it. Tests and the
// evidence script use it to inject the exceptional states a real back-office
// app produces.

import { setTimeout as sleep } from 'node:timers/promises';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import type { AppContext } from './server.js';
import { loginPage } from './server.js';
import { esc, hidden, page, submit } from './views.js';

export type ChaosSwitch = 'interstitial' | 'expireSession' | 'slow' | 'error500' | 'unknownDialog';

export interface ChaosArm {
  switch: ChaosSwitch;
  /** Fire on every eligible request instead of once. */
  persist?: boolean;
  /** Only fire on requests whose path starts with this. */
  path?: string;
  /** For slow: delay in milliseconds. */
  ms?: number;
}

const SWITCHES: readonly ChaosSwitch[] = [
  'interstitial',
  'expireSession',
  'slow',
  'error500',
  'unknownDialog',
];

// Frame chrome and sign-on never misbehave, so a fault always lands on the
// page the automation is actually working in.
const EXEMPT = ['/app/banner', '/app/nav', '/app/login', '/app/logout', '/app/main'];

export function registerChaos(app: Express, ctx: AppContext): void {
  const armed: ChaosArm[] = [];

  app.get('/__chaos', (_req, res) => {
    res.json({ armed });
  });

  app.post('/__chaos', express.json(), (req, res) => {
    const arm = req.body as Partial<ChaosArm>;
    if (!arm.switch || !SWITCHES.includes(arm.switch)) {
      res.status(400).json({ error: `switch must be one of ${SWITCHES.join(', ')}` });
      return;
    }
    if (arm.switch === 'slow' && !(typeof arm.ms === 'number' && arm.ms > 0)) {
      res.status(400).json({ error: 'slow needs ms > 0' });
      return;
    }
    armed.push({
      switch: arm.switch,
      persist: arm.persist === true,
      ...(arm.path ? { path: arm.path } : {}),
      ...(arm.ms ? { ms: arm.ms } : {}),
    });
    res.json({ armed });
  });

  app.delete('/__chaos', (_req, res) => {
    armed.length = 0;
    res.json({ armed });
  });

  app.use('/app', async (req: Request, res: Response, next: NextFunction) => {
    const path = req.baseUrl + req.path;
    if (EXEMPT.some((p) => path.startsWith(p))) {
      next();
      return;
    }
    const take = (sw: ChaosSwitch): ChaosArm | undefined => {
      const i = armed.findIndex((a) => a.switch === sw && (!a.path || path.startsWith(a.path)));
      if (i < 0) return undefined;
      const arm = armed[i];
      if (arm && !arm.persist) armed.splice(i, 1);
      return arm;
    };

    const slow = take('slow');
    if (slow?.ms) await sleep(slow.ms);

    if (take('error500')) {
      res.status(500).type('html').send(errorPage(ctx));
      return;
    }
    if (take('expireSession')) {
      ctx.sessions.destroy(req);
      res
        .type('html')
        .send(loginPage(ctx.tenant, 'Your session has expired. Please sign on again.'));
      return;
    }
    if (take('interstitial')) {
      res
        .type('html')
        .send(
          resubmitPage(
            ctx,
            req,
            'System notice',
            'Scheduled maintenance tonight from 11:00 PM to 1:00 AM. Save your work before then.',
            'Continue',
          ),
        );
      return;
    }
    if (take('unknownDialog')) {
      res
        .type('html')
        .send(
          resubmitPage(
            ctx,
            req,
            'Compliance Attestation',
            'Annual BSA/AML attestation is due. Confirm you have completed the required training.',
            'Acknowledge',
          ),
        );
      return;
    }
    next();
  });
}

/**
 * A page that, once dismissed, replays the request it interrupted: same
 * method, same URL, same form fields. That is how real interstitials behave,
 * and it means dismissing one leaves the flow exactly where it was.
 */
function resubmitPage(
  ctx: AppContext,
  req: Request,
  title: string,
  text: string,
  button: string,
): string {
  const method = req.method === 'POST' ? 'post' : 'get';
  const fields =
    method === 'post'
      ? (req.body ?? {})
      : (Object.fromEntries(new URL(req.originalUrl, 'http://x').searchParams) as Record<
          string,
          string
        >);
  const action = method === 'post' ? req.originalUrl : req.baseUrl + req.path;
  const hiddenFields = Object.entries(fields as Record<string, string>)
    .map(([k, v]) => hidden(k, String(v)))
    .join('');
  return page(
    ctx.tenant,
    title,
    `<font face="Arial" size="2">${esc(text)}</font><br><br>
<form method="${method}" action="${esc(action)}">${hiddenFields}${submit(button)}</form>`,
  );
}

function errorPage(ctx: AppContext): string {
  const incident = Math.random().toString(36).slice(2, 10).toUpperCase();
  return page(
    ctx.tenant,
    'Application Error',
    `<font face="Arial" size="2">An unexpected error occurred while processing your request.<br>
Incident reference: ${incident}<br>Contact the help desk if the problem persists.</font>`,
  );
}
