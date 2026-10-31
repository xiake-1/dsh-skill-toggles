/**
 * dsh-skill-toggles — host half.
 *
 * A bundle plugin (installed via `dsh plugin --profile <p> add <path>`; the
 * cordis.patch.yml row mounts it into the host composition). Whitelist-group
 * semantics: each group only ever CONTRIBUTES the skills it enables, and the
 * effective enabled set is the UNION over the ACTIVE groups — a skill is
 * usable when at least one active group enables it, so activating another
 * group can only add usable skills (two active groups can never conflict
 * into an empty catalog), and with NO active group every skill is unusable.
 * A fresh install, a missing state file, or a corrupt state file all mean
 * "default group active, enables everything" — never a first-boot
 * "everything vanished".
 *
 * It provides:
 *
 *  1. State model & persistence — a plugin-owned state file
 *     (`<harness home>/dsh-skill-toggles/state.json`, atomic write; the
 *     directory is removed together with the plugin via the package's
 *     `postuninstall` script). State (v3): groups, each either a wildcard
 *     (`all: true`, enables everything except `except`) or an explicit
 *     whitelist (`enabled`), plus the active-group ids. The EFFECTIVE enabled
 *     set is the union over the ACTIVE groups; the built-in `default` group
 *     starts as a wildcard with no exceptions (everything on) and is
 *     editable. v1 flat and v2 per-group `disabled` documents migrate into
 *     wildcard groups on load.
 *  2. Skill filtering — a per-agent shadow skill provider
 *     (`skill-toggles-filter`) registered on `agent.ctx` at `agent/created`.
 *     Its list() emits ONLY the names that exist in that agent's live
 *     catalog but are NOT in the effective union (no active group enables
 *     them), each with invocation rewritten to
 *     { modelInvocable: false, userInvocable: false } and rank 0 (within one
 *     layer the rank decides duplicates, and every filesystem root ranks
 *     100..500, so the shadow entry wins outright; the nearest layer wins
 *     across layers, so registering on the agent layer also covers
 *     agent-plane user/project skills). Enabled skills are NOT re-emitted:
 *     they keep their original candidates, so `path` previews and body
 *     loading stay with the real provider. The registry merge removes the
 *     disabled skills from the model `<available_skills>` catalog (next
 *     request turn — the model-side projection is persistent by design) and
 *     the `skill` tool's isModelInvocable gate refuses them. Every entry the
 *     shadow enumerates also has its PRE-shadow attribution (provider /
 *     source / path / resourceBase) recorded per agent: the registry forces a
 *     candidate's `provider` to equal the emitting provider and the public
 *     summary drops the locator, so without that record every DISABLED skill
 *     loses its plugin attribution in the panel (asset-backed and
 *     runtime-registered skills fall under "other"). `skillsList()` merges it
 *     back before classifying each row's source.
 *  3. Composer '/' menu refresh — the client (`dsh-client-ui-skill`) caches
 *     the catalog per session and drops one entry on the forwarded Host
 *     event `agent-preset/selected` (the only lightweight invalidation in
 *     the forwarded-event allowlist; `skills/change` is Host-local). After
 *     every toggle we invalidate every shadow provider (clears the skill
 *     registry collect cache) AND emit `agent-preset/selected` for every
 *     live session, so the very next '/' open re-fetches `skills/list` and
 *     reflects the change (sub-second). We additionally subscribe to the
 *     Host-local `skills/change` and re-emit that invalidation (coalesced),
 *     so a plugin install/remove, a bundle enable/disable, or a hand-edited
 *     skill file also drops the stale browser caches — the official client
 *     only clears on `plugin-manager/changed`, which a CLI/HMR-applied patch
 *     never emits.
 *  4. The `skill_toggles_*` tools in the shared tools registry.
 *  5. The RPC surface for the browser half: one JSON POST route
 *     `/plugins/dsh-skill-toggles/rpc` with body { method, args } →
 *     { ok, value } | { ok: false, error } (bundle plugins have no
 *     harness.handle/host.call).
 *
 * Lifecycle: every side effect is fiber-scoped or explicitly disposed
 * (store writes, tools.register, skills.registerProvider, webServer routes,
 * ctx.on listeners). No live data is ever serialized: only scalar fields are
 * extracted into fresh JSON.
 *
 * Known limitation (same as any per-agent shadow): a session whose Agent is
 * NOT live is served by its preset's standing scope, which this plugin does
 * not shadow; its menu may still list disabled skills until the session is
 * activated (the model catalog and the `skill` tool are unaffected because
 * they always run through a live Agent).
 */
