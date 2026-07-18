/**
 * Back-compat shim for the pre-de-brand module name. NOT a second source of truth —
 * it re-exports `shraga-config.ts` and must never grow logic or its own types.
 *
 * Why it exists: a deployment's data config is written by the operator and value-imports
 * this path (`import { defineConfig } from '../src/server/unclaw-config.ts'`), so the name
 * is part of our public surface — renaming the module broke every deployment still carrying
 * a legacy `data/unclaw.config.ts`, and the loader swallows that failure into an empty config.
 *
 * Same back-compat contract the loader already honours on the filename side
 * (`CONFIG_FILENAMES = ['shraga.config.ts', 'unclaw.config.ts']`, new name preferred,
 * old name still accepted) — this is that contract on the module side.
 *
 * Retire both together, once no deployment ships a legacy config.
 */
export * from './shraga-config.ts';

/** Legacy name for {@link ShragaConfig} — the interface a legacy data config may annotate with. */
export type { ShragaConfig as UnclawConfig } from './shraga-config.ts';
