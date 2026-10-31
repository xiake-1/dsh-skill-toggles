/**
 * Unit tests for the pure state logic (grouped WHITELIST semantics, v4) +
 * the store round-trip. Run with: node test/state.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BUILTIN_GROUP_ID,
  BUILTIN_SCOPE,
  DEFAULT_GROUP_ID,
  SHADOW_LOCATOR_PREFIX,
  STATE_VERSION,
  classifyOrigin,
  effectiveDisabled,
  effectiveEnabled,
  effectiveEnabledList,
  enabledByGroups,
  groupEnables,
  isBuiltinSkill,
  mergeCatalog,
  normalizePath,
  normalizeState,
  resolveGroupId,
  restoreAttribution,
  snapshotState,
  withAllEnabled,
  withDisabled,
  withEnabled,
  withGroupActive,
  withGroupAllDisabled,
  withGroupAllEnabled,
  withGroupCreated,
  withGroupDeleted,
  withGroupRenamed,
  withGroupSet,
} from '../lib/state.js';
import { createStateStore, resolveStateDir } from '../lib/store.js';

/** Expected group row helper (v4 canonical shape; wildcard by default). */
const g = (id, extra = {}) => ({ id, name: '', all: true, scope: '', enabled: [], except: [], ...extra });
/** The seeded built-in-skills group as it appears in a normalized document. */
const BUILTIN_GROUP = g(BUILTIN_GROUP_ID, { all: false, scope: BUILTIN_SCOPE });

test('normalizeState: missing/garbage input falls back to the wildcard default group', () => {
  for (const raw of [undefined, null, {}, { disabled: 'nope' }, { groups: 'nope' }]) {
    const state = normalizeState(raw);
    assert.equal(state.version, STATE_VERSION);
    assert.deepEqual(state.groups, [g(DEFAULT_GROUP_ID), BUILTIN_GROUP]);
    assert.deepEqual(state.activeGroups, [DEFAULT_GROUP_ID]);
  }
});

test('normalizeState: v1 documents migrate into the default wildcard group', () => {
  const state = normalizeState({ disabled: [1, null, '', 'ok', 'ok', 'two'] });
  assert.deepEqual(state.groups, [g(DEFAULT_GROUP_ID, { except: ['ok', 'two'] }), BUILTIN_GROUP]);
  assert.deepEqual(state.activeGroups, [DEFAULT_GROUP_ID]);
});

test('normalizeState: v2 blacklists migrate to wildcard groups that except those names', () => {
  const state = normalizeState({
    groups: [
      { id: 'a', name: 'A', disabled: ['x', 'x', '', 5] },
      { id: 'b', name: 'B' },
    ],
    activeGroups: ['a'],
  });
  assert.deepEqual(state.groups, [
    g(DEFAULT_GROUP_ID),
    g('a', { name: 'A', except: ['x'] }),
    g('b', { name: 'B' }),
    BUILTIN_GROUP,
  ]);
  assert.deepEqual(state.activeGroups, ['a']);
  // The migrated single-group setup keeps its previous effective behavior.
  assert.deepEqual(effectiveEnabledList(state, ['x', 'y']), ['y']);
});

test('normalizeState: v3 documents keep groups, canonicalize shape, dedupe ids, filter activeGroups', () => {
  const state = normalizeState({
    groups: [
      { id: 'a', name: 'A', all: false, enabled: ['x', 'x', '', 5], except: ['ignored-when-explicit'] },
      { id: 'a', name: 'dup', all: false, enabled: ['ignored'] },
      { id: 'b', name: 'B', all: true, enabled: ['ignored-when-wildcard'], except: ['y'] },
      { id: '', name: 'dropped' },
    ],
    activeGroups: ['a', 'ghost', 'b', 'a'],
  });
  assert.deepEqual(state.groups, [
    g(DEFAULT_GROUP_ID),
    g('a', { name: 'A', all: false, enabled: ['x'] }),
    g('b', { name: 'B', except: ['y'] }),
    BUILTIN_GROUP,
  ]);
  assert.deepEqual(state.activeGroups, ['a', 'b']);
});

