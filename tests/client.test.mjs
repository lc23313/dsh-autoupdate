import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function mount(reply) {
  let factory, Section, cursor = 0, first = true;
  const states = [], refs = [], effects = [];
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], v => { states[i] = v; }]; },
    useRef(initial) { const i = cursor++; return refs[i] ??= { current: initial }; },
    useEffect(fn) { if (first) effects.push(fn); },
  };
  const context = vm.createContext({
    window: { __ModuleLoader__: { load: entry => { factory = entry.factory; } } },
    location: { origin: 'http://localhost:3080' }, navigator: { language: 'en' }, console,
    fetch: async (url, init) => {
      const request = JSON.parse(init.body);
      const result = await reply(request.method, request.payload);
      return { ok: true, json: async () => ({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: result } }) };
    },
  });
  vm.runInContext(readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'), context);
  factory(() => React).apply({
    effect: fn => fn(), locale: { register() {}, bind: () => key => key },
    slots: { inject: (_, fn) => fn(), register: (_, component) => { Section = component; } },
  });
  const render = () => { cursor = 0; const tree = Section({}); first = false; return tree; };
  const initial = render();
  for (const fn of effects) fn();
  return { render, initial };
}
function buttons(tree) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(buttons);
  return [...(typeof tree.type === 'function' && tree.props.onClick ? [tree] : []), ...tree.children.flatMap(buttons)];
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('status failure leaves check retryable and successful retry refreshes the version', async () => {
  const ui = mount(async endpoint => {
    if (endpoint === 'autoupdate/status') throw new Error('temporary disconnect');
    return { state: 'up-to-date', current: '1.1.0', latest: '1.1.0', channel: 'latest' };
  });
  await settle();
  const check = buttons(ui.render())[0];
  assert.ok(!check.props.disabled);
  check.props.onClick();
  await settle();
  const rendered = JSON.stringify(ui.render());
  assert.match(rendered, /You are up to date/);
  assert.match(rendered, /1.1.0/);
});

test('unknown check response displays an error instead of claiming up to date', async () => {
  const ui = mount(async endpoint => endpoint === 'autoupdate/status' ? { enabled: true } : {});
  await settle();
  buttons(ui.render())[0].props.onClick();
  await settle();
  assert.match(JSON.stringify(ui.render()), /Invalid update check result/);
});

test('confirmation requires a matching armed response', async () => {
  const ui = mount(async endpoint => {
    if (endpoint === 'autoupdate/status') return { enabled: true };
    if (endpoint === 'autoupdate/check') return { state: 'update-available', current: '1.0.0', latest: '1.1.0' };
    return { armed: false };
  });
  await settle();
  buttons(ui.render())[0].props.onClick();
  await settle();
  buttons(ui.render()).find(button => button.props.primary).props.onClick();
  await settle();
  assert.match(JSON.stringify(ui.render()), /Update was not scheduled/);
});
