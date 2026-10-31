/**
 * Pure state logic for the dsh-skill-toggles host half.
 *
 * Deliberately dependency-free (no Cordis, no schemastery): every function
 * here is unit-testable with plain `node --test` and is the single source of
 * truth for the whitelist semantics shared by the skill_toggles_* tools, the
 * RPC surface, and the shadow skill provider in lib/index.js.
 *
 * State shape (plain JSON, version 4 — groups):
 *   state = {
 *     version: 4,
 *     groups: [{ id, name, all: boolean, scope: '' | 'builtin',
 *                enabled: string[], except: string[] }],
 *     activeGroups: string[],   // ids of the groups currently in effect
 *   }
 *
 * Whitelist semantics, per group: a group only ever CONTRIBUTES the skills it
 * enables — it never disables another group's skills.
 *   - `all: true`  → wildcard group: enables every catalog skill EXCEPT the
 *                    names in `except` (a fresh default group is a wildcard
 *                    with an empty `except`, so a fresh install enables
 *                    everything, including skills added later).
 *   - `all: false` → explicit group: enables exactly the names in `enabled`.
 *   - `scope: 'builtin'` → catalog-derived membership: enables the skills the
 *                    APPLICATION ships (see {@link isBuiltinSkill}) plus its
 *                    own `enabled` additions, minus `except`. Membership is
 *                    re-read from the live catalog on every evaluation, so a
 *                    DSH upgrade that ships a new packaged skill joins the
 *                    group by itself. The seeded `builtin` group is INACTIVE
 *                    until the user activates it, so seeding changes nothing.
 * The EFFECTIVE enabled set is the UNION over the ACTIVE groups: a skill is
 * usable when at least one active group enables it. Activating another group
 * can therefore only ADD usable skills (never remove them), so two active
 * groups can never "conflict" into an empty catalog. With NO active group the
 * union is empty and every skill is unusable.
 *
 * A fresh install, a missing file, or a corrupt file all normalize to
 * "default group active, wildcard, nothing excepted" — never the "everything
 * vanished" failure mode on first boot. Names absent from the live catalog
 * are ignored silently (renames never error).
 *
 * Older documents migrate automatically:
 *   v3 ({ groups: [{ id, name, all, enabled, except }] }) — gains the seeded
 *      inactive `builtin` group ONCE (a v4 document without it stays without
 *      it: deleting that group is a deliberate choice).
 *   v2 ({ groups: [{ id, name, disabled: string[] }], activeGroups }) —
 *      each group's blacklist becomes a wildcard group excepting those names
 *      (single-group setups keep their exact previous behavior).
 *   v1 ({ disabled: string[] }) — the flat list becomes the default group's
 *      wildcard `except` (active).
 */

/** The built-in, never-deletable group (all-on until edited). */
export const DEFAULT_GROUP_ID = 'default';

/**
 * The seeded group whose MEMBERSHIP comes from the live catalog instead of a
 * stored name list: it enables exactly the skills that ship with the
 * application itself (see {@link isBuiltinSkill}). Because membership is
 * re-derived on every read, a DSH upgrade that adds or removes a packaged
 * skill joins or leaves the group automatically — nothing to re-declare.
 */
export const BUILTIN_GROUP_ID = 'builtin';
/** The only membership scope a group can carry. */
export const BUILTIN_SCOPE = 'builtin';
const GROUP_SCOPES = new Set([BUILTIN_SCOPE]);

/** The state document version (4 = groups + catalog-derived membership). */
export const STATE_VERSION = 4;

/** One group in canonical form (wildcard: enabled cleared; explicit: except cleared). */
function group(id, name = '', all = true, enabled = [], except = [], scope = '') {
  const scoped = GROUP_SCOPES.has(scope) ? scope : '';
  const wildcard = scoped.length === 0 && Boolean(all);
  return {
    id,
    name,
    all: wildcard,
    /** '' = membership by name lists; 'builtin' = membership by catalog source. */
    scope: scoped,
    enabled: wildcard ? [] : [...enabled],
    // A wildcard group and a scoped group both keep their exceptions; a plain
    // explicit group has none (its `enabled` list IS its membership).
    except: wildcard || scoped.length > 0 ? [...except] : [],
  };
}

