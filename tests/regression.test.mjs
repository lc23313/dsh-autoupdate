import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { globalDshDir, prefixFromGlobalRoot, resolveRunningDsh, verifyDshInstall, runCommand } from '../lib/install.js';
import { AutoUpdater } from '../lib/updater.js';
import { createGuard } from '../lib/guard.js';
import { StateStore } from '../lib/state.js';
import { registerUpdateChannel } from '../lib/channel.js';
import vm from 'node:vm';

const updaterUrl = new URL('../lib/updater.js', import.meta.url).href;
const helperPath = fileURLToPath(new URL('../scripts/update-agent.mjs', import.meta.url));
const fakeNpmPath = fileURLToPath(new URL('./fixtures/npm.cjs', import.meta.url));
const sleep = ms => new Promise(r => setTimeout(r, ms));

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh regression '));
  t.after(() => {
    assert.equal(dirname(dir), resolve(tmpdir()));
    rmSync(dir, { recursive: true, force: true });
  });
  const prefix = join(dir, 'node prefix');
  mkdirSync(prefix);
  writeFileSync(join(prefix, '.test-prefix'), '');
  const pkg = globalDshDir(prefix);
  const entry = join(pkg, 'lib', 'bin.cjs');
  mkdirSync(dirname(entry), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '1.0.0', bin: { dsh: 'lib/bin.cjs' } }));
  writeFileSync(entry, 'console.log("1.0.0")');
  const npm = join(dir, process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const quoteSh = s => "'" + s.replaceAll("'", "'\\''") + "'";
  writeFileSync(npm, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${fakeNpmPath}" %*\r\n`
    : `#!/bin/sh\nexec ${quoteSh(process.execPath)} ${quoteSh(fakeNpmPath)} "$@"\n`, { mode: 0o755 });
  return { dir, prefix, pkg, entry, npm };
}

