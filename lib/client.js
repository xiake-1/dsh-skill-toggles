/**
 * dsh-skill-toggles — client half (browser).
 *
 * A bundle-plugin client half: a classic script in the client-modules format
 * (`window.__ModuleLoader__.load({ id, factory })`). The factory is CJS-style
 * and may require only platform seed words (`react`); everything else is
 * self-contained. The exports are the Cordis plugin face: `{ apply, inject }`.
 *
 * UI: a left-docked floating panel registered in the additive `shell.overlay`
 * slot (root scope) plus a toggle button in `conversation.input.left` (the
 * composer tool row, session scope). The panel manages GROUPS — each group
 * carries its own skill blacklist and an active switch; the effective state
 * is the union over the ACTIVE groups (the built-in default group starts
 * all-on and is editable). The selected group is edited in the skill list
 * below (name/description search + per-skill switches). All data flows
 * through the host RPC route `POST /plugins/dsh-skill-toggles/rpc` (bundle
 * plugins have no `harness.handle`/`host.call`; the host serves the business
 * logic over one JSON POST route with body { method, args } → { ok, value } |
 * { ok: false, error }).
 *
 * Interaction model: loading / empty / error states; optimistic local updates
 * with rollback on RPC failure; busy gating; localStorage remembers the open
 * state and the selected group; the composer button and the panel sync
 * through a window event. The host pushes composer-menu invalidation itself
 * (agent-preset/selected), so the panel never needs to poll.
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
    const PANEL_WIDTH = 360;
    const PANEL_MAX_HEIGHT = 560;
    const PANEL_DOCK_MARGIN = 24;
    const PANEL_DOCK_LEFT = 18;
    const PANEL_COMPACT_BREAKPOINT = 960;
    const STORAGE_KEY = 'dsh-skill-toggles:panel:v2';
    const TOGGLE_EVENT = 'skill-toggles:toggle-panel';
    const RPC_PATH = '/plugins/dsh-skill-toggles/rpc';
    const DEFAULT_GROUP_ID = 'default';

    // ── dictionaries ────────────────────────────────────────────────────────
    const zh = {
      'panel.title': '技能开关',
      'panel.aria': '技能开关面板',
      'panel.collapse': '收起面板',
      'toggle.aria': '切换技能开关面板',
      'toggle.title': '技能开关',
      'toggle.label': '技能',
      'state.loading': '加载中…',
      'state.retry': '重试',
      'search.placeholder': '搜索技能…',
      'list.empty': '没有可见技能。',
      'list.noMatch': '没有匹配的技能。',
      'summary.enabled': '生效：{enabled}/{total} 已启用',
      'action.enableAll': '全部启用',
      'action.disableAll': '全部禁用',
      'source.user': '用户技能',
      'source.project': '项目技能',
      'source.custom': '自定义目录',
      'source.other': '其他',
      'section.collapse': '折叠该来源',
      'section.expand': '展开该来源',
      'skill.enable': '启用 {name}',
      'skill.disable': '禁用 {name}',
      'skill.modelOnly': '仅模型',
      'skill.userOnly': '仅用户',
      'skill.disabledByOther': '被「{groups}」禁用',
      'skill.groupInactive': '本组未启用',
      'group.section': '分组',
      'group.default': '默认分组',
      'group.add': '新建分组',
      'group.addPlaceholder': '分组名称…',
      'group.confirmAdd': '创建',
      'group.cancelAdd': '取消',
      'group.activeOn': '启用分组「{name}」',
      'group.activeOff': '停用分组「{name}」',
      'group.select': '编辑分组「{name}」',
      'group.rename': '重命名分组',
      'group.delete': '删除分组「{name}」',
      'group.deleteConfirm': '确认删除？',
      'group.clear': '清空该组',
      'group.editing': '正在编辑：{name}',
      'group.count': '{count} 项启用',
      'note.title': '黑名单语义：仅被「启用中的分组」禁用的技能会被过滤（多个启用分组取并集）；改动在下一条消息与下次打开 / 菜单时生效。',
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
      'summary.enabled': 'Effective: {enabled}/{total} enabled',
      'action.enableAll': 'Enable all',
      'action.disableAll': 'Disable all',
      'source.user': 'User skills',
      'source.project': 'Project skills',
      'source.custom': 'Custom dirs',
      'source.other': 'Other',
      'section.collapse': 'Collapse this source',
      'section.expand': 'Expand this source',
      'skill.enable': 'Enable {name}',
      'skill.disable': 'Disable {name}',
      'skill.modelOnly': 'model-only',
      'skill.userOnly': 'user-only',
      'skill.disabledByOther': 'disabled by “{groups}”',
      'skill.groupInactive': 'group inactive',
      'group.section': 'Groups',
      'group.default': 'Default',
      'group.add': 'New group',
      'group.addPlaceholder': 'Group name…',
      'group.confirmAdd': 'Create',
      'group.cancelAdd': 'Cancel',
      'group.activeOn': 'Activate group “{name}”',
      'group.activeOff': 'Deactivate group “{name}”',
      'group.select': 'Edit group “{name}”',
      'group.rename': 'Rename group',
      'group.delete': 'Delete group “{name}”',
      'group.deleteConfirm': 'Confirm delete?',
      'group.clear': 'Clear group',
      'group.editing': 'Editing: {name}',
      'group.count': '{count} enabled',
      'note.title': 'Blacklist semantics: a skill is filtered only when an ACTIVE group disables it (active groups union); changes land on the next message and the next "/" menu open.',
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
    function PlusIcon({ size }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round', 'aria-hidden': true },
        h('path', { d: 'M6 2v8M2 6h8' }),
      );
    }
    function PencilIcon({ size }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', strokeWidth: '1.3', strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M8.2 1.8l2 2L4 10l-2.6.6L2 8z' }),
      );
    }
    function XIcon({ size }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round', 'aria-hidden': true },
        h('path', { d: 'M3 3l6 6M9 3l-6 6' }),
      );
    }

    // ── geometry ───────────────────────────────────────────────────────────
    function initialBounds() {
      if (typeof window === 'undefined') return { width: 1440, height: 900, anchorLeft: 0 };
      return { width: window.innerWidth, height: window.innerHeight, anchorLeft: 0 };
    }
    function readStored() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw === null) return { open: false, group: DEFAULT_GROUP_ID, collapsed: {} };
        const parsed = JSON.parse(raw);
        return {
          open: parsed.open === true,
          group: typeof parsed.group === 'string' && parsed.group.length > 0 ? parsed.group : DEFAULT_GROUP_ID,
          collapsed: parsed.collapsed !== null && typeof parsed.collapsed === 'object' ? parsed.collapsed : {},
        };
      } catch {
        return { open: false, group: DEFAULT_GROUP_ID, collapsed: {} };
      }
    }
    function resolveGeometry(bounds, anchor) {
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
      const width = Math.min(PANEL_WIDTH, Math.max(160, bounds.width - 24));
      const height = Math.max(120, Math.min(PANEL_MAX_HEIGHT, bounds.height - PANEL_DOCK_MARGIN * 2));
      if (anchor !== null && anchor !== undefined) {
        // Dock just above the clicked composer button, left-aligned with it.
        const x = Math.min(Math.max(anchor.left, 12), Math.max(12, bounds.width - width - 12));
        const y = Math.min(Math.max(anchor.bottom - height - 10, 12), Math.max(12, bounds.height - height - 12));
        return { x, y, width, height, compact: false };
      }
      // Fallback (no click anchor, e.g. restored open state at boot): left
      // dock anchored to the conversation column, vertically centered.
      const maxX = Math.max(12, bounds.width - width - 12);
      const x = Math.min(Math.max(bounds.anchorLeft + PANEL_DOCK_LEFT, 12), maxX);
      const y = Math.max(12, Math.round((bounds.height - height) / 2));
      return { x, y, width, height, compact: false };
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

    /** The effective disabled set: union over the ACTIVE groups of a snapshot. */
    function effectiveSet(state) {
      const active = new Set(state?.activeGroups ?? []);
      const out = new Set();
      for (const entry of state?.groups ?? []) {
        if (!active.has(entry.id)) continue;
        for (const name of entry.disabled) out.add(name);
      }
      return out;
    }

    /** Display name of a group (the default group localizes). */
    function groupLabel(entry, t) {
      if (entry.name.length > 0) return entry.name;
      return entry.id === DEFAULT_GROUP_ID ? t('group.default') : entry.id;
    }

    /** Display label of an origin key (plugin:<pkg> shows the package name). */
    function originLabel(origin, t) {
      if (origin === 'user') return t('source.user');
      if (origin === 'project') return t('source.project');
      if (origin === 'custom') return t('source.custom');
      if (origin === 'other') return t('source.other');
      if (origin.startsWith('plugin:')) return origin.slice('plugin:'.length);
      return origin;
    }

    /** Section order: plugin sources (alphabetical), then user, project, custom, other. */
    function compareOrigins(a, b) {
      const rank = (origin) => (origin.startsWith('plugin:') ? 0
        : origin === 'user' ? 1 : origin === 'project' ? 2 : origin === 'custom' ? 3 : 4);
      return rank(a) - rank(b) || a.localeCompare(b);
    }

    // ── one skill row ───────────────────────────────────────────────────────
    function SkillRow({ t, row, busy, onToggle }) {
      const restriction = !row.userInvocable && row.modelInvocable
        ? t('skill.modelOnly')
        : row.userInvocable && !row.modelInvocable
          ? t('skill.userOnly')
          : null;
      return h('div', { className: 'st-row', 'data-disabled': !row.groupEnabled || undefined },
        h('div', { className: 'st-row-main' },
          h('span', { className: 'st-row-name', title: row.name }, row.name),
          row.description !== '' && h('span', { className: 'st-row-desc', title: row.description }, row.description),
          row.crossBadge !== null && h('span', { className: 'st-row-badge st-row-badge-warn', title: row.crossBadge }, row.crossBadge),
        ),
        restriction !== null && h('span', { className: 'st-row-badge' }, restriction),
        h('button', {
          type: 'button',
          role: 'switch',
          'aria-checked': row.groupEnabled,
          className: 'st-switch',
          'data-on': row.groupEnabled || undefined,
          onClick: () => onToggle(row.name, !row.groupEnabled),
          'aria-label': t(row.groupEnabled ? 'skill.disable' : 'skill.enable', { name: row.name }),
          title: t(row.groupEnabled ? 'skill.disable' : 'skill.enable', { name: row.name }),
          disabled: busy,
        }),
      );
    }

    // ── one group row (active switch, select, rename, delete) ──────────────
    function GroupRow({ t, entry, total, selected, active, busy, renaming, renameDraft, pendingDelete,
      onSelect, onActive, onRenameStart, onRenameInput, onRenameCommit, onRenameCancel,
      onDeleteArm, onDeleteConfirm, onDeleteCancel }) {
      const label = groupLabel(entry, t);
      return h('div', {
        className: 'st-group',
        'data-selected': selected || undefined,
        'data-active': active || undefined,
      },
        h('button', {
          type: 'button',
          role: 'switch',
          'aria-checked': active,
          className: 'st-switch',
          'data-on': active || undefined,
          disabled: busy,
          onClick: () => onActive(entry.id, !active),
          'aria-label': t(active ? 'group.activeOff' : 'group.activeOn', { name: label }),
          title: t(active ? 'group.activeOff' : 'group.activeOn', { name: label }),
        }),
        renaming
          ? h('input', {
              className: 'st-input st-input-mini',
              value: renameDraft,
              autoFocus: true,
              disabled: busy,
              onChange: (event) => onRenameInput(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') onRenameCommit(entry.id);
                else if (event.key === 'Escape') onRenameCancel();
              },
              onBlur: () => onRenameCommit(entry.id),
              'aria-label': t('group.rename'),
            })
          : h('button', {
              type: 'button',
              className: 'st-group-name',
              onClick: () => onSelect(entry.id),
              'aria-label': t('group.select', { name: label }),
              title: t('group.select', { name: label }),
            },
              h('span', { className: 'st-group-label' }, label),
              h('span', { className: 'st-group-count' }, t('group.count', { count: Math.max(total - entry.disabled.length, 0) })),
            ),
        h('button', {
          type: 'button',
          className: 'st-icon-button',
          disabled: busy,
          onClick: () => onRenameStart(entry.id),
          'aria-label': t('group.rename'),
          title: t('group.rename'),
        }, h(PencilIcon, { size: 11 })),
        entry.id === DEFAULT_GROUP_ID
          ? null
          : pendingDelete
            ? h(react.Fragment, null,
                h('button', {
                  type: 'button',
                  className: 'st-button st-button-mini st-button-danger',
                  disabled: busy,
                  onClick: () => onDeleteConfirm(entry.id),
                }, t('group.deleteConfirm')),
                h('button', {
                  type: 'button',
                  className: 'st-icon-button',
                  disabled: busy,
                  onClick: onDeleteCancel,
                  'aria-label': t('group.cancelAdd'),
                }, h(XIcon, { size: 11 })),
              )
            : h('button', {
                type: 'button',
                className: 'st-icon-button',
                disabled: busy,
                onClick: () => onDeleteArm(entry.id),
                'aria-label': t('group.delete', { name: label }),
                title: t('group.delete', { name: label }),
              }, h(XIcon, { size: 11 })),
      );
    }

    // ── panel root (shell.overlay entry) ────────────────────────────────────
    function TogglesPanel(props) {
      const t = makeT(props.t);
      const stored = react.useRef(readStored()).current;
      const [open, setOpen] = react.useState(stored.open);
      const [status, setStatus] = react.useState('loading');
      const [loadError, setLoadError] = react.useState(null);
      const [rows, setRows] = react.useState([]);
      const [state, setState] = react.useState(null);
      const [selectedId, setSelectedId] = react.useState(stored.group);
      const [query, setQuery] = react.useState('');
      const [opError, setOpError] = react.useState(null);
      const [busy, setBusy] = react.useState(false);
      const [bounds, setBounds] = react.useState(initialBounds);
      const [adding, setAdding] = react.useState(false);
      const [addDraft, setAddDraft] = react.useState('');
      const [renamingId, setRenamingId] = react.useState(null);
      const [renameDraft, setRenameDraft] = react.useState('');
      const [pendingDelete, setPendingDelete] = react.useState(null);
      const [anchor, setAnchor] = react.useState(null);
      const [collapsed, setCollapsed] = react.useState(stored.collapsed);
      const wasOpen = react.useRef(open);

      const load = react.useCallback(async (silent) => {
        if (!silent) { setStatus('loading'); setLoadError(null); }
        try {
          const [nextState, skills] = await Promise.all([
            rpc('skillToggles.state.get', {}),
            rpc('skillToggles.skills.list', {}),
          ]);
          setState(nextState);
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
        const prevState = state;
        const prevRows = rows;
        if (optimistic !== undefined) optimistic();
        try {
          const result = await rpc(method, args);
          if (result !== null && typeof result === 'object' && Array.isArray(result.groups)) {
            // Group mutations return the fresh snapshot directly.
            setState(result);
          } else {
            await load(true);
          }
        } catch (error) {
          setState(prevState);
          setRows(prevRows);
          setOpError(errorMessage(error));
        } finally {
          setBusy(false);
        }
      };

      // initial load
      react.useEffect(() => { load(false); }, [load]);
      // refresh when the panel re-opens (host state may have changed via tools)
      react.useEffect(() => {
        if (open && !wasOpen.current) load(true);
        wasOpen.current = open;
      }, [open, load]);
      // persist open state + selected group + collapsed origins
      react.useEffect(() => {
        try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ open, group: selectedId, collapsed })); } catch { /* ignore */ }
      }, [open, selectedId, collapsed]);
      // composer toggle button sync (the click carries the button's live
      // rect relative to the overlay, so the panel docks right above it)
      react.useEffect(() => {
        const onToggle = (event) => {
          const detail = event === null || event === undefined ? undefined : event.detail;
          if (detail !== undefined && detail !== null
            && typeof detail.left === 'number' && typeof detail.bottom === 'number') {
            setAnchor({ left: detail.left, bottom: detail.bottom });
          }
          setOpen((current) => !current);
        };
        window.addEventListener(TOGGLE_EVENT, onToggle);
        return () => window.removeEventListener(TOGGLE_EVENT, onToggle);
      }, []);
      // two-step delete arming expires on its own
      react.useEffect(() => {
        if (pendingDelete === null) return;
        const timer = setTimeout(() => setPendingDelete(null), 4000);
        return () => clearTimeout(timer);
      }, [pendingDelete]);

      // Fallback anchor for a panel that opens WITHOUT a click (restored
      // open state at boot): prefer the composer button's rect, else the
      // conversation column. At boot the session UI may not be laid out
      // yet, so a single delayed retry runs when nothing was found.
      react.useLayoutEffect(() => {
        let retry = null;
        const measure = () => {
          const overlay = document.querySelector('[data-shell-overlay]');
          if (overlay === null) return false;
          const overlayRect = overlay.getBoundingClientRect();
          const next = {
            width: overlayRect.width,
            height: overlayRect.height,
            anchorLeft: 0,
          };
          const button = document.querySelector('[data-skill-toggles-button]');
          if (button !== null) {
            const buttonRect = button.getBoundingClientRect();
            next.anchorLeft = Math.min(Math.max(buttonRect.left - overlayRect.left, 0), overlayRect.width);
            setAnchor((prev) => (prev === null
              ? { left: buttonRect.left - overlayRect.left, bottom: buttonRect.bottom - overlayRect.top }
              : prev));
            setBounds((prev) => (prev.width === next.width && prev.height === next.height && prev.anchorLeft === next.anchorLeft ? prev : next));
            return true;
          }
          const conversation = document.querySelector("[data-phase='active']");
          const conversationRect = conversation === null ? undefined : conversation.getBoundingClientRect();
          if (conversationRect !== undefined) {
            next.anchorLeft = Math.min(Math.max(conversationRect.left - overlayRect.left, 0), overlayRect.width);
          }
          setBounds((prev) => (prev.width === next.width && prev.height === next.height && prev.anchorLeft === next.anchorLeft ? prev : next));
          return conversationRect !== undefined;
        };
        if (!measure()) retry = setTimeout(measure, 600);
        return () => { if (retry !== null) clearTimeout(retry); };
      }, []);

      if (!open) return null;

      const geometry = resolveGeometry(bounds, anchor);
      const compact = geometry.compact;

      const groups = state?.groups ?? [];
      const activeIds = new Set(state?.activeGroups ?? []);
      const selected = groups.find((entry) => entry.id === selectedId)
        ?? groups.find((entry) => entry.id === DEFAULT_GROUP_ID)
        ?? { id: DEFAULT_GROUP_ID, name: '', disabled: [] };
      const groupDisabled = new Set(selected.disabled);
      const effective = effectiveSet(state);

      // Rows carry the EFFECTIVE enabled flag from the host; re-derive it
      // locally so optimistic group edits show up instantly, and compute the
      // per-group switch state + cross-group badges for the selected group.
      const decorated = rows.map((row) => {
        const groupEnabled = !groupDisabled.has(row.name);
        const effectiveEnabled = !effective.has(row.name);
        let crossBadge = null;
        if (groupEnabled && !effectiveEnabled) {
          const others = (row.disabledBy ?? []).join('、');
          crossBadge = t('skill.disabledByOther', { groups: others });
        } else if (!groupEnabled && effectiveEnabled) {
          crossBadge = t('skill.groupInactive');
        }
        return { ...row, groupEnabled, effectiveEnabled, crossBadge };
      });
      const visible = filterRows(decorated, query);
      const enabledCount = decorated.reduce((count, row) => count + (row.effectiveEnabled ? 1 : 0), 0);
      const anyDisabled = decorated.some((row) => !row.effectiveEnabled)
        || groups.some((entry) => entry.disabled.length > 0);
      // Visible rows bucketed by source origin (plugin:<pkg> / user / project / custom / other).
      const originSections = (() => {
        const map = new Map();
        for (const row of visible) {
          const origin = typeof row.origin === 'string' && row.origin.length > 0 ? row.origin : 'other';
          const list = map.get(origin) ?? [];
          list.push(row);
          map.set(origin, list);
        }
        return [...map.entries()].sort((a, b) => compareOrigins(a[0], b[0]));
      })();

      // ── group actions ─────────────────────────────────────────────────────
      const toggleSkill = (name, enabled) => mutate(enabled ? 'skillToggles.enable' : 'skillToggles.disable',
        { skill: name, group: selected.id },
        () => setState((prev) => prev === null ? prev : {
          ...prev,
          groups: prev.groups.map((entry) => {
            if (entry.id !== selected.id) return entry;
            return {
              ...entry,
              disabled: enabled
                ? entry.disabled.filter((entry2) => entry2 !== name)
                : [...entry.disabled, name],
            };
          }),
        }));
      const setGroupActive = (id, active) => mutate('skillToggles.group.setActive',
        { group: id, active },
        () => setState((prev) => prev === null ? prev : {
          ...prev,
          activeGroups: active
            ? [...prev.activeGroups, id]
            : prev.activeGroups.filter((entry) => entry !== id),
        }));
      const clearGroup = () => mutate('skillToggles.enableAll',
        { group: selected.id },
        () => setState((prev) => prev === null ? prev : {
          ...prev,
          groups: prev.groups.map((entry) => (entry.id === selected.id ? { ...entry, disabled: [] } : entry)),
        }));
      const enableAll = () => mutate('skillToggles.enableAll',
        {},
        () => setState((prev) => prev === null ? prev : {
          ...prev,
          groups: prev.groups.map((entry) => ({ ...entry, disabled: [] })),
        }));
      /** Bulk add/remove names in the SELECTED group only (optimistic). */
      const bulkSet = (names, disabled) => setState((prev) => prev === null ? prev : {
        ...prev,
        groups: prev.groups.map((entry) => {
          if (entry.id !== selected.id) return entry;
          if (disabled) return { ...entry, disabled: [...new Set([...entry.disabled, ...names])] };
          const remove = new Set(names);
          return { ...entry, disabled: entry.disabled.filter((name) => !remove.has(name)) };
        }),
      });
      const disableAll = () => mutate('skillToggles.disableAll',
        { group: selected.id },
        () => bulkSet(decorated.map((row) => row.name), true));
      const setOrigin = (origin, disabled) => mutate('skillToggles.sourceSet',
        { group: selected.id, origin, disabled },
        () => bulkSet(decorated.filter((row) => (row.origin ?? 'other') === origin).map((row) => row.name), disabled));
      const createGroup = () => {
        const name = addDraft.trim();
        setAdding(false);
        setAddDraft('');
        if (name.length === 0) return;
        mutate('skillToggles.group.create', { name });
      };
      const commitRename = (id) => {
        if (renamingId !== id) return;
        setRenamingId(null);
        const name = renameDraft.trim();
        if (name.length === 0 || name === (groups.find((entry) => entry.id === id)?.name ?? '')) return;
        mutate('skillToggles.group.rename', { group: id, name });
      };
      const confirmDelete = (id) => {
        setPendingDelete(null);
        if (selectedId === id) setSelectedId(DEFAULT_GROUP_ID);
        mutate('skillToggles.group.delete', { group: id },
          () => setState((prev) => prev === null ? prev : {
            ...prev,
            groups: prev.groups.filter((entry) => entry.id !== id),
            activeGroups: prev.activeGroups.filter((entry) => entry !== id),
          }));
      };

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
                  // ── groups section ──
                  h('div', { className: 'st-section-head' },
                    h('span', { className: 'st-section-title' }, t('group.section')),
                    adding
                      ? null
                      : h('button', {
                          type: 'button',
                          className: 'st-button st-button-mini',
                          disabled: busy,
                          onClick: () => { setAdding(true); setAddDraft(''); },
                        }, h(PlusIcon, { size: 10 }), ' ', t('group.add')),
                  ),
                  h('div', { className: 'st-groups' },
                    groups.map((entry) => h(GroupRow, {
                      key: entry.id,
                      t,
                      entry,
                      total: rows.length,
                      busy,
                      selected: entry.id === selected.id,
                      active: activeIds.has(entry.id),
                      renaming: renamingId === entry.id,
                      renameDraft: renamingId === entry.id ? renameDraft : '',
                      pendingDelete: pendingDelete === entry.id,
                      onSelect: (id) => setSelectedId(id),
                      onActive: setGroupActive,
                      onRenameStart: (id) => {
                        setPendingDelete(null);
                        setRenamingId(id);
                        setRenameDraft(groups.find((g) => g.id === id)?.name ?? '');
                      },
                      onRenameInput: setRenameDraft,
                      onRenameCommit: commitRename,
                      onRenameCancel: () => setRenamingId(null),
                      onDeleteArm: (id) => setPendingDelete((prev) => (prev === id ? null : id)),
                      onDeleteConfirm: confirmDelete,
                      onDeleteCancel: () => setPendingDelete(null),
                    })),
                    adding && h('div', { className: 'st-group st-group-add' },
                      h('input', {
                        className: 'st-input st-input-mini',
                        value: addDraft,
                        autoFocus: true,
                        placeholder: t('group.addPlaceholder'),
                        disabled: busy,
                        onChange: (event) => setAddDraft(event.target.value),
                        onKeyDown: (event) => {
                          if (event.key === 'Enter') createGroup();
                          else if (event.key === 'Escape') { setAdding(false); setAddDraft(''); }
                        },
                      }),
                      h('button', { type: 'button', className: 'st-button st-button-mini st-button-primary', disabled: busy, onClick: createGroup }, t('group.confirmAdd')),
                      h('button', { type: 'button', className: 'st-button st-button-mini', disabled: busy, onClick: () => { setAdding(false); setAddDraft(''); } }, t('group.cancelAdd')),
                    ),
                  ),
                  // ── selected group + effective summary ──
                  h('div', { className: 'st-summary' },
                    h('span', { className: 'st-summary-count', title: groupLabel(selected, t) },
                      t('group.editing', { name: groupLabel(selected, t) })),
                    selected.disabled.length > 0 && h('button', {
                      type: 'button',
                      className: 'st-button st-button-mini',
                      disabled: busy,
                      onClick: clearGroup,
                    }, t('group.clear')),
                  ),
                  h('div', { className: 'st-summary' },
                    h('span', { className: 'st-summary-count' }, t('summary.enabled', { enabled: enabledCount, total: rows.length })),
                    h('span', { className: 'st-summary-actions' },
                      decorated.some((row) => row.groupEnabled) && h('button', {
                        type: 'button',
                        className: 'st-button st-button-mini',
                        disabled: busy,
                        onClick: disableAll,
                      }, t('action.disableAll')),
                      anyDisabled && h('button', {
                        type: 'button',
                        className: 'st-button st-button-mini st-button-primary',
                        disabled: busy,
                        onClick: enableAll,
                      }, t('action.enableAll')),
                    ),
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
                      : h(react.Fragment, null,
                          originSections.map(([origin, sectionRows]) => {
                            const isCollapsed = collapsed[origin] === true;
                            const anyGroupEnabled = sectionRows.some((row) => row.groupEnabled);
                            const anyGroupDisabled = sectionRows.some((row) => !row.groupEnabled);
                            const toggleCollapsed = () => setCollapsed((prev) => ({ ...prev, [origin]: !isCollapsed }));
                            return h('div', { key: origin, className: 'st-origin' },
                              h('div', { className: 'st-origin-head' },
                                h('button', {
                                  type: 'button',
                                  className: 'st-icon-button',
                                  onClick: toggleCollapsed,
                                  'aria-label': t(isCollapsed ? 'section.expand' : 'section.collapse'),
                                  title: t(isCollapsed ? 'section.expand' : 'section.collapse'),
                                }, h(ChevronIcon, { size: 12, direction: isCollapsed ? 'right' : 'down' })),
                                h('button', {
                                  type: 'button',
                                  className: 'st-origin-label',
                                  onClick: toggleCollapsed,
                                },
                                  h('span', { className: 'st-origin-name', title: origin }, originLabel(origin, t)),
                                  h('span', { className: 'st-group-count' }, String(sectionRows.length)),
                                ),
                                h('span', { className: 'st-origin-actions' },
                                  anyGroupEnabled && h('button', {
                                    type: 'button',
                                    className: 'st-button st-button-mini',
                                    disabled: busy,
                                    onClick: () => setOrigin(origin, true),
                                  }, t('action.disableAll')),
                                  anyGroupDisabled && h('button', {
                                    type: 'button',
                                    className: 'st-button st-button-mini',
                                    disabled: busy,
                                    onClick: () => setOrigin(origin, false),
                                  }, t('action.enableAll')),
                                ),
                              ),
                              isCollapsed ? null : h('div', { className: 'st-list' },
                                sectionRows.map((row) => h(SkillRow, { key: row.name, t, row, busy, onToggle: toggleSkill })),
                              ),
                            );
                          }),
                        ),
                  h('div', { className: 'st-note' }, t('note.title')),
                ),
        ),
      );
    }

    // ── composer toggle button (conversation.input.left entry) ─────────────
    function PanelToggleButton(props) {
      const t = makeT(props.t);
      return h('button', {
        type: 'button',
        className: 'st-toggle',
        'aria-label': t('toggle.aria'),
        title: t('toggle.title'),
        'data-skill-toggles-button': true,
        onClick: (event) => {
          // Pass the button's live rect (overlay-relative) so the panel
          // docks right above THIS button, wherever the layout puts it.
          const rect = event.currentTarget.getBoundingClientRect();
          const overlay = document.querySelector('[data-shell-overlay]');
          const orect = overlay === null
            ? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
            : overlay.getBoundingClientRect();
          window.dispatchEvent(new CustomEvent(TOGGLE_EVENT, {
            detail: { left: rect.left - orect.left, bottom: rect.bottom - orect.top },
          }));
        },
      }, h(ToggleIcon, { size: 14 }), h('span', { className: 'st-toggle-label' }, t('toggle.label')));
    }

    // ── stylesheet (fiber-scoped) ───────────────────────────────────────────
    const PANEL_CSS = [
      '.st-panel{box-sizing:border-box;position:absolute;display:flex;flex-direction:column;overflow:hidden;border:1px solid color-mix(in srgb,var(--dsw-alias-line-strong,#cfd3d6) 58%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-module,#fff) 95%,transparent);backdrop-filter:blur(20px) saturate(1.08);box-shadow:0 12px 32px color-mix(in srgb,var(--dsw-alias-label-primary,#1f2329) 12%,transparent),0 32px 72px color-mix(in srgb,var(--dsw-alias-label-primary,#1f2329) 16%,transparent);border-radius:16px;color:var(--dsw-alias-label-primary,#1f2329);font-size:13px;line-height:18px;animation:st-panel-in .16s ease-out}',
      '@keyframes st-panel-in{from{opacity:0}to{opacity:1}}',
      '.st-panel-head{display:flex;align-items:center;justify-content:space-between;flex:none;min-height:44px;padding:0 10px 0 14px;border-bottom:1px solid var(--dsw-alias-line-normal,#e7e9ee)}',
      '.st-panel-title{display:inline-flex;align-items:center;gap:8px;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2329)}',
      '.st-panel-controls{display:inline-flex;align-items:center;gap:2px;flex:none}',
      '.st-icon-button{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;color:var(--dsw-alias-label-tertiary,#8a919c);background:transparent;border:0;border-radius:7px;cursor:pointer;transition:background-color .12s,color .12s}',
      '.st-icon-button:hover{background:var(--dsw-alias-bg-fill-neutral,#eef0f4);color:var(--dsw-alias-label-primary,#1f2329)}',
      '.st-body{flex:1;min-height:0;overflow-y:auto;padding:10px 12px 12px;display:flex;flex-direction:column;gap:8px}',
      '.st-loading,.st-error{display:flex;flex-direction:column;align-items:center;gap:8px;padding:24px 0;color:var(--dsw-alias-label-tertiary,#8a919c);font-size:12px}',
      '.st-error-text{color:var(--dsw-alias-state-danger,#e5484d);text-align:center}',
      '.st-op-error{color:var(--dsw-alias-state-danger,#e5484d);font-size:12px;line-height:16px}',
      '.st-empty{color:var(--dsw-alias-label-tertiary,#8a919c);font-size:12px;line-height:16px;padding:6px 0}',
      '.st-section-head{display:flex;align-items:center;justify-content:space-between;gap:8px}',
      '.st-section-title{color:var(--dsw-alias-label-secondary,#5c6470);font-size:12px;font-weight:700}',
      '.st-groups{display:flex;flex-direction:column;gap:4px}',
      '.st-group{display:flex;align-items:center;gap:6px;min-width:0;padding:5px 6px;border:1px solid var(--dsw-alias-line-normal,#e7e9ee);border-radius:10px}',
      '.st-group[data-selected]{border-color:var(--dsw-alias-state-business-primary,#4d6bfe);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4d6bfe) 6%,transparent)}',
      '.st-group[data-active] .st-group-label{color:var(--dsw-alias-label-primary,#1f2329)}',
      '.st-group-name{display:inline-flex;align-items:center;gap:6px;flex:1;min-width:0;padding:0;background:transparent;border:0;cursor:pointer;text-align:left}',
      '.st-group-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-secondary,#5c6470)}',
      '.st-group-count{flex:none;padding:0 6px;border-radius:4px;font-size:10px;font-weight:600;line-height:16px;background:var(--dsw-alias-bg-fill-neutral,#eef0f4);color:var(--dsw-alias-label-tertiary,#8a919c)}',
      '.st-group-add{padding:6px}',
      '.st-summary{display:flex;align-items:center;justify-content:space-between;gap:8px}',
      '.st-summary-count{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#5c6470);font-size:12px;font-weight:600}',
      '.st-summary-actions{display:inline-flex;gap:6px;flex:none}',
      '.st-origin{display:flex;flex-direction:column;gap:4px}',
      '.st-origin-head{display:flex;align-items:center;gap:6px;min-width:0}',
      '.st-origin-label{display:inline-flex;align-items:center;gap:6px;flex:1;min-width:0;padding:2px 0;background:transparent;border:0;cursor:pointer;text-align:left}',
      '.st-origin-name{font-size:12px;font-weight:700;color:var(--dsw-alias-label-secondary,#5c6470);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.st-origin-actions{display:inline-flex;gap:6px;flex:none}',
      '.st-input{box-sizing:border-box;flex:1;min-width:0;height:30px;padding:0 8px;color:var(--dsw-alias-label-primary,#1f2329);background:var(--dsw-alias-bg-module-platform,#f7f8fa);border:1px solid var(--dsw-alias-line-normal,#e7e9ee);border-radius:8px;font-size:12px;font-family:inherit}',
      '.st-input-mini{height:24px}',
      '.st-input:focus{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:1px;border-color:transparent}',
      '.st-button{flex:none;display:inline-flex;align-items:center;gap:4px;height:30px;padding:0 12px;color:var(--dsw-alias-label-secondary,#5c6470);background:var(--dsw-alias-bg-module-platform,#f7f8fa);border:1px solid var(--dsw-alias-line-normal,#e7e9ee);border-radius:8px;font-size:12px;font-weight:600;cursor:pointer}',
      '.st-button:hover{background:var(--dsw-alias-bg-fill-neutral,#eef0f4)}',
      '.st-button:disabled{opacity:.5;cursor:default}',
      '.st-button-primary{color:var(--dsw-alias-label-on-fill,#fff);background:var(--dsw-alias-state-business-primary,#4d6bfe);border-color:transparent}',
      '.st-button-primary:hover{filter:brightness(1.06)}',
      '.st-button-danger{color:var(--dsw-alias-state-danger,#e5484d);border-color:color-mix(in srgb,var(--dsw-alias-state-danger,#e5484d) 45%,transparent)}',
      '.st-button-mini{height:22px;padding:0 8px;font-size:11px;border-radius:6px}',
      '.st-list{display:flex;flex-direction:column;gap:4px}',
      '.st-row{display:flex;align-items:center;gap:8px;min-width:0;padding:7px 8px;border:1px solid var(--dsw-alias-line-normal,#e7e9ee);border-radius:10px}',
      '.st-row[data-disabled]{opacity:.62;background:var(--dsw-alias-bg-fill-neutral,#eef0f4)}',
      '.st-row-main{display:flex;flex-direction:column;flex:1;min-width:0}',
      '.st-row-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2329)}',
      '.st-row-desc{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a919c)}',
      '.st-row-badge{flex:none;padding:0 6px;border-radius:4px;font-size:10px;font-weight:600;line-height:16px;background:var(--dsw-alias-bg-fill-neutral,#eef0f4);color:var(--dsw-alias-label-tertiary,#8a919c)}',
      '.st-row-main .st-row-badge-warn{align-self:flex-start;margin-top:2px;background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#c98a00) 14%,transparent);color:var(--dsw-alias-state-warning-primary,#c98a00)}',
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
      ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'skill-toggles-toggle',
        order: 30,
        label: 'Skill toggles',
        locale: 'skill-toggles',
      }, PanelToggleButton));
    }

    exports.apply = apply;
    exports.inject = inject;
    // Pure list logic, exported for unit tests (the browser runtime ignores
    // this extra export).
    exports.__logic = { filterRows, effectiveSet };
    return module.exports;
  },
});
