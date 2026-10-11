// Synthetic MemberDesk credentials for tests. The target app and the replay
// engine both read them from the environment, as they would in production.
process.env.MEMBERDESK_OPERATOR_ID ??= 'teller01';
process.env.MEMBERDESK_OPERATOR_PASSWORD ??= 'change-me-local-only';
