import { describe, expect, it } from 'vitest';
import type { Condition } from '../../src/schema/app-profile.js';
import type { Outcome } from '../../src/schema/capability.js';
import { classify, retryAllowed } from '../../src/replay/classify.js';
import { matches } from '../../src/replay/matcher.js';
import type { Observation, ObservedElement } from '../../src/surface/types.js';

const screen = (texts: string[], url = 'http://h/app/search'): Observation => ({
  location: 'http://h/',
  frames: [
    { path: [], url: 'http://h/', title: 'MemberDesk' },
    { path: ['main'], url, title: texts[0] ?? '' },
  ],
  hash: 'h',
  takenAt: '',
  elements: texts.map((name, i): ObservedElement => ({
    ref: `e${i}`,
    role: name === 'Continue' ? 'button' : 'text',
    name,
    framePath: ['main'],
    bbox: { x: 0, y: i * 20, w: 10, h: 10 },
    states: [],
  })),
});

const notFound: Outcome = {
  code: 'MEMBER_NOT_FOUND',
  afterSteps: ['s3'],
  detect: { textPresent: 'No member found' },
  source: 'probe',
};
const conditions: Condition[] = [
  {
    id: 'maintenance_notice',
    class: 'recoverable',
    detect: { textPresent: 'System notice' },
    recover: { then: 'continue' },
    maxAttempts: 2,
  },
  {
    id: 'app_error',
    class: 'hard_failure',
    code: 'APP_ERROR',
    detect: { textPresent: 'Application Error' },
    maxAttempts: 1,
  },
];
const base = {
  stepId: 's3',
  expect: { textPresent: 'Member Detail' },
  outcomes: [notFound],
  conditions,
};

describe('state matchers', () => {
  const obs = screen(['Member Detail', 'Savings', 'Continue']);
  it('evaluates text, location, visibility and boolean combinators', () => {
    expect(matches(obs, { textPresent: 'Member Detail' })).toBe(true);
    expect(matches(obs, { textPresent: 'Detail', inFrame: ['main'] })).toBe(true);
    expect(matches(obs, { textPresent: 'Detail', inFrame: ['nav'] })).toBe(false);
    expect(matches(obs, { locationMatches: '/app/search$' })).toBe(true);
    expect(
      matches(obs, { visible: { locators: [{ kind: 'text', role: 'button', text: 'Continue' }] } }),
    ).toBe(true);
    expect(
      matches(obs, { all: [{ textPresent: 'Savings' }, { not: { textPresent: 'Checking' } }] }),
    ).toBe(true);
    expect(matches(obs, { any: [{ textPresent: 'nope' }, { textPresent: 'Savings' }] })).toBe(true);
  });
});

describe('classification order', () => {
  it('1: the step expectation wins', () => {
    expect(classify({ ...base, obs: screen(['Member Detail', 'No member found']) }).kind).toBe(
      'expected',
    );
  });

  it('2: a step-scoped business outcome comes before app conditions', () => {
    const c = classify({ ...base, obs: screen(['No member found', 'Application Error']) });
    expect(c).toMatchObject({ kind: 'outcome', outcome: { code: 'MEMBER_NOT_FOUND' } });
  });

  it('ignores outcomes scoped to other steps', () => {
    const c = classify({ ...base, stepId: 's1', obs: screen(['No member found']) });
    expect(c.kind).toBe('unrecognized');
  });

  it('3: app conditions are next', () => {
    expect(classify({ ...base, obs: screen(['System notice', 'Continue']) })).toMatchObject({
      kind: 'condition',
      condition: { id: 'maintenance_notice' },
    });
    expect(classify({ ...base, obs: screen(['Application Error']) })).toMatchObject({
      kind: 'condition',
      condition: { id: 'app_error' },
    });
  });

  it('4: anything else is unrecognized', () => {
    expect(classify({ ...base, obs: screen(['Compliance Attestation', 'Acknowledge']) }).kind).toBe(
      'unrecognized',
    );
  });
});

describe('retry safety', () => {
  it('allows a retry only when every executed step is retry safe', () => {
    expect(retryAllowed([{ id: 's1', retrySafe: true }])).toEqual({ ok: true });
    expect(
      retryAllowed([
        { id: 's8', retrySafe: true },
        { id: 's9', retrySafe: false },
      ]),
    ).toEqual({ ok: false, unsafe: ['s9'] });
  });
});
