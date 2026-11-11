// Runs every registered test script and reports a pass/fail summary.
//
// Each test is judged by its EXIT CODE, not by grepping its output for a
// PASS string: several scripts succeed silently and print nothing at all.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const tests = Object.keys(pkg.scripts)
  .filter(key => key.startsWith('test:'))
  .map(key => ({ name: key.slice(5), command: pkg.scripts[key] }));

let passed = 0;
const failed = [];

for (const test of tests) {
  process.stdout.write(`${test.name.padEnd(34)}`);
  const result = spawnSync(test.command, {
    shell: true,
    encoding: 'utf8',
    timeout: 600000,
  });
  if (result.status === 0) {
    console.log('PASS');
    passed += 1;
  } else {
    console.log('FAIL');
    failed.push(test.name);
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    console.log(output.split('\n').slice(-8).map(line => `    ${line}`).join('\n'));
  }
}

console.log('');
console.log(`PASSED=${passed} FAILED=${failed.length}`);
if (failed.length) console.log(`failed: ${failed.join(' ')}`);
process.exit(failed.length ? 1 : 0);