/** The seeded built-in-skills group (inactive by default: it changes nothing until activated). */
function builtinGroup() {
  return group(BUILTIN_GROUP_ID, '', false, [], [], BUILTIN_SCOPE);
}

/** Unique, non-empty, order-preserving strings from an untrusted array. */
function uniqueStrings(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry) => typeof entry === 'string' && entry.length > 0))];
}

/** Forward-slash, trailing-separator-free path for cross-platform prefix tests. */
export function normalizePath(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Whether a skill ships with the application itself (a "built-in" skill).
 *
 * Primary rule: its `path` or `resourceBase` lives inside the install
 * directory — the packaged app keeps its own skills under
 * `<install>/resources/app.asar/...` and its asset skills under
 * `<install>/resources/runtime/...`, while profile-installed plugins live
 * under `<DSH_HOME>/profiles/.../node_modules` and never match. Secondary
 * rule: the provider declares the packaged `bundled` source, because some
 * packaged skills copy their assets into a temp directory at startup (the
 * Windows ACL diagnosis skill) and the path alone would miss them.
 *
 * @param skill - a catalog summary (or a pre-shadow entry) to test.
 * @param roots - install roots from {@link normalizePath}; an empty list
 *   degrades the rule to the `bundled` source test only.
 */
export function isBuiltinSkill(skill, roots = []) {
  if (skill?.source === 'bundled') return true;
  if (!Array.isArray(roots) || roots.length === 0) return false;
  const paths = [normalizePath(skill?.path), normalizePath(skill?.resourceBase?.path)]
    .filter((entry) => entry.length > 0);
  if (paths.length === 0) return false;
  for (const p of paths) {
    const lower = p.toLowerCase();
    for (const root of roots) {
      if (root.length === 0) continue;
      const needle = root.toLowerCase();
      if (lower === needle || lower.startsWith(`${needle}/`)) return true;
    }
  }
  return false;
}

/** Normalize one untrusted group entry (v3/v4 shape; v2 `disabled` migrates to wildcard+except). */
function normalizeGroup(entry) {
  const name = typeof entry.name === 'string' ? entry.name : '';
  const scope = GROUP_SCOPES.has(entry.scope) ? entry.scope : '';
  const isV3 = typeof entry.all === 'boolean'
    || entry.enabled !== undefined
    || entry.except !== undefined
    || scope.length > 0;
  if (isV3) {
    return group(entry.id, name, entry.all === true, uniqueStrings(entry.enabled), uniqueStrings(entry.except), scope);
  }
  // v2 entry: a blacklist becomes a wildcard group that excepts those names.
  return group(entry.id, name, true, [], uniqueStrings(entry.disabled), scope);
}

/** Normalize an untrusted parsed document into the v4 state shape (v1/v2/v3 migrate). */
export function normalizeState(raw) {
  if (Array.isArray(raw?.groups)) {
    const seen = new Set();
    const groups = [];
    for (const entry of raw.groups) {
      if (entry === null || typeof entry !== 'object') continue;
      if (typeof entry.id !== 'string' || entry.id.length === 0) continue;
      if (seen.has(entry.id)) continue; // duplicate ids: keep the first
      seen.add(entry.id);
      groups.push(normalizeGroup(entry));
    }
    if (!seen.has(DEFAULT_GROUP_ID)) {
      groups.unshift(group(DEFAULT_GROUP_ID));
      seen.add(DEFAULT_GROUP_ID); // implicit default stays valid in activeGroups
    }
    // v3 → v4 migration: seed the built-in-skills group ONCE. A v4 document
    // that no longer has it means the user deleted it deliberately, so it is
    // never resurrected. It is seeded INACTIVE: it contributes nothing to the
    // union until the user activates it, so upgrading never re-enables skills
    // the user had already turned off.
    const seeded = (typeof raw.version === 'number' ? raw.version : 0) < STATE_VERSION
      && !seen.has(BUILTIN_GROUP_ID);
    if (seeded) {
      groups.push(builtinGroup());
      seen.add(BUILTIN_GROUP_ID);
    }
    const activeGroups = Array.isArray(raw.activeGroups)
      ? uniqueStrings(raw.activeGroups).filter((id) => seen.has(id))
      : groups.filter((entry) => !(seeded && entry.id === BUILTIN_GROUP_ID)).map((entry) => entry.id);
    return { version: STATE_VERSION, groups, activeGroups };
  }
  // v1 shape (or garbage): one default wildcard group excepting the flat list,
  // plus the inactive built-in-skills group.
  return {
    version: STATE_VERSION,
    groups: [group(DEFAULT_GROUP_ID, '', true, [], uniqueStrings(raw?.disabled)), builtinGroup()],
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

/**
 * Whether ONE group enables a skill name.
 * @param entry - the group.
 * @param name - the skill name.
 * @param membership - optional `{ builtin: Set<string> }`: the live set of
 *   application-shipped skills. REQUIRED to evaluate a scoped group (without
 *   it a scoped group enables only its explicit `enabled` additions).
 */
export function groupEnables(entry, name, membership) {
  if (entry.scope === BUILTIN_SCOPE) {
    if (entry.except.includes(name)) return false;
    return membership?.builtin?.has(name) === true || entry.enabled.includes(name);
  }
  return entry.all ? !entry.except.includes(name) : entry.enabled.includes(name);
}

/** The ACTIVE groups, in declaration order. */
export function activeGroupsOf(state) {
  const active = new Set(state.activeGroups);
  return state.groups.filter((entry) => active.has(entry.id));
}

/**
 * The effective enabled-name set: the UNION over the ACTIVE groups. With no
 * active group the union is empty (every skill unusable). Wildcard groups
 * contribute every catalog name they do not except, and scoped groups
 * contribute every catalog name the membership says they own, so `names` (the
 * live catalog) is required to expand them. `names` may be any iterable (it is
 * materialized once, so single-pass iterators like `map.keys()` are safe).
 * @param membership - `{ builtin: Set<string> }` for scoped groups.
 */
export function effectiveEnabled(state, names, membership) {
  const nameList = Array.isArray(names) ? names : [...names];
  const out = new Set();
  const active = activeGroupsOf(state);
  if (active.length === 0) return out;
  for (const entry of active) {
    if (entry.all) {
      const except = new Set(entry.except);
      for (const name of nameList) if (!except.has(name)) out.add(name);
    } else if (entry.scope.length > 0) {
      // Catalog-derived membership: a packaged skill added by a DSH upgrade
      // joins this group on its own, with no stored list to refresh.
      for (const name of nameList) if (groupEnables(entry, name, membership)) out.add(name);
    } else {
      for (const name of entry.enabled) out.add(name);
    }
  }
  return out;
}

/** The effective DISABLED names (catalog names no active group enables). */
export function effectiveDisabled(state, names, membership) {
  const nameList = Array.isArray(names) ? names : [...names];
  const enabled = effectiveEnabled(state, nameList, membership);
  const out = new Set();
  for (const name of nameList) if (!enabled.has(name)) out.add(name);
  return out;
}

/** The effective enabled names as a sorted list (tool/RPC display). */
export function effectiveEnabledList(state, names, membership) {
  return [...effectiveEnabled(state, names, membership)].sort((a, b) => a.localeCompare(b));
}

/** Map skill name → display names of the active groups that ENABLE it. */
export function enabledByGroups(state, names, membership) {
  const active = activeGroupsOf(state);
  const byName = new Map();
  for (const name of names) {
    const labels = active
      .filter((entry) => groupEnables(entry, name, membership))
      .map((entry) => entry.name || entry.id);
    if (labels.length > 0) byName.set(name, labels);
  }
  return byName;
}

/** Immutable map over the groups array (same array → same state object). */
function withGroups(state, nextGroups) {
  if (nextGroups === state.groups) return state;
  return { ...state, groups: nextGroups };
}

/** Replace one group entry immutably (same entry → same state object). */
function withGroupEntry(state, index, nextEntry) {
  const target = state.groups[index];
  if (nextEntry === target) return state;
  const groups = [...state.groups];
  groups[index] = nextEntry;
  return withGroups(state, groups);
}

/** Locate one group or throw. */
function groupIndex(state, groupId) {
  const index = state.groups.findIndex((entry) => entry.id === groupId);
  if (index === -1) throw new Error(`unknown group ${JSON.stringify(groupId)}`);
  return index;
}

/**
 * Immutable disable inside ONE group: a wildcard group records the name in
 * `except`; an explicit group drops it from `enabled`; a scoped group drops a
 * member into `except` and a non-member out of its explicit `enabled`
 * additions. Other groups are never touched — a skill another active group
 * enables stays usable. Returns the same state when the group already matches
 * (callers skip the write pair).
 */
export function withDisabled(state, name, groupId = DEFAULT_GROUP_ID, membership) {
  const index = groupIndex(state, groupId);
  const target = state.groups[index];
  if (target.scope === BUILTIN_SCOPE) {
    if (membership?.builtin?.has(name) === true) {
      if (target.except.includes(name)) return state;
      return withGroupEntry(state, index, { ...target, except: [...target.except, name] });
    }
    if (!target.enabled.includes(name)) return state;
    return withGroupEntry(state, index, { ...target, enabled: target.enabled.filter((entry) => entry !== name) });
  }
  if (target.all) {
    if (target.except.includes(name)) return state;
    return withGroupEntry(state, index, { ...target, except: [...target.except, name] });
  }
  if (!target.enabled.includes(name)) return state;
  return withGroupEntry(state, index, { ...target, enabled: target.enabled.filter((entry) => entry !== name) });
}

/** Immutable enable inside ONE group (inverse of withDisabled; same idempotence). */
export function withEnabled(state, name, groupId = DEFAULT_GROUP_ID, membership) {
  const index = groupIndex(state, groupId);
  const target = state.groups[index];
  if (target.scope === BUILTIN_SCOPE) {
    if (membership?.builtin?.has(name) === true) {
      if (!target.except.includes(name)) return state;
      return withGroupEntry(state, index, { ...target, except: target.except.filter((entry) => entry !== name) });
    }
    if (target.enabled.includes(name)) return state;
    return withGroupEntry(state, index, { ...target, enabled: [...target.enabled, name] });
  }
  if (target.all) {
    if (!target.except.includes(name)) return state;
    return withGroupEntry(state, index, { ...target, except: target.except.filter((entry) => entry !== name) });
  }
  if (target.enabled.includes(name)) return state;
  return withGroupEntry(state, index, { ...target, enabled: [...target.enabled, name] });
}

/**
 * Immutable "this group enables everything it can" for ONE group: a wildcard
 * group drops every exception; a scoped group keeps its scope and drops its
 * exceptions (so it owns the whole built-in set); an explicit group becomes a
 * wildcard. Same state when already that shape.
 */
export function withGroupAllEnabled(state, groupId = DEFAULT_GROUP_ID, membership) {
  const index = groupIndex(state, groupId);
  const target = state.groups[index];
  if (target.scope === BUILTIN_SCOPE) {
    if (target.except.length === 0) return state;
    return withGroupEntry(state, index, { ...target, except: [] });
  }
  if (target.all && target.except.length === 0) return state;
  return withGroupEntry(state, index, group(target.id, target.name, true));
}

/**
 * Immutable "this group enables nothing" for ONE group: an explicit group
 * empties its list, a wildcard group becomes an empty explicit whitelist, and
 * a scoped group excepts its whole current membership (its scope survives, so
 * newly packaged skills join it again on the next catalog read).
 */
export function withGroupAllDisabled(state, groupId = DEFAULT_GROUP_ID, membership) {
  const index = groupIndex(state, groupId);
  const target = state.groups[index];
  if (target.scope === BUILTIN_SCOPE) {
    const members = membership?.builtin ? [...membership.builtin] : [];
    const except = [...new Set([...target.except, ...members])];
    if (target.enabled.length === 0 && sameSet(except, target.except)) return state;
    return withGroupEntry(state, index, { ...target, except, enabled: [] });
  }
  if (!target.all && target.enabled.length === 0) return state;
  return withGroupEntry(state, index, group(target.id, target.name, false));
}

/** Order-insensitive set equality over two string lists. */
function sameSet(a, b) {
  return a.length === b.length && a.every((entry) => b.includes(entry));
}

/**
 * Global "enable everything": EVERY group becomes a wildcard with no
 * exceptions (a scoped group keeps its scope and simply drops its exceptions,
 * so it never silently turns into an all-on group) AND every group is
 * activated — with no active group the union would still be empty, so
 * activation is part of the promise.
 */
export function withAllEnabled(state) {
  const groups = state.groups.map((entry) => {
    if (entry.scope === BUILTIN_SCOPE) {
      return entry.except.length === 0 ? entry : { ...entry, except: [] };
    }
    return entry.all && entry.except.length === 0 ? entry : group(entry.id, entry.name, true);
  });
  const activeGroups = state.groups.map((entry) => entry.id);
  const nextGroups = groups.every((entry, i) => entry === state.groups[i]) ? state.groups : groups;
  if (nextGroups === state.groups && sameIdList(activeGroups, state.activeGroups)) return state;
  return { ...state, groups: nextGroups, activeGroups };
}

/** Same ids, same order? */
function sameIdList(a, b) {
  return a.length === b.length && a.every((id, i) => b[i] === id);
}

/**
 * Immutable bulk set inside ONE group: add (`disabled: true`) or remove
 * (`disabled: false`) a batch of names from the group's enable set. For a
 * wildcard group that means its `except`; for an explicit group its `enabled`;
 * for a scoped group the batch splits — catalog members go through `except`,
 * non-members through the explicit `enabled` additions. Returns the same state
 * when the group already matches (set-wise, order-insensitive).
 */
export function withGroupSet(state, groupId, names, disabled, membership) {
  const index = groupIndex(state, groupId);
  const target = state.groups[index];
  if (target.scope === BUILTIN_SCOPE) {
    const members = [];
    const others = [];
    for (const name of names) {
      if (membership?.builtin?.has(name) === true) members.push(name);
      else others.push(name);
    }
    const except = disabled
      ? [...new Set([...target.except, ...members])]
      : target.except.filter((entry) => !members.includes(entry));
    const enabled = disabled
      ? target.enabled.filter((entry) => !others.includes(entry))
      : [...new Set([...target.enabled, ...others])];
    if (sameSet(except, target.except) && sameSet(enabled, target.enabled)) return state;
    return withGroupEntry(state, index, { ...target, except, enabled });
  }
  const list = target.all ? target.except : target.enabled;
  // disabled=true: wildcard adds to except, explicit removes from enabled.
  const adds = disabled ? target.all : !target.all;
  let next;
  if (adds) {
    next = [...new Set([...list, ...names])];
  } else {
    const remove = new Set(names);
    next = list.filter((entry) => !remove.has(entry));
  }
  if (next.length === list.length && next.every((entry) => list.includes(entry))) {
    return state;
  }
  return withGroupEntry(state, index, { ...target, [target.all ? 'except' : 'enabled']: next });
}

/** Slug a group name into a safe id stem; empty → "group". */
function slugify(name) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'group';
}

/**
 * Immutable group creation (the new group starts ACTIVE as an explicit EMPTY
 * whitelist: it contributes nothing until skills are enabled inside it —
 * "each group is only responsible for the skills it itself enables"). Pass
 * `scope: 'builtin'` for a group whose membership is the live set of
 * application-shipped skills instead of a name list. Ids are slugs of the
 * name, uniquified with numeric suffixes; `default` is reserved.
 * @returns {{ state: object, id: string }}
 */
export function withGroupCreated(state, name, scope = '') {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed.length === 0) throw new Error('group name must be a non-empty string');
  const stem = slugify(trimmed);
  const taken = new Set(state.groups.map((entry) => entry.id));
  let id = stem;
  for (let n = 2; taken.has(id); n += 1) id = `${stem}-${n}`;
  return {
    state: {
      ...state,
      groups: [...state.groups, group(id, trimmed, false, [], [], scope)],
      activeGroups: [...state.activeGroups, id],
    },
    id,
  };
}

/** Immutable group rename (display name only; ids never change). */
export function withGroupRenamed(state, groupId, name) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed.length === 0) throw new Error('group name must be a non-empty string');
  const index = groupIndex(state, groupId);
  const target = state.groups[index];
  if (target.name === trimmed) return state;
  return withGroupEntry(state, index, { ...target, name: trimmed });
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
  const index = groupIndex(state, groupId);
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
    version: STATE_VERSION,
    groups: state.groups.map((entry) => ({
      id: entry.id,
      name: entry.name,
      all: entry.all,
      scope: entry.scope ?? '',
      enabled: [...entry.enabled],
      except: [...entry.except],
    })),
    activeGroups: [...state.activeGroups],
  };
}

