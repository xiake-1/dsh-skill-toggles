/**
 * Client-half render test: mount TogglesPanel with a minimal hook-capable
 * React shim, feed it a realistic RPC payload, and simulate the composer
 * button click.
 *
 * Why this exists: the render path is invisible to `node --check` AND to the
 * apply() smoke — an undefined identifier inside the JSX (0.6.0 shipped
 * `phase === 'loading'` where the state variable is `status`) throws only when
 * the panel opens, React unmounts the overlay occupant, and the button
 * silently stops working. This test opens the panel for real.
 * Run with: node test/client-render.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const fakeRect = { left: 100, top: 500, right: 200, bottom: 530, width: 100, height: 30 };

function createBrowserStub() {
  const listeners = new Map();
  const storage = new Map();
  const fakeEl = {
    getBoundingClientRect: () => fakeRect,
    closest: () => null,
    style: {},
    setAttribute: () => {},
    appendChild: () => {},
    textContent: '',
  };
  const windowStub = {
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener: (type, fn) => { listeners.get(type)?.delete(fn); },
    dispatchEvent: (event) => {
      for (const fn of listeners.get(event.type) ?? []) fn(event);
      return true;
    },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => { storage.set(key, value); },
      removeItem: (key) => { storage.delete(key); },
    },
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    innerWidth: 1440,
    innerHeight: 900,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
  };
  return {
    window: windowStub,
    document: {
      querySelector: () => fakeEl,
      querySelectorAll: () => [],
      createElement: () => fakeEl,
      head: { appendChild: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {},
    },
    CustomEvent: class CustomEvent {
      constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
    },
    Event: class Event { constructor(type) { this.type = type; } },
    fetch: async (url, init) => {
      const body = JSON.parse(init?.body ?? '{}');
      const value = body.method === 'skillToggles.state.get' ? STATE_PAYLOAD
        : body.method === 'skillToggles.skills.list' ? ROWS_PAYLOAD
          : { groups: [], activeGroups: [] };
      return { ok: true, json: async () => ({ ok: true, value }) };
    },
  };
}

const STATE_PAYLOAD = {
  version: 4,
  groups: [
    { id: 'default', name: '', all: true, scope: '', enabled: [], except: ['docs-sync'] },
    { id: 'builtin', name: '', all: false, scope: 'builtin', enabled: [], except: [] },
    { id: 'ppt', name: 'PPT', all: false, scope: '', enabled: ['ppt-master'], except: [] },
  ],
  activeGroups: ['default', 'builtin'],
};
const ROWS_PAYLOAD = [
  { name: 'office', description: 'Office workflows', enabled: true, enabledBy: ['builtin'], origin: 'plugin:dsh-office', builtin: true, modelInvocable: true, userInvocable: true },
  { name: 'office-xlsx', description: 'Excel workflows', enabled: true, enabledBy: ['builtin'], origin: 'plugin:dsh-office', builtin: true, modelInvocable: true, userInvocable: true },
  { name: 'diagnose-windows-sandbox-acl', description: 'ACL diagnosis', enabled: true, enabledBy: ['builtin'], origin: 'plugin:dsh-windows-acl', builtin: true, modelInvocable: true, userInvocable: true },
  { name: 'docs-sync', description: 'docs consistency', enabled: false, enabledBy: [], origin: 'plugin:dsh-project-plan-docs', builtin: false, modelInvocable: true, userInvocable: true },
  { name: 'ppt-master', description: 'PPT master', enabled: false, enabledBy: [], origin: 'custom', builtin: false, modelInvocable: true, userInvocable: true },
];

/** A tiny hook-capable React: enough to run function components + effects. */
function createReactShim() {
  const instances = new Map();
  let current = null;
  const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((entry, index) => entry === b[index]);
  const makeInstance = (path) => ({ path, hooks: [], pendingEffects: [], hookIndex: 0, dirty: false });
  function useSlot(create) {
    const index = current.hookIndex;
    current.hookIndex += 1;
    if (current.hooks.length <= index) current.hooks.push(create());
    return current.hooks[index];
  }
  function useState(initial) {
    const instance = current;
    const slot = useSlot(() => ({ value: typeof initial === 'function' ? initial() : initial }));
    return [slot.value, (next) => {
      slot.value = typeof next === 'function' ? next(slot.value) : next;
      instance.dirty = true;
    }];
  }
  function useEffect(fn, deps) {
    const instance = current;
    const slot = useSlot(() => ({ first: true, deps: undefined, cleanup: undefined }));
    if (slot.first || deps === undefined || !sameDeps(deps, slot.deps)) {
      if (typeof slot.cleanup === 'function') { try { slot.cleanup(); } catch { /* ignore */ } }
      slot.cleanup = undefined;
      slot.first = false;
      slot.deps = deps;
      instance.pendingEffects.push({ fn, slot });
    }
  }
  function useMemo(fn, deps) {
    const slot = useSlot(() => ({ first: true, deps: undefined, value: undefined }));
    if (slot.first || deps === undefined || !sameDeps(deps, slot.deps)) {
      slot.value = fn();
      slot.first = false;
      slot.deps = deps;
    }
    return slot.value;
  }
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useState,
    useRef: (initial) => useSlot(() => ({ ref: { current: initial } })).ref,
    useEffect,
    useLayoutEffect: useEffect,
    useMemo,
    useCallback: (fn, deps) => useMemo(() => fn, deps),
    Fragment: 'fragment',
  };

  function renderNode(node, path) {
    if (node === null || node === undefined || typeof node === 'boolean') return null;
    if (Array.isArray(node)) return node.map((child, index) => renderNode(child, `${path}[${index}]`));
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (typeof node.type === 'function') {
      const instance = instances.get(path) ?? makeInstance(path);
      instances.set(path, instance);
      const previous = current;
      current = instance;
      instance.hookIndex = 0;
      let out;
      try {
        out = node.type({ ...node.props, children: node.children });
      } catch (error) {
        error.message = `render ${node.type.name || '?'} at ${path}: ${error.message}`;
        throw error;
      } finally {
        current = previous;
      }
      return renderNode(out, `${path}>`);
    }
    return {
      tag: node.type,
      props: node.props,
      children: node.children.map((child, index) => renderNode(child, `${path}<${node.type}[${index}]`)),
    };
  }

  async function flush(rootNode, passes = 12) {
    let tree = null;
    for (let pass = 0; pass < passes; pass += 1) {
      instances.forEach((instance) => { instance.dirty = false; });
      tree = renderNode(rootNode, 'root');
      for (const instance of instances.values()) {
        for (const effect of instance.pendingEffects.splice(0)) {
          const result = effect.fn();
          if (typeof result === 'function') effect.slot.cleanup = result;
        }
      }
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      if (![...instances.values()].some((instance) => instance.dirty)) return tree;
    }
    return tree;
  }

  function collectText(node, out = []) {
    if (node === null || node === undefined) return out;
    if (typeof node === 'string') { out.push(node); return out; }
    if (Array.isArray(node)) { for (const child of node) collectText(child, out); return out; }
    for (const child of node.children ?? []) collectText(child, out);
    return out;
  }

  return { react, flush, renderNode, collectText, reset: () => instances.clear() };
}

