// Drop env vars whose value is an unresolved `${VAR}` placeholder left by deploy tooling
// (deploy tools may write `KEY=${VAR}` when the source var is unset). Such a value is never
// legitimate — it defeats `process.env.A ?? process.env.B` fallbacks and breaks JSON.parse.
// Imported first in index.ts so it runs before any config is read.
const PLACEHOLDER = /^['"]?\$\{[A-Za-z0-9_]+\}['"]?$/;

for (const [key, value] of Object.entries(process.env)) {
  if (typeof value === 'string' && PLACEHOLDER.test(value.trim())) delete process.env[key];
}