/**
 * Merge the enumerated catalog with the effective whitelist into panel/tool
 * rows.
 * @param skills - [{ name, description, invocation, origin?, builtin? }]
 *   (`origin` is the caller-classified source key from classifyOrigin,
 *   `builtin` the caller-computed {@link isBuiltinSkill} flag).
 * @param state - the resolved toggle state.
 * @param membership - `{ builtin: Set<string> }` for scoped groups; defaults
 *   to the rows' own `builtin` flags.
 * @returns rows sorted by name, each with the effective enabled flag
 *   (enabled = at least one ACTIVE group enables it; the raw invocation
 *   policy is preserved for display so host-level restrictions stay visible),
 *   the display names of the active groups that enable it, the origin key, and
 *   whether the skill ships with the application.
 */
export function mergeCatalog(skills, state, membership) {
  const names = skills.map((skill) => skill.name);
  const context = membership ?? { builtin: new Set(skills.filter((skill) => skill.builtin === true).map((skill) => skill.name)) };
  const enabled = effectiveEnabled(state, names, context);
  const byGroup = enabledByGroups(state, names, context);
  return skills
    .map((skill) => ({
      name: skill.name,
      description: skill.description ?? '',
      enabled: enabled.has(skill.name),
      enabledBy: byGroup.get(skill.name) ?? [],
      origin: typeof skill.origin === 'string' && skill.origin.length > 0 ? skill.origin : 'other',
      builtin: skill.builtin === true || context.builtin?.has(skill.name) === true,
      modelInvocable: skill.invocation?.modelInvocable === true,
      userInvocable: skill.invocation?.userInvocable === true,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Prefix the shadow provider encodes into its candidate locator (the
 * public Skill view strips locators, so classification rides on the
 * passed-through path/resourceBase instead; this remains for debugging). */
export const SHADOW_LOCATOR_PREFIX = 'st-orig:';

/**
 * Classify one catalog skill into a source key for the panel's origin
 * sections: `plugin:<name>` (a path/resourceBase under node_modules/<pkg>,
 * or a dedicated named provider), `user` (under the harness/agents homes),
 * `project` (a project .dsh/.agents skills root), `custom`, or `other`.
 * Runtime-registered plugin skills (generic provider `runtime`, no path)
 * are attributed via their resourceBase directory, which lives inside the
 * plugin package. Shadow-won entries keep path/resourceBase, so they
 * classify identically to their enabled form.
 * @param skill - catalog entry ({ name, path?, provider?, resourceBase? }).
 * @param options.dshHome / options.agentsHome - home roots for user vs project
 *   disambiguation (both homes contain a /.dsh/skills/-shaped segment).
 * @param options.shadowProvider - this plugin's shadow provider name (never
 *   treated as a plugin attribution). Callers MUST feed a shadow-won entry
 *   through {@link restoreAttribution} first, or every DISABLED skill loses
 *   its plugin attribution (asset-backed and runtime-registered skills then
 *   fall into `custom`/`other` instead of `plugin:<provider>`).
 */
export function classifyOrigin(skill, options = {}) {
  const norm = (value) => (typeof value === 'string' ? value.replace(/\\/g, '/') : '');
  const paths = [norm(skill.path), norm(skill.resourceBase?.path)].filter((entry) => entry.length > 0);
  for (const p of paths) {
    const pkg = /\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(p);
    if (pkg !== null) return `plugin:${pkg[1]}`;
  }
  const provider = typeof skill.provider === 'string' ? skill.provider : '';
  // `filesystem` and `runtime` are generic providers (roots / ctx.skills.register);
  // any other non-empty provider name IS the plugin attribution.
  if (provider.length > 0 && provider !== 'filesystem' && provider !== 'runtime'
    && provider !== options.shadowProvider) {
    return `plugin:${provider}`;
  }
  for (const p of paths) {
    const lower = p.toLowerCase();
    for (const home of [options.dshHome, options.agentsHome]) {
      if (typeof home !== 'string' || home.length === 0) continue;
      if (lower.startsWith(`${home.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()}/skills/`)) return 'user';
    }
    if (p.includes('/.dsh/skills/') || p.includes('/.agents/skills/')) return 'project';
    if (p.includes('/skills/')) return 'custom';
  }
  // Last resort: a registration with a generic provider and no filesystem
  // anchor still states where it came from through `source` (packaged
  // `bundled` skills mounted by the application itself).
  if (skill.source === 'bundled') return 'bundled';
  return 'other';
}

/**
 * Merge the pre-shadow attribution back into a shadow-won catalog entry.
 *
 * The skill registry validates that a candidate's `provider` equals the
 * emitting provider's name and its public summary drops `locator`/`rank`, so
 * a disabled (shadow-won) summary no longer carries the provider that owns
 * the skill, and `path`/`resourceBase` may be absent too. The shadow provider
 * captures the ORIGINAL summary for every name it enumerated in the same
 * collect; feeding that back makes origin classification identical whether a
 * skill is enabled or disabled.
 * @param skill - the winning summary as returned by the registry.
 * @param original - the pre-shadow summary for the same name (or undefined).
 * @returns a shallow copy carrying the original attribution, or `skill`
 *   unchanged when there is nothing to restore.
 */
export function restoreAttribution(skill, original) {
  if (original === null || typeof original !== 'object') return skill;
  const next = { ...skill };
  let changed = false;
  const assign = (key, value) => {
    if (typeof value !== 'string' || value.length === 0) return;
    if (next[key] === value) return;
    next[key] = value;
    changed = true;
  };
  assign('provider', original.provider);
  assign('source', original.source);
  assign('path', original.path);
  if (original.resourceBase !== null && typeof original.resourceBase === 'object') {
    if (next.resourceBase !== original.resourceBase) {
      next.resourceBase = original.resourceBase;
      changed = true;
    }
  }
  return changed ? next : skill;
}