test('normalizeState: v3 without activeGroups activates every group but the seeded built-in one', () => {
  const state = normalizeState({ groups: [{ id: 'a', all: false, enabled: ['x'] }] });
  assert.deepEqual(state.activeGroups, [DEFAULT_GROUP_ID, 'a']);
  assert.ok(state.groups.some((entry) => entry.id === BUILTIN_GROUP_ID), 'v3 gains the built-in group');
});

test('normalizeState: the built-in group is seeded ONCE and never resurrected in v4', () => {
  const migrated = normalizeState({ version: 3, groups: [g(DEFAULT_GROUP_ID)], activeGroups: [DEFAULT_GROUP_ID] });
  assert.ok(migrated.groups.some((entry) => entry.id === BUILTIN_GROUP_ID));
  // A v4 document without it means the user deleted it: it stays deleted.
  const kept = normalizeState({ version: STATE_VERSION, groups: [g(DEFAULT_GROUP_ID)], activeGroups: [DEFAULT_GROUP_ID] });
  assert.deepEqual(kept.groups, [g(DEFAULT_GROUP_ID)]);
  // Seeding never activates it, so upgrading cannot re-enable anything.
  assert.deepEqual(migrated.activeGroups, [DEFAULT_GROUP_ID]);
  assert.deepEqual(effectiveEnabledList(migrated, ['x', 'y']), ['x', 'y']);
});

test('effectiveEnabled: union over ACTIVE groups; wildcard expands over the catalog', () => {
  const state = normalizeState({
    groups: [
      { id: 'a', name: 'A', all: false, enabled: ['x', 'y'] },
      { id: 'b', name: 'B', all: false, enabled: ['y', 'z'] },
    ],
    activeGroups: ['a', 'b'],
  });
  assert.deepEqual([...effectiveEnabled(state, ['x', 'y', 'z', 'w'])].sort(), ['x', 'y', 'z']);
  assert.deepEqual(effectiveEnabledList(state, ['x', 'y', 'z', 'w']), ['x', 'y', 'z']);
  // 'w' is enabled by nobody → effectively disabled.
  assert.deepEqual([...effectiveDisabled(state, ['x', 'y', 'z', 'w'])], ['w']);
});

test('two active groups never conflict: each only contributes its own skills', () => {
  // The user scenario: group A enables {x}, group B enables {y}. Both active
  // → {x, y} usable; activating B can only ADD, never remove x.
  const state = normalizeState({
    groups: [
      { id: 'a', name: 'A', all: false, enabled: ['x'] },
      { id: 'b', name: 'B', all: false, enabled: ['y'] },
    ],
    activeGroups: ['a'],
  });
  assert.deepEqual(effectiveEnabledList(state, ['x', 'y']), ['x']);
  const both = withGroupActive(state, 'b', true);
  assert.deepEqual(effectiveEnabledList(both, ['x', 'y']), ['x', 'y']);
  // Disabling x inside B does not touch A's skill.
  const bDropsX = withDisabled(both, 'x', 'b');
  assert.deepEqual(effectiveEnabledList(bDropsX, ['x', 'y']), ['x', 'y']);
});

test('no active group → nothing usable; every skill is effectively disabled', () => {
  const state = normalizeState({
    groups: [
      { id: 'a', name: 'A', all: false, enabled: ['x'] },
    ],
    activeGroups: [DEFAULT_GROUP_ID, 'a'],
  });
  assert.deepEqual(effectiveEnabledList(state, ['x', 'y']), ['x', 'y']); // default wildcard
  const offA = withGroupActive(state, 'a', false);
  assert.deepEqual(effectiveEnabledList(offA, ['x', 'y']), ['x', 'y']); // default still on
  const offDefault = withGroupActive(offA, DEFAULT_GROUP_ID, false);
  assert.deepEqual(effectiveEnabledList(offDefault, ['x', 'y']), []);
  assert.deepEqual([...effectiveDisabled(offDefault, ['x', 'y'])].sort(), ['x', 'y']);
});

test('wildcard group: enables everything except its exceptions', () => {
  const state = normalizeState({
    groups: [{ id: 'a', name: 'A', all: true, except: ['ghost-skill'] }],
    activeGroups: ['a'],
  });
  // Unknown exception names are harmless; new catalog skills are enabled.
  assert.deepEqual(effectiveEnabledList(state, ['x', 'y', 'brand-new']), ['brand-new', 'x', 'y']);
});

