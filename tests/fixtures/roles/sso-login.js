// Stands in for an SSO/MFA login script: writes a Playwright storage state to $WINGMAN_ROLE_STATE_FILE.
const fs = require('fs');
const host = new URL(process.env.WINGMAN_BASE_URL).hostname;
if (process.env.SSO_FAIL) { console.error('SSO provider said no'); process.exit(3); }
fs.writeFileSync(process.env.WINGMAN_ROLE_STATE_FILE, JSON.stringify({ cookies: [{ name: 'sid', value: 'admin', domain: host, path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' }], origins: [] }));
