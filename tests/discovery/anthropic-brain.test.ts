import { describe, expect, it } from 'vitest';
import { DECIDE_TOOLS, renderDecidePrompt } from '../../src/discovery/anthropic-brain.js';
import type { Observation } from '../../src/surface/types.js';

describe('Anthropic brain (no network)', () => {
  it('defines strict tools whose schemas require every property', () => {
    for (const t of DECIDE_TOOLS) {
      expect(t.strict).toBe(true);
      const schema = t.input_schema as unknown as {
        properties: object;
        required: string[];
        additionalProperties: boolean;
      };
      expect(schema.additionalProperties).toBe(false);
      expect(schema.required.sort()).toEqual(Object.keys(schema.properties).sort());
    }
    expect(DECIDE_TOOLS.map((t) => t.name)).toEqual([
      'click',
      'type',
      'select',
      'press',
      'read',
      'wait',
      'done',
      'stuck',
    ]);
  });

  it('shows secrets by name only and lists elements with their labels', () => {
    const obs: Observation = {
      location: 'http://h/',
      frames: [{ path: ['main'], url: 'http://h/app/login', title: 'MemberDesk Sign On' }],
      hash: 'x',
      takenAt: '',
      elements: [
        {
          ref: 'e3',
          role: 'textbox',
          name: '',
          nearText: { text: 'Password', relation: 'left_of' },
          framePath: ['main'],
          bbox: { x: 0, y: 0, w: 1, h: 1 },
          states: [],
        },
      ],
    };
    const text = renderDecidePrompt({
      goal: 'Look up member 10001',
      inputs: [{ name: 'memberId', binding: 'inputs.memberId', value: '10001' }],
      outputs: [{ name: 'savingsBalance', type: 'money' }],
      secrets: ['operatorPassword'],
      history: [],
      observation: obs,
      step: 1,
      maxSteps: 25,
    });
    expect(text).toContain('secrets.operatorPassword (secret, value hidden)');
    expect(text).toContain('[e3] textbox "" (label left: "Password")');
    expect(text).not.toContain('change-me-local-only');
  });

  it('refuses to start without an API key', async () => {
    const { AnthropicBrain } = await import('../../src/discovery/anthropic-brain.js');
    const { SpendTracker } = await import('../../src/discovery/spend.js');
    expect(
      () =>
        new AnthropicBrain({ model: 'claude-sonnet-5-5', spend: new SpendTracker(1), apiKey: '' }),
    ).toThrow(/ANTHROPIC_API_KEY/);
  });
});