test('two active wildcard groups rescue each other\'s exceptions; single-pass name iterables are safe', () => {
  const state = normalizeState({
    groups: [
      { id: 'a', all: true, except: ['x'] },
      { id: 'b', all: true, except: ['y'] },
    ],
    activeGroups: ['a', 'b'],
  });
  const catalog = new Map([['x', {}], ['y', {}], ['z', {}]]);
  // byName.keys() is a single-pass iterator (the shadow provider's shape).
  assert.deepEqual(effectiveEnabledList(state, catalog.keys()), ['x', 'y', 'z']);
  assert.deepEqual([...effectiveDisabled(state, catalog.keys())], []);
  // Deactivating b re-exposes x as disabled (only a is active, a excepts x).
  const offB = withGroupActive(state, 'b', false);
  assert.deepEqual(effectiveEnabledList(offB, catalog.keys()), ['y', 'z']);
  assert.deepEqual([...effectiveDisabled(offB, catalog.keys())], ['x']);
});

test('default-allow: empty state enables every skill (fresh install)', () => {
  const state = normalizeState(undefined);
  const rows = mergeCatalog(
    [{ name: 'a', description: 'A', invocation: { modelInvocable: true, userInvocable: true } }],
    state,
  );
  assert.equal(rows[0].enabled, true);
  assert.deepEqual(rows[0].enabledBy, ['default']);
});

test('withDisabled / withEnabled target one group (wildcard vs explicit), immutable and idempotent', () => {
  const base = normalizeState(undefined); // default = wildcard
  const once = withDisabled(base, 'x');
  assert.deepEqual(base.groups[0].except, []);
  assert.deepEqual(once.groups[0].except, ['x']);
  assert.equal(withDisabled(once, 'x'), once, 'already excepted returns the same object');
  const back = withEnabled(once, 'x');
  assert.deepEqual(back.groups[0].except, []);
  assert.equal(withEnabled(back, 'x'), back, 'not excepted returns the same object');

  // Explicit group: the lists move in the opposite direction.
  const explicit = normalizeState({ groups: [{ id: 'g', all: false, enabled: ['x'] }] });
  const dropped = withDisabled(explicit, 'x', 'g');
  assert.deepEqual(dropped.groups[1].enabled, []);
  assert.equal(withDisabled(dropped, 'x', 'g'), dropped, 'already absent returns the same object');
  const added = withEnabled(dropped, 'x', 'g');
  assert.deepEqual(added.groups[1].enabled, ['x']);
  assert.equal(withEnabled(added, 'x', 'g'), added);
  // Other groups are never touched.
  assert.deepEqual(withDisabled(explicit, 'x', DEFAULT_GROUP_ID).groups[1].enabled, ['x']);

  assert.throws(() => withDisabled(base, 'x', 'ghost'), /unknown group/);
  assert.throws(() => withEnabled(base, 'x', 'ghost'), /unknown group/);
});

test('withGroupAllEnabled / withGroupAllDisabled reshape one group only', () => {
  const state = normalizeState({
    groups: [
      { id: 'a', all: false, enabled: ['x'] },
      { id: 'b', all: true, except: ['y'] },
    ],
  });
  const one = withGroupAllEnabled(state, 'a');
  assert.deepEqual(one.groups[1], g('a'));
  assert.deepEqual(one.groups[2], g('b', { except: ['y'] }));
  assert.equal(withGroupAllEnabled(one, 'a'), one);
  const off = withGroupAllDisabled(state, 'b');
  assert.deepEqual(off.groups[2], g('b', { all: false }));
  assert.equal(withGroupAllDisabled(off, 'b'), off);
});

