/**
 * dsh-skill-toggles — client half (browser).
 *
 * A bundle-plugin client half: a classic script in the client-modules format
 * (`window.__ModuleLoader__.load({ id, factory })`). The factory is CJS-style
 * and may require only platform seed words (`react`); everything else is
 * self-contained. The exports are the Cordis plugin face: `{ apply, inject }`.
 *
 * UI: a left-docked floating panel registered in the additive `shell.overlay`
 * slot (root scope) plus a toggle button in `conversation.session.header.actions`
 * (session scope). The panel lists every skill visible to live sessions with
 * an on/off switch and a name/description search, calling the host RPC route
 * `POST /plugins/dsh-skill-toggles/rpc` (bundle plugins have no
 * `harness.handle`/`host.call`; the host serves the business logic over one
 * JSON POST route with body { method, args } → { ok, value } | { ok: false,
 * error }).
 *
 * Interaction model: loading / empty / error states; optimistic local updates
 * with rollback on RPC failure; busy gating; localStorage remembers the open
 * state; the header button and the panel sync through a window event. The
 * host pushes composer-menu invalidation itself (agent-preset/selected), so
 * the panel never needs to poll.
 *
 * Lifecycle: every side effect is fiber-scoped — locale dictionaries and the
 * stylesheet are installed through ctx.effect (disposed on unload), slot
 * registrations go through ctx.slots.inject/register (fiber-owned), and all
 * component effects (measurement, storage, event listeners) return cleanups.
 * No live data is serialized: only plain JSON from the RPC route.
 */