import {
  SHADOW_LOCATOR_PREFIX,
  BUILTIN_SCOPE,
  classifyOrigin,
  effectiveDisabled,
  effectiveEnabledList,
  findGroup,
  isBuiltinSkill,
  mergeCatalog,
  normalizePath,
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
} from './state.js';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createStateStore } from './store.js';

export const name = 'skill-toggles';
export const inject = ['skills', 'tools', 'agents', 'sessions', 'loader'];

/** Unique shadow provider name; the registry merges by skill name, not provider name. */
const SHADOW_PROVIDER_NAME = 'skill-toggles-filter';
/** Web-server service key candidates, newest first. */
const WEB_SERVER_KEYS = ['webServer', 'httpServer'];
/** Base path of the browser-half RPC route. */
const RPC_PATH = '/plugins/dsh-skill-toggles/rpc';
/** Max RPC request body bytes. */
const MAX_RPC_BODY_BYTES = 64 * 1024;
/** The mutually exclusive legacy plugin (warn once; stacking shadows is uncontrolled). */
const LEGACY_PLUGIN_NAME = 'dsh-skills-mcp-group-manager';
/** Coalescing window for registry-driven (`skills/change`) client invalidation. */
const CLIENT_NOTIFY_DEBOUNCE_MS = 200;

/**
 * Roots that identify "this application shipped it": the Electron resources
 * directory and the executable's directory. A packaged desktop/web host has
 * both (its own skills sit under `<install>/resources/app.asar/...` and its
 * skill assets under `<install>/resources/runtime/...`); a plain Node host has
 * neither, and the built-in rule then degrades to the `bundled` source test.
 * Profile-installed plugins (`<DSH_HOME>/profiles/.../node_modules`) and
 * user/project/external-repo skills never match.
 */
function resolveInstallRoots() {
  const raw = new Set();
  const resources = typeof process.resourcesPath === 'string' ? process.resourcesPath : '';
  if (resources.length > 0) raw.add(resources);
  const exe = typeof process.execPath === 'string' ? process.execPath : '';
  if (exe.length > 0) raw.add(dirname(exe));
  return [...raw].map(normalizePath).filter((entry) => entry.length > 0);
}

/** The names among `skills` that ship with the application (scoped-group membership). */
function builtinNameSet(skills, roots) {
  const out = new Set();
  for (const skill of skills) if (isBuiltinSkill(skill, roots)) out.add(skill.name);
  return out;
}

/**
 * Host half plugin.
 * @param ctx - plugin context (injects skills/tools/agents/sessions/loader).
 * @param config - unused today; reserved for future composition options.
 *
 * MUST stay synchronous: Cordis treats a prototype-bearing function as a
 * constructor and ignores its returned promise, so an async apply would
 * turn any post-await throw into an unhandled rejection that crashes the
 * whole dsh process.
 */
