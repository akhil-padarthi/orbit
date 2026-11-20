/** Development: rebuild the React app on change and restart the API server on change. Works on macOS, Linux and Windows. */
import { spawn } from 'node:child_process';

const procs = [
  spawn(process.execPath, ['scripts/build-client.js', '--watch'], { stdio: 'inherit' }),
  spawn(process.execPath, ['--env-file-if-exists=.env', '--disable-warning=ExperimentalWarning', '--watch', 'server/index.js'], { stdio: 'inherit' }),
];

const stop = () => {
  for (const p of procs) p.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => code && stop());
