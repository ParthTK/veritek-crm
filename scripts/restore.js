// Restores a backup into an EMPTY database (new installation, or a fresh schema on Cloud SQL):
//   npm run restore -- backups/backup-2026-11-18T02-00-00-000Z/
// The backup is read from the document store this installation uses (data/files locally, the bucket on
// Cloud Run). A database that already has accounts is refused.
import { restoreBackup } from '../server/services/backup.js';
import { closeDb } from '../server/db.js';

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: npm run restore -- backups/backup-<time>/');
  process.exit(1);
}
let code = 0;
try {
  const r = restoreBackup(arg.endsWith('/') ? arg : `${arg}/`);
  console.log(`Restored ${r.rows} records in ${r.tables} tables from the backup taken ${r.created_at}${r.documents_restored ? `, and ${r.documents_restored} document(s)` : ''}.`);
} catch (err) {
  console.error(`Restore failed: ${err.message}`);
  code = 1;
}
closeDb();
process.exit(code);
