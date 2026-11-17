# Hosting costs & dependency ownership

The specification asks that recurring costs are documented and that no essential service is tied only to a
developer's personal account. Fill in the cost column from the actual quotes when the host is chosen.

## What has to run

| Need | Minimum | Notes |
|---|---|---|
| Application server | 1 vCPU, 1–2 GB RAM, Node.js 22.13+ | One process serves the API and the web app |
| Persistent disk | 10–20 GB to start | Database, documents and local backups (`CRM_DATA_DIR`) |
| Off-server backup storage | A bucket or second disk | Point `CRM_BACKUP_DIR` at it, or copy `data/backups` daily |
| Domain + TLS certificate | e.g. `crm.veritekindia.com` | Free certificates (Let's Encrypt) or the cloud load balancer's |
| QR public address | Same domain | Printed QR codes point here permanently — keep the domain stable |

No paid third-party API, message gateway or database licence is required.

## Recurring services (to be owned by Veritek)

| Service | Purpose | Account owner | Monthly cost |
|---|---|---|---|
| Cloud server / VM or container host | Runs the CRM | Veritek company account | *(from quote)* |
| Disk / bucket for backups | Off-server copies | Veritek company account | *(from quote)* |
| Domain registrar & DNS | `veritekindia.com` sub-domain | Veritek | *(existing)* |
| Source repository (e.g. GitHub organisation) | Code, history, handover | Veritek organisation, developers as members | *(free tier possible)* |
| Optional demo hosting (Vercel) | Public demo only | Veritek team account | *(free tier possible)* |

Keep at least two Veritek administrators on every account and in the CRM itself (super administrator role).

## Software dependencies

All open source; versions pinned in `package-lock.json`.

| Package | Used for | Licence |
|---|---|---|
| Node.js (runtime, built-in `node:sqlite`) | Server and database | MIT |
| express | HTTP API | MIT |
| qrcode | QR code images | MIT |
| react, react-dom, react-router-dom | Web interface | MIT |
| vite, @vitejs/plugin-react | Building the web interface | MIT |

Upgrade by running `npm outdated`, updating, then `npm test` and a restore test before deploying.

## Operational owner

Name an operational owner at Veritek for: backup status (Settings → System & backups), reminder evaluator
status, import failures, user access reviews, and the error log (Settings → System & backups shows recent
server errors).
