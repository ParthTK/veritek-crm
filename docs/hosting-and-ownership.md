# Hosting costs & dependency ownership

The specification asks that recurring costs are documented and that no essential service is tied only to a
developer's personal account. Fill in the cost column from the actual quotes when the host is chosen.

## What has to run

| Need | Minimum | Notes |
|---|---|---|
| Application | Google Cloud Run, 1 vCPU / 512 MB, 1 instance | One container serves the API and the web app; scales to zero when idle |
| Database | PostgreSQL — the existing Cloud SQL instance `veritek-db`, schema `crm` | Shared with the website and portal, each in its own schema with its own user |
| Documents & CRM backups | Cloud Storage bucket `veritek-513405-crm-files` | Private; soft delete keeps deleted objects recoverable |
| Reminders & daily backup | Cloud Scheduler, every 15 minutes | Calls the CRM's protected scheduler endpoint |
| Domain + TLS certificate | Google-managed on the Cloud Run address; optionally `crm.veritekindia.com` | Certificates are automatic |
| QR public address | Same domain | Printed QR codes point here permanently — keep the domain stable |

No paid third-party API, message gateway or database licence is required.

## Recurring services (to be owned by Veritek)

| Service | Purpose | Account owner | Monthly cost |
|---|---|---|---|
| Google Cloud project `veritek-513405` (Cloud Run, Cloud SQL, Cloud Storage, Cloud Scheduler, Secret Manager) | Runs the CRM, its database and documents | Veritek Google account | Pay per use: roughly ₹200–400 a month for the CRM (see [deploy-google-cloud.md](deploy-google-cloud.md)). Cloud SQL is already paid for by the website |
| Domain registrar & DNS | `veritekindia.com` sub-domain | Veritek | *(existing)* |
| Source repository (e.g. GitHub organisation) | Code, history, handover | Veritek organisation, developers as members | *(free tier possible)* |
| Optional demo hosting (Vercel) | Public demo only | Veritek team account | *(free tier possible)* |

Keep at least two Veritek administrators on every account and in the CRM itself (super administrator role).

## Software dependencies

All open source; versions pinned in `package-lock.json`.

| Package | Used for | Licence |
|---|---|---|
| Node.js | Server runtime | MIT |
| PostgreSQL (Cloud SQL) | Database | PostgreSQL licence |
| pg | PostgreSQL client | MIT |
| @electric-sql/pglite | Embedded PostgreSQL for local use, tests and the demo | Apache-2.0 / PostgreSQL |
| express | HTTP API | MIT |
| qrcode | QR code images | MIT |
| react, react-dom, react-router-dom | Web interface | MIT |
| vite, @vitejs/plugin-react | Building the web interface | MIT |

Upgrade by running `npm outdated`, updating, then `npm test` and a restore test before deploying.

## Operational owner

Name an operational owner at Veritek for: backup status (Settings → System & backups), reminder evaluator
status, import failures, user access reviews, and the error log (Settings → System & backups shows recent
server errors).
