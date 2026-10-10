/**
 * dsh-skill-toggles — dedicated state store.
 *
 * Persists the blacklist to a plugin-owned location OUTSIDE settings.yaml:
 *
 *   `<harness home>/dsh-skill-toggles/state.json`
 *
 * (`<harness home>` = `$DSH_HOME` or `~/.dsh`). Writes are atomic (temp file
 * + rename) and serialized through a promise chain; reads fall back to the
 * EMPTY state on a missing or corrupt file — the blacklist default is
 * "everything allowed", so a broken file must never hide skills. The whole
 * directory is plugin-owned: uninstalling the package runs
 * `scripts/cleanup.mjs` (postuninstall) and removes the data with it.
 */
import { readFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { normalizeState } from './state.js';

/** Resolve the plugin-owned state directory under the harness home. */
export function resolveStateDir(dshHome) {
  const home = dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
  return join(home, 'dsh-skill-toggles');
}

/**
 * Create the state store.
 * @param options.dshHome - explicit harness home (tests pass a temp dir).
 * @param options.logger - optional `{ warn, error }` logger (defaults to console).
 */
export function createStateStore({ dshHome, logger = console } = {}) {
  const dir = resolveStateDir(dshHome);
  const file = join(dir, 'state.json');
  let state = { disabled: [] };
  let writeChain = Promise.resolve();

  /**
   * Load state from disk SYNCHRONOUSLY (idempotent; call once at startup).
   * The host plugin's apply() must stay synchronous — Cordis treats a
   * prototype-bearing function as a constructor and ignores its returned
   * promise, so an async apply would turn any post-await throw into an
   * unhandled rejection that crashes the whole dsh process.
   */
  function loadSync() {
    try {
      state = normalizeState(JSON.parse(readFileSync(file, 'utf8')));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger.warn?.(`dsh-skill-toggles: state file unreadable (${file}): ${String(error)}; starting with everything enabled`);
      }
      state = { disabled: [] };
    }
    return state;
  }

  /** Load state from disk (async variant; kept for tests and tooling). */
  async function load() {
    try {
      state = normalizeState(JSON.parse(await readFile(file, 'utf8')));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        logger.warn?.(`dsh-skill-toggles: state file unreadable (${file}): ${String(error)}; starting with everything enabled`);
      }
      state = { disabled: [] };
    }
    return state;
  }

  /** Current in-memory state (plain data; callers must not mutate it). */
  function get() {
    return state;
  }

  /** Merge a patch into the state and persist atomically. */
  function update(patch) {
    state = { ...state, ...patch };
    return persist();
  }

  /** Serialized atomic write; failures never poison the chain. */
  function persist() {
    const snapshot = JSON.stringify(state, null, 2);
    writeChain = writeChain
      .then(async () => {
        await mkdir(dir, { recursive: true });
        const tmp = join(dir, `.state.${process.pid}.${Date.now()}.tmp`);
        await writeFile(tmp, snapshot, 'utf8');
        await rename(tmp, file);
      })
      .catch((error) => {
        logger.error?.(`dsh-skill-toggles: state write failed (${file}): ${String(error)}`);
      });
    return writeChain;
  }

  return { load, loadSync, get, update, persist, dir, file };
}
