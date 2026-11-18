// Command-line backup: exports every table and records every stored document's checksum into the document
// store under backups/ (data/files/backups locally — with copies of the documents — or the bucket on Cloud
// Run). With --restore-test it instead reads the latest backup (or the one named) back and reconciles it.
//   npm run backup          # take a backup now
//   npm run restore-test    # prove the latest backup restores cleanly
import { createBackup, restoreTest } from '../server/services/backup.js';
import { closeDb } from '../server/db.js';

const done = (code) => {
  closeDb();
  process.exit(code);
};

if (process.argv.includes('--restore-test')) {
  const result = restoreTest(process.argv[process.argv.indexOf('--restore-test') + 1] || undefined);
  for (const c of result.checks || []) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  console.log(result.ok ? `\nRestore test passed for ${result.backup}` : '\nRestore test FAILED');
  done(result.ok ? 0 : 1);
} else {
  const b = createBackup('manual');
  if (!b || !['ok', 'warning'].includes(b.status)) {
    console.error(`Backup failed: ${b?.error || 'unknown error'}`);
    done(1);
  }
  console.log(`Backup ${b.status === 'warning' ? 'completed with warnings' : 'completed'}: ${b.path}`);
  if (b.status === 'warning' && b.error) console.log(`Warning: ${b.error}`);
  done(0);
}