export function apply(ctx, config = {}) {
  // ── 1) state model & persistence ─────────────────────────────────────────
  const store = createStateStore({ dshHome: process.env.DSH_HOME, logger: ctx.logger });
  store.loadSync();

  /** Install roots for the built-in-skill membership rule (computed once). */
  const installRoots = resolveInstallRoots();

  // Per-apply runtime bookkeeping (all plain data, no live objects).
  /** agent.id -> { control, dispose } of the shadow provider registration. */
  const shadowControls = new Map();
  /**
   * agent.id -> Map<skillName, { provider, source, path?, resourceBase? }> —
   * the PRE-shadow attribution of every catalog entry the shadow enumerated in
   * its last collect. The registry rewrites a shadow candidate's `provider` to
   * this provider's name and its public summary drops `locator`, so without
   * this map every DISABLED skill loses its plugin attribution and the panel
   * files it under `other`/`custom` instead of `plugin:<provider>`.
   */
  const shadowAttributions = new Map();
  /** Serializes read-modify-write cycles so concurrent calls never interleave. */
  let writeChain = Promise.resolve();

  // ── 2) skill filtering (per-agent shadow provider) ──────────────────────
  function applyAgentFilter(agent) {
    if (shadowControls.has(agent.id)) return;
    // IMPORTANT: use agent.ctx.get('skills') — NOT agent.ctx.skills. In the
    // running process the agent ctx's inject map lacks 'skills', so the
    // property access throws the Cordis Guard error ("cannot get property
    // skills without inject") and crashes the plugin tree at boot when
    // sessions are restored; get() resolves the service directly.
    const skills = agent.ctx.get('skills');
    if (skills === undefined) return;
    const attribution = new Map();
    shadowAttributions.set(agent.id, attribution);
    let controlRef;
    const dispose = skills.registerProvider((control) => {
      controlRef = control; // factory runs synchronously; captured for invalidate()
      // Re-entrancy guard: this provider's own list() reads the agent's view
      // to see agent-plane skills (user-dsh/project providers live in the
      // agent layer, NOT the global layer). Reading that view re-enters this
      // list() through the registry; the re-entrant call yields NO candidates
      // so the enclosing call can enumerate the raw catalog (the registry
      // overwrites the intermediate cached layer with this provider's
      // filtered output once the outer call completes).
      let catalogInFlight = false;
      return {
        name: SHADOW_PROVIDER_NAME,
        async list(options) {
          if (catalogInFlight) return [];
          catalogInFlight = true;
          try {
            // Union of the global view (bundled providers) and this agent's
            // raw view (global + agent-plane providers, shadow stripped by
            // the guard). This is exactly the catalog the agent sees, so the
            // filter can suppress agent-plane skills too.
            const byName = new Map();
            for (const skill of await ctx.skills.list({ cwd: options.cwd, signal: options.signal })) {
              byName.set(skill.name, skill);
            }
            const raw = await skills.list({ cwd: options.cwd, signal: options.signal, scope: agent });
            for (const skill of raw) {
              if (!byName.has(skill.name)) byName.set(skill.name, skill);
            }
            // Capture the PRE-shadow attribution of the whole catalog: the
            // registry forces our candidates to carry this provider's name and
            // the public summary drops the locator, so this is the only place
            // the owning plugin (provider / path / resourceBase / source) is
            // still visible for a disabled skill. `skillsList()` merges it back
            // before classifying, so a skill's source section never depends on
            // whether it currently happens to be disabled.
            attribution.clear();
            for (const [skillName, skill] of byName) {
              attribution.set(skillName, {
                provider: skill.provider,
                source: skill.source,
                ...(skill.path !== undefined ? { path: skill.path } : {}),
                ...(skill.resourceBase !== undefined ? { resourceBase: skill.resourceBase } : {}),
              });
            }
            // Whitelist emission: only catalog entries that NO active group
            // enables (the complement of the union over active groups).
            // Names absent from the catalog are irrelevant (skill renames
            // never error and never inject phantom entries). Enabled skills
            // are left to their real providers — path previews, resource
            // bases, and body loading keep full fidelity. With no active
            // group the union is empty, so every catalog entry is shadowed.
            // Membership for catalog-scoped groups: a `builtin` group decides
            // its members from THIS catalog read, so a scoped group that is
            // active keeps owning the packaged skills (without the membership
            // it would own nothing and every packaged skill would be shadowed).
            const membership = { builtin: builtinNameSet(byName.values(), installRoots) };
            const disabled = effectiveDisabled(store.get(), byName.keys(), membership);
            const out = [];
            for (const [skillName, skill] of byName) {
              if (!disabled.has(skillName)) continue;
              out.push({
                name: skillName,
                description: skill.description,
                ...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
                ...(skill.path !== undefined ? { path: skill.path } : {}),
                invocation: { modelInvocable: false, userInvocable: false },
                source: skill.source,
                provider: SHADOW_PROVIDER_NAME, // must equal this provider's name
                ...(skill.resourceBase !== undefined ? { resourceBase: skill.resourceBase } : {}),
                rank: 0, // sole shadow candidate; outranks every filesystem root (100..500)
                // Opaque handle for debugging/log correlation only: the public
                // summary drops `locator`, so attribution is recovered from the
                // `attribution` map above, never from here.
                locator: `${SHADOW_LOCATOR_PREFIX}${skill.provider ?? 'unknown'}:${skillName}`,
              });
            }
            return out;
          } finally {
            catalogInFlight = false;
          }
        },
        async get(candidate, options) {
          // Delegate body loading to the global view (resolves to the real
          // filesystem provider's candidate). Disabled skills never reach
          // get(): dsh-tool-skill's isModelInvocable gate refuses them after
          // list().
          return ctx.skills.get(candidate.name, { cwd: options.cwd, signal: options.signal });
        },
      };
    });
    shadowControls.set(agent.id, { control: controlRef, dispose });
  }

  /** Clear every skill registry collect cache so the next list() re-collects. */
  function refreshSkillCatalogs() {
    for (const { control } of shadowControls.values()) control.invalidate();
  }

  /** Pending coalesced client invalidation (external catalog changes). */
  let notifyTimer = null;

  /**
   * Coalesce the client invalidations triggered by the registry's own
   * `skills/change` notifications: a plugin install/remove, a bundle
   * enable/disable, a hand-edited skill file, or any provider registration.
   * Without this the composer '/' menu and the panel keep listing a skill
   * whose plugin has already been removed until the next toggle or a page
   * reload — the official client only clears its cache on
   * `plugin-manager/changed`, which a CLI/HMR-applied patch never emits.
   */
  function scheduleClientNotify() {
    if (notifyTimer !== null) return;
    notifyTimer = setTimeout(() => {
      notifyTimer = null;
      notifyClients();
    }, CLIENT_NOTIFY_DEBOUNCE_MS);
    if (typeof notifyTimer?.unref === 'function') notifyTimer.unref();
  }

  /**
   * Drop the browser halves' per-session catalog caches. The forwarded-event
   * allowlist has no skills entry; `agent-preset/selected` is the one
   * lightweight invalidation both `dsh-client-ui-skill` (catalog cache) and
   * `dsh-client-ui-commands` (command directory) consume, keyed by sessionId.
   * The second argument is the session's current preset (both remote
   * consumers ignore it; the declared signature requires a string).
   */
  function notifyClients() {
    // A direct invalidation supersedes any pending coalesced one.
    if (notifyTimer !== null) {
      clearTimeout(notifyTimer);
      notifyTimer = null;
    }
    for (const session of ctx.sessions.list()) {
      let preset = '';
      try {
        preset = session.projections?.values?.agentPreset
          ?? session.header?.agentPreset
          ?? '';
      } catch {
        // Projections are best-effort display context; never block a toggle.
      }
      ctx.emit('agent-preset/selected', session.id, preset);
    }
  }

  // ── 3) shared business logic (tools + RPC) ───────────────────────────────
  /** Serialize one read-modify-write cycle; failures never poison the chain. */
  function withWriteLock(task) {
    const run = writeChain.then(task, task);
    writeChain = run.catch(() => {});
    return run;
  }

  /** Re-apply every dynamic effect after a state change. */
  function applyStateEffects() {
    refreshSkillCatalogs();
    notifyClients();
  }

  /**
   * Enumerate the full catalog the way the agents see it. The host-plane
   * skills service only sees the global layer; user/project skill roots are
   * served by the agent-plane filesystem provider, so read each live agent's
   * view (global + agent layers) to list the full catalog.
   */
  async function skillsList() {
    const byName = new Map();
    for (const agent of ctx.agents.list()) {
      const skills = agent.ctx.get('skills');
      if (skills === undefined) continue;
      const attribution = shadowAttributions.get(agent.id);
      const all = await skills.list({
        cwd: agent.session?.header?.cwd,
        scope: agent,
      });
      for (const skill of all) {
        if (byName.has(skill.name)) continue;
        // A disabled skill wins as a shadow entry whose `provider` is ours;
        // restore the real owner so the panel groups it under its plugin. Only
        // our own entries are touched — a real provider's summary is already
        // authoritative, and the attribution map is keyed by name (a name can
        // exist in both the global and the agent layer).
        byName.set(skill.name, skill.provider === SHADOW_PROVIDER_NAME
          ? restoreAttribution(skill, attribution?.get(skill.name))
          : skill);
      }
    }
    if (byName.size === 0) {
      // No live agents (or none resolve skills): fall back to the host view.
      for (const skill of await ctx.skills.list()) if (!byName.has(skill.name)) byName.set(skill.name, skill);
    }
    const originOptions = {
      dshHome: process.env.DSH_HOME ?? join(homedir(), '.dsh'),
      agentsHome: process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents'),
      shadowProvider: SHADOW_PROVIDER_NAME,
    };
    const catalog = [...byName.values()].map((skill) => ({
      ...skill,
      origin: classifyOrigin(skill, originOptions),
      builtin: isBuiltinSkill(skill, installRoots),
    }));
    // Membership context for catalog-scoped groups, derived from the same read
    // so the panel, the tools, and the shadow provider all agree.
    const membership = { builtin: new Set(catalog.filter((row) => row.builtin).map((row) => row.name)) };
    return mergeCatalog(catalog, store.get(), membership);
  }

  function requireSkillName(args) {
    const skill = typeof args?.skill === 'string' ? args.skill.trim() : '';
    if (skill.length === 0) throw new Error('skill must be a non-empty string');
    return skill;
  }

  /** Resolve the optional `group` argument (id or display name; empty → default). */
  function requireGroupId(args) {
    return resolveGroupId(store.get(), args?.group);
  }

  /** Commit one immutable state transition; no-op transitions skip the write. */
  async function commit(next) {
    await withWriteLock(async () => {
      if (next !== store.get()) {
        await store.update(next);
        applyStateEffects();
      }
    });
  }

  /**
   * Membership context for a group that needs one (catalog-scoped groups).
   * Plain groups get `undefined` so their mutations never touch the catalog.
   */
  async function membershipForGroup(groupId) {
    const entry = findGroup(store.get(), groupId);
    if (entry === undefined || entry.scope !== BUILTIN_SCOPE) return undefined;
    const rows = await skillsList();
    return { builtin: new Set(rows.filter((row) => row.builtin).map((row) => row.name)) };
  }

  const api = {
    async stateGet() {
      return snapshotState(store.get());
    },
    async skillsList() {
      return skillsList();
    },
    async disable(args) {
      const skill = requireSkillName(args);
      const group = requireGroupId(args);
      await commit(withDisabled(store.get(), skill, group, await membershipForGroup(group)));
      return { skill, group, enabled: false };
    },
    async enable(args) {
      const skill = requireSkillName(args);
      const group = requireGroupId(args);
      await commit(withEnabled(store.get(), skill, group, await membershipForGroup(group)));
      return { skill, group, enabled: true };
    },
    async enableAll(args) {
      const groupRef = typeof args?.group === 'string' ? args.group.trim() : '';
      if (groupRef.length > 0) {
        const group = requireGroupId(args);
        await commit(withGroupAllEnabled(store.get(), group, await membershipForGroup(group)));
        return snapshotState(store.get());
      }
      // Global "enable everything": every group becomes a wildcard with no
      // exceptions AND every group is activated (with no active group the
      // union would still be empty).
      await commit(withAllEnabled(store.get()));
      return snapshotState(store.get());
    },
    async disableAll(args) {
      const group = requireGroupId(args);
      await commit(withGroupAllDisabled(store.get(), group, await membershipForGroup(group)));
      return snapshotState(store.get());
    },
    async sourceSet(args) {
      const group = requireGroupId(args);
      const origin = typeof args?.origin === 'string' ? args.origin.trim() : '';
      if (origin.length === 0) throw new Error('origin must be a non-empty string');
      const rows = await skillsList();
      const names = rows.filter((row) => row.origin === origin).map((row) => row.name);
      const membership = { builtin: new Set(rows.filter((row) => row.builtin).map((row) => row.name)) };
      await commit(withGroupSet(store.get(), group, names, args?.disabled !== false, membership));
      return snapshotState(store.get());
    },
    async groupCreate(args) {
      const scope = typeof args?.scope === 'string' ? args.scope.trim() : '';
      const created = withGroupCreated(store.get(), args?.name, scope);
      await commit(created.state);
      return snapshotState(store.get());
    },
    async groupRename(args) {
      const group = resolveGroupId(store.get(), args?.group);
      await commit(withGroupRenamed(store.get(), group, args?.name));
      return snapshotState(store.get());
    },
    async groupDelete(args) {
      const group = resolveGroupId(store.get(), args?.group);
      await commit(withGroupDeleted(store.get(), group));
      return snapshotState(store.get());
    },
    async groupSetActive(args) {
      const group = resolveGroupId(store.get(), args?.group);
      await commit(withGroupActive(store.get(), group, args?.active !== false));
      return snapshotState(store.get());
    },
  };

  // ── 4) skill_toggles_* tools (shared registry) ──────────────────────────
  // The host half must stay free of external package imports so that
  // `dsh plugin add` alone works (Node resolves the plugin's imports from
  // the linked source directory, which has no node_modules). The compact
  // parameter/value specs below are converted to raw JSON schema locally.
  /** Convert the compact parameter spec to a raw JSON-schema object root. */
  function parameterSchema(spec) {
    const properties = {};
    const required = [];
    for (const [name, field] of Object.entries(spec ?? {})) {
      const { required: isRequired, ...rest } = field;
      properties[name] = rest;
      if (isRequired) required.push(name);
    }
    return {
      type: 'object',
      additionalProperties: false,
      properties,
      ...(required.length > 0 ? { required } : {}),
    };
  }

  /** Convert a compact value spec (required flags inside properties) to raw JSON schema. */
  function valueSchema(spec) {
    if (spec === undefined) return undefined;
    const convert = (node) => {
      if (node === null || typeof node !== 'object' || Array.isArray(node)) return node;
      const out = {};
      const required = [];
      for (const [key, value] of Object.entries(node)) {
        if (key === 'required' && value === true) continue; // hoisted to this level
        if (key === 'properties' && typeof value === 'object') {
          out.properties = {};
          for (const [pname, pnode] of Object.entries(value)) {
            if (pnode !== null && typeof pnode === 'object' && pnode.required === true) {
              required.push(pname);
              const { required: _drop, ...rest } = pnode;
              out.properties[pname] = convert(rest);
            } else {
              out.properties[pname] = convert(pnode);
            }
          }
        } else if (key === 'items' && typeof value === 'object') {
          out.items = convert(value);
        } else {
          out[key] = value;
        }
      }
      if (required.length > 0) out.required = required;
      return out;
    };
    return convert(spec);
  }

  const toolDisposers = [];
  const tool = (definition) => {
    toolDisposers.push(ctx.tools.register({
      ...definition,
      parameters: parameterSchema(definition.parameters),
      ...(definition.output !== undefined
        ? { output: { ...definition.output, schema: valueSchema(definition.output.schema) } }
        : {}),
    }));
  };

  const skillRowSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', required: true },
      description: { type: 'string', required: true },
      enabled: { type: 'boolean', required: true },
      enabledBy: { type: 'array', required: true, items: { type: 'string' } },
      origin: { type: 'string', required: true },
      builtin: { type: 'boolean', required: true, description: 'true = the skill ships with the application itself (install directory or packaged `bundled` source); these are exactly the members of a `scope: "builtin"` group.' },
      modelInvocable: { type: 'boolean', required: true },
      userInvocable: { type: 'boolean', required: true },
    },
  };

  const groupSchema = {
    type: 'string',
    description: 'Group id or display name (empty/omitted = the default group).',
  };

  /** Group snapshot row shared by the mutation tools' outputs. */
  const groupRowSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string', required: true },
      name: { type: 'string', required: true },
      all: { type: 'boolean', required: true, description: 'true = wildcard group: enables every skill except `except`; false = enables exactly `enabled` (or the catalog-scoped membership when `scope` is set).' },
      scope: { type: 'string', required: true, description: '"" = membership by name lists; "builtin" = membership derived from the live catalog (the skills that ship with the application).' },
      enabled: { type: 'array', required: true, items: { type: 'string' } },
      except: { type: 'array', required: true, items: { type: 'string' } },
    },
  };
  /** Group snapshot row + activation flag. */
  const groupActiveRowSchema = {
    ...groupRowSchema,
    properties: { ...groupRowSchema.properties, active: { type: 'boolean', required: true } },
  };
  /** The common snapshot output shape. */
  const snapshotOutputSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      groups: { type: 'array', required: true, items: groupRowSchema },
      activeGroups: { type: 'array', required: true, items: { type: 'string' } },
    },
  };

  tool({
    name: 'skill_toggles_list',
    description: 'List every skill visible to live sessions with its effective enabled flag, the groups and active groups (whitelist semantics: each group only contributes the skills it enables; a skill is usable when at least one ACTIVE group enables it — the effective set is the union over active groups, and with no active group nothing is usable).',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          skills: { type: 'array', required: true, items: skillRowSchema },
          enabled: { type: 'array', required: true, items: { type: 'string' } },
          groups: { type: 'array', required: true, items: groupActiveRowSchema },
          activeGroups: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute() {
      const skills = await api.skillsList();
      const state = store.get();
      const snap = snapshotState(state);
      const active = new Set(snap.activeGroups);
      const membership = { builtin: new Set(skills.filter((row) => row.builtin).map((row) => row.name)) };
      return {
        skills,
        enabled: effectiveEnabledList(state, skills.map((row) => row.name), membership),
        groups: snap.groups.map((entry) => ({ ...entry, active: active.has(entry.id) })),
        activeGroups: snap.activeGroups,
      };
    },
  });

  tool({
    name: 'skill_toggles_disable',
    description: 'Disable one skill by name in one group (default group if omitted): the skill leaves THAT group\'s enable set (a wildcard group records it as an exception). It disappears from the model catalog (next request turn), the composer "/" menu, and the skill tool refuses it — unless another ACTIVE group still enables it (groups never disable each other\'s skills). Persists across restarts.',
    parameters: {
      skill: { type: 'string', required: true, description: 'Exact skill name (kebab-case).' },
      group: groupSchema,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          skill: { type: 'string', required: true },
          group: { type: 'string', required: true },
          enabled: { type: 'boolean', required: true },
        },
      },
      render: (args) => [{ type: 'text', text: `Skill "${args.skill}" disabled in group "${args.group ?? 'default'}".` }],
    },
    async execute(args) {
      return api.disable(args);
    },
  });

  tool({
    name: 'skill_toggles_enable',
    description: 'Enable one skill inside one group (default group if omitted) by adding it to that group\'s enable set (or clearing the wildcard group\'s exception). If the group is ACTIVE the skill becomes usable immediately, regardless of what other groups do.',
    parameters: {
      skill: { type: 'string', required: true, description: 'Exact skill name (kebab-case).' },
      group: groupSchema,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          skill: { type: 'string', required: true },
          group: { type: 'string', required: true },
          enabled: { type: 'boolean', required: true },
        },
      },
      render: (args) => [{ type: 'text', text: `Skill "${args.skill}" enabled in group "${args.group ?? 'default'}".` }],
    },
    async execute(args) {
      return api.enable(args);
    },
  });

  tool({
    name: 'skill_toggles_enable_all',
    description: 'Re-enable every skill at once: without `group` EVERY group becomes a wildcard that enables everything AND all groups are activated (with no active group nothing would be usable); with `group` only that group is set to enable everything.',
    parameters: {
      group: groupSchema,
    },
    output: {
      schema: snapshotOutputSchema,
      render: () => [{ type: 'text', text: 'All skills enabled.' }],
    },
    async execute(args) {
      return api.enableAll(args);
    },
  });

  tool({
    name: 'skill_toggles_disable_all',
    description: 'Make one group (default group if omitted) enable nothing: its enable set becomes empty. Other groups are untouched — skills another ACTIVE group enables stay usable.',
    parameters: {
      group: groupSchema,
    },
    output: {
      schema: snapshotOutputSchema,
      render: (args) => [{ type: 'text', text: `Group "${args.group ?? 'default'}" now enables nothing.` }],
    },
    async execute(args) {
      return api.disableAll(args);
    },
  });

  tool({
    name: 'skill_toggles_source_set',
    description: 'Add or remove every skill of one source origin (e.g. "plugin:dsh-ppt", "user", "project", "custom", "other") from one group\'s enable set (default group if omitted).',
    parameters: {
      origin: { type: 'string', required: true, description: 'Source key as reported by skill_toggles_list rows (origin field).' },
      group: groupSchema,
      disabled: { type: 'boolean', required: true, description: 'true = remove that origin\'s skills from the group\'s enable set, false = add them to it.' },
    },
    output: {
      schema: snapshotOutputSchema,
      render: (args) => [{ type: 'text', text: `Origin "${args.origin}" ${args.disabled === false ? 'enabled' : 'disabled'} in group "${args.group ?? 'default'}".` }],
    },
    async execute(args) {
      return api.sourceSet(args);
    },
  });

  tool({
    name: 'skill_toggles_group_create',
    description: 'Create a new skill group (starts active as an EMPTY whitelist: it enables nothing until skills are enabled inside it, and it never disables skills owned by other groups). With scope="builtin" the group instead owns the skills that ship with the application itself — membership is re-derived from the live catalog, so newly packaged skills join it automatically.',
    parameters: {
      name: { type: 'string', required: true, description: 'Display name for the new group.' },
      scope: { type: 'string', enum: ['builtin'], description: 'Omit for a normal name-list group. "builtin" = catalog-derived membership (the application-shipped skills).' },
    },
    output: {
      schema: snapshotOutputSchema,
      render: (args) => [{ type: 'text', text: `Group "${args.name}" created (active${args.scope === 'builtin' ? ', owns the application-shipped skills' : ', enables nothing yet'}).` }],
    },
    async execute(args) {
      return api.groupCreate(args);
    },
  });

  tool({
    name: 'skill_toggles_group_delete',
    description: 'Delete a skill group by id or name (the default group cannot be deleted).',
    parameters: {
      group: { ...groupSchema, required: true },
    },
    output: {
      schema: snapshotOutputSchema,
      render: (args) => [{ type: 'text', text: `Group "${args.group}" deleted.` }],
    },
    async execute(args) {
      return api.groupDelete(args);
    },
  });

  tool({
    name: 'skill_toggles_group_set_active',
    description: 'Activate or deactivate one skill group: only ACTIVE groups contribute their enable sets; the effective enabled set is the union over active groups, so activating a group can only ADD usable skills, and deactivating EVERY group makes every skill unusable.',
    parameters: {
      group: { ...groupSchema, required: true },
      active: { type: 'boolean', required: true, description: 'true = group in effect, false = group ignored.' },
    },
    output: {
      schema: snapshotOutputSchema,
      render: (args) => [{ type: 'text', text: `Group "${args.group}" ${args.active ? 'activated' : 'deactivated'}.` }],
    },
    async execute(args) {
      return api.groupSetActive(args);
    },
  });

  // ── 5) RPC surface for the browser half ─────────────────────────────────
  const rpcMethods = {
    'skillToggles.state.get': async () => api.stateGet(),
    'skillToggles.skills.list': async () => api.skillsList(),
    'skillToggles.disable': async (args) => api.disable(args),
    'skillToggles.enable': async (args) => api.enable(args),
    'skillToggles.enableAll': async (args) => api.enableAll(args),
    'skillToggles.disableAll': async (args) => api.disableAll(args),
    'skillToggles.sourceSet': async (args) => api.sourceSet(args),
    'skillToggles.group.create': async (args) => api.groupCreate(args),
    'skillToggles.group.rename': async (args) => api.groupRename(args),
    'skillToggles.group.delete': async (args) => api.groupDelete(args),
    'skillToggles.group.setActive': async (args) => api.groupSetActive(args),
  };

  async function readJsonBody(req) {
    const chunks = [];
    let received = 0;
    for await (const chunk of req) {
      received += chunk.byteLength;
      if (received > MAX_RPC_BODY_BYTES) throw new Error('request body too large');
      chunks.push(chunk);
    }
    if (chunks.length === 0) return {};
    const text = Buffer.concat(chunks).toString('utf8');
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('request body must be a JSON object');
    }
    return parsed;
  }

  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(body);
  }

  let webRegistered = false;
  const registerWebSurface = () => {
    if (webRegistered) return;
    const webServer = ctx.get(WEB_SERVER_KEYS[0]) ?? ctx.get(WEB_SERVER_KEYS[1]);
    if (webServer === undefined) return;
    webRegistered = true;
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: RPC_PATH,
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req);
          const method = body.method;
          const handler = typeof method === 'string' ? rpcMethods[method] : undefined;
          if (handler === undefined) {
            sendJson(res, 400, { ok: false, error: `unknown method ${JSON.stringify(method)}` });
            return;
          }
          const value = await handler(body.args ?? {});
          sendJson(res, 200, { ok: true, value });
        } catch (error) {
          sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
      },
    }), 'dsh-skill-toggles: rpc route');
  };
  registerWebSurface();
  ctx.on('internal/service', (serviceName) => {
    if (WEB_SERVER_KEYS.includes(serviceName)) registerWebSurface();
  });

  // ── 6) legacy plugin detection (mutual exclusion warning) ───────────────
  // Two stacked shadow providers have uncontrolled combined semantics; the
  // legacy group manager is a whitelist filter and must not coexist. Warn
  // once at startup — never auto-unmount another plugin.
  function detectLegacyPlugin() {
    for (const entry of ctx.loader.entries()) {
      if (entry.options?.name === LEGACY_PLUGIN_NAME) {
        ctx.logger.warn(
          `dsh-skill-toggles: detected "${LEGACY_PLUGIN_NAME}" in this profile. The two plugins are mutually exclusive (stacked shadow providers have uncontrolled semantics); uninstall the legacy group manager for predictable skill filtering.`,
        );
        return;
      }
    }
  }
  detectLegacyPlugin();

  // ── 7) apply to live agents + lifecycle wiring ──────────────────────────
  // Shadow providers are registered on AGENT fibers (they must live as long
  // as the agent), so they are NOT auto-disposed with this plugin fiber. On
  // plugin unload/reload (HMR) dispose them explicitly — otherwise a reload
  // would hit duplicate provider names in the agent layer.
  ctx.effect(() => () => {
    for (const dispose of toolDisposers) dispose();
    toolDisposers.length = 0;
    for (const { dispose } of shadowControls.values()) dispose();
    shadowControls.clear();
    shadowAttributions.clear();
    if (notifyTimer !== null) {
      clearTimeout(notifyTimer);
      notifyTimer = null;
    }
  }, 'dsh-skill-toggles: agent-layer cleanup');

  // Any catalog change — a plugin install/remove, a bundle enable/disable, a
  // hand-edited skill file, a provider registration — drops the browser
  // halves' cached '/' menus and refreshes the panel, so a skill whose plugin
  // is gone never lingers in the UI until the next toggle or page reload.
  // Guarded: an older host that does not expose `skills/change` to plugins
  // keeps the previous (toggle-triggered) invalidation behavior instead of
  // failing the whole apply().
  try {
    ctx.on('skills/change', scheduleClientNotify);
  } catch (error) {
    ctx.logger?.warn?.(`dsh-skill-toggles: cannot watch skills/change (${String(error)}); catalog changes will only invalidate client caches after a toggle`);
  }

  for (const agent of ctx.agents.list()) applyAgentFilter(agent);

  ctx.on('agent/created', ({ agent }) => {
    applyAgentFilter(agent);
  });

  ctx.on('agent/disposed', ({ agent }) => {
    shadowControls.delete(agent.id);
    shadowAttributions.delete(agent.id);
  });
}
