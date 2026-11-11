# DocuSign Vote Counter

Node.js app that tallies board votes cast through DocuSign envelopes. DocuSign **Connect** webhooks push every envelope event to the app, which counts the votes, closes the vote when a majority is reached or the deadline passes, and emails the final report.

## How it works

1. **Template config (API)** – An admin syncs templates from the DocuSign API (`/api/templates/sync`) and configures each one in the portal: display name, vote options, content field, and whether it is tracked.
2. **Votes (Connect webhooks)** – DocuSign Connect posts envelope events to `POST /connect`. The raw event is stored, the envelope is re-read from DocuSign, and recipient checkbox/radio selections are normalized into vote totals. The app never polls for envelopes.
3. **Majority rule** – With `n` eligible voters, the threshold is `floor(n / 2) + 1`. As soon as that many have voted, the envelope is closed (`completed`) and the report is sent.
4. **Timer** – An in-process scheduler (`services/schedulerService.js`) checks every `SCHEDULER_TICK_MS` (default 60 s dev / 15 min prod) for envelopes past their deadline. Expired envelopes have their latest votes saved, are **voided in DocuSign**, closed locally, and the report is emailed. Deadlines come from the template's `Fecha / Hora / Minutos / Meridiem Limite para votar` fields.

## Authentication

| Concern | Mechanism |
|---------|-----------|
| Portal users (dashboard, `/api/*`, `/connect/events`) | DocuSign OAuth 2.0 **SSO** (`/auth/login` → `/auth/callback`), signed HTTP-only session cookie. Optional restriction by account (`DOCUSIGN_ACCOUNT_ID`) and email (`SSO_ALLOWED_EMAILS`) |
| DocuSign API calls (sync, read envelope, void) | **JWT grant** signed with the integration's RSA private key/certificate. No user tokens are used |
| DocuSign Connect → `POST /connect` | HMAC-SHA256 signature (`X-DocuSign-Signature-1`) verified with `DOCUSIGN_CONNECT_HMAC_KEY` |

If SSO is not configured the portal is open (local development only; a warning is logged).

## Architecture

```
index.js                     Express app + boot
config.js                    Environment configuration
routes/auth.js               Portal SSO (OAuth login/callback/logout)
routes/connect.js            POST /connect webhook, GET /connect/events
routes/api.js                Dashboard API
middleware/ssoAuth.js        SSO session gate
services/connectService.js   Connect event ingestion, vote update, majority close
services/schedulerService.js Deadline timer, closing/voiding envelopes
services/docusignService.js  DocuSign REST client (JWT)
services/docusignParser.js   Envelope/template normalization and vote counting
services/syncService.js      Template sync
services/emailService.js     Final report emails (SMTP)
services/databaseService.js  Data service layer (only storage interface used by the app)
services/db/redisDriver.js     Redis driver (Upstash REST / TCP / in-memory)
services/db/postgresDriver.js  PostgreSQL driver
services/db/models.js          Row mappers shared by both drivers
services/db/schema.sql         PostgreSQL schema
public/                      Vanilla JS dashboard
```

### Data layer

All storage goes through `services/databaseService.js`, which picks a driver from `DB_PROVIDER`:

- unset / `redis` (current): Upstash REST (`UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`, or `KV_REST_API_URL` + `KV_REST_API_TOKEN`), TCP Redis (`REDIS_URL` / `KV_URL`), or an ephemeral in-memory store when none is set.
- `postgres`: set `DATABASE_URL` (or `POSTGRES_URL`). `schema.sql` is applied on first connect.

Both drivers store the same relational rows (`templates`, `envelopes`, `connect_events`, `sync_meta`), so moving to Postgres is a configuration change.

## HTTP API

All routes below require an SSO session.

