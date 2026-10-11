// Synthetic seed data for MemberDesk. Every name, SSN fragment and account
// number here is invented. Nothing maps to a real person.

export type AccountType = 'Savings' | 'Checking' | 'Money Market' | 'Certificate';

export interface Account {
  type: AccountType;
  number: string;
  /** Balance in cents. Money is never a float. */
  balanceCents: number;
  nickname?: string;
}

export interface Member {
  id: string;
  name: string;
  ssnLast4: string;
  restricted: boolean;
  accounts: Account[];
}

export const SEED_MEMBERS: readonly Member[] = [
  {
    id: '10001',
    name: 'Avery Lindqvist',
    ssnLast4: '4417',
    restricted: false,
    accounts: [
      { type: 'Savings', number: '7001000101', balanceCents: 1_254_032 },
      { type: 'Checking', number: '7001000102', balanceCents: 88_915 },
    ],
  },
  {
    id: '10002',
    name: 'Jordan Okafor',
    ssnLast4: '9023',
    restricted: false,
    accounts: [
      { type: 'Savings', number: '7001000201', balanceCents: 50_000 },
      { type: 'Certificate', number: '7001000202', balanceCents: 2_500_000 },
    ],
  },
  {
    id: '10003',
    name: 'Riley Castellanos',
    ssnLast4: '3381',
    restricted: false,
    accounts: [
      { type: 'Checking', number: '7001000301', balanceCents: 412_877 },
      { type: 'Savings', number: '7001000302', balanceCents: 3_120_450 },
      { type: 'Money Market', number: '7001000303', balanceCents: 1_000_000 },
    ],
  },
  {
    // Has no savings account: exercises the NO_SAVINGS_ACCOUNT outcome.
    id: '10004',
    name: 'Morgan Achterberg',
    ssnLast4: '6612',
    restricted: false,
    accounts: [{ type: 'Checking', number: '7001000401', balanceCents: 23_310 }],
  },
  {
    id: '10005',
    name: 'Sam Whitcombe',
    ssnLast4: '1290',
    restricted: false,
    accounts: [{ type: 'Savings', number: '7001000501', balanceCents: 7_705 }],
  },
  {
    // Restricted: lookups return a permission denial.
    id: '10006',
    name: 'Casey Delacroix-Ng',
    ssnLast4: '5548',
    restricted: true,
    accounts: [{ type: 'Savings', number: '7001000601', balanceCents: 9_900_000 }],
  },
  {
    // Two savings accounts: "the savings balance" is ambiguous for this member.
    id: '10007',
    name: 'Taylor Brennan',
    ssnLast4: '7734',
    restricted: false,
    accounts: [
      { type: 'Savings', number: '7001000701', balanceCents: 640_000 },
      { type: 'Savings', number: '7001000703', balanceCents: 18_000 },
      { type: 'Checking', number: '7001000702', balanceCents: 15_250 },
    ],
  },
  {
    id: '10008',
    name: 'Quinn Haverford',
    ssnLast4: '8805',
    restricted: false,
    accounts: [{ type: 'Savings', number: '7001000801', balanceCents: 125 }],
  },
];

/** Opening deposit floor for a new sub-account, in cents. */
export const MIN_OPENING_DEPOSIT_CENTS = 2_500;

export const SUB_ACCOUNT_TYPES: readonly AccountType[] = ['Savings', 'Money Market', 'Certificate'];

/**
 * Mutable per-server copy of the seed data, so opening a sub-account in one
 * test or tenant never leaks into another.
 */
export class MemberStore {
  private readonly members: Map<string, Member>;
  private nextAccountSeq = 900;

  constructor(seed: readonly Member[] = SEED_MEMBERS) {
    this.members = new Map(seed.map((m) => [m.id, structuredClone(m)]));
  }

  get(id: string): Member | undefined {
    return this.members.get(id);
  }

  openSubAccount(
    memberId: string,
    type: AccountType,
    nickname: string,
    depositCents: number,
  ): Account {
    const member = this.members.get(memberId);
    if (!member) throw new Error(`unknown member ${memberId}`);
    const account: Account = {
      type,
      number: `70${memberId}${String(this.nextAccountSeq++).padStart(3, '0')}`.slice(0, 10),
      balanceCents: depositCents,
      nickname,
    };
    member.accounts.push(account);
    return account;
  }
}

export function formatMoney(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString('en-US');
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, '0')}`;
}

/** Parses "1,234.56" or "$1234" into cents. Returns null when it is not money. */
export function parseMoneyInput(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole = '0', frac = ''] = cleaned.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}
