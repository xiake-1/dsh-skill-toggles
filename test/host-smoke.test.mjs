/**
 * Host-half smoke test: run apply() end to end against a stub Cordis ctx.
 *
 * Why this exists: `node --check` cannot see an identifier that is USED but
 * never IMPORTED, and that failure mode is invisible until runtime — the fiber
 * dies inside apply(), no tools and no RPC surface register, and the panel
 * button silently stops opening (0.6.0 shipped exactly this with `dirname`).
 * This test executes the whole apply() path and asserts the mount completed.
 * Run with: node test/state.test.mjs && node test/host-smoke.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOOL_NAMES = [
  'skill_toggles_list',
  'skill_toggles_disable',
  'skill_toggles_enable',
  'skill_toggles_enable_all',
  'skill_toggles_disable_all',
  'skill_toggles_source_set',
  'skill_toggles_group_create',
  'skill_toggles_group_delete',
  'skill_toggles_group_set_active',
];

/** A stub ctx covering exactly the host surfaces lib/index.js touches. */
function createStubCtx() {
  const seen = { tools: [], events: [], effects: [] };
  const noopDisposer = () => () => {};
  const ctx = {
    logger: { warn() {}, error() {}, info() {} },
    agents: { list: () => [] },
    sessions: { list: () => [] },
    skills: {
      list: async () => [],
      get: async () => undefined,
      register: () => ({ invalidate: () => {}, dispose: () => {} }),
    },
    tools: {
      register: (definition) => {
        seen.tools.push(definition);
        return noopDisposer;
      },
    },
    on: (event) => {
      seen.events.push(event);
      return noopDisposer;
    },
    emit: () => {},
    effect: (dispose) => {
      seen.effects.push(dispose);
      return () => dispose();
    },
    loader: { entries: () => [{ options: { name: 'dsh-skill-toggles' } }] },
    get: () => undefined, // no web server in the stub: the RPC surface must bail cleanly
  };
  return { ctx, seen };
}

test('host apply() mounts cleanly, registers every tool, and disposes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-skill-toggles-home-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home; // the state store must not touch the real profile
  try {
    const mod = await import('../lib/index.js');
    const { ctx, seen } = createStubCtx();
    let dispose;
    assert.doesNotThrow(() => {
      dispose = mod.apply(ctx, {});
    }, 'apply() must not throw (an unimported identifier here kills the fiber silently)');
    assert.equal(mod.name, 'skill-toggles');

    assert.deepEqual(seen.tools.map((definition) => definition.name), TOOL_NAMES);
    for (const definition of seen.tools) {
      assert.equal(definition.parameters.type, 'object');
      assert.equal(typeof definition.execute, 'function');
      assert.ok(definition.description.length > 0, `${definition.name} needs a description`);
    }

    // The catalog-change subscription is what keeps the '/' menu in sync.
    for (const event of ['internal/service', 'skills/change', 'agent/created', 'agent/disposed']) {
      assert.ok(seen.events.includes(event), `expected a subscription to ${event}`);
    }

    // The built-in-skills group must be reachable through the create tool.
    const create = seen.tools.find((definition) => definition.name === 'skill_toggles_group_create');
    assert.deepEqual(create.parameters.properties.scope.enum, ['builtin']);

    // Cleanup is wired through ctx.effect (the fiber disposer), not a return value.
    assert.ok(seen.effects.length > 0, 'expected at least one ctx.effect disposer');
    assert.doesNotThrow(() => {
      for (const effect of seen.effects) effect();
      if (typeof dispose === 'function') dispose();
    }, 'disposers must be safe to run twice-free');
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});
