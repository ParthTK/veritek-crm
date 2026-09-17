// Vercel serverless entry point: the rewrite in vercel.json sends every /api/* request here,
// and Express sees the original URL. The automation scheduler is not started — serverless
// instances are short-lived, so automation runs on demand from Settings → Automation.
import app from '../server/app.js';

export default app;
