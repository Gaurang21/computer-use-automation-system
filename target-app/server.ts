// MemberDesk: a fictional teller back-office for an invented credit union.
// One Express app per tenant, built from a TenantConfig.

import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { MemberStore, formatMoney, type Member } from './data.js';
import { registerChaos } from './chaos.js';
import { SessionStore } from './session.js';
import { registerSubAccountRoutes } from './subaccount.js';
import { accountTypeLabel, type NavItem, type TenantConfig } from './tenants.js';
import {
  doc,
  esc,
  fieldGrid,
  frameset,
  message,
  page,
  submit,
  textInput,
  hidden,
} from './views.js';

export interface AppContext {
  tenant: TenantConfig;
  members: MemberStore;
  sessions: SessionStore;
}

export function createApp(tenant: TenantConfig): Express {
  const ctx: AppContext = { tenant, members: new MemberStore(), sessions: new SessionStore() };
  const app = express();
  app.disable('x-powered-by');
  app.use(express.urlencoded({ extended: false }));

  app.get('/', (_req, res) => {
    res.type('html').send(frameset(tenant));
  });

  app.get('/app/banner', (_req, res) => {
    res.type('html').send(
      doc(
        'banner',
        `<table width="100%" cellpadding="6" cellspacing="0" border="0"><tr>
  <td><font face="Georgia" size="5" color="#ffffff"><b>${esc(tenant.institution)}</b></font></td>
  <td align="right"><font face="Arial" size="2" color="#dddddd">MemberDesk Teller Workstation</font></td>
</tr></table>`,
        tenant.bannerColor,
      ),
    );
  });

  app.get('/app/nav', (_req, res) => {
    res.type('html').send(doc('nav', navHtml(tenant), '#d8d8c8'));
  });

  app.get('/app/main', (req, res) => {
    res.redirect(303, ctx.sessions.get(req) ? '/app/home' : '/app/login');
  });

  app.get('/app/login', (_req, res) => {
    res.type('html').send(loginPage(tenant));
  });

  app.post('/app/login', (req, res) => {
    const { f1 = '', f2 = '' } = req.body as Record<string, string>;
    if (f1 !== tenant.operator.id || f2 !== tenant.operator.password) {
      res.type('html').send(loginPage(tenant, 'Invalid operator ID or password.', f1));
      return;
    }
    ctx.sessions.create(res, f1);
    res.redirect(303, '/app/home');
  });

  app.get('/app/logout', (req, res) => {
    ctx.sessions.destroy(req);
    res.redirect(303, '/');
  });

  // Everything below needs a signed-in operator.
  app.use('/app', requireSession(ctx));
  // Failure switches fire only for signed-in pages, after the session check.
  registerChaos(app, ctx);

  app.get('/app/home', (req, res) => {
    const op = ctx.sessions.get(req)?.operatorId ?? '';
    res
      .type('html')
      .send(
        page(
          tenant,
          'Teller Home',
          `<font face="Arial" size="2">Welcome, ${esc(op)}. Select a function from the menu.</font>`,
        ),
      );
  });

  app.get('/app/search', (_req, res) => {
    res.type('html').send(searchPage(tenant));
  });

  app.post('/app/search', (req, res) => {
    const { f1 = '' } = req.body as Record<string, string>;
    const id = f1.trim();
    if (!/^\d{5}$/.test(id)) {
      res.type('html').send(searchPage(tenant, `${tenant.labels.memberId} must be 5 digits.`, id));
      return;
    }
    const member = ctx.members.get(id);
    if (!member) {
      res
        .type('html')
        .send(searchPage(tenant, `No member found for ${tenant.labels.memberId} ${id}.`, id));
      return;
    }
    if (member.restricted) {
      res
        .type('html')
        .send(searchPage(tenant, 'You are not authorized to view this member record.', id));
      return;
    }
    res.type('html').send(memberDetailPage(tenant, member));
  });

  registerSubAccountRoutes(app, ctx);

  app.get('/app/admin', (_req, res) => {
    res.type('html').send(
      page(
        tenant,
        tenant.labels.admin,
        `<form method="post" action="/app/admin/reset-passwords">
  <font face="Arial" size="2">Operator maintenance.</font><br><br>
  ${submit('Reset All Operator Passwords')}
</form>`,
      ),
    );
  });

  return app;
}

