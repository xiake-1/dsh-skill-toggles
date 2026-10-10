/**
 * Unit tests for the pure state logic (grouped blacklist semantics, v2) +
 * the store round-trip. Run with: node test/state.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_GROUP_ID,
  SHADOW_LOCATOR_PREFIX,
  classifyOrigin,
  effectiveDisabled,
  effectiveDisabledList,
  mergeCatalog,
  normalizeState,
  resolveGroupId,
  snapshotState,
  withAllEnabled,
  withDisabled,
  withEnabled,
  withGroupActive,
  withGroupAllEnabled,
  withGroupCreated,
  withGroupDeleted,
  withGroupRenamed,
  withGroupSet,
} from '../lib/state.js';
import { createStateStore, resolveStateDir } from '../lib/store.js';

test('normalizeState: missing/garbage input falls back to the empty default group', () => {
  for (const raw of [undefined, null, {}, { disabled: 'nope' }, { groups: 'nope' }]) {
    const state = normalizeState(raw);
    assert.equal(state.version, 2);
    assert.deepEqual(state.groups, [{ id: DEFAULT_GROUP_ID, name: '', disabled: [] }]);
    assert.deepEqual(state.activeGroups, [DEFAULT_GROUP_ID]);
  }
});

test('normalizeState: v1 documents migrate into the default group', () => {
  const state = normalizeState({ disabled: [1, null, '', 'ok', 'ok', 'two'] });
  assert.deepEqual(state.groups, [{ id: DEFAULT_GROUP_ID, name: '', disabled: ['ok', 'two'] }]);
  assert.deepEqual(state.activeGroups, [DEFAULT_GROUP_ID]);
});

test('normalizeState: v2 documents keep groups, dedupe ids, filter activeGroups', () => {
  const state = normalizeState({
    groups: [
      { id: 'a', name: 'A', disabled: ['x', 'x', '', 5] },
      { id: 'a', name: 'dup', disabled: ['ignored'] },
      { id: 'b', name: 'B' },
      { id: '', name: 'dropped' },
    ],
    activeGroups: ['a', 'ghost', 'b', 'a'],
  });
  assert.deepEqual(state.groups, [
    { id: DEFAULT_GROUP_ID, name: '', disabled: [] },
    { id: 'a', name: 'A', disabled: ['x'] },
    { id: 'b', name: 'B', disabled: [] },
  ]);
  assert.deepEqual(state.activeGroups, ['a', 'b']);
});

test('normalizeState: v2 without activeGroups activates every group', () => {
  const state = normalizeState({ groups: [{ id: 'a', disabled: ['x'] }] });
  assert.deepEqual(state.activeGroups, [DEFAULT_GROUP_ID, 'a']);
});

test('effectiveDisabled: union over ACTIVE groups only', () => {
  const state = normalizeState({
    groups: [
      { id: 'a', name: 'A', disabled: ['x', 'y'] },
      { id: 'b', name: 'B', disabled: ['y', 'z'] },
    ],
    activeGroups: ['a', 'b'],
  });
  assert.deepEqual([...effectiveDisabled(state)].sort(), ['x', 'y', 'z']);
  assert.deepEqual(effectiveDisabledList(state), ['x', 'y', 'z']);
  const off = withGroupActive(state, 'b', false);
  assert.deepEqual(effectiveDisabledList(off), ['x', 'y']);
  const none = withGroupActive(withGroupActive(off, 'a', false), DEFAULT_GROUP_ID, false);
  assert.deepEqual(effectiveDisabledList(none), []);
});

test('blacklist default: empty state enables every skill', () => {
  const state = normalizeState(undefined);
  const rows = mergeCatalog(
    [{ name: 'a', description: 'A', invocation: { modelInvocable: true, userInvocable: true } }],
    state,
  );
  assert.equal(rows[0].enabled, true);
  assert.deepEqual(rows[0].disabledBy, []);
});

test('withDisabled / withEnabled target one group, immutable and idempotent', () => {
  const base = normalizeState(undefined);
  const once = withDisabled(base, 'x');
  assert.deepEqual(base.groups[0].disabled, []);
  assert.deepEqual(once.groups[0].disabled, ['x']);
  assert.equal(withDisabled(once, 'x'), once, 'already disabled returns the same object');
  const back = withEnabled(once, 'x');
  assert.deepEqual(back.groups[0].disabled, []);
  assert.equal(withEnabled(back, 'x'), back, 'not disabled returns the same object');
  assert.throws(() => withDisabled(base, 'x', 'ghost'), /unknown group/);
  assert.throws(() => withEnabled(base, 'x', 'ghost'), /unknown group/);
});

test('withGroupAllEnabled clears one group; withAllEnabled clears every group', () => {
  const state = normalizeState({
    groups: [
      { id: 'a', disabled: ['x'] },
      { id: 'b', disabled: ['y'] },
    ],
  });
  const one = withGroupAllEnabled(state, 'a');
  assert.deepEqual(one.groups.map((g) => g.disabled), [[], [], ['y']]); // default, a, b
  assert.equal(withGroupAllEnabled(one, 'a'), one);
  const all = withAllEnabled(state);
  assert.deepEqual(all.groups.map((g) => g.disabled), [[], [], []]);
  assert.equal(withAllEnabled(all), all);
});

test('group create / rename / delete / activate', () => {
  const base = normalizeState(undefined);
  const { state, id } = withGroupCreated(base, 'My Tools');
  assert.equal(id, 'my-tools');
  assert.deepEqual(state.activeGroups, [DEFAULT_GROUP_ID, 'my-tools']);
  const { state: state2, id: id2 } = withGroupCreated(state, 'My Tools');
  assert.equal(id2, 'my-tools-2');
  assert.throws(() => withGroupCreated(base, '   '), /non-empty/);

  const renamed = withGroupRenamed(state, id, 'Renamed');
  assert.equal(renamed.groups.find((g) => g.id === id).name, 'Renamed');
  assert.equal(withGroupRenamed(renamed, id, 'Renamed'), renamed);
  assert.throws(() => withGroupRenamed(base, 'ghost', 'x'), /unknown group/);

  const off = withGroupActive(state, id, false);
  assert.deepEqual(off.activeGroups, [DEFAULT_GROUP_ID]);
  assert.equal(withGroupActive(off, id, false), off);
  assert.deepEqual(withGroupActive(off, id, true), state);

  const deleted = withGroupDeleted(off, id);
  assert.equal(deleted.groups.length, 1);
  assert.deepEqual(deleted.activeGroups, [DEFAULT_GROUP_ID]);
  assert.throws(() => withGroupDeleted(base, DEFAULT_GROUP_ID), /cannot be deleted/);
});

test('resolveGroupId: empty → default; by id; by name; unknown throws', () => {
  const state = normalizeState({ groups: [{ id: 'g1', name: '写作' }] });
  assert.equal(resolveGroupId(state, ''), DEFAULT_GROUP_ID);
  assert.equal(resolveGroupId(state, undefined), DEFAULT_GROUP_ID);
  assert.equal(resolveGroupId(state, 'g1'), 'g1');
  assert.equal(resolveGroupId(state, '写作'), 'g1');
  assert.throws(() => resolveGroupId(state, 'nope'), /unknown group/);
});

test('mergeCatalog: effective enabled + disabledBy from active groups', () => {
  const state = normalizeState({
    groups: [
      { id: 'a', name: 'A', disabled: ['b', 'ghost'] },
      { id: 'b', name: 'B', disabled: ['b'] },
      { id: 'c', name: 'C', disabled: ['a'] },
    ],
    activeGroups: ['a', 'b'],
  });
  const rows = mergeCatalog(
    [
      { name: 'b', description: 'B skill', invocation: { modelInvocable: true, userInvocable: true } },
      { name: 'a', description: '', invocation: { modelInvocable: false, userInvocable: true } },
    ],
    state,
  );
  assert.deepEqual(rows.map((row) => row.name), ['a', 'b']);
  assert.equal(rows[0].enabled, true); // 'c' disables 'a' but c is inactive
  assert.equal(rows[1].enabled, false);
  assert.deepEqual(rows[1].disabledBy, ['A', 'B']);
  assert.equal(rows[0].userInvocable, true);
  assert.equal(rows[0].modelInvocable, false);
});

test('snapshotState returns an independent deep copy', () => {
  const state = normalizeState({ groups: [{ id: 'a', name: 'A', disabled: ['x'] }] });
  const snap = snapshotState(state);
  snap.groups[1].disabled.push('y');
  snap.activeGroups.push('zz');
  assert.deepEqual(state.groups[1].disabled, ['x']);
  assert.deepEqual(state.activeGroups, [DEFAULT_GROUP_ID, 'a']);
});

test('withGroupSet: bulk add/remove inside one group, set-wise idempotent', () => {
  const base = normalizeState(undefined);
  const added = withGroupSet(base, DEFAULT_GROUP_ID, ['a', 'b', 'a'], true);
  assert.deepEqual(added.groups[0].disabled, ['a', 'b']);
  assert.equal(withGroupSet(added, DEFAULT_GROUP_ID, ['b', 'a'], true), added, 'same set → same object');
  const removed = withGroupSet(added, DEFAULT_GROUP_ID, ['a'], false);
  assert.deepEqual(removed.groups[0].disabled, ['b']);
  assert.equal(withGroupSet(removed, DEFAULT_GROUP_ID, ['ghost'], false), removed);
  assert.throws(() => withGroupSet(base, 'ghost', ['x'], true), /unknown group/);
});

test('classifyOrigin: plugin paths, resourceBase, named providers, user/project/custom', () => {
  const opts = { dshHome: 'C:/Users/u/.dsh', agentsHome: 'C:/Users/u/.agents', shadowProvider: 'skill-toggles-filter' };
  assert.equal(classifyOrigin({ path: 'C:/p/node_modules/dsh-ppt/skills/ppt/SKILL.md', provider: 'filesystem' }, opts), 'plugin:dsh-ppt');
  assert.equal(classifyOrigin({ path: 'C:/p/node_modules/@scope/pkg/skills/x.md', provider: 'filesystem' }, opts), 'plugin:@scope/pkg');
  // Runtime-registered plugin skills: generic provider "runtime", attributed via resourceBase.
  assert.equal(classifyOrigin({ provider: 'runtime', resourceBase: { kind: 'directory', path: 'C:/p/node_modules/dsh-project-plan-docs/skills/plan/' } }, opts), 'plugin:dsh-project-plan-docs');
  assert.equal(classifyOrigin({ provider: 'dsh-badge' }, opts), 'plugin:dsh-badge');
  // Shadow-won entry keeps path/resourceBase → classifies like the enabled form.
  assert.equal(classifyOrigin({
    provider: 'skill-toggles-filter',
    resourceBase: { kind: 'directory', path: 'C:/p/node_modules/dsh-unity-mcp-bridge/skills/install/' },
  }, opts), 'plugin:dsh-unity-mcp-bridge');
  assert.equal(classifyOrigin({ provider: 'skill-toggles-filter', path: 'C:/Users/u/.dsh/skills/my/SKILL.md' }, opts), 'user');
  assert.equal(classifyOrigin({ path: 'C:/Users/u/.dsh/skills/my/SKILL.md', provider: 'filesystem' }, opts), 'user');
  assert.equal(classifyOrigin({ path: 'C:/Users/u/.agents/skills/x.md', provider: 'filesystem' }, opts), 'user');
  assert.equal(classifyOrigin({ path: 'D:/proj/.dsh/skills/x/SKILL.md', provider: 'filesystem' }, opts), 'project');
  assert.equal(classifyOrigin({ path: 'D:/proj/.agents/skills/x.md', provider: 'filesystem' }, opts), 'project');
  assert.equal(classifyOrigin({ path: 'D:/extra/skills/x.md', provider: 'filesystem' }, opts), 'custom');
  assert.equal(classifyOrigin({ provider: 'filesystem' }, opts), 'other');
  assert.equal(classifyOrigin({}, opts), 'other');
});

test('mergeCatalog: rows carry the origin key', () => {
  const rows = mergeCatalog(
    [{ name: 'a', description: '', invocation: {}, origin: 'plugin:dsh-ppt' }, { name: 'b', description: '', invocation: {} }],
    normalizeState(undefined),
  );
  assert.equal(rows[0].origin, 'plugin:dsh-ppt');
  assert.equal(rows[1].origin, 'other');
});

test('store: missing file loads the default group; update persists v2; corrupt falls back; v1 migrates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-toggles-test-'));
  try {
    const store = createStateStore({ dshHome: dir, logger: { warn() {}, error() {} } });
    assert.deepEqual(store.loadSync(), {
      version: 2,
      groups: [{ id: DEFAULT_GROUP_ID, name: '', disabled: [] }],
      activeGroups: [DEFAULT_GROUP_ID],
    });
    const next = withGroupCreated(withDisabled(store.get(), 'a'), 'Work');
    await store.update(next.state);
    const raw = JSON.parse(await readFile(join(resolveStateDir(dir), 'state.json'), 'utf8'));
    assert.equal(raw.version, 2);
    assert.deepEqual(raw.groups.find((g) => g.id === DEFAULT_GROUP_ID).disabled, ['a']);
    assert.ok(raw.groups.some((g) => g.id === 'work'));

    const reloaded = createStateStore({ dshHome: dir, logger: { warn() {}, error() {} } });
    assert.deepEqual(reloaded.loadSync(), normalizeState(raw));

    await writeFile(join(resolveStateDir(dir), 'state.json'), '{ not json', 'utf8');
    const broken = createStateStore({ dshHome: dir, logger: { warn() {}, error() {} } });
    assert.deepEqual(broken.loadSync(), normalizeState(undefined), 'corrupt file must fall back to allow-all');

    await writeFile(join(resolveStateDir(dir), 'state.json'), JSON.stringify({ disabled: ['legacy'] }), 'utf8');
    const migrated = createStateStore({ dshHome: dir, logger: { warn() {}, error() {} } });
    assert.deepEqual(migrated.loadSync().groups[0], { id: DEFAULT_GROUP_ID, name: '', disabled: ['legacy'] });
    assert.deepEqual(migrated.loadSync().activeGroups, [DEFAULT_GROUP_ID]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