window.__ModuleLoader__.load({
  id: 'dsh-skill-toggles',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    let react = require('react');
    const h = react.createElement;

    // ── constants ──────────────────────────────────────────────────────────
    const PANEL_WIDTH = 340;
    const PANEL_DOCK_TOP = 64;
    const PANEL_DOCK_LEFT = 18;
    const PANEL_DOCK_BOTTOM = 48;
    const PANEL_COMPACT_BREAKPOINT = 960;
    const STORAGE_KEY = 'dsh-skill-toggles:panel:v1';
    const TOGGLE_EVENT = 'skill-toggles:toggle-panel';
    const RPC_PATH = '/plugins/dsh-skill-toggles/rpc';

    // ── dictionaries ────────────────────────────────────────────────────────
    const zh = {
      'panel.title': '技能开关',
      'panel.aria': '技能开关面板',
      'panel.collapse': '收起面板',
      'toggle.aria': '切换技能开关面板',
      'toggle.title': '技能开关',
      'toggle.label': '技能开关',
      'state.loading': '加载中…',
      'state.retry': '重试',
      'search.placeholder': '搜索技能…',
      'list.empty': '没有可见技能。',
      'list.noMatch': '没有匹配的技能。',
      'summary.enabled': '{enabled}/{total} 已启用',
      'action.enableAll': '全部启用',
      'skill.enable': '启用 {name}',
      'skill.disable': '禁用 {name}',
      'skill.modelOnly': '仅模型',
      'skill.userOnly': '仅用户',
      'note.title': '黑名单语义：默认全部可用，仅关闭的被过滤；改动在下一条消息与下次打开 / 菜单时生效。',
    };
    const en = {
      'panel.title': 'Skill toggles',
      'panel.aria': 'Skill toggles panel',
      'panel.collapse': 'Collapse panel',
      'toggle.aria': 'Toggle the skill toggles panel',
      'toggle.title': 'Skill toggles',
      'toggle.label': 'Skills',
      'state.loading': 'Loading…',
      'state.retry': 'Retry',
      'search.placeholder': 'Search skills…',
      'list.empty': 'No visible skills.',
      'list.noMatch': 'No matching skills.',
      'summary.enabled': '{enabled}/{total} enabled',
      'action.enableAll': 'Enable all',
      'skill.enable': 'Enable {name}',
      'skill.disable': 'Disable {name}',
      'skill.modelOnly': 'model-only',
      'skill.userOnly': 'user-only',
      'note.title': 'Blacklist semantics: everything is usable unless disabled; changes land on the next message and the next "/" menu open.',
    };

    /** Fallback translator when the framework `t` prop is unavailable. */
    function dictFor() {
      const lang = (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang) || 'en';
      return lang.toLowerCase().startsWith('zh') ? zh : en;
    }
    function makeT(t) {
      if (typeof t === 'function') return t;
      const dict = dictFor();
      return (key, params) => {
        let text = dict[key] ?? key;
        if (params !== undefined) {
          for (const [name, value] of Object.entries(params)) {
            text = text.split(`{${name}}`).join(String(value));
          }
        }
        return text;
      };
    }

    // ── RPC client ─────────────────────────────────────────────────────────
    async function rpc(method, args) {
      const res = await fetch(RPC_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, args: args ?? {} }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || `RPC ${method} failed`);
      return data.value;
    }
    function errorMessage(error) {
      return error instanceof Error ? error.message : String(error);
    }

    // ── icons (inline SVG, currentColor) ───────────────────────────────────
    function ToggleIcon({ size }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: '1.3', strokeLinecap: 'round', 'aria-hidden': true },
        h('path', { d: 'M2 4.5h8M12.5 4.5H14M2 11.5h4M8.5 11.5H14' }),
        h('circle', { cx: '11.5', cy: '4.5', r: '1.8' }),
        h('circle', { cx: '6.5', cy: '11.5', r: '1.8' }),
      );
    }
    function ChevronIcon({ size, direction }) {
      const paths = {
        left: 'M10 3L7 6l3 3',
        right: 'M6 3l3 3-3 3',
        down: 'M3 6l3 3 3-3',
        up: 'M3 9l3-3 3 3',
      };
      const d = paths[direction] ?? paths.left;
      return h('svg', { width: size, height: size, viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d }),
      );
    }

    // ── geometry ───────────────────────────────────────────────────────────
    function initialBounds() {
      if (typeof window === 'undefined') return { width: 1440, height: 900, anchorLeft: 0 };
      return { width: window.innerWidth, height: window.innerHeight, anchorLeft: 0 };
    }
    function readStoredOpen() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw === null) return false;
        const parsed = JSON.parse(raw);
        return parsed.open === true;
      } catch {
        return false;
      }
    }
    function resolveGeometry(bounds) {
      const compact = bounds.width <= PANEL_COMPACT_BREAKPOINT;
      if (compact) {
        return {
          x: 12,
          y: 12,
          width: Math.max(160, Math.min(PANEL_WIDTH, bounds.width - 24)),
          height: Math.max(120, bounds.height - 24),
          compact: true,
        };
      }
      const maxX = Math.max(12, bounds.width - PANEL_WIDTH - 12);
      const x = Math.min(Math.max(bounds.anchorLeft + PANEL_DOCK_LEFT, 12), maxX);
      return {
        x,
        y: PANEL_DOCK_TOP,
        width: PANEL_WIDTH,
        height: Math.max(120, bounds.height - PANEL_DOCK_TOP - PANEL_DOCK_BOTTOM),
        compact: false,
      };
    }

    // ── selection logic (pure; exported as __logic for unit tests) ─────────
    /** Filter skill rows by the query (name or description, case-insensitive). */
    function filterRows(rows, query) {
      const q = query.trim().toLowerCase();
      if (q.length === 0) return rows;
      return rows.filter((row) =>
        row.name.toLowerCase().includes(q)
        || (row.description ?? '').toLowerCase().includes(q));
    }

    // ── one skill row ───────────────────────────────────────────────────────
    function SkillRow({ t, row, busy, onToggle }) {
      const restriction = !row.userInvocable && row.modelInvocable
        ? t('skill.modelOnly')
        : row.userInvocable && !row.modelInvocable
          ? t('skill.userOnly')
          : null;
      return h('div', { className: 'st-row', 'data-disabled': !row.enabled || undefined },
        h('div', { className: 'st-row-main' },
          h('span', { className: 'st-row-name', title: row.name }, row.name),
          row.description !== '' && h('span', { className: 'st-row-desc', title: row.description }, row.description),
        ),
        restriction !== null && h('span', { className: 'st-row-badge' }, restriction),
        h('button', {
          type: 'button',
          role: 'switch',
          'aria-checked': row.enabled,
          className: 'st-switch',
          'data-on': row.enabled || undefined,
          onClick: () => onToggle(row.name, !row.enabled),
          'aria-label': t(row.enabled ? 'skill.disable' : 'skill.enable', { name: row.name }),
          title: t(row.enabled ? 'skill.disable' : 'skill.enable', { name: row.name }),
          disabled: busy,
        }),
      );
    }

    // ── panel root (shell.overlay entry) ────────────────────────────────────
    function TogglesPanel(props) {
      const t = makeT(props.t);
      const [open, setOpen] = react.useState(readStoredOpen);
      const [status, setStatus] = react.useState('loading');
      const [loadError, setLoadError] = react.useState(null);
      const [rows, setRows] = react.useState([]);
      const [query, setQuery] = react.useState('');
      const [opError, setOpError] = react.useState(null);
      const [busy, setBusy] = react.useState(false);
      const [bounds, setBounds] = react.useState(initialBounds);
      const wasOpen = react.useRef(open);

      const load = react.useCallback(async (silent) => {
        if (!silent) { setStatus('loading'); setLoadError(null); }
        try {
          const skills = await rpc('skillToggles.skills.list', {});
          setRows(skills ?? []);
          if (!silent) setStatus('ready');
        } catch (error) {
          const message = errorMessage(error);
          if (silent) setOpError(message);
          else { setLoadError(message); setStatus('error'); }
        }
      }, []);

      /** Optimistic mutate: apply locally, call RPC, re-align; roll back on failure. */
      const mutate = async (method, args, optimistic) => {
        setOpError(null);
        setBusy(true);
        const prev = rows;
        if (optimistic !== undefined) optimistic();
        try {
          await rpc(method, args);
          await load(true);
        } catch (error) {
          setRows(prev);
          setOpError(errorMessage(error));
        } finally {
          setBusy(false);
        }
      };
      const toggleSkill = (name, enabled) => mutate(enabled ? 'skillToggles.enable' : 'skillToggles.disable', { skill: name }, () => {
        setRows((prev) => prev.map((row) => (row.name === name ? { ...row, enabled } : row)));
      });
      const enableAll = () => mutate('skillToggles.enableAll', {}, () => {
        setRows((prev) => prev.map((row) => ({ ...row, enabled: true })));
      });

      // initial load
      react.useEffect(() => { load(false); }, [load]);
      // refresh when the panel re-opens (host state may have changed via tools)
      react.useEffect(() => {
        if (open && !wasOpen.current) load(true);
        wasOpen.current = open;
      }, [open, load]);
      // persist open state
      react.useEffect(() => {
        try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ open })); } catch { /* ignore */ }
      }, [open]);
      // header toggle button sync
      react.useEffect(() => {
        const onToggle = () => setOpen((current) => !current);
        window.addEventListener(TOGGLE_EVENT, onToggle);
        return () => window.removeEventListener(TOGGLE_EVENT, onToggle);
      }, []);

      // Measure the dock anchor ONCE on mount (no observers, no resize
      // listeners): the toggle and panel keep a fixed position for the page
      // lifetime instead of jumping when the conversation column resizes.
      react.useLayoutEffect(() => {
        const overlay = document.querySelector('[data-shell-overlay]');
        if (overlay === null) return;
        const conversation = document.querySelector("[data-phase='active']");
        const overlayRect = overlay.getBoundingClientRect();
        const conversationRect = conversation?.getBoundingClientRect();
        const next = {
          width: overlayRect.width,
          height: overlayRect.height,
          anchorLeft: conversationRect === undefined
            ? 0
            : Math.min(Math.max(conversationRect.left - overlayRect.left, 0), overlayRect.width),
        };
        setBounds((prev) => (prev.width === next.width && prev.height === next.height && prev.anchorLeft === next.anchorLeft ? prev : next));
      }, []);

      if (!open) return null;

      const geometry = resolveGeometry(bounds);
      const compact = geometry.compact;
      const visible = filterRows(rows, query);
      const enabledCount = rows.reduce((count, row) => count + (row.enabled ? 1 : 0), 0);
      const disabledCount = rows.length - enabledCount;
      return h('aside', {
        className: 'st-panel',
        'data-skill-toggles-panel': true,
        'data-compact': compact || undefined,
        style: { left: geometry.x, top: geometry.y, width: geometry.width, height: geometry.height },
        'aria-label': t('panel.aria'),
      },
        h('header', { className: 'st-panel-head' },
          h('span', { className: 'st-panel-title' }, h(ToggleIcon, { size: 15 }), t('panel.title')),
          h('div', { className: 'st-panel-controls' },
            h('button', {
              type: 'button',
              className: 'st-icon-button',
              onClick: () => setOpen(false),
              'aria-label': t('panel.collapse'),
              title: t('panel.collapse'),
            }, h(ChevronIcon, { size: 12, direction: 'left' })),
          ),
        ),
        h('div', { className: 'st-body' },
          status === 'loading'
            ? h('div', { className: 'st-loading' }, t('state.loading'))
            : status === 'error'
              ? h('div', { className: 'st-error' },
                  h('div', { className: 'st-error-text' }, loadError),
                  h('button', { type: 'button', className: 'st-button', onClick: () => load(false) }, t('state.retry')),
                )
              : h(react.Fragment, null,
                  opError !== null && h('div', { className: 'st-op-error' }, opError),
                  h('div', { className: 'st-summary' },
                    h('span', { className: 'st-summary-count' }, t('summary.enabled', { enabled: enabledCount, total: rows.length })),
                    disabledCount > 0 && h('button', {
                      type: 'button',
                      className: 'st-button st-button-mini st-button-primary',
                      disabled: busy,
                      onClick: enableAll,
                    }, t('action.enableAll')),
                  ),
                  h('input', {
                    className: 'st-input',
                    value: query,
                    placeholder: t('search.placeholder'),
                    onChange: (event) => setQuery(event.target.value),
                  }),
                  rows.length === 0
                    ? h('div', { className: 'st-empty' }, t('list.empty'))
                    : visible.length === 0
                      ? h('div', { className: 'st-empty' }, t('list.noMatch'))
                      : h('div', { className: 'st-list' },
                          visible.map((row) => h(SkillRow, { key: row.name, t, row, busy, onToggle: toggleSkill })),
                        ),
                  h('div', { className: 'st-note' }, t('note.title')),
                ),
        ),
      );
    }

    // ── header toggle button (conversation.session.header.actions entry) ───
    function PanelToggleButton(props) {
      const t = makeT(props.t);
      return h('button', {
        type: 'button',
        className: 'st-toggle',
        'aria-label': t('toggle.aria'),
        title: t('toggle.title'),
        onClick: () => { window.dispatchEvent(new CustomEvent(TOGGLE_EVENT)); },
      }, h(ToggleIcon, { size: 14 }), h('span', { className: 'st-toggle-label' }, t('toggle.label')));
    }

    // ── stylesheet (fiber-scoped) ───────────────────────────────────────────
    const PANEL_CSS = [
      '.st-panel{box-sizing:border-box;position:absolute;display:flex;flex-direction:column;overflow:hidden;border:1px solid color-mix(in srgb,var(--dsw-alias-line-strong,#cfd3d6) 58%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-module,#fff) 95%,transparent);backdrop-filter:blur(20px) saturate(1.08);box-shadow:0 12px 32px color-mix(in srgb,var(--dsw-alias-label-primary,#1f2329) 12%,transparent),0 32px 72px color-mix(in srgb,var(--dsw-alias-label-primary,#1f2329) 16%,transparent);border-radius:16px;color:var(--dsw-alias-label-primary,#1f2329);font-size:13px;line-height:18px;animation:st-panel-in .16s ease-out}',
      '@keyframes st-panel-in{from{opacity:0}to{opacity:1}}',
      '.st-panel-head{display:flex;align-items:center;justify-content:space-between;flex:none;min-height:44px;padding:0 10px 0 14px;border-bottom:1px solid var(--dsw-alias-line-normal,#e7e9ee)}',
      '.st-panel-title{display:inline-flex;align-items:center;gap:8px;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2329)}',
      '.st-panel-controls{display:inline-flex;align-items:center;gap:2px;flex:none}',
      '.st-icon-button{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;color:var(--dsw-alias-label-tertiary,#8a919c);background:transparent;border:0;border-radius:7px;cursor:pointer;transition:background-color .12s,color .12s}',
      '.st-icon-button:hover{background:var(--dsw-alias-bg-fill-neutral,#eef0f4);color:var(--dsw-alias-label-primary,#1f2329)}',
      '.st-body{flex:1;min-height:0;overflow-y:auto;padding:10px 12px 12px;display:flex;flex-direction:column;gap:10px}',
      '.st-loading,.st-error{display:flex;flex-direction:column;align-items:center;gap:8px;padding:24px 0;color:var(--dsw-alias-label-tertiary,#8a919c);font-size:12px}',
      '.st-error-text{color:var(--dsw-alias-state-danger,#e5484d);text-align:center}',
      '.st-op-error{color:var(--dsw-alias-state-danger,#e5484d);font-size:12px;line-height:16px}',
      '.st-empty{color:var(--dsw-alias-label-tertiary,#8a919c);font-size:12px;line-height:16px;padding:6px 0}',
      '.st-summary{display:flex;align-items:center;justify-content:space-between;gap:8px}',
      '.st-summary-count{color:var(--dsw-alias-label-secondary,#5c6470);font-size:12px;font-weight:600}',
      '.st-input{box-sizing:border-box;flex:1;min-width:0;height:30px;padding:0 8px;color:var(--dsw-alias-label-primary,#1f2329);background:var(--dsw-alias-bg-module-platform,#f7f8fa);border:1px solid var(--dsw-alias-line-normal,#e7e9ee);border-radius:8px;font-size:12px;font-family:inherit}',
      '.st-input:focus{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:1px;border-color:transparent}',
      '.st-button{flex:none;height:30px;padding:0 12px;color:var(--dsw-alias-label-secondary,#5c6470);background:var(--dsw-alias-bg-module-platform,#f7f8fa);border:1px solid var(--dsw-alias-line-normal,#e7e9ee);border-radius:8px;font-size:12px;font-weight:600;cursor:pointer}',
      '.st-button:hover{background:var(--dsw-alias-bg-fill-neutral,#eef0f4)}',
      '.st-button:disabled{opacity:.5;cursor:default}',
      '.st-button-primary{color:var(--dsw-alias-label-on-fill,#fff);background:var(--dsw-alias-state-business-primary,#4d6bfe);border-color:transparent}',
      '.st-button-primary:hover{filter:brightness(1.06)}',
      '.st-button-mini{height:22px;padding:0 8px;font-size:11px;border-radius:6px}',
      '.st-list{display:flex;flex-direction:column;gap:4px}',
      '.st-row{display:flex;align-items:center;gap:8px;min-width:0;padding:7px 8px;border:1px solid var(--dsw-alias-line-normal,#e7e9ee);border-radius:10px}',
      '.st-row[data-disabled]{opacity:.62;background:var(--dsw-alias-bg-fill-neutral,#eef0f4)}',
      '.st-row-main{display:flex;flex-direction:column;flex:1;min-width:0}',
      '.st-row-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2329)}',
      '.st-row-desc{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a919c)}',
      '.st-row-badge{flex:none;padding:0 6px;border-radius:4px;font-size:10px;font-weight:600;line-height:16px;background:var(--dsw-alias-bg-fill-neutral,#eef0f4);color:var(--dsw-alias-label-tertiary,#8a919c)}',
      '.st-switch{position:relative;flex:none;width:32px;height:18px;padding:0;border:1px solid var(--dsw-alias-line-normal,#e7e9ee);border-radius:999px;background:var(--dsw-alias-bg-fill-neutral,#eef0f4);cursor:pointer;transition:background-color .12s,border-color .12s}',
      '.st-switch::after{content:"";position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);transition:transform .12s}',
      '.st-switch[data-on]{background:var(--dsw-alias-state-success-primary,#12a150);border-color:transparent}',
      '.st-switch[data-on]::after{transform:translateX(14px)}',
      '.st-switch:disabled{opacity:.5;cursor:default}',
      '.st-note{color:var(--dsw-alias-label-tertiary,#8a919c);font-size:11px;line-height:15px;padding-top:2px}',
      '.st-toggle{display:inline-flex;align-items:center;justify-content:center;gap:5px;min-height:28px;padding:3px 8px;color:var(--dsw-alias-label-tertiary,#8a919c);background:transparent;border:0;border-radius:6px;cursor:pointer}',
      '.st-toggle:hover,.st-toggle:focus-visible{color:var(--dsw-alias-label-secondary,#5c6470)}',
      '.st-toggle-label{font-size:12px;font-weight:600;white-space:nowrap}',
      '@media (prefers-reduced-motion:reduce){.st-panel{animation:none;transition:none}}',
    ].join('');

    // ── plugin face ─────────────────────────────────────────────────────────
    const inject = ['slots', 'locale'];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register('skill-toggles', { zh, en }), 'dsh-skill-toggles: dictionaries');
      ctx.effect(() => {
        if (typeof document === 'undefined') return;
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-skill-toggles';
        tag.dataset.pluginCss = 'dsh-skill-toggles/panel.css';
        tag.textContent = PANEL_CSS;
        document.head.appendChild(tag);
        return () => { tag.remove(); };
      }, 'dsh-skill-toggles: styles');
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'skill-toggles-panel',
        order: 71,
        label: 'Skill toggles',
        locale: 'skill-toggles',
      }, TogglesPanel));
      ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: 'skill-toggles-toggle',
        order: 11,
        label: 'Skill toggles',
        locale: 'skill-toggles',
      }, PanelToggleButton));
    }

    exports.apply = apply;
    exports.inject = inject;
    // Pure list logic, exported for unit tests (the browser runtime ignores
    // this extra export).
    exports.__logic = { filterRows };
    return module.exports;
  },
});
