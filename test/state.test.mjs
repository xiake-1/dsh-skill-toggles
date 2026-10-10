/**
 * Unit tests for the pure state logic + the store round-trip (blacklist
 * semantics). Run with: node --test test/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  disabledNames,
  mergeCatalog,
  normalizeState,
  snapshotState,
  withAllEnabled,
  withDisabled,
  withEnabled,
} from '../lib/state.js';
import { createStateStore, resolveStateDir } from '../lib/store.js';

test('normalizeState: missing/garbage input falls back to the empty blacklist', () => {
  assert.deepEqual(normalizeState(undefined), { disabled: [] });
  assert.deepEqual(normalizeState(null), { disabled: [] });
  assert.deepEqual(normalizeState({}), { disabled: [] });
  assert.deepEqual(normalizeState({ disabled: 'nope' }), { disabled: [] });
  assert.deepEqual(normalizeState({ disabled: [1, null, '', 'ok', 'ok', 'two'] }), { disabled: ['ok', 'two'] });
});

test('blacklist default: empty state enables every skill', () => {
  const state = normalizeState(undefined);
  const rows = mergeCatalog(
    [{ name: 'a', description: 'A', invocation: { modelInvocable: true, userInvocable: true } }],
    state,
  );
  assert.equal(rows[0].enabled, true);
});

test('withDisabled / withEnabled are immutable and idempotent', () => {
  const base = { disabled: [] };
  const once = withDisabled(base, 'x');
  assert.deepEqual(base.disabled, []);
  assert.deepEqual(once.disabled, ['x']);
  assert.equal(withDisabled(once, 'x'), once, 'already disabled returns the same object');
  const back = withEnabled(once, 'x');
  assert.deepEqual(back.disabled, []);
  assert.equal(withEnabled(back, 'x'), back, 'not disabled returns the same object');
  assert.equal(withAllEnabled(base), base, 'nothing disabled returns the same object');
  assert.deepEqual(withAllEnabled(once).disabled, []);
});

test('mergeCatalog: disabled names flip enabled=false, unknown names never error, sorted by name', () => {
  const state = { disabled: ['ghost', 'b'] };
  const rows = mergeCatalog(
    [
      { name: 'b', description: 'B skill', invocation: { modelInvocable: true, userInvocable: true } },
      { name: 'a', description: '', invocation: { modelInvocable: false, userInvocable: true } },
    ],
    state,
  );
  assert.deepEqual(rows.map((row) => row.name), ['a', 'b']);
  assert.equal(rows[1].enabled, false);
  assert.equal(rows[0].enabled, true);
  assert.equal(rows[0].userInvocable, true);
  assert.equal(rows[0].modelInvocable, false);
});

test('snapshotState returns an independent copy', () => {
  const state = { disabled: ['x'] };
  const snap = snapshotState(state);
  snap.disabled.push('y');
  assert.deepEqual(state.disabled, ['x']);
});

test('disabledNames returns a Set', () => {
  const set = disabledNames({ disabled: ['x', 'y'] });
  assert.ok(set instanceof Set);
  assert.ok(set.has('x') && set.has('y'));
});

test('store: missing file loads the empty blacklist; update persists atomically; corrupt file falls back', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-toggles-test-'));
  try {
    const store = createStateStore({ dshHome: dir, logger: { warn() {}, error() {} } });
    assert.deepEqual(store.loadSync(), { disabled: [] });
    await store.update({ disabled: ['a', 'b'] });
    const raw = JSON.parse(await readFile(join(resolveStateDir(dir), 'state.json'), 'utf8'));
    assert.deepEqual(raw, { disabled: ['a', 'b'] });

    const reloaded = createStateStore({ dshHome: dir, logger: { warn() {}, error() {} } });
    assert.deepEqual(reloaded.loadSync(), { disabled: ['a', 'b'] });

    await writeFile(join(resolveStateDir(dir), 'state.json'), '{ not json', 'utf8');
    const broken = createStateStore({ dshHome: dir, logger: { warn() {}, error() {} } });
    assert.deepEqual(broken.loadSync(), { disabled: [] }, 'corrupt file must fall back to allow-all');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
