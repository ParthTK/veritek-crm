// Standalone server: the API plus the built client on one port.
import app from './app.js';
import { startScheduler } from './services/automation.js';

const PORT = Number(process.env.PORT) || 4000;

app.listen(PORT, () => {
  console.log(`Veritek CRM listening on http://localhost:${PORT}`);
  startScheduler();
});
