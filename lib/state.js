/**
 * Pure state logic for the dsh-skill-toggles host half.
 *
 * Deliberately dependency-free (no Cordis, no schemastery): every function
 * here is unit-testable with plain `node --test` and is the single source of
 * truth for the blacklist semantics shared by the skill_toggles_* tools, the
 * RPC surface, and the shadow skill provider in lib/index.js.
 *
 * State shape (plain JSON):
 *   state = { disabled: string[] }
 *
 * Blacklist semantics: an empty `disabled` list means EVERY skill is usable
 * (fresh install, missing file, corrupt file — never the "everything
 * vanished" failure mode of whitelist plugins). Only names explicitly listed
 * here are suppressed; names absent from the live catalog are ignored
 * silently (renames never error).
 */

/** Normalize an untrusted parsed document into the state shape. */
export function normalizeState(raw) {
  const disabled = Array.isArray(raw?.disabled)
    ? [...new Set(raw.disabled.filter((name) => typeof name === 'string' && name.length > 0))]
    : [];
  return { disabled };
}

/** The disabled-name set for one state (Set for O(1) provider lookups). */
export function disabledNames(state) {
  return new Set(state.disabled);
}

/**
 * Immutable disable: returns the same state when the name is already
 * disabled (callers skip the write + invalidation pair).
 */
export function withDisabled(state, name) {
  if (state.disabled.includes(name)) return state;
  return { ...state, disabled: [...state.disabled, name] };
}

/** Immutable enable: returns the same state when the name was not disabled. */
export function withEnabled(state, name) {
  const index = state.disabled.indexOf(name);
  if (index === -1) return state;
  return { ...state, disabled: state.disabled.filter((entry) => entry !== name) };
}

/** Immutable enable-all: returns the same state when nothing is disabled. */
export function withAllEnabled(state) {
  if (state.disabled.length === 0) return state;
  return { ...state, disabled: [] };
}

/**
 * Fresh plain-JSON copy of the state (scalars only; never live data).
 */
export function snapshotState(state) {
  return { disabled: [...state.disabled] };
}

/**
 * Merge the enumerated catalog with the blacklist into panel/tool rows.
 * @param skills - [{ name, description, invocation: { modelInvocable, userInvocable } }]
 * @param state - the resolved toggle state.
 * @returns rows sorted by name, each with the effective enabled flag
 *   (enabled = not blacklisted; the raw invocation policy is preserved for
 *   display so host-level restrictions stay visible).
 */
export function mergeCatalog(skills, state) {
  const disabled = disabledNames(state);
  return skills
    .map((skill) => ({
      name: skill.name,
      description: skill.description ?? '',
      enabled: !disabled.has(skill.name),
      modelInvocable: skill.invocation?.modelInvocable === true,
      userInvocable: skill.invocation?.userInvocable === true,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