| Route | Description |
|-------|-------------|
| `GET /api/votes` | Tracked envelopes and overall totals |
| `POST /api/close/:envelopeId` | Close an open envelope now (voids it in DocuSign, sends report) |
| `POST /api/report/:envelopeId` | Resend the report email |
| `GET /api/templates` | Stored templates (valid / non-voting) and sync metadata |
| `POST /api/templates/sync` | Sync templates from DocuSign (`?full=true` for a full sync) |
| `POST /api/templates/:id/refresh` | Refresh one template from DocuSign |
| `POST /api/templates/:id/config` | Save template config |
| `GET /connect/events` | Recent stored Connect events (`?envelopeId=`, `?limit=`) |

Unauthenticated: `GET /health`, `/auth/*`, static assets, and `POST /connect` (HMAC-verified).

## Configuration

| Variable | Purpose |
|----------|---------|
| `DOCUSIGN_INTEGRATION_KEY`, `DOCUSIGN_USER_ID`, `DOCUSIGN_ACCOUNT_ID` | JWT integration / impersonated user / account |
| `DOCUSIGN_RSA_PRIVATE_KEY` or `DOCUSIGN_RSA_PRIVATE_KEY_PATH` | RSA private key (inline PEM, or file path; default `dev.pem`) |
| `DOCUSIGN_AUTH_SERVER` | `account-d.docusign.com` (demo) or `account.docusign.com` (production) |
| `DOCUSIGN_SECRET_KEY` | OAuth client secret for portal SSO |
| `SSO_ENABLED`, `SSO_REDIRECT_URI`, `SSO_ALLOWED_EMAILS` | SSO toggle (default: on when key + secret are set), fixed redirect URI, email allowlist |
| `SESSION_SECRET` | Session signing secret (falls back to `DOCUSIGN_SECRET_KEY`); required when SSO is on |
| `DOCUSIGN_CONNECT_HMAC_KEY` | Connect HMAC secret (if unset, signatures are not enforced) |
| `DB_PROVIDER`, `DATABASE_URL` / `POSTGRES_URL`, Redis variables above | Storage |
| `SCHEDULER_TICK_MS` | Deadline check interval |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM_NAME`, `SMTP_FROM_EMAIL` | Report emails |
| `PORT` | HTTP port (default 3000) |

Grant DocuSign JWT consent once for the impersonated user. Register `https://<host>/auth/callback` as a redirect URI on the integration key, and point the Connect configuration at `https://<host>/connect`.

## Running

```bash
npm install
npm start        # http://localhost:3000
npm test
```

`api/index.js` and `vercel.json` are a thin serverless adapter that re-exports the Express app; the application code itself has no platform dependencies. The scheduler is an in-process timer, so it only runs where the process stays alive.

## Deployment (AWS)

Low-cost MVP: one **EC2** `t4g.small` (Amazon Linux 2023, ARM, 2 GB RAM) running **Docker Compose** — Node app + Redis 7. No App Runner, RDS, NAT Gateway, or open SSH.

### Architecture

| Piece | Current implementation |
|-------|------------------------|
| Compute | EC2 `t4g.small` (2 vCPU / 2 GB) + Elastic IP, 20 GB encrypted gp3 root volume |
| App + cache | [`docker-compose.yml`](docker-compose.yml): `app` (build from [`Dockerfile`](Dockerfile), host **:80 → :3000**) + `redis` (`redis:7-alpine`, named volume `redisdata`) |
| Install path on instance | `/opt/docusign-vote-counter` |
| Network | Public subnet + IGW; security group allows **TCP 80 only** |
| Shell access | **SSM Session Manager** (AWS Console). Port **22 is closed** |
| Deploy artifacts | S3 bucket `docusign-vote-counter-prod-deploy-<account-id>` (objects expire after 14 days) |
| CI/CD | Push or manual on `main` → [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) |
| IaC | [`terraform/`](terraform/) — Terraform **≥ 1.11**, S3 backend with `use_lockfile` (no DynamoDB) |
| Auth | Temporary HTTP Basic Auth (`APP_BASIC_AUTH_*`). `/health` is unauthenticated |
| TLS / custom domain | Not configured — URL is `http://<elastic-ip>` |

**Rough cost:** ~\$12–18/mo (EC2 `t4g.small` + EBS + EIP). Override with `instance_type = "t4g.medium"` in Terraform if you want 4 GB RAM.

