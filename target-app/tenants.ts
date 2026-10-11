// One MemberDesk codebase, two tenants. Tenant B is the same vendor product on
// an older version with a different skin: renamed labels, reordered nav, other
// branding. Behaviour is identical. It stands in for two institutions running
// one vendor product.

export type NavItem = 'home' | 'search' | 'admin' | 'signout';

export interface TenantConfig {
  tenantId: string;
  institution: string;
  productVersion: string;
  port: number;
  bannerColor: string;
  navOrder: NavItem[];
  /** Synthetic operator login. Not a real credential. */
  operator: { id: string; password: string };
  /** Every user-visible label goes through this table. */
  labels: Labels;
}

export interface Labels {
  memberId: string;
  savings: string;
  searchButton: string;
  memberSearch: string;
  findAMember: string;
  memberDetail: string;
  home: string;
  admin: string;
  signOut: string;
}

const BASE_LABELS: Labels = {
  memberId: 'Member ID',
  savings: 'Savings',
  searchButton: 'Search',
  memberSearch: 'Member Search',
  findAMember: 'Find a member',
  memberDetail: 'Member Detail',
  home: 'Home',
  admin: 'Administration',
  signOut: 'Sign Out',
};

const operator = {
  id: process.env.MEMBERDESK_OPERATOR_ID ?? 'teller01',
  password: process.env.MEMBERDESK_OPERATOR_PASSWORD ?? 'change-me-local-only',
};

export const TENANTS: Record<'tenant-a' | 'tenant-b', TenantConfig> = {
  'tenant-a': {
    tenantId: 'tenant-a',
    institution: 'Cedar Valley Credit Union',
    productVersion: '7.4',
    port: 4000,
    bannerColor: '#003366',
    navOrder: ['home', 'search', 'admin', 'signout'],
    operator,
    labels: BASE_LABELS,
  },
  'tenant-b': {
    tenantId: 'tenant-b',
    institution: 'Prairie Ridge Federal Credit Union',
    productVersion: '7.2',
    port: 4001,
    bannerColor: '#5a2d0c',
    navOrder: ['search', 'home', 'signout', 'admin'],
    operator,
    labels: {
      ...BASE_LABELS,
      memberId: 'Account Holder No.',
      savings: 'Share Savings',
      searchButton: 'Find',
    },
  },
};

/** The display label for an account type under a tenant's renames. */
export function accountTypeLabel(labels: Labels, type: string): string {
  return type === 'Savings' ? labels.savings : type;
}
