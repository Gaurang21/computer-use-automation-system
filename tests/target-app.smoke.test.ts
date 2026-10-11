import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { HttpOperator, startTenant, type RunningTenant } from './support/memberdesk.js';

describe('MemberDesk tenant A', () => {
  let app: RunningTenant;
  let op: HttpOperator;

  beforeAll(async () => {
    app = await startTenant('tenant-a');
  });
  afterAll(() => app.close());
  beforeEach(async () => {
    await app.reset();
    op = new HttpOperator(app.baseUrl);
    await op.signOn(app.operator.id, app.operator.password);
  });

  it('serves a frameset with banner, nav and main frames', async () => {
    const { html } = await op.get('/');
    expect(html).toContain('<frame src="/app/banner" name="banner"');
    expect(html).toContain('<frame src="/app/nav" name="nav"');
    expect(html).toContain('<frame src="/app/main" name="main"');
  });

  it('rejects bad credentials and asks for sign-on when there is no session', async () => {
    const anon = new HttpOperator(app.baseUrl);
    expect((await anon.post('/app/login', { f1: 'teller01', f2: 'wrong' })).html).toContain(
      'Invalid operator ID or password.',
    );
    expect((await anon.get('/app/search')).html).toContain('Please sign on to continue.');
  });

  it('walks the lookup flow to the savings balance', async () => {
    expect((await op.get('/app/search')).html).toContain('Find a member');
    const { html } = await op.post('/app/search', { f1: '10001' });
    expect(html).toContain('Member Detail');
    expect(html).toContain('Avery Lindqvist');
    expect(html).toContain('***-**-4417');
    expect(html).toContain('$12,540.32');
    expect(html).toContain('MemberDesk v7.4');
  });

  it('returns the built-in business outcomes', async () => {
    expect((await op.post('/app/search', { f1: '99999' })).html).toContain('No member found');
    expect((await op.post('/app/search', { f1: '10006' })).html).toContain(
      'You are not authorized',
    );
    expect((await op.post('/app/search', { f1: '12' })).html).toContain('must be 5 digits');
    const noSavings = (await op.post('/app/search', { f1: '10004' })).html;
    expect(noSavings).toContain('Member Detail');
    expect(noSavings).not.toContain('Savings');
  });

  it('walks the open sub-account flow through review to confirmation', async () => {
    expect((await op.get('/app/subaccount?m=10002')).html).toContain('Opening Deposit');
    const form = { m: '10002', f1: 'Money Market', f2: 'Rainy day', f3: '150.00' };
    const review = (await op.post('/app/subaccount/review', form)).html;
    expect(review).toContain('Review New Account');
    expect(review).toContain('$150.00');
    expect(review).toContain('value="Submit"');
    const done = (await op.post('/app/subaccount/submit', form)).html;
    expect(done).toContain('Account Opened');
    expect(done).toMatch(/New Account Number.*?<b>\d{10}<\/b>/s);
  });

  it('rejects an opening deposit under the minimum', async () => {
    const { html } = await op.post('/app/subaccount/review', {
      m: '10002',
      f1: 'Savings',
      f2: 'Too small',
      f3: '5',
    });
    expect(html).toContain('Opening deposit must be at least $25.00.');
  });

  it('has an admin area (the policy, not the app, blocks it)', async () => {
    expect((await op.get('/app/admin')).html).toContain('Reset All Operator Passwords');
  });

  describe('failure switches', () => {
    it('interstitial: shows a notice whose Continue replays the interrupted request', async () => {
      await app.arm({ switch: 'interstitial' });
      const notice = (await op.post('/app/search', { f1: '10001' })).html;
      expect(notice).toContain('System notice');
      expect(notice).toContain('value="Continue"');
      expect(notice).toContain('name="f1" value="10001"');
      expect((await op.post('/app/search', { f1: '10001' })).html).toContain('Member Detail');
    });

    it('expireSession: lands on sign-on and drops the session', async () => {
      await app.arm({ switch: 'expireSession' });
      expect((await op.get('/app/search')).html).toContain('Your session has expired');
      expect((await op.get('/app/search')).html).toContain('Please sign on to continue.');
    });

    it('slow: delays the response', async () => {
      await app.arm({ switch: 'slow', ms: 300 });
      const start = Date.now();
      expect((await op.get('/app/search')).html).toContain('Find a member');
      expect(Date.now() - start).toBeGreaterThanOrEqual(290);
    });

    it('error500: shows the application error page', async () => {
      await app.arm({ switch: 'error500' });
      const res = await op.get('/app/search');
      expect(res.status).toBe(500);
      expect(res.html).toContain('Application Error');
    });

    it('unknownDialog: shows a page no artifact knows, with Acknowledge', async () => {
      await app.arm({ switch: 'unknownDialog' });
      const html = (await op.post('/app/search', { f1: '10001' })).html;
      expect(html).toContain('Compliance Attestation');
      expect(html).toContain('value="Acknowledge"');
    });

    it('fires once by default, every time with persist, and only on a matching path', async () => {
      await app.arm({ switch: 'error500', path: '/app/subaccount' });
      expect((await op.get('/app/search')).status).toBe(200);
      expect((await op.get('/app/subaccount?m=10001')).status).toBe(500);
      expect((await op.get('/app/subaccount?m=10001')).status).toBe(200);

      await app.arm({ switch: 'interstitial', persist: true });
      expect((await op.get('/app/search')).html).toContain('System notice');
      expect((await op.get('/app/search')).html).toContain('System notice');
    });

    it('rejects an unknown switch', async () => {
      await expect(app.arm({ switch: 'nope' as never })).rejects.toThrow(/switch must be one of/);
    });
  });
});

describe('MemberDesk tenant B (same product, different skin)', () => {
  let app: RunningTenant;
  let op: HttpOperator;

  beforeAll(async () => {
    app = await startTenant('tenant-b');
    op = new HttpOperator(app.baseUrl);
    await op.signOn(app.operator.id, app.operator.password);
  });
  afterAll(() => app.close());

  it('renames labels and reports its own version', async () => {
    const search = (await op.get('/app/search')).html;
    expect(search).toContain('Account Holder No.');
    expect(search).toContain('value="Find"');
    const detail = (await op.post('/app/search', { f1: '10001' })).html;
    expect(detail).toContain('Share Savings');
    expect(detail).toContain('MemberDesk v7.2');
  });

  it('reorders the nav and rebrands the banner', async () => {
    const nav = (await op.get('/app/nav')).html;
    expect(nav.indexOf('Member Search')).toBeLessThan(nav.indexOf('Home'));
    expect((await op.get('/app/banner')).html).toContain('Prairie Ridge Federal Credit Union');
  });
});