test('resolves the real lib/bin entry and platform-specific global layout', async t => {
  const f = fixture(t);
  const found = resolveRunningDsh(f.entry);
  assert.equal(found.version, '1.0.0');
  assert.equal(found.prefix, f.prefix);
  assert.equal(prefixFromGlobalRoot(join(f.prefix, 'lib', 'node_modules'), 'linux'), f.prefix);
  assert.equal(globalDshDir(f.prefix, 'linux'), join(f.prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh'));
  assert.equal(prefixFromGlobalRoot(join(f.prefix, 'lib', 'node_modules'), 'win32'), join(f.prefix, 'lib'));
  assert.equal((await verifyDshInstall(f.prefix, '1.0.0')).ok, true);
  writeFileSync(f.entry, 'process.exit(1)');
  assert.equal((await verifyDshInstall(f.prefix, '1.0.0')).ok, false);
});

test('follows linked launchers and supports deeper entry layouts', t => {
  const f = fixture(t);
  const deep = join(f.pkg, 'lib', 'nested', 'cli.cjs');
  mkdirSync(dirname(deep)); writeFileSync(deep, '');
  assert.equal(resolveRunningDsh(deep).prefix, f.prefix);
  const link = join(f.dir, 'linked-package');
  symlinkSync(f.pkg, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(resolveRunningDsh(join(link, 'lib', 'bin.cjs')).prefix, f.prefix);
});

test('channel registration retains authority and routes actual async handlers', async () => {
  let registered;
  const ctx = { inject: (deps, cb) => {
    assert.deepEqual(deps, ['connection']);
    cb({ connection: { rpc: { handle: (...args) => { registered = args; } } } });
  } };
  assert.equal(registerUpdateChannel(ctx, { checkForUi: async () => ({ state: 'update-available' }) }), true);
  assert.equal(registered[0], '/dsh-autoupdate');
  assert.deepEqual(registered[2], { authority: 'loopback' });
  assert.equal((await registered[1]('autoupdate/check', {})).value.state, 'update-available');
});

test('disabled/stopped updater and unknown prefix never arm', async t => {
  const f = fixture(t);
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = f.dir;
  t.after(() => { if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome; });
  const updater = new AutoUpdater({}, { enabled: false });
  updater.start();
  await assert.rejects(updater.checkForUi(), /禁用/);
  await assert.rejects(updater.armFromUi('1.1.0'), /禁用/);
  updater.config.enabled = true;
  updater.start();
  updater.state.mutate(d => { d.installedVersion = '1.0.0'; d.pendingVersion = '1.1.0'; });
  await assert.rejects(updater.armFromUi('1.1.0'), /安装前缀/);
  assert.equal(updater.state.data.helper, null);
  updater.dispose();
  await assert.rejects(updater.armFromUi('1.1.0'), /停止/);
});

test('open circuit permits a delayed recovery probe', t => {
  const f = fixture(t);
  const state = new StateStore(f.dir);
  const guard = createGuard(state, { maxConsecutiveFailures: 1, cooldownMs: 1000, checkIntervalMs: 300000 }, { warn() {} });
  guard.recordFailure(new Error('offline')); guard.recordFailure(new Error('offline'));
  state.data.lastCheckAt = Date.now();
  assert.equal(guard.canCheck(), false);
  assert.equal(guard.canCheck(Date.now() + 300001), true);
  guard.recordSuccess();
  assert.equal(guard.canAutoApply(), true);
});

test('helper still waits after one hour and only proceeds when the parent exits', async () => {
  const source = readFileSync(helperPath, 'utf8');
  const waitSource = source.slice(source.indexOf('async function waitParentExit('), source.indexOf('async function refreshProfiles('));
  let clock = 0;
  const wait = vm.runInNewContext(waitSource + '\nwaitParentExit', {
    ownsArm: () => true,
    Date: { now: () => clock },
    sleep: async () => { clock += 3600001; },
    process: { kill() { if (clock > 7200000) throw Object.assign(new Error('gone'), { code: 'ESRCH' }); } },
  });
  assert.equal(await wait(1234), true);
  assert.ok(clock > 7200000);
});

test('live helper plans older than six hours survive startup cleanup', t => {
  const f = fixture(t);
  const updater = new AutoUpdater({}, {});
  updater.state = new StateStore(f.dir);
  updater.warn = () => {};
  updater.state.data.helper = { armed: true, armedAt: Date.now() - 86400000, helperPid: process.pid };
  updater.staleHelperSweep();
  assert.equal(updater.state.data.helper.armed, true);
});

for (const [mode, expected] of [['success', 'done'], ['bad-target', 'rolled-back'], ['bad-rollback', 'failed']]) {
  test(`real detached helper: check → confirm → parent exits → ${mode}`, { timeout: 20000 }, async t => {
    const f = fixture(t);
    if (mode === 'bad-target') writeFileSync(join(f.prefix, '.break-target'), '');
    if (mode === 'bad-rollback') writeFileSync(join(f.prefix, '.break-all'), '');
    const parent = join(f.dir, 'parent.mjs');
    const resultPath = join(f.dir, 'plugins-data', 'dsh-autoupdate', 'helper-result.json');
    writeFileSync(parent, `
      import { AutoUpdater } from ${JSON.stringify(updaterUrl)};
      process.env.DSH_HOME = ${JSON.stringify(f.dir)};
      process.argv[1] = ${JSON.stringify(f.entry)};
      const updater = new AutoUpdater({}, { npmCommand: ${JSON.stringify(f.npm)}, updateProfilePlugins: false });
      updater.start();
      const check = await updater.checkForUi();
      if (check.latest !== '1.1.0' || updater.state.data.helper !== null) throw new Error('check must not install');
      await updater.armFromUi(check.latest);
      updater.dispose();
    `);
    const r = await runCommand(process.execPath, [parent], { timeoutMs: 5000 });
    assert.equal(r.ok, true, r.stderr);
    let result;
    for (let i = 0; i < 100; i++) {
      try { result = JSON.parse(readFileSync(resultPath, 'utf8')); } catch {}
      if (['done', 'rolled-back', 'failed'].includes(result?.phase)) break;
      await sleep(100);
    }
    assert.equal(result?.phase, expected, JSON.stringify(result));
    const calls = readFileSync(join(f.prefix, 'installs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls[0].includes('@deepseek-ai/dsh@1.1.0'), true);
    assert.equal(calls[0][calls[0].indexOf('--prefix') + 1], f.prefix);
    if (mode !== 'success') assert.equal(calls[1].includes('@deepseek-ai/dsh@1.0.0'), true);
  });
}

test('superseded helper exits without overwriting another result or installing', { timeout: 5000 }, async t => {
  const f = fixture(t);
  const statePath = join(f.dir, 'state.json');
  const resultPath = join(f.dir, 'helper-result.json');
  writeFileSync(statePath, JSON.stringify({ helper: { armed: true, armId: 'old', parentPid: process.pid, targetVersion: '1.1.0' } }));
  const child = spawn(process.execPath, [helperPath, '--state-dir', f.dir, '--parent-pid', String(process.pid), '--target', '1.1.0', '--from', '1.0.0', '--prefix', f.prefix, '--npm', f.npm, '--arm-id', 'old'], { stdio: 'ignore', windowsHide: true });
  const exited = once(child, 'exit');
  t.after(() => { if (child.exitCode === null) child.kill(); });
  for (let i = 0; i < 30 && !existsSync(resultPath); i++) await sleep(50);
  assert.equal(existsSync(resultPath), true);
  writeFileSync(statePath, JSON.stringify({ helper: { armed: true, armId: 'new', parentPid: process.pid, targetVersion: '1.1.0' } }));
  writeFileSync(resultPath, JSON.stringify({ phase: 'done', armId: 'new' }));
  await exited;
  assert.equal(JSON.parse(readFileSync(resultPath)).armId, 'new');
  assert.equal(existsSync(join(f.prefix, 'installs.jsonl')), false);
});
