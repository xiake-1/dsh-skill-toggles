/**
 * dsh-skill-toggles — uninstall cleanup.
 *
 * Runs as the package's `postuninstall` lifecycle script (pnpm executes it
 * when `dsh plugin --profile <p> remove dsh-skill-toggles` removes the
 * package), so the plugin's persisted blacklist is removed together with the
 * plugin.
 *
 * Deletes the whole plugin-owned state directory:
 *   `<harness home>/dsh-skill-toggles/`
 * (`<harness home>` = `$DSH_HOME` or `~/.dsh`). Idempotent and safe: a
 * missing directory is not an error.
 */
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const dir = join(home, 'dsh-skill-toggles');

try {
  await rm(dir, { recursive: true, force: true });
  console.log(`dsh-skill-toggles: removed state directory ${dir}`);
} catch (error) {
  console.error(`dsh-skill-toggles: failed to remove state directory ${dir}: ${String(error)}`);
  process.exitCode = 1;
}