### What a Deploy run does

1. Assume the GitHub OIDC IAM role (`AWS_ROLE_ARN`)
2. `terraform apply` — VPC, EC2, EIP, IAM instance profile (SSM + S3 read), deploy bucket
3. Build `.env` from GitHub secrets/vars
4. Package the repo as `app.tgz` (excludes `.git`, `node_modules`, `terraform`, `.github`, …)
5. Upload `app.tgz` and `.env` to `s3://…/releases/<git-sha>/`
6. Wait until the instance SSM agent is **Online**
7. **SSM Run Command**: pull artifacts → extract to `/opt/docusign-vote-counter` → `docker compose up -d --build`
8. Print `service_url` and `instance_id`

```
GitHub secrets/vars
        │
        ├──► terraform apply → EC2 (SSM role) + EIP + deploy S3 bucket
        │
        └──► app.tgz + .env → S3
                    │
                    ▼
              SSM Run Command → docker compose up --build
```

### First-time setup

1. AWS CLI with rights to create IAM + S3 (bootstrap), then the full EC2 stack via Terraform
2. Bootstrap state bucket + OIDC deploy role:

```bash
export AWS_REGION=us-east-1
export GITHUB_ORG=onboardllc
export GITHUB_REPO=docusignVoteCounter
./terraform/bootstrap.sh
```

3. In GitHub: **Settings → Secrets and variables → Actions** — set secrets/variables from the bootstrap output. `AWS_ROLE_ARN` must be the **full ARN** printed by the script (not just the role name).
4. Grant DocuSign **JWT consent** once for the API user
5. Push to `main` or run workflow **Deploy** → **Run workflow**
6. Open **Service URL** from the Actions log; sign in with Basic Auth

To reset a broken OIDC / first-deploy setup from scratch:

```bash
./terraform/teardown-bootstrap.sh
export AWS_REGION=us-east-1
export GITHUB_ORG=onboardllc
export GITHUB_REPO=docusignVoteCounter
./terraform/bootstrap.sh
```

Then update GitHub `AWS_ROLE_ARN` / `TF_STATE_BUCKET` / `AWS_ACCOUNT_ID` from the bootstrap output and re-run Deploy.

**OIDC note (2026):** New GitHub repos use **immutable** OIDC subjects like `repo:onboardllc@123/docusignVoteCounter@456:ref:refs/heads/main`. Bootstrap trusts both that format and the legacy `repo:onboardllc/docusignVoteCounter:*` pattern. If AssumeRole still fails, check the workflow **Debug OIDC token claims** step for the real `sub` value.

### GitHub secrets

Path: **Settings → Secrets and variables → Actions → Secrets**

