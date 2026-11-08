# DocuSign Vote Counter & Form Data Aggregator

The **DocuSign Vote Counter** is an automated Node.js application designed to streamline, track, and tally voting processes conducted through DocuSign envelopes. Originally built to handle board referendums and case presentations, the application acts as an intelligent intermediary that seamlessly pulls signed envelopes, analyzes custom form fields (like checkboxes), calculates voting results, and automatically coordinates reporting once the voting window closes.

Instead of manually reviewing DocuSign envelopes to see who voted for what, this system automatically aggregates the choices (e.g., *A Favor*, *No a Favor*, *Abstenido*) across all recipients in real time, exposing the live results to a clean, user-friendly frontend dashboard.

## How It Works

The system operates under the philosophy that **DocuSign is the ultimate source of truth**. 

1. **Synchronization**: On demand or at startup, the sync service reaches out to the DocuSign eSignature REST API via secure JWT (JSON Web Token) authentication.
2. **Parsing & Normalization**: As envelopes are fetched, a dedicated parser examines each document. It identifies the template type (e.g., *Board Referendum* vs. *Presentacion de Casos*), extracts relevant metadata (like voting deadlines), and validates recipient checkboxes against a configured list of valid vote options.
3. **Storage & Caching**: The normalized envelope data, recipient statuses, and calculated totals are saved in **Redis** to serve the frontend API quickly without hitting DocuSign API rate limits.
4. **Lifecycle Management**: A background scheduler continuously monitors active votes. When a predefined expiration time is reached, the system automatically intervenes—it voids the envelope in DocuSign to prevent late voting, updates the local Redis cache, and triggers an email report with the final tally.

## Development Stack

The application is built on a lightweight, highly efficient technology stack tailored for rapid I/O operations and easy extensibility.

### Backend Core
* **Node.js**: The core runtime environment powering the asynchronous engine of the application.
* **Express.js**: A minimal web framework used to expose a clean RESTful API (`/api/votes`, `/api/refresh`, etc.) and serve the static frontend files.
* **Redis**: In-memory cache (with AOF persistence in Compose) for envelopes and the active-presentaciones index.

### Third-Party Integrations
* **DocuSign eSignature REST API**: The backbone of the document management process. The app uses the advanced JWT Grant OAuth flow for server-to-server authentication, allowing it to impersonate system users and perform actions (like fetching and voiding envelopes) seamlessly in the background.
* **Nodemailer**: A module for Node.js applications to send emails easily. It is used to dispatch final voting tally reports to administrators once an envelope is successfully closed or expired.

### Frontend
* **Vanilla Web Technologies**: The dashboard interface (located in the `public/` directory) is built using standard HTML5, CSS3, and vanilla JavaScript (`client.js`). This avoids the overhead of heavy frontend frameworks while keeping the application highly performant and easy to deploy.

## Architecture Highlights

* **Service-Oriented Structure**: The codebase is neatly divided into domain-specific services (`databaseService.js`, `docusignService.js`, `emailService.js`, etc.) residing in the `/services` directory. This modularity makes testing and swapping out logic incredibly straightforward.
* **Dynamic Configuration**: The `config.js` file allows administrators to map checkbox labels dynamically based on the template type. This means the system can adapt to new DocuSign templates without requiring deep code refactoring. 
* **Self-Healing State**: By treating DocuSign as the immutable source of truth, the application easily recovers from downtime. A simple cache refresh will re-align Redis with DocuSign.
* **Data Preservation**: When DocuSign voids an envelope (e.g., due to expiration), it drops underlying template data from its API responses. The sync engine detects this state and intelligently merges the voided record with locally cached data, ensuring historical votes and metadata are never lost.

## API Usage

The application exposes a RESTful API under the `/api` route to interact with the backend:

- **`GET /api/votes`**
  Returns all envelopes currently cached in Redis, along with overall voting totals.

- **`POST /api/refresh`**
  Admin trigger to re-sync the local cache with DocuSign. This fetches the latest envelope statuses and form data.

- **`POST /api/report/:envelopeId`**
  Manually triggers the email service to resend the final voting tally report for a specific envelope.

- **`POST /api/close/:envelopeId`**
  Manual "Close Now" for *Presentacion de Casos* envelopes. Closes the envelope, prevents further voting, and sends the final report.

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
