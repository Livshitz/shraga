// Drop env vars whose value is an unresolved `${VAR}` placeholder left by deploy tooling
// (deploy tools may write `KEY=${VAR}` when the source var is unset). Such a value is never
// legitimate — it defeats `process.env.A ?? process.env.B` fallbacks and breaks JSON.parse.
// Imported first in index.ts so it runs before any config is read.
const PLACEHOLDER = /^['"]?\$\{[A-Za-z0-9_]+\}['"]?$/;

for (const [key, value] of Object.entries(process.env)) {
  if (typeof value === 'string' && PLACEHOLDER.test(value.trim())) delete process.env[key];
}

// A PEM key stored UNQUOTED in an EnvironmentFile loses its backslashes — systemd does not process
// escapes there, so `KEY=-----BEGIN…\nMHc…` arrives as `-----BEGIN…nMHc…`: the `\n`s become stray `n`
// characters INSIDE the base64. The value still looks like a key, so it fails far away and much later
// (`NO_START_LINE` from OpenSSL, mid-job), and an inherited env beats any later `--env-file`. Warning
// at boot turns a day-long silent data gap into a line in the log. Warn, never delete — a broken
// credential is still better than a missing one for diagnosing.
for (const [key, value] of Object.entries(process.env)) {
  if (typeof value !== 'string' || !value.includes('-----BEGIN')) continue;
  if (value.includes('\n') || value.includes('\\n')) continue; // real or escaped newlines: fine
  console.warn(`[env] ⚠️  ${key} looks like a PEM key with its newlines eaten (no \\n at all) — quote it in the env file ('single quotes'), else it will fail at use time with NO_START_LINE.`);
}
