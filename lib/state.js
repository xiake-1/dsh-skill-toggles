/**
 * Pure state logic for the dsh-skill-toggles host half.
 *
 * Deliberately dependency-free (no Cordis, no schemastery): every function
 * here is unit-testable with plain `node --test` and is the single source of
 * truth for the blacklist semantics shared by the skill_toggles_* tools, the
 * RPC surface, and the shadow skill provider in lib/index.js.
 *
 * State shape (plain JSON, version 2 — groups):
 *   state = {
 *     version: 2,
 *     groups: [{ id: string, name: string, disabled: string[] }],
 *     activeGroups: string[],   // ids of the groups currently in effect
 *   }
 *
 * Blacklist semantics, per group: a group's `disabled` list only suppresses
 * the names it lists. The EFFECTIVE blacklist is the UNION over the active
 * groups: a skill is usable unless at least one active group disables it.
 * The built-in `default` group starts with an empty list (everything on) and
 * is fully editable; extra groups are user-created profiles that can be
 * switched on/off independently.
 *
 * Default-allow is preserved end to end: a fresh install, a missing file, or
 * a corrupt file all normalize to "default group, nothing disabled" — never
 * the "everything vanished" failure mode of whitelist plugins. Names absent
 * from the live catalog are ignored silently (renames never error).
 *
 * v1 documents ({ disabled: string[] }) migrate automatically: their list
 * becomes the default group's blacklist (active).
 */

/** The built-in, never-deletable group (all-on until edited). */
export const DEFAULT_GROUP_ID = 'default';

/** One group with a fresh copy of the disabled list. */
function group(id, name = '', disabled = []) {
  return { id, name, disabled: [...disabled] };
}

/** Unique, non-empty, order-preserving strings from an untrusted array. */
function uniqueStrings(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry) => typeof entry === 'string' && entry.length > 0))];
}

/** Normalize an untrusted parsed document into the v2 state shape (v1 migrates). */
export function normalizeState(raw) {
  if (Array.isArray(raw?.groups)) {
    const seen = new Set();
    const groups = [];
    for (const entry of raw.groups) {
      if (entry === null || typeof entry !== 'object') continue;
      if (typeof entry.id !== 'string' || entry.id.length === 0) continue;
      if (seen.has(entry.id)) continue; // duplicate ids: keep the first
      seen.add(entry.id);
      groups.push(group(entry.id, typeof entry.name === 'string' ? entry.name : '', uniqueStrings(entry.disabled)));
    }
    if (!seen.has(DEFAULT_GROUP_ID)) groups.unshift(group(DEFAULT_GROUP_ID));
    const activeGroups = Array.isArray(raw.activeGroups)
      ? uniqueStrings(raw.activeGroups).filter((id) => seen.has(id))
      : groups.map((entry) => entry.id); // missing list: every group active
    return { version: 2, groups, activeGroups };
  }
  // v1 shape (or garbage): one default group carrying the flat blacklist.
  return {
    version: 2,
    groups: [group(DEFAULT_GROUP_ID, '', uniqueStrings(raw?.disabled))],
    activeGroups: [DEFAULT_GROUP_ID],
  };
}

/** Look up one group by id (undefined when absent). */
export function findGroup(state, id) {
  return state.groups.find((entry) => entry.id === id);
}

/**
 * Resolve a user/tool-supplied group reference (id or display name; empty →
 * the default group). Throws with the available options on a miss.
 */
export function resolveGroupId(state, ref) {
  const text = typeof ref === 'string' ? ref.trim() : '';
  if (text.length === 0) return DEFAULT_GROUP_ID;
  const byId = state.groups.find((entry) => entry.id === text);
  if (byId !== undefined) return byId.id;
  const byName = state.groups.find((entry) => entry.name === text);
  if (byName !== undefined) return byName.id;
  const options = state.groups.map((entry) => entry.name || entry.id).join(', ');
  throw new Error(`unknown group ${JSON.stringify(ref)} (available: ${options})`);
}

/** The effective disabled-name set: union over the ACTIVE groups. */
export function effectiveDisabled(state) {
  const active = new Set(state.activeGroups);
  const out = new Set();
  for (const entry of state.groups) {
    if (!active.has(entry.id)) continue;
    for (const name of entry.disabled) out.add(name);
  }
  return out;
}

/** The effective disabled names as a sorted list (tool/RPC display). */
export function effectiveDisabledList(state) {
  return [...effectiveDisabled(state)].sort((a, b) => a.localeCompare(b));
}

/** Map skill name → display names of the active groups disabling it. */
export function disabledByGroups(state) {
  const active = new Set(state.activeGroups);
  const byName = new Map();
  for (const entry of state.groups) {
    if (!active.has(entry.id)) continue;
    const label = entry.name || entry.id;
    for (const name of entry.disabled) {
      const list = byName.get(name) ?? [];
      list.push(label);
      byName.set(name, list);
    }
  }
  return byName;
}

/** Immutable map over the groups array (same array → same state object). */
function withGroups(state, nextGroups) {
  if (nextGroups === state.groups) return state;
  return { ...state, groups: nextGroups };
}

/**
 * Immutable disable inside ONE group: returns the same state when the name
 * is already disabled there (callers skip the write + invalidation pair).
 */
