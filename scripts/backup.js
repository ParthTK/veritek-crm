// Command-line backup: copies the database and every stored document into data/backups (or
// CRM_BACKUP_DIR), with a manifest of record counts and checksums. With --restore-test it instead
// restores the latest backup into a temporary folder and reconciles it against the manifest.
//   npm run backup          # take a backup now
//   npm run restore-test    # prove the latest backup restores cleanly
import { createBackup, restoreTest } from '../server/services/backup.js';

const restore = process.argv.includes('--restore-test');
if (restore) {
  const result = restoreTest(process.argv[process.argv.indexOf('--restore-test') + 1] || undefined);
  for (const c of result.checks || []) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  console.log(result.ok ? `\nRestore test passed for ${result.backup}` : '\nRestore test FAILED');
  process.exit(result.ok ? 0 : 1);
}

const b = createBackup('manual');
if (!b || !['ok', 'warning'].includes(b.status)) {
  console.error(`Backup failed: ${b?.error || 'unknown error'}`);
  process.exit(1);
}
console.log(`Backup ${b.status === 'warning' ? 'completed with warnings' : 'completed'}: ${b.path}`);
if (b.status === 'warning' && b.error) console.log(`Warning: ${b.error}`);
