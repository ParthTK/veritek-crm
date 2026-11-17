// Standalone server: the API plus the built client on one port, with the reminder scheduler and daily
// backups running in-process.
import app from './app.js';
import { startScheduler } from './services/alerts.js';
import { maybeScheduledBackup } from './services/backup.js';
import { ENV, DB_PATH } from './db.js';

const PORT = Number(process.env.PORT) || 4000;

app.listen(PORT, () => {
  console.log(`Veritek CRM (${ENV}) listening on http://localhost:${PORT}  — database ${DB_PATH}`);
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