test('withAllEnabled: every group becomes a bare wildcard AND every group activates', () => {
  const state = normalizeState({
    groups: [
      { id: 'a', all: false, enabled: ['x'] },
      { id: 'b', all: true, except: ['y'] },
    ],
    activeGroups: [], // nothing usable before
  });
  assert.deepEqual(effectiveEnabledList(state, ['x', 'y']), []);
  const all = withAllEnabled(state);
  assert.deepEqual(all.groups.map((entry) => [entry.all, entry.scope, entry.enabled, entry.except]), [
    [true, '', [], []],
    [true, '', [], []],
    [true, '', [], []],
    // The scoped group keeps its scope: "enable everything" means "own the
    // whole shipped set", not "become an all-on wildcard".
    [false, BUILTIN_SCOPE, [], []],
  ]);
  assert.deepEqual(all.activeGroups, [DEFAULT_GROUP_ID, 'a', 'b', BUILTIN_GROUP_ID]);
  assert.deepEqual(effectiveEnabledList(all, ['x', 'y']), ['x', 'y']);
  assert.equal(withAllEnabled(all), all);
});

test('group create / rename / delete / activate', () => {
  const base = normalizeState(undefined);
  const { state, id } = withGroupCreated(base, 'My Tools');
  assert.equal(id, 'my-tools');
  assert.deepEqual(state.activeGroups, [DEFAULT_GROUP_ID, 'my-tools']);
  // A new group starts as an EXPLICIT EMPTY whitelist: it contributes nothing.
  assert.deepEqual(state.groups.find((entry) => entry.id === id), g(id, { name: 'My Tools', all: false }));
  assert.deepEqual(effectiveEnabledList(state, ['x']), ['x']); // default wildcard still rules
  const { state: state2, id: id2 } = withGroupCreated(state, 'My Tools');
  assert.equal(id2, 'my-tools-2');
  assert.throws(() => withGroupCreated(base, '   '), /non-empty/);
  // A scoped group is created on request (the tool/panel "成员＝自带技能" path).
  const { state: scopedState, id: scopedId } = withGroupCreated(base, 'Shipped', BUILTIN_SCOPE);
  assert.deepEqual(scopedState.groups.find((entry) => entry.id === scopedId), g(scopedId, { name: 'Shipped', all: false, scope: BUILTIN_SCOPE }));

  const renamed = withGroupRenamed(state, id, 'Renamed');
  assert.equal(renamed.groups.find((entry) => entry.id === id).name, 'Renamed');
  assert.equal(withGroupRenamed(renamed, id, 'Renamed'), renamed);
  assert.throws(() => withGroupRenamed(base, 'ghost', 'x'), /unknown group/);

  const off = withGroupActive(state, id, false);
  assert.deepEqual(off.activeGroups, [DEFAULT_GROUP_ID]);
  assert.equal(withGroupActive(off, id, false), off);
  assert.deepEqual(withGroupActive(off, id, true), state);

  const deleted = withGroupDeleted(off, id);
  assert.deepEqual(deleted.groups.map((entry) => entry.id), [DEFAULT_GROUP_ID, BUILTIN_GROUP_ID]);
  assert.deepEqual(deleted.activeGroups, [DEFAULT_GROUP_ID]);
  assert.throws(() => withGroupDeleted(base, DEFAULT_GROUP_ID), /cannot be deleted/);
});

test('resolveGroupId: empty → default; by id; by name; unknown throws', () => {  const state = normalizeState({ groups: [{ id: 'g1', name: '写作' }] });
  assert.equal(resolveGroupId(state, ''), DEFAULT_GROUP_ID);
  assert.equal(resolveGroupId(state, undefined), DEFAULT_GROUP_ID);
  assert.equal(resolveGroupId(state, 'g1'), 'g1');
  assert.equal(resolveGroupId(state, '写作'), 'g1');
  assert.throws(() => resolveGroupId(state, 'nope'), /unknown group/);
});

test('groupEnables: wildcard excepts, explicit lists', () => {
  assert.equal(groupEnables({ all: true, enabled: [], except: ['x'] }, 'x'), false);
  assert.equal(groupEnables({ all: true, enabled: [], except: ['x'] }, 'y'), true);
  assert.equal(groupEnables({ all: false, enabled: ['y'], except: [] }, 'x'), false);
  assert.equal(groupEnables({ all: false, enabled: ['y'], except: [] }, 'y'), true);
});

