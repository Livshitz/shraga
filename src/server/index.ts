// Run-from-source entry — `bun run src/server/index.ts` (prod) and `bun run start`.
//
// This is now a thin consumer of the public library surface: the boot sequence lives in
// createShraga(...).start() (see ../index.ts + ./boot.ts). Behavior is unchanged — the same
// env-driven config, the same seams, the same server. The library is the one true boot path;
// this file just wires the environment into it.
import './env-resolve.ts'; // resolve named .env file (must be first — before any config read)
import './env-sanitize.ts'; // strip unresolved ${VAR} placeholders before any config is read
import { createShraga, fromEnv } from '../index.ts';

await createShraga(fromEnv()).start();