test('the composer button opens the panel and it renders the groups (incl. the built-in group)', async () => {
  const browser = createBrowserStub();
  globalThis.window = browser.window;
  globalThis.document = browser.document;
  globalThis.CustomEvent = browser.CustomEvent;
  globalThis.Event = browser.Event;
  globalThis.fetch = browser.fetch;

  let captured = null;
  browser.window.__ModuleLoader__ = { load: (mod) => { captured = mod; } };
  const shim = createReactShim();
  await import('../lib/client.js');
  assert.ok(captured !== null, 'the client half must register with window.__ModuleLoader__');
  const exportsObj = captured.factory((name) => (name === 'react' ? shim.react : {}));

  const noop = () => () => {};
  const registrants = new Map();
  exportsObj.apply({
    logger: { warn: () => {}, error: () => {}, info: () => {} },
    effect: (dispose) => { try { dispose(); } catch { /* ignore */ } return noop; },
    slots: {
      inject: (name, build) => { build(); return noop; },
      register: (definition, component) => { registrants.set(definition?.id, { definition, component }); return noop; },
    },
    locale: { register: () => noop, messages: () => noop },
    remote: { $on: () => noop, call: async () => ({}) },
  }, {});

  const panel = registrants.get('skill-toggles-panel')?.component;
  const button = registrants.get('skill-toggles-toggle')?.component;
  assert.equal(typeof panel, 'function', 'the panel component must be registered in shell.overlay');
  assert.equal(typeof button, 'function', 'the toggle button must be registered in conversation.input.left');

  // Closed: renders nothing (that is the expected `active: false` occupant).
  assert.equal(await shim.flush(shim.react.createElement(panel, {})), null);

  // The composer button click must open it — and the open render must not throw.
  const buttonTree = shim.renderNode(shim.react.createElement(button, {}), 'btn');
  assert.equal(typeof buttonTree?.props?.onClick, 'function', 'the button needs a click handler');
  buttonTree.props.onClick({ currentTarget: { getBoundingClientRect: () => fakeRect } });
  const opened = await shim.flush(shim.react.createElement(panel, {}));
  assert.notEqual(opened, null, 'the panel must render after the toggle click');
  assert.equal(opened?.props?.['data-skill-toggles-panel'], true);

  const text = shim.collectText(opened).join(' ');
  for (const name of ['office', 'office-xlsx', 'docs-sync', 'ppt-master']) {
    assert.ok(text.includes(name), `the skill list must show ${name}`);
  }
  // The seeded built-in group is present and marked as catalog-scoped.
  assert.ok(/auto · shipped|自带·自动/.test(text), 'the built-in group must carry its scope badge');

  // Click every control the panel exposes (group switch, rename, add-group,
  // the scoped-group toggle, delete arming, section collapse, skill switches).
  // Any render path that throws on a state change shows up here — the same
  // failure mode as the `phase` typo: React unmounts the occupant and the
  // button silently stops responding.
  const collectButtons = (node, out = []) => {
    if (node === null || node === undefined) return out;
    if (Array.isArray(node)) { for (const child of node) collectButtons(child, out); return out; }
    if (typeof node === 'object') {
      if (node.tag === 'button' && typeof node.props?.onClick === 'function') out.push(node);
      for (const child of node.children ?? []) collectButtons(child, out);
    }
    return out;
  };
  const click = (node) => node.props.onClick({
    currentTarget: { getBoundingClientRect: () => fakeRect },
    target: { closest: () => null },
  });
  let tree = opened;
  let clicks = 0;
  for (let round = 0; round < 2; round += 1) {
    for (const buttonNode of collectButtons(tree)) {
      click(buttonNode);
      clicks += 1;
      tree = await shim.flush(shim.react.createElement(panel, {}));
      if (tree === null) {
        // A control closed the panel (collapse / click-outside): reopen it.
        browser.window.dispatchEvent(new browser.CustomEvent('skill-toggles:toggle-panel', {
          detail: { left: 10, bottom: 20 },
        }));
        tree = await shim.flush(shim.react.createElement(panel, {}));
      }
      assert.notEqual(tree, null, `the panel must survive control #${clicks}`);
    }
  }
  assert.ok(clicks > 10, `expected a populated panel, exercised ${clicks} controls`);
});
