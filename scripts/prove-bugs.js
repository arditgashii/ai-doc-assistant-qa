// Mutation style check for the test suite itself: switch on each known defect
// in the mock and confirm the suite goes red. A suite that stays green with
// a data leak switched on is not protecting anything.
const { spawnSync } = require('child_process');

const cases = [
  { bug: 'leak', project: 'api', grep: 'isolation|IDOR|parallel|same file name' },
  { bug: 'hallucinate', project: 'ai-eval', grep: 'not-in-document|Unsupported|G03' },
  { bug: 'raw500', project: 'reliability', grep: 'No 5xx' },
  { bug: 'share', project: 'api', grep: 'Shared user' },
];

let ok = true;
for (const [i, c] of cases.entries()) {
  const port = String(3100 + i);
  const r = spawnSync('npx', ['playwright', 'test', `--project=${c.project}`, '--grep', c.grep, '--reporter=line'], {
    env: { ...process.env, MOCK_BUGS: c.bug, PORT: port, CI: '' },
    encoding: 'utf8',
  });
  const caught = r.status !== 0;
  ok = ok && caught;
  console.log(`${caught ? 'CAUGHT ' : 'MISSED '} MOCK_BUGS=${c.bug} -> ${c.project} tests ${caught ? 'failed as expected' : 'still passed'}`);
}
process.exit(ok ? 0 : 1);
