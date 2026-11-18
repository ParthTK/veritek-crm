// Standalone server: the API plus the built client on one port. On a normal server the reminder scheduler
// and daily backups run in-process; on Cloud Run (CRM_NO_SCHEDULER=1) Cloud Scheduler calls
// POST /api/internal/scheduled instead, because the container only has CPU while it serves requests.
import app from './app.js';
import { startScheduler } from './services/alerts.js';
import { maybeScheduledBackup } from './services/backup.js';
import { ENV, DB_PATH, closeDb } from './db.js';
import { STORAGE_LABEL } from './storage.js';

const PORT = Number(process.env.PORT) || 4000;

const server = app.listen(PORT, () => {
  console.log(`Veritek CRM (${ENV}) listening on http://localhost:${PORT} — database ${DB_PATH}, documents ${STORAGE_LABEL}`);
  if (process.env.CRM_NO_SCHEDULER !== '1') {
    startScheduler(() => {
      try {
        maybeScheduledBackup();
      } catch (err) {
        console.error('Scheduled backup failed', err);
      }
    });
  }
});

// Stop taking requests, then close the database cleanly (Cloud Run sends SIGTERM before stopping a container).
let stopping = false;
const shutdown = (signal) => {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: shutting down`);
  server.close(() => {
    closeDb();
    process.exit(0);
  });
  setTimeout(() => {
    closeDb();
    process.exit(0);
  }, 8000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
