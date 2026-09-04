// Offline npm stand-in. It only writes inside the test-owned prefix.
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === 'view') {
  console.log(JSON.stringify({ latest: '1.1.0' }));
} else if (args[0] === 'install') {
  const prefix = args[args.indexOf('--prefix') + 1];
  if (!prefix || !fs.existsSync(path.join(prefix, '.test-prefix'))) process.exit(90);
  const version = args.find(a => a.startsWith('@deepseek-ai/dsh@')).slice('@deepseek-ai/dsh@'.length);
  fs.appendFileSync(path.join(prefix, 'installs.jsonl'), JSON.stringify(args) + '\n');
  const dir = path.join(prefix, ...(process.platform === 'win32' ? [] : ['lib']), 'node_modules', '@deepseek-ai', 'dsh');
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version, bin: { dsh: 'lib/bin.cjs' } }));
  const broken = fs.existsSync(path.join(prefix, '.break-all')) || (version === '1.1.0' && fs.existsSync(path.join(prefix, '.break-target')));
  fs.writeFileSync(path.join(dir, 'lib/bin.cjs'), broken ? 'process.exit(1)' : `console.log(${JSON.stringify(version)})`);
} else {
  console.error('Unexpected test command', args);
  process.exit(91);
}
