// Open sub-account flow: form -> review -> confirmation. The final Submit on
// the review screen is the irreversible step.

import type { Express } from 'express';
import {
  MIN_OPENING_DEPOSIT_CENTS,
  SUB_ACCOUNT_TYPES,
  formatMoney,
  parseMoneyInput,
} from './data.js';
import type { AccountType } from './data.js';
import type { AppContext } from './server.js';
import { accountTypeLabel, type TenantConfig } from './tenants.js';
import { esc, fieldGrid, hidden, message, page, select, submit, textInput } from './views.js';

interface FormValues {
  m: string;
  f1: string;
  f2: string;
  f3: string;
}

export function registerSubAccountRoutes(app: Express, ctx: AppContext): void {
  const { tenant } = ctx;

  app.get('/app/subaccount', (req, res) => {
    const m = String(req.query.m ?? '');
    const member = ctx.members.get(m);
    if (!member || member.restricted) {
      res.type('html').send(page(tenant, 'Open Sub-Account', message('No member selected.')));
      return;
    }
    res.type('html').send(formPage(tenant, member.name, { m, f1: '', f2: '', f3: '' }));
  });

  app.post('/app/subaccount/review', (req, res) => {
    const values = readForm(req.body);
    const member = ctx.members.get(values.m);
    if (!member || member.restricted) {
      res.type('html').send(page(tenant, 'Open Sub-Account', message('No member selected.')));
      return;
    }
    const error = validate(values);
    if (error) {
      res.type('html').send(formPage(tenant, member.name, values, error));
      return;
    }
    res.type('html').send(reviewPage(tenant, member.name, values));
  });

  app.post('/app/subaccount/submit', (req, res) => {
    const values = readForm(req.body);
    const member = ctx.members.get(values.m);
    const error = validate(values);
    if (!member || member.restricted || error) {
      res
        .type('html')
        .send(page(tenant, 'Open Sub-Account', message(error ?? 'No member selected.')));
      return;
    }
    const account = ctx.members.openSubAccount(
      member.id,
      values.f1 as AccountType,
      values.f2.trim(),
      parseMoneyInput(values.f3) ?? 0,
    );
    res.type('html').send(
      page(
        tenant,
        'Account Opened',
        `<font face="Arial" size="2">The sub-account was opened for ${esc(member.name)}.</font><br><br>
${summaryGrid([
  ['New Account Number', account.number],
  ['Account Type', accountTypeLabel(tenant.labels, account.type)],
  ['Opening Deposit', formatMoney(account.balanceCents)],
])}`,
      ),
    );
  });
}

function readForm(body: unknown): FormValues {
  const b = (body ?? {}) as Record<string, string | undefined>;
  return { m: b.m ?? '', f1: b.f1 ?? '', f2: b.f2 ?? '', f3: b.f3 ?? '' };
}

function validate(v: FormValues): string | undefined {
  if (!SUB_ACCOUNT_TYPES.includes(v.f1 as AccountType)) return 'Account type is required.';
  if (!v.f2.trim()) return 'Nickname is required.';
  const cents = parseMoneyInput(v.f3);
  if (cents === null) return 'Opening deposit must be a dollar amount.';
  if (cents < MIN_OPENING_DEPOSIT_CENTS)
    return `Opening deposit must be at least ${formatMoney(MIN_OPENING_DEPOSIT_CENTS)}.`;
  return undefined;
}

function formPage(tenant: TenantConfig, memberName: string, v: FormValues, error?: string): string {
  return page(
    tenant,
    'Open Sub-Account',
    `<font face="Arial" size="2">Member: <b>${esc(memberName)}</b></font><br><br>
${error ? message(error) : ''}
<form method="post" action="/app/subaccount/review">
${hidden('m', v.m)}
${fieldGrid([
  { label: 'Account Type', input: select('f1', SUB_ACCOUNT_TYPES, v.f1) },
  { label: 'Nickname', input: textInput('f2', v.f2, 24) },
  { label: 'Opening Deposit', input: textInput('f3', v.f3, 12) },
])}
<br>${submit('Review')}
</form>`,
  );
}

function reviewPage(tenant: TenantConfig, memberName: string, v: FormValues): string {
  return page(
    tenant,
    'Review New Account',
    `<font face="Arial" size="2">Confirm the details below. Submitting opens the account and cannot be undone.</font><br><br>
${summaryGrid([
  ['Member', memberName],
  ['Account Type', accountTypeLabel(tenant.labels, v.f1)],
  ['Nickname', v.f2.trim()],
  ['Opening Deposit', formatMoney(parseMoneyInput(v.f3) ?? 0)],
])}
<br>
<form method="post" action="/app/subaccount/submit">
${hidden('m', v.m)}${hidden('f1', v.f1)}${hidden('f2', v.f2)}${hidden('f3', v.f3)}
${submit('Submit')}
</form>`,
  );
}

function summaryGrid(rows: [string, string][]): string {
  const trs = rows
    .map(
      ([k, val]) =>
        `<tr><td><font face="Arial" size="2">${esc(k)}</font></td><td><font face="Arial" size="2"><b>${esc(val)}</b></font></td></tr>`,
    )
    .join('\n');
  return `<table cellpadding="3" cellspacing="0" border="0">${trs}</table>`;
}