test('mergeCatalog: effective enabled + enabledBy from active groups', () => {
  const state = normalizeState({
    groups: [
      { id: 'a', name: 'A', all: false, enabled: ['b'] },
      { id: 'b', name: 'B', all: false, enabled: ['b'] },
      { id: 'c', name: 'C', all: false, enabled: ['a'] },
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
  assert.equal(rows[0].enabled, false); // only 'c' enables 'a', but c is inactive
  assert.deepEqual(rows[0].enabledBy, []);
  assert.equal(rows[1].enabled, true);
  assert.deepEqual(rows[1].enabledBy, ['A', 'B']);
  assert.equal(rows[0].userInvocable, true);
  assert.equal(rows[0].modelInvocable, false);
});

test('enabledByGroups: wildcard groups list under their exceptions', () => {
  const state = normalizeState({
    groups: [{ id: 'a', name: 'A', all: true, except: ['x'] }],
    activeGroups: ['a'],
  });
  const map = enabledByGroups(state, ['x', 'y']);
  assert.equal(map.has('x'), false);
  assert.deepEqual(map.get('y'), ['A']);
});

test('snapshotState returns an independent deep copy', () => {
  const state = normalizeState({ groups: [{ id: 'a', name: 'A', all: false, enabled: ['x'] }] });
  const snap = snapshotState(state);
  snap.groups[1].enabled.push('y');
  snap.activeGroups.push('zz');
  assert.deepEqual(state.groups[1].enabled, ['x']);
  assert.deepEqual(state.activeGroups, [DEFAULT_GROUP_ID, 'a']);
});

test('withGroupSet: bulk add/remove inside one group (both modes), set-wise idempotent', () => {
  // Wildcard group: disabled=true ADDS exceptions, disabled=false clears them.
  const wildcard = normalizeState(undefined);
  const excepted = withGroupSet(wildcard, DEFAULT_GROUP_ID, ['a', 'b', 'a'], true);
  assert.deepEqual(excepted.groups[0].except, ['a', 'b']);
  assert.deepEqual(excepted.groups[0].enabled, []);
  assert.equal(withGroupSet(excepted, DEFAULT_GROUP_ID, ['b', 'a'], true), excepted, 'same set → same object');
  const cleared = withGroupSet(excepted, DEFAULT_GROUP_ID, ['a'], false);
  assert.deepEqual(cleared.groups[0].except, ['b']);
  assert.equal(withGroupSet(cleared, DEFAULT_GROUP_ID, ['ghost'], false), cleared);

  // Explicit group: disabled=true REMOVES from the enable set, false adds.
  const explicit = normalizeState({ groups: [{ id: 'g', all: false, enabled: ['a', 'b'] }] });
  const removed = withGroupSet(explicit, 'g', ['a'], true);
  assert.deepEqual(removed.groups[1].enabled, ['b']);
  const added = withGroupSet(removed, 'g', ['c'], false);
  assert.deepEqual(added.groups[1].enabled, ['b', 'c']);
  assert.equal(withGroupSet(added, 'g', ['b', 'c'], false), added);
  assert.throws(() => withGroupSet(wildcard, 'ghost', ['x'], true), /unknown group/);
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
  void SHADOW_LOCATOR_PREFIX; // kept for the shadow locator contract test elsewhere
});

test('classifyOrigin: a generic provider falls back to source "bundled" instead of "other"', () => {
  const opts = { dshHome: 'C:/Users/u/.dsh', agentsHome: 'C:/Users/u/.agents', shadowProvider: 'skill-toggles-filter' };
  assert.equal(classifyOrigin({ provider: 'runtime', source: 'bundled' }, opts), 'bundled');
  assert.equal(classifyOrigin({ provider: 'skill-toggles-filter', source: 'bundled' }, opts), 'bundled');
  // A named provider still wins over the source fallback.
  assert.equal(classifyOrigin({ provider: 'dsh-windows-acl', source: 'bundled' }, opts), 'plugin:dsh-windows-acl');
});

test('restoreAttribution: a disabled skill keeps the attribution of its enabled form', () => {
  const opts = { dshHome: 'C:/Users/u/.dsh', agentsHome: 'C:/Users/u/.agents', shadowProvider: 'skill-toggles-filter' };
  // Real production shapes. (1) An asset-backed packaged provider whose assets
  // live OUTSIDE node_modules (the Office skills). (2) A runtime registration
  // whose resourceBase points at an external repo (a bridge plugin's skill).
  const officeOriginal = {
    provider: 'dsh-office',
    source: 'bundled',
    resourceBase: { kind: 'directory', path: 'D:/App/resources/office-skills/office' },
  };
  const officeShadow = { ...officeOriginal, provider: 'skill-toggles-filter' };
  // Unrestored it degrades to the coarse `bundled` bucket (was: `other`).
  assert.equal(classifyOrigin(officeShadow, opts), 'bundled');
  assert.equal(classifyOrigin(restoreAttribution(officeShadow, officeOriginal), opts), 'plugin:dsh-office');

  const bridgeOriginal = {
    provider: 'dsh-ppt-master-bridge',
    source: 'runtime',
    resourceBase: { kind: 'directory', path: 'D:/Github/ppt-master/skills/ppt-master' },
  };
  const bridgeShadow = { ...bridgeOriginal, provider: 'skill-toggles-filter' };
  assert.equal(classifyOrigin(bridgeShadow, opts), 'custom'); // the reported bug
  assert.equal(classifyOrigin(restoreAttribution(bridgeShadow, bridgeOriginal), opts), 'plugin:dsh-ppt-master-bridge');

  // A shadow entry that lost the path entirely gets it back from the original.
  const pathOriginal = { provider: 'filesystem', source: 'project-dsh', path: 'C:/p/node_modules/dsh-ppt/skills/ppt/SKILL.md' };
  const pathShadow = { provider: 'skill-toggles-filter', source: 'project-dsh' };
  assert.equal(classifyOrigin(restoreAttribution(pathShadow, pathOriginal), opts), 'plugin:dsh-ppt');

  // Nothing to restore → the very same object; the input is never mutated.
  assert.equal(restoreAttribution(officeShadow, undefined), officeShadow);
  assert.equal(restoreAttribution(officeShadow, officeShadow), officeShadow);
  const restored = restoreAttribution(officeShadow, officeOriginal);
  assert.notEqual(restored, officeShadow);
  assert.equal(officeShadow.provider, 'skill-toggles-filter');
  assert.equal(restored.name, undefined);
});

test('mergeCatalog: rows carry the origin key', () => {
  const rows = mergeCatalog(
    [{ name: 'a', description: '', invocation: {}, origin: 'plugin:dsh-ppt' }, { name: 'b', description: '', invocation: {} }],
    normalizeState(undefined),
  );
  assert.equal(rows[0].origin, 'plugin:dsh-ppt');
  assert.equal(rows[1].origin, 'other');
});

test('store: missing file loads the wildcard default group; update persists v4; corrupt falls back; v1/v2 migrate', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-skill-toggles-test-'));
  try {
    const store = createStateStore({ dshHome: dir, logger: { warn() {}, error() {} } });
    assert.deepEqual(store.loadSync(), {
      version: STATE_VERSION,
      groups: [g(DEFAULT_GROUP_ID), BUILTIN_GROUP],
      activeGroups: [DEFAULT_GROUP_ID],
    });
    const created = withGroupCreated(withDisabled(store.get(), 'a'), 'Work');
    await store.update(created.state);
    const raw = JSON.parse(await readFile(join(resolveStateDir(dir), 'state.json'), 'utf8'));
    assert.equal(raw.version, STATE_VERSION);
    assert.deepEqual(raw.groups.find((entry) => entry.id === DEFAULT_GROUP_ID).except, ['a']);
    const work = raw.groups.find((entry) => entry.id === 'work');
    assert.equal(work.all, false);
    assert.deepEqual(work.enabled, []);
    assert.equal(raw.groups.find((entry) => entry.id === BUILTIN_GROUP_ID).scope, BUILTIN_SCOPE);

    const reloaded = createStateStore({ dshHome: dir, logger: { warn() {}, error() {} } });
    assert.deepEqual(reloaded.loadSync(), normalizeState(raw));

    await writeFile(join(resolveStateDir(dir), 'state.json'), '{ not json', 'utf8');
    const broken = createStateStore({ dshHome: dir, logger: { warn() {}, error() {} } });
    assert.deepEqual(broken.loadSync(), normalizeState(undefined), 'corrupt file must fall back to allow-all');

    await writeFile(join(resolveStateDir(dir), 'state.json'), JSON.stringify({ disabled: ['legacy'] }), 'utf8');
    const migrated = createStateStore({ dshHome: dir, logger: { warn() {}, error() {} } });
    assert.deepEqual(migrated.loadSync().groups[0], g(DEFAULT_GROUP_ID, { except: ['legacy'] }));
    assert.deepEqual(migrated.loadSync().activeGroups, [DEFAULT_GROUP_ID]);

    await writeFile(join(resolveStateDir(dir), 'state.json'), JSON.stringify({
      version: 2,
      groups: [{ id: DEFAULT_GROUP_ID, name: '', disabled: ['old'] }],
      activeGroups: [DEFAULT_GROUP_ID],
    }), 'utf8');
    const migrated2 = createStateStore({ dshHome: dir, logger: { warn() {}, error() {} } });
    assert.deepEqual(migrated2.loadSync().groups[0], g(DEFAULT_GROUP_ID, { except: ['old'] }));
    // A v3 document on disk gains the built-in group exactly once.
    await writeFile(join(resolveStateDir(dir), 'state.json'), JSON.stringify({
      version: 3,
      groups: [{ id: DEFAULT_GROUP_ID, name: '', all: true, enabled: [], except: ['old'] }],
      activeGroups: [DEFAULT_GROUP_ID],
    }), 'utf8');
    const migrated3 = createStateStore({ dshHome: dir, logger: { warn() {}, error() {} } });
    assert.deepEqual(migrated3.loadSync().groups.map((entry) => entry.id), [DEFAULT_GROUP_ID, BUILTIN_GROUP_ID]);
    assert.deepEqual(migrated3.loadSync().activeGroups, [DEFAULT_GROUP_ID]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── catalog-scoped (built-in skills) group ────────────────────────────────

test('isBuiltinSkill: install-dir paths and resourceBase count; profile/user/project skills do not', () => {
  const roots = [normalizePath('C:/App/resources'), normalizePath('C:/App')];
  assert.equal(isBuiltinSkill({ path: 'C:\\App\\resources\\app.asar\\dsh\\node_modules\\@dsh\\skill\\a\\SKILL.md' }, roots), true);
  assert.equal(isBuiltinSkill({ resourceBase: { path: 'C:/App/resources/runtime/office-skills/office' } }, roots), true);
  assert.equal(isBuiltinSkill({ source: 'bundled', resourceBase: { path: 'C:/Users/x/AppData/Local/Temp/dsh-acl-skill-1' } }, roots), true,
    'a packaged skill that copies its assets to a temp dir is still built-in');
  assert.equal(isBuiltinSkill({ path: 'C:/Users/x/.dsh/profiles/desktop/node_modules/dsh-ppt/skills/ppt/SKILL.md' }, roots), false);
  assert.equal(isBuiltinSkill({ path: 'D:/Github/ppt-master/skills/ppt-master/SKILL.md' }, roots), false);
  assert.equal(isBuiltinSkill({ path: 'C:/AppOther/skills/x/SKILL.md' }, roots), false, 'the root match must be a directory boundary');
  assert.equal(isBuiltinSkill({ path: 'C:/Users/x/.dsh/skills/me/SKILL.md' }, []), false, 'no roots → only the bundled-source rule');
  assert.equal(isBuiltinSkill({}, roots), false);
});

test('scoped builtin group: membership comes from the catalog, not from a stored list', () => {
  const state = normalizeState({ groups: [g('ship', { all: false, scope: BUILTIN_SCOPE })], activeGroups: ['ship'] });
  const membership = { builtin: new Set(['office', 'acl']) };
  assert.deepEqual(effectiveEnabledList(state, ['office', 'acl', 'docs-sync'], membership), ['acl', 'office']);
  // A DSH upgrade that ships a new skill joins the group automatically: the
  // membership IS the current catalog, so there is no stored list to refresh.
  const upgraded = { builtin: new Set(['office', 'acl', 'new-shipped']) };
  assert.deepEqual(effectiveEnabledList(state, ['office', 'acl', 'new-shipped', 'docs-sync'], upgraded), ['acl', 'new-shipped', 'office']);
  // Without the membership the scoped group owns nothing (never silently all-on).
  assert.deepEqual(effectiveEnabledList(state, ['office']), []);
  // Inactive → contributes nothing, exactly like any other group.
  const inactive = withGroupActive(state, 'ship', false);
  assert.deepEqual(effectiveEnabledList(inactive, ['office', 'acl'], membership), []);
});

test('scoped builtin group: exceptions, explicit additions, and the shadow view', () => {
  const state = normalizeState({ groups: [g('ship', { all: false, scope: BUILTIN_SCOPE })], activeGroups: ['ship'] });
  const membership = { builtin: new Set(['office', 'acl']) };
  const off = withDisabled(state, 'office', 'ship', membership);
  assert.deepEqual(off.groups.find((entry) => entry.id === 'ship').except, ['office']);
  assert.deepEqual(effectiveEnabledList(off, ['office', 'acl'], membership), ['acl']);
  assert.equal(withDisabled(off, 'office', 'ship', membership), off, 'idempotent');
  assert.deepEqual(withEnabled(off, 'office', 'ship', membership).groups, state.groups, 'enabling a member clears the exception');
  // A non-member is an explicit addition (the user opted a foreign skill in).
  const added = withEnabled(state, 'docs-sync', 'ship', membership);
  assert.deepEqual(added.groups.find((entry) => entry.id === 'ship').enabled, ['docs-sync']);
  assert.deepEqual(effectiveEnabledList(added, ['docs-sync', 'office'], membership), ['docs-sync', 'office']);
  // effectiveDisabled feeds the shadow provider: the members stay usable.
  assert.deepEqual([...effectiveDisabled(state, ['office', 'acl', 'docs-sync'], membership)], ['docs-sync']);
});

test('scoped builtin group: bulk set splits members from non-members; all-on/all-off keep the scope', () => {
  const state = normalizeState({ groups: [g('ship', { all: false, scope: BUILTIN_SCOPE })], activeGroups: ['ship'] });
  const membership = { builtin: new Set(['office', 'acl']) };
  const ship = (doc) => doc.groups.find((entry) => entry.id === 'ship');
  const off = withGroupSet(state, 'ship', ['office', 'docs-sync'], true, membership);
  assert.deepEqual(ship(off).except, ['office']);
  assert.deepEqual(ship(off).enabled, []);
  const on = withGroupSet(state, 'ship', ['office', 'docs-sync'], false, membership);
  assert.deepEqual(ship(on).enabled, ['docs-sync']);
  // "This group enables nothing" excepts the current members and keeps the scope.
  const emptied = withGroupAllDisabled(state, 'ship', membership);
  assert.deepEqual(ship(emptied), g('ship', { all: false, scope: BUILTIN_SCOPE, except: ['office', 'acl'] }));
  assert.deepEqual(effectiveEnabledList(emptied, ['office', 'acl', 'docs-sync'], membership), []);
  // A skill shipped by a later upgrade joins again (the scope survived the reset).
  assert.deepEqual(effectiveEnabledList(emptied, ['office', 'acl', 'newcomer'], { builtin: new Set(['office', 'acl', 'newcomer']) }), ['newcomer']);
  assert.equal(withGroupAllEnabled(emptied, 'ship', membership).groups.find((entry) => entry.id === 'ship').except.length, 0);
  assert.equal(withGroupAllEnabled(state, 'ship', membership), state);
});

test('mergeCatalog: rows carry the builtin flag and a scoped group resolves through it', () => {
  const state = normalizeState({ groups: [g('ship', { all: false, scope: BUILTIN_SCOPE })], activeGroups: ['ship'] });
  const rows = mergeCatalog([
    { name: 'office', description: '', invocation: {}, origin: 'plugin:dsh-office', builtin: true },
    { name: 'docs-sync', description: '', invocation: {}, origin: 'plugin:dsh-project-plan-docs' },
  ], state);
  assert.deepEqual(rows.map((row) => [row.name, row.enabled, row.builtin]), [
    ['docs-sync', false, false],
    ['office', true, true],
  ]);
});
