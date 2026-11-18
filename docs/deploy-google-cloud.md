# Deploying on Google Cloud

Production runs in the Veritek Google Cloud project **`veritek-513405`**, region **`asia-south1`** (Mumbai),
next to the website and portal.

| Piece | Google service | Name |
|---|---|---|
| Application (API + web app) | Cloud Run service, built from this repository's `Dockerfile` | `veritek-crm` |
| Database | Cloud SQL for PostgreSQL — the existing instance, its own schema and user | instance `veritek-db`, database `veritek`, schema `crm`, user `veritek_crm` |
| Documents and the CRM's backups | Cloud Storage bucket (private, soft delete on) | `veritek-513405-crm-files` |
| Reminders every 15 minutes + daily backup | Cloud Scheduler job → `POST /api/internal/scheduled` | `veritek-crm-scheduled` |
| Secrets | Secret Manager | `veritek-crm-db-password`, `veritek-crm-cron-secret`, `veritek-crm-admin-password` |
| Runtime identity | Service account | `veritek-crm-run@veritek-513405.iam.gserviceaccount.com` |

The CRM's database user owns only the `crm` schema. It has no rights on the website's (`public`) or portal's
(`portal`) tables, and their users have none on the CRM's. The Cloud SQL instance stays closed to the
internet: Cloud Run reaches it through the built-in Cloud SQL connection (IAM-authorised).

Cloud Run runs **one instance at most** (the CRM handles one database statement at a time) and scales to
zero when idle, so the first request after a quiet spell takes a few seconds.

## One-time set-up

Commands assume `gcloud` is signed in to the Veritek account with this project selected. Never put secret
values on a command line: generate them into Secret Manager through standard input, as below.

1. **APIs**

   ```bash
   gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
     cloudscheduler.googleapis.com secretmanager.googleapis.com sqladmin.googleapis.com
   ```

2. **Secrets** (random values, created from standard input)

   ```bash
   for s in veritek-crm-db-password veritek-crm-cron-secret veritek-crm-admin-password; do
     node -e "process.stdout.write(require('crypto').randomBytes(24).toString('base64url') + 'a1')" \
       | gcloud secrets create $s --replication-policy=automatic --data-file=-
   done
   ```

3. **Database user and schema** — as the instance's `postgres` user (Cloud SQL Studio in the console, or a
   Cloud SQL connector session), with the password from `veritek-crm-db-password`:

   ```sql
   CREATE ROLE veritek_crm LOGIN PASSWORD '<veritek-crm-db-password>';
   GRANT veritek_crm TO postgres;            -- lets the administrator create the schema for it
   CREATE SCHEMA crm AUTHORIZATION veritek_crm;
   GRANT CONNECT ON DATABASE veritek TO veritek_crm;
   ALTER ROLE veritek_crm SET search_path = crm, public;
   CREATE EXTENSION IF NOT EXISTS citext;    -- case-insensitive emails and product codes
   ```

   The CRM creates its tables in `crm` on first start.

4. **Bucket**

   ```bash
   gcloud storage buckets create gs://veritek-513405-crm-files --location=asia-south1 \
     --uniform-bucket-level-access --public-access-prevention
   ```

5. **Service account and its permissions**

   ```bash
   gcloud iam service-accounts create veritek-crm-run --display-name="Veritek CRM (Cloud Run)"
   SA=veritek-crm-run@veritek-513405.iam.gserviceaccount.com
   gcloud projects add-iam-policy-binding veritek-513405 --member=serviceAccount:$SA --role=roles/cloudsql.client --condition=None
   gcloud storage buckets add-iam-policy-binding gs://veritek-513405-crm-files --member=serviceAccount:$SA --role=roles/storage.objectAdmin
   for s in veritek-crm-db-password veritek-crm-cron-secret veritek-crm-admin-password; do
     gcloud secrets add-iam-policy-binding $s --member=serviceAccount:$SA --role=roles/secretmanager.secretAccessor
   done
   ```

6. **Deploy** (also the command for every update)

   ```bash
   gcloud run deploy veritek-crm --source . --region=asia-south1 \
     --service-account=veritek-crm-run@veritek-513405.iam.gserviceaccount.com \
     --add-cloudsql-instances=veritek-513405:asia-south1:veritek-db \
     --set-env-vars=PGHOST=/cloudsql/veritek-513405:asia-south1:veritek-db,PGUSER=veritek_crm,PGDATABASE=veritek,CRM_PG_SCHEMA=crm,CRM_FILES_BUCKET=veritek-513405-crm-files,CRM_NO_DEMO=1,CRM_NO_SCHEDULER=1,CRM_ADMIN_EMAIL=admin@veritekindia.com \
     --set-secrets=PGPASSWORD=veritek-crm-db-password:latest,CRM_CRON_SECRET=veritek-crm-cron-secret:latest,CRM_ADMIN_PASSWORD=veritek-crm-admin-password:latest \
     --min-instances=0 --max-instances=1 --cpu=1 --memory=512Mi --concurrency=20 --timeout=300 \
     --allow-unauthenticated
   ```

   On the first start the CRM creates its tables and a clean installation (product models without prices,
   sales regions, settings) with one super administrator, `CRM_ADMIN_EMAIL`, whose temporary password is the
   `veritek-crm-admin-password` secret (Secret Manager → the secret → *View secret value*). It must be changed
   at first sign-in. The admin variables are ignored once accounts exist.

7. **Scheduler** — every 15 minutes, `POST https://<service URL>/api/internal/scheduled` with the header
   `X-Cron-Secret: <veritek-crm-cron-secret>` (time zone Asia/Kolkata). Create it in the console (Cloud Scheduler
   → Create job → HTTP target), or through the Cloud Scheduler API with the secret read from Secret Manager —
   not typed on a command line.

## Updating

Run the deploy command in step 6 from the repository. The schema is migrated automatically at start-up.
Take a CRM backup first (Settings → System & backups → Back up now).

## Custom address

The service answers on its Cloud Run address (`https://veritek-crm-….run.app`). To use
`crm.veritekindia.com`, front it with Firebase Hosting (free, with a managed certificate) or a load balancer,
and add the DNS records your DNS provider is given. Keep the address stable once QR codes are printed.

## Costs

Estimate for 10–15 users: **roughly ₹200–400 a month including GST**, from Google's list prices for Mumbai in
November 2026, without counting on any free allowance. Check the actual figure in Billing after the first month.

| Item | List price (before GST) | Assumed use |
|---|---|---|
| Cloud Run CPU / memory (billed while handling requests) | ₹0.002286 per vCPU-second, ₹0.000238 per GiB-second | about 40,000–110,000 seconds a month |
| Cloud Storage, Mumbai | ₹2.19 per GB-month | about 5 GB of documents and backups |
| Artifact Registry | first 0.5 GB free, then ₹9.52 per GB-month | about 1 GB of images |
| Internet traffic | a few rupees per GB | a few GB a month |
| Cloud Scheduler, Cloud Build | one job and a few builds fit the free allowance | |
| Secret Manager | first 6 secret versions free, then ₹5.71 each | three new secrets |

The Cloud SQL instance is already paid for by the website. It is the smallest size and is now shared by three
applications: if it becomes slow it will need a larger size, which costs more.
