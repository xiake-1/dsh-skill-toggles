/**
 * dsh-skill-toggles — host half.
 *
 * A bundle plugin (installed via `dsh plugin --profile <p> add <path>`; the
 * cordis.patch.yml row mounts it into the host composition). Blacklist
 * semantics: EVERY skill is usable unless explicitly disabled; a fresh
 * install, a missing state file, or a corrupt state file all mean "allow
 * everything" — never the whitelist plugin's "everything vanished" failure.
 *
 * It provides:
 *
 *  1. State model & persistence — a plugin-owned state file
 *     (`<harness home>/dsh-skill-toggles/state.json`, atomic write; the
 *     directory is removed together with the plugin via the package's
 *     `postuninstall` script). State: `{ disabled: string[] }`.
 *  2. Skill filtering — a per-agent shadow skill provider
 *     (`skill-toggles-filter`) registered on `agent.ctx` at `agent/created`.
 *     Its list() emits ONLY the disabled names that exist in that agent's
 *     live catalog, each with invocation rewritten to
 *     { modelInvocable: false, userInvocable: false } and rank 0 (within one
 *     layer the rank decides duplicates, and every filesystem root ranks
 *     100..500, so the shadow entry wins outright; the nearest layer wins
 *     across layers, so registering on the agent layer also covers
 *     agent-plane user/project skills). Enabled skills are NOT re-emitted:
 *     they keep their original candidates, so `path` previews and body
 *     loading stay with the real provider. The registry merge removes the
 *     disabled skills from the model `<available_skills>` catalog (next
 *     request turn — the model-side projection is persistent by design) and
 *     the `skill` tool's isModelInvocable gate refuses them.
 *  3. Composer '/' menu refresh — the client (`dsh-client-ui-skill`) caches
 *     the catalog per session and drops one entry on the forwarded Host
 *     event `agent-preset/selected` (the only lightweight invalidation in
 *     the forwarded-event allowlist; `skills/change` is Host-local). After
 *     every toggle we invalidate every shadow provider (clears the skill
 *     registry collect cache) AND emit `agent-preset/selected` for every
 *     live session, so the very next '/' open re-fetches `skills/list` and
 *     reflects the change (sub-second).
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
  disabledNames,
  mergeCatalog,
  snapshotState,
  withAllEnabled,
  withDisabled,
  withEnabled,
} from './state.js';
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

  // Per-apply runtime bookkeeping (all plain data, no live objects).
  /** agent.id -> { control, dispose } of the shadow provider registration. */
  const shadowControls = new Map();
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
            // blacklist can suppress agent-plane skills too.
            const byName = new Map();
            for (const skill of await ctx.skills.list({ cwd: options.cwd, signal: options.signal })) {
              byName.set(skill.name, skill);
            }
            const raw = await skills.list({ cwd: options.cwd, signal: options.signal, scope: agent });
            for (const skill of raw) {
              if (!byName.has(skill.name)) byName.set(skill.name, skill);
            }
            // Blacklist emission: only disabled names that actually exist.
            // Unknown names are skipped silently (skill renames never error
            // and never inject phantom entries). Enabled skills are left to
            // their real providers — path previews, resource bases, and body
            // loading keep full fidelity.
            const disabled = disabledNames(store.get());
            const out = [];
            for (const skillName of disabled) {
              const skill = byName.get(skillName);
              if (skill === undefined) continue;
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
                locator: skillName, // opaque handle, passed back to get()
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

  /**
   * Drop the browser halves' per-session catalog caches. The forwarded-event
   * allowlist has no skills entry; `agent-preset/selected` is the one
   * lightweight invalidation both `dsh-client-ui-skill` (catalog cache) and
   * `dsh-client-ui-commands` (command directory) consume, keyed by sessionId.
   * The second argument is the session's current preset (both remote
   * consumers ignore it; the declared signature requires a string).
   */
  function notifyClients() {
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
      const all = await skills.list({
        cwd: agent.session?.header?.cwd,
        scope: agent,
      });
      for (const skill of all) if (!byName.has(skill.name)) byName.set(skill.name, skill);
    }
    if (byName.size === 0) {
      // No live agents (or none resolve skills): fall back to the host view.
      for (const skill of await ctx.skills.list()) if (!byName.has(skill.name)) byName.set(skill.name, skill);
    }
    return mergeCatalog([...byName.values()], store.get());
  }

  function requireSkillName(args) {
    const skill = typeof args?.skill === 'string' ? args.skill.trim() : '';
    if (skill.length === 0) throw new Error('skill must be a non-empty string');
    return skill;
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
      await withWriteLock(async () => {
        const next = withDisabled(store.get(), skill);
        if (next !== store.get()) {
          await store.update({ disabled: next.disabled });
          applyStateEffects();
        }
      });
      return { skill, enabled: false };
    },
    async enable(args) {
      const skill = requireSkillName(args);
      await withWriteLock(async () => {
        const next = withEnabled(store.get(), skill);
        if (next !== store.get()) {
          await store.update({ disabled: next.disabled });
          applyStateEffects();
        }
      });
      return { skill, enabled: true };
    },
    async enableAll() {
      await withWriteLock(async () => {
        const next = withAllEnabled(store.get());
        if (next !== store.get()) {
          await store.update({ disabled: next.disabled });
          applyStateEffects();
        }
      });
      return { disabled: [] };
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
      modelInvocable: { type: 'boolean', required: true },
      userInvocable: { type: 'boolean', required: true },
    },
  };

  tool({
    name: 'skill_toggles_list',
    description: 'List every skill visible to live sessions with its effective enabled flag (blacklist semantics: everything is enabled unless explicitly disabled).',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          skills: { type: 'array', required: true, items: skillRowSchema },
          disabled: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute() {
      const skills = await api.skillsList();
      return { skills, disabled: snapshotState(store.get()).disabled };
    },
  });

  tool({
    name: 'skill_toggles_disable',
    description: 'Disable one skill by name: it leaves the model catalog (next request turn), the composer "/" menu, and the skill tool refuses it. Persists across restarts.',
    parameters: {
      skill: { type: 'string', required: true, description: 'Exact skill name (kebab-case).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          skill: { type: 'string', required: true },
          enabled: { type: 'boolean', required: true },
        },
      },
      render: (args) => [{ type: 'text', text: `Skill "${args.skill}" disabled.` }],
    },
    async execute(args) {
      return api.disable(args);
    },
  });

  tool({
    name: 'skill_toggles_enable',
    description: 'Enable one previously disabled skill by name.',
    parameters: {
      skill: { type: 'string', required: true, description: 'Exact skill name (kebab-case).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          skill: { type: 'string', required: true },
          enabled: { type: 'boolean', required: true },
        },
      },
      render: (args) => [{ type: 'text', text: `Skill "${args.skill}" enabled.` }],
    },
    async execute(args) {
      return api.enable(args);
    },
  });

  tool({
    name: 'skill_toggles_enable_all',
    description: 'Re-enable every disabled skill at once (clears the blacklist).',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          disabled: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: () => [{ type: 'text', text: 'All skills enabled.' }],
    },
    async execute() {
      return api.enableAll();
    },
  });

  // ── 5) RPC surface for the browser half ─────────────────────────────────
  const rpcMethods = {
    'skillToggles.state.get': async () => api.stateGet(),
    'skillToggles.skills.list': async () => api.skillsList(),
    'skillToggles.disable': async (args) => api.disable(args),
    'skillToggles.enable': async (args) => api.enable(args),
    'skillToggles.enableAll': async () => api.enableAll(),
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
  }, 'dsh-skill-toggles: agent-layer cleanup');

  for (const agent of ctx.agents.list()) applyAgentFilter(agent);

  ctx.on('agent/created', ({ agent }) => {
    applyAgentFilter(agent);
  });

  ctx.on('agent/disposed', ({ agent }) => {
    shadowControls.delete(agent.id);
  });
}
