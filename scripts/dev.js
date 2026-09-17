// Runs the API (with --watch) and the Vite dev server together.
import { spawn } from 'node:child_process';

const procs = [
  ['api', ['--watch', '--no-warnings=ExperimentalWarning', 'server/index.js']],
  ['web', ['node_modules/vite/bin/vite.js', '--config', 'client/vite.config.js']],
].map(([name, args]) => {
  const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const prefix = (chunk) => chunk.toString().split('\n').filter(Boolean).map((l) => `[${name}] ${l}`).join('\n');
  p.stdout.on('data', (c) => console.log(prefix(c)));
  p.stderr.on('data', (c) => console.error(prefix(c)));
  p.on('exit', (code) => {
    console.log(`[${name}] exited with ${code}`);
    shutdown();
  });
  return p;
});

function shutdown() {
  for (const p of procs) if (!p.killed) p.kill();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