| Name | Required | Purpose | How to obtain |
|------|----------|---------|---------------|
| `AWS_ROLE_ARN` | Yes | OIDC role for Terraform + S3 upload + SSM Run Command | **Full ARN** from bootstrap, e.g. `arn:aws:iam::123456789012:role/docusign-vote-counter-github-actions` (not the role name alone) |
| `TF_STATE_BUCKET` | Yes | Terraform state + native `.tflock` files | Bootstrap output (`docusign-vote-counter-tfstate-<account-id>`) |
| `DOCUSIGN_INTEGRATION_KEY` | Yes | JWT integration / client ID | DocuSign Admin → **Apps and Keys** → Integration Key ([demo Admin](https://admindemo.docusign.com/) or production Admin) |
| `DOCUSIGN_USER_ID` | Yes | User GUID to impersonate | Admin → **Users** → User ID |
| `DOCUSIGN_ACCOUNT_ID` | Yes | API Account ID | Apps and Keys → **API Account ID** |
| `DOCUSIGN_RSA_PRIVATE_KEY` | Yes | JWT RSA private key (PEM) | Apps and Keys → generate RSA keypair → paste full private key including `BEGIN`/`END` |
| `SMTP_USER` | Yes | SMTP username | Mailbox (e.g. Gmail) |
| `SMTP_PASS` | Yes | SMTP password / app password | [Gmail App Password](https://support.google.com/accounts/answer/185833) or Microsoft 365 SMTP password |
| `APP_BASIC_AUTH_PASSWORD` | Yes | Shared password for dashboard + `/api` | Choose a strong password |

No SSH keys. Redis is local to the instance (Compose network only; no password). Cache survives `docker compose up --build`; it is lost if the instance or `redisdata` volume is destroyed.

### GitHub variables

Path: **Settings → Secrets and variables → Actions → Variables**

| Name | Required | Example | Notes |
|------|----------|---------|-------|
| `AWS_REGION` | Yes | `us-east-1` | Must match bootstrap / Terraform |
| `AWS_ACCOUNT_ID` | Recommended | `123456789012` | Printed by bootstrap. Required if `AWS_ROLE_ARN` is only a role name; unused when the secret is a full ARN |
| `DOCUSIGN_AUTH_SERVER` | Yes | `account.docusign.com` | `account-d.docusign.com` = demo; `account.docusign.com` = production |
| `SMTP_HOST` | Yes | `smtp.gmail.com` | Or `smtp.office365.com` |
| `SMTP_PORT` | Yes | `587` | Use `465` with `SMTP_SECURE=true` if needed |
| `SMTP_SECURE` | Yes | `false` | |
| `SMTP_FROM_NAME` | No | `DocuSign Vote Counter` | Defaults in the workflow if empty |
| `SMTP_FROM_EMAIL` | No | | Defaults to `SMTP_USER` |
| `APP_BASIC_AUTH_USER` | No | `admin` | Defaults to `admin` |

### Multiline PEM (`DOCUSIGN_RSA_PRIVATE_KEY`)

Paste the entire PEM (multiple lines) into the GitHub secret. Do not wrap in quotes. If a tool stored literal `\n`, the app expands those at runtime.

### Security group

| Port | Open? | Purpose |
|------|-------|---------|
| 80 | Yes (`0.0.0.0/0`) | Public HTTP for the Compose-published app |
| 22 | **No** | Shell via Session Manager only |
| 443 | No | No TLS yet |

### Shell access (AWS Console)

1. **EC2** → instance → **Connect** → **Session Manager**, or **Systems Manager** → **Session Manager** → Start session
2. Your IAM user/role needs `ssm:StartSession` (admin console access — not the GitHub deploy role)

### After deploy

1. Open `http://<elastic-ip>` (`terraform output service_url` or the workflow log)
2. Sign in with Basic Auth (`APP_BASIC_AUTH_USER` / `APP_BASIC_AUTH_PASSWORD`)
3. On boot the app connects to Redis and serves `GET /health`
4. Redis AOF data persists on the Docker volume across redeploys; it is lost if the EC2 instance/volume is destroyed

### Runtime env on the instance (`.env`)

Written by CI to `/opt/docusign-vote-counter/.env` (mode `600`):

| Variable | Source |
|----------|--------|
| `NODE_ENV` | `production` (set by CI) |
| `REDIS_URL` | Set by Compose to `redis://redis:6379` |
| `DOCUSIGN_*` | GitHub secrets/vars |
| `SMTP_*` | GitHub secrets/vars |
| `APP_BASIC_AUTH_USER` / `APP_BASIC_AUTH_PASSWORD` | GitHub var/secret |

### Local development

```bash
# Full stack (same Compose file as production)
# Create a .env with DocuSign/SMTP/Basic Auth vars (Compose sets REDIS_URL)
docker compose up --build
# App: http://localhost
```


Or run Node against local Redis with `npm start`, `REDIS_URL`, and a `.env` / `DOCUSIGN_RSA_PRIVATE_KEY_PATH`.

### Local Terraform (optional)

```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars
terraform init \
  -backend-config="bucket=<TF_STATE_BUCKET>" \
  -backend-config="key=docusign-vote-counter/prod/terraform.tfstate" \
  -backend-config="region=us-east-1"
terraform apply
terraform output service_url
terraform output instance_id
terraform output deploy_bucket
```

Infra only — app code and `.env` are still delivered by the GitHub Actions deploy steps (or manually via S3 + SSM).