export function withDisabled(state, name, groupId = DEFAULT_GROUP_ID) {
  const index = state.groups.findIndex((entry) => entry.id === groupId);
  if (index === -1) throw new Error(`unknown group ${JSON.stringify(groupId)}`);
  const target = state.groups[index];
  if (target.disabled.includes(name)) return state;
  const groups = [...state.groups];
  groups[index] = { ...target, disabled: [...target.disabled, name] };
  return withGroups(state, groups);
}

/** Immutable enable inside ONE group: same state when the name was not disabled there. */
export function withEnabled(state, name, groupId = DEFAULT_GROUP_ID) {
  const index = state.groups.findIndex((entry) => entry.id === groupId);
  if (index === -1) throw new Error(`unknown group ${JSON.stringify(groupId)}`);
  const target = state.groups[index];
  if (!target.disabled.includes(name)) return state;
  const groups = [...state.groups];
  groups[index] = { ...target, disabled: target.disabled.filter((entry) => entry !== name) };
  return withGroups(state, groups);
}

/** Immutable clear of ONE group's blacklist (same state when already empty). */
export function withGroupAllEnabled(state, groupId = DEFAULT_GROUP_ID) {
  const index = state.groups.findIndex((entry) => entry.id === groupId);
  if (index === -1) throw new Error(`unknown group ${JSON.stringify(groupId)}`);
  const target = state.groups[index];
  if (target.disabled.length === 0) return state;
  const groups = [...state.groups];
  groups[index] = { ...target, disabled: [] };
  return withGroups(state, groups);
}

/** Immutable enable-all across EVERY group (same state when nothing is disabled). */
export function withAllEnabled(state) {
  if (state.groups.every((entry) => entry.disabled.length === 0)) return state;
  return withGroups(state, state.groups.map((entry) => ({ ...entry, disabled: [] })));
}

/** Slug a group name into a safe id stem; empty → "group". */
function slugify(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'group';
}

/**
 * Immutable group creation (the new group starts ACTIVE). Ids are slugs of
 * the name, uniquified with numeric suffixes; `default` is reserved.
 * @returns {{ state: object, id: string }}
 */
export function withGroupCreated(state, name) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed.length === 0) throw new Error('group name must be a non-empty string');
  const stem = slugify(trimmed);
  const taken = new Set(state.groups.map((entry) => entry.id));
  let id = stem;
  for (let n = 2; taken.has(id); n += 1) id = `${stem}-${n}`;
  return {
    state: {
      ...state,
      groups: [...state.groups, group(id, trimmed)],
      activeGroups: [...state.activeGroups, id],
    },
    id,
  };
}

/** Immutable group rename (display name only; ids never change). */
export function withGroupRenamed(state, groupId, name) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed.length === 0) throw new Error('group name must be a non-empty string');
  const index = state.groups.findIndex((entry) => entry.id === groupId);
  if (index === -1) throw new Error(`unknown group ${JSON.stringify(groupId)}`);
  const target = state.groups[index];
  if (target.name === trimmed) return state;
  const groups = [...state.groups];
  groups[index] = { ...target, name: trimmed };
  return withGroups(state, groups);
}

/** Immutable group delete (the default group is never deletable). */
export function withGroupDeleted(state, groupId) {
  if (groupId === DEFAULT_GROUP_ID) throw new Error('the default group cannot be deleted');
  const index = state.groups.findIndex((entry) => entry.id === groupId);
  if (index === -1) throw new Error(`unknown group ${JSON.stringify(groupId)}`);
  return {
    ...state,
    groups: state.groups.filter((entry) => entry.id !== groupId),
    activeGroups: state.activeGroups.filter((entry) => entry !== groupId),
  };
}

/** Immutable group activation toggle (same state when already in that mode). */
export function withGroupActive(state, groupId, active) {
  const index = state.groups.findIndex((entry) => entry.id === groupId);
  if (index === -1) throw new Error(`unknown group ${JSON.stringify(groupId)}`);
  const isActive = state.activeGroups.includes(groupId);
  if (isActive === Boolean(active)) return state;
  return {
    ...state,
    activeGroups: active
      ? [...state.activeGroups, groupId]
      : state.activeGroups.filter((entry) => entry !== groupId),
  };
}

/**
 * Fresh plain-JSON copy of the state (scalars only; never live data).
 */
export function snapshotState(state) {
  return {
    version: 2,
    groups: state.groups.map((entry) => ({ id: entry.id, name: entry.name, disabled: [...entry.disabled] })),
    activeGroups: [...state.activeGroups],
  };
}

/**
 * Merge the enumerated catalog with the effective blacklist into panel/tool
 * rows.
 * @param skills - [{ name, description, invocation: { modelInvocable, userInvocable } }]
 * @param state - the resolved toggle state.
 * @returns rows sorted by name, each with the effective enabled flag
 *   (enabled = no ACTIVE group blacklists it; the raw invocation policy is
 *   preserved for display so host-level restrictions stay visible) and the
 *   display names of the active groups that disable it.
 */
export function mergeCatalog(skills, state) {
  const disabled = effectiveDisabled(state);
  const byGroup = disabledByGroups(state);
  return skills
    .map((skill) => ({
      name: skill.name,
      description: skill.description ?? '',
      enabled: !disabled.has(skill.name),
      disabledBy: byGroup.get(skill.name) ?? [],
      modelInvocable: skill.invocation?.modelInvocable === true,
      userInvocable: skill.invocation?.userInvocable === true,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
