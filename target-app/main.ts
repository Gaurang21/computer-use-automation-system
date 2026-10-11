// Starts both MemberDesk tenants: tenant A on :4000, tenant B on :4001.

import { createApp } from './server.js';
import { TENANTS } from './tenants.js';

for (const tenant of Object.values(TENANTS)) {
  createApp(tenant).listen(tenant.port, () => {
    console.log(
      `MemberDesk v${tenant.productVersion} (${tenant.tenantId}, ${tenant.institution}) on http://localhost:${tenant.port}`,
    );
  });
}
