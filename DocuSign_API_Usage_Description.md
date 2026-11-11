# DocuSign API Usage Description

The "Vote Counter" integrates with DocuSign for board referendums and case presentations. Votes are received through **DocuSign Connect** webhooks. The REST API is used only for template configuration, reading a single envelope's details, and voiding envelopes when the voting period ends.

## Authentication

- **Server-to-server (REST API):** OAuth **JWT Grant**, signed with the integration's RSA private key (certificate), scopes `signature impersonation`. This is the only credential used for API calls.
- **Portal sign-in:** OAuth 2.0 Authorization Code (SSO), scope `signature`. Used only to identify the person using the dashboard (`/oauth/userinfo`). The token is discarded and never used for API calls.
- **Connect:** Each webhook is verified with HMAC-SHA256 (`X-DocuSign-Signature-1`).

## Connect webhooks

`POST /connect` receives envelope events. Each event is stored and triggers a re-read of that envelope, so vote totals are computed from DocuSign's current recipient tab data. When `floor(n/2) + 1` of the `n` eligible voters have voted, the envelope is closed and the report emailed.

## REST endpoints used

| Operation | Endpoint | Purpose |
|-----------|----------|---------|
| Token | `POST /oauth/token` | JWT grant (API) and authorization-code exchange (portal SSO) |
| User info | `GET /oauth/userinfo` | Resolve account `base_uri`; identify SSO user |
| List templates | `GET /accounts/{accountId}/templates` | Admin template sync (incremental by created date, or full) |
| Template details | `GET /accounts/{accountId}/templates/{templateId}` | Refresh a single template |
| Template recipients | `GET /accounts/{accountId}/templates/{templateId}/recipients?include_tabs=true` | Discover vote controls (checkboxes / radio groups) |
| Envelope | `GET /accounts/{accountId}/envelopes/{envelopeId}` | Envelope metadata for a webhook event |
| Envelope recipients | `GET /accounts/{accountId}/envelopes/{envelopeId}/recipients?include_tabs=true` | Per-voter selections used to count votes |
| Envelope documents | `GET /accounts/{accountId}/envelopes/{envelopeId}/documents` | Template matching |
| DocGen fields | `GET /accounts/{accountId}/envelopes/{envelopeId}/docGenFormFields` | Voting deadline and summary text |
| Void envelope | `PUT /accounts/{accountId}/envelopes/{envelopeId}` | Close voting at the deadline or on manual close (`voidedReason`) |

## Voting deadline

The deadline is read from the template fields `Fecha Limite para votar`, `Hora limite votar`, `Minutos Limite para votar` and `Meridiem Limite para votar`. An in-process scheduler saves the latest vote data first (DocuSign drops tab data after a void), then voids the envelope in DocuSign to block late votes.