function requireSession(ctx: AppContext) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (ctx.sessions.get(req)) {
      next();
      return;
    }
    res.type('html').send(loginPage(ctx.tenant, 'Please sign on to continue.'));
  };
}

function navHtml(tenant: TenantConfig): string {
  const links: Record<NavItem, string> = {
    home: `<a href="/app/home" target="main">${esc(tenant.labels.home)}</a>`,
    search: `<a href="/app/search" target="main">${esc(tenant.labels.memberSearch)}</a>`,
    admin: `<a href="/app/admin" target="main">${esc(tenant.labels.admin)}</a>`,
    signout: `<a href="/app/logout" target="_top">${esc(tenant.labels.signOut)}</a>`,
  };
  const rows = tenant.navOrder
    .map((item) => `<tr><td><font face="Arial" size="2">${links[item]}</font></td></tr>`)
    .join('\n');
  return `<table cellpadding="4" cellspacing="0" border="0" width="100%"><tr><td>
  <table cellpadding="2" cellspacing="0" border="0">${rows}</table>
</td></tr></table>`;
}

export function loginPage(tenant: TenantConfig, msg?: string, operatorId = ''): string {
  return page(
    tenant,
    'MemberDesk Sign On',
    `${msg ? message(msg) : ''}
<form method="post" action="/app/login" target="_self">
${fieldGrid([
  { label: 'Operator ID', input: textInput('f1', operatorId, 12) },
  { label: 'Password', input: textInput('f2', '', 12, 'password') },
])}
<br>${submit('Sign On')}
</form>`,
  );
}

function searchPage(tenant: TenantConfig, msg?: string, value = ''): string {
  return page(
    tenant,
    tenant.labels.memberSearch,
    `<font face="Arial" size="2">${esc(tenant.labels.findAMember)}</font><br><br>
${msg ? message(msg) : ''}
<form method="post" action="/app/search">
${fieldGrid([{ label: tenant.labels.memberId, input: textInput('f1', value, 10) }])}
<br>${submit(tenant.labels.searchButton)}
</form>`,
  );
}

function memberDetailPage(tenant: TenantConfig, member: Member): string {
  const rows = member.accounts
    .map(
      (a) =>
        `<tr><td><font face="Arial" size="2">${esc(accountTypeLabel(tenant.labels, a.type))}</font></td><td><font face="Courier" size="2">${esc(a.number)}</font></td><td align="right"><font face="Courier" size="2">${formatMoney(a.balanceCents)}</font></td></tr>`,
    )
    .join('\n');
  return page(
    tenant,
    tenant.labels.memberDetail,
    `<table cellpadding="3" cellspacing="0" border="0">
<tr><td><font face="Arial" size="2">Name</font></td><td><font face="Arial" size="2"><b>${esc(member.name)}</b></font></td></tr>
<tr><td><font face="Arial" size="2">${esc(tenant.labels.memberId)}</font></td><td><font face="Arial" size="2">${esc(member.id)}</font></td></tr>
<tr><td><font face="Arial" size="2">SSN</font></td><td><font face="Arial" size="2">***-**-${esc(member.ssnLast4)}</font></td></tr>
</table>
<br><font face="Arial" size="2"><b>Accounts</b></font>
<table cellpadding="4" cellspacing="0" border="1" width="80%">
<tr bgcolor="#dddddd"><td><font face="Arial" size="2"><b>Type</b></font></td><td><font face="Arial" size="2"><b>Account Number</b></font></td><td><font face="Arial" size="2"><b>Balance</b></font></td></tr>
${rows}
</table>
<br>
<form method="get" action="/app/subaccount">${hidden('m', member.id)}${submit('Open Sub-Account')}</form>`,
  );
}
