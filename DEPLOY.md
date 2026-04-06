# Deploying the RTIC Data Agent

Single Cloud Run container serving the FastAPI backend + React frontend, with IAP for access control and Cloud Scheduler for autonomous analysis.

## Prerequisites

- `gcloud` CLI installed and authenticated (`gcloud auth login`)
- DNS access for the domain you'll use (e.g. `agent.velky-brands.com`)
- A Slack incoming webhook URL (for scheduled report notifications)

## 1. Enable GCP APIs

```bash
gcloud services enable \
  run.googleapis.com \
  compute.googleapis.com \
  iap.googleapis.com \
  cloudscheduler.googleapis.com \
  storage.googleapis.com
```

## 2. Create the GCS bucket

```bash
gsutil mb -l us-central1 gs://velky-brands-data-agent
```

## 3. Deploy to Cloud Run

From the project root (`agent/`):

```bash
gcloud run deploy data-agent \
  --source . \
  --region us-central1 \
  --no-allow-unauthenticated \
  --memory 1Gi \
  --timeout 300 \
  --set-env-vars "GOOGLE_CLOUD_PROJECT=velky-brands,GCS_BUCKET=velky-brands-data-agent,SLACK_WEBHOOK_URL=https://hooks.slack.com/services/XXX/YYY/ZZZ"
```

This builds the multi-stage Dockerfile (compiles the React frontend, bundles it into the Python image) and deploys in one step.

## 4. Grant IAM permissions to the Cloud Run service account

Find the service account:

```bash
gcloud run services describe data-agent \
  --region us-central1 \
  --format 'value(spec.template.spec.serviceAccountName)'
```

Grant it the roles it needs:

```bash
SA="YOUR_SERVICE_ACCOUNT_EMAIL"

# BigQuery read + query access
gcloud projects add-iam-policy-binding velky-brands \
  --member="serviceAccount:$SA" \
  --role="roles/bigquery.dataViewer"

gcloud projects add-iam-policy-binding velky-brands \
  --member="serviceAccount:$SA" \
  --role="roles/bigquery.jobUser"

# GCS bucket access for conversation/report storage
gsutil iam ch "serviceAccount:${SA}:objectAdmin" gs://velky-brands-data-agent
```

## 5. Set up the load balancer

IAP requires an HTTPS load balancer in front of Cloud Run.

### Create a serverless Network Endpoint Group (NEG)

```bash
gcloud compute network-endpoint-groups create data-agent-neg \
  --region=us-central1 \
  --network-endpoint-type=serverless \
  --cloud-run-service=data-agent
```

### Create the backend service

```bash
gcloud compute backend-services create data-agent-backend \
  --global \
  --load-balancing-scheme=EXTERNAL_MANAGED

gcloud compute backend-services add-backend data-agent-backend \
  --global \
  --network-endpoint-group=data-agent-neg \
  --network-endpoint-group-region=us-central1
```

### Create the URL map

```bash
gcloud compute url-maps create data-agent-lb \
  --default-service=data-agent-backend
```

### Create the SSL certificate

```bash
gcloud compute ssl-certificates create data-agent-cert \
  --domains=agent.velky-brands.com
```

Replace `agent.velky-brands.com` with your actual domain. Google will auto-provision and renew the cert once DNS is pointed correctly.

### Create the HTTPS proxy and forwarding rule

```bash
gcloud compute target-https-proxies create data-agent-https-proxy \
  --ssl-certificates=data-agent-cert \
  --url-map=data-agent-lb

gcloud compute forwarding-rules create data-agent-fw \
  --global \
  --target-https-proxy=data-agent-https-proxy \
  --ports=443
```

## 6. Configure DNS

Get the load balancer's IP:

```bash
gcloud compute forwarding-rules describe data-agent-fw \
  --global --format='value(IPAddress)'
```

Create an A record in your DNS provider:

```
agent.velky-brands.com  →  <IP from above>
```

The Google-managed SSL certificate will not become active until DNS is pointing to the load balancer. This can take up to 24 hours but usually completes in 15–30 minutes.

## 7. Enable IAP

```bash
gcloud iap web enable \
  --resource-type=backend-services \
  --service=data-agent-backend
```

This creates an OAuth consent screen and client automatically. If prompted to configure the OAuth consent screen first, do so in the Cloud Console under **APIs & Services > OAuth consent screen** (internal type for Workspace domains).

## 8. Grant user access through IAP

```bash
# Grant access to an entire Google Workspace domain
gcloud iap web add-iam-policy-binding \
  --resource-type=backend-services \
  --service=data-agent-backend \
  --member="domain:velky-brands.com" \
  --role="roles/iap.httpsResourceAccessUser"

# Or grant access to individual users
gcloud iap web add-iam-policy-binding \
  --resource-type=backend-services \
  --service=data-agent-backend \
  --member="user:scott@velky-brands.com" \
  --role="roles/iap.httpsResourceAccessUser"
```

## 9. Set up Cloud Scheduler

The scheduler needs its own service account to authenticate through IAP.

### Create the scheduler service account

```bash
gcloud iam service-accounts create scheduler-agent \
  --display-name="Cloud Scheduler for Data Agent"
```

### Grant it Cloud Run Invoker

```bash
gcloud run services add-iam-policy-binding data-agent \
  --region=us-central1 \
  --member="serviceAccount:scheduler-agent@velky-brands.iam.gserviceaccount.com" \
  --role="roles/run.invoker"
```

### Get the IAP OAuth client ID

Find it in the Cloud Console under **Security > Identity-Aware Proxy**, click the three dots next to `data-agent-backend`, and select **Go to OAuth configuration**. Copy the **Client ID**. You'll use this as the OIDC audience.

Or retrieve it via CLI:

```bash
gcloud iap oauth-clients list \
  --project=velky-brands \
  --format='value(name)'
```

### Create the scheduler jobs

Replace `IAP_CLIENT_ID` below with the OAuth client ID from the previous step.

```bash
SERVICE_URL=$(gcloud run services describe data-agent \
  --region us-central1 \
  --format 'value(status.url)')

SA_EMAIL="scheduler-agent@velky-brands.iam.gserviceaccount.com"
IAP_CLIENT_ID="YOUR_IAP_CLIENT_ID"

# Daily trend scan — 8:00 AM CT every day
gcloud scheduler jobs create http data-agent-daily-trends \
  --location=us-central1 \
  --schedule="0 8 * * *" \
  --time-zone="America/Chicago" \
  --uri="${SERVICE_URL}/api/scheduled/daily-trends" \
  --http-method=POST \
  --oidc-service-account-email="$SA_EMAIL" \
  --oidc-token-audience="$IAP_CLIENT_ID" \
  --attempt-deadline=600s \
  --description="Daily trend scan at 8 AM CT"

# Weekly deep dive — 7:00 AM CT every Monday
gcloud scheduler jobs create http data-agent-weekly-deep-dive \
  --location=us-central1 \
  --schedule="0 7 * * 1" \
  --time-zone="America/Chicago" \
  --uri="${SERVICE_URL}/api/scheduled/weekly-deep-dive" \
  --http-method=POST \
  --oidc-service-account-email="$SA_EMAIL" \
  --oidc-token-audience="$IAP_CLIENT_ID" \
  --attempt-deadline=600s \
  --description="Weekly deep dive at 7 AM CT on Mondays"
```

## 10. Set up Slack notifications

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app (From Scratch)
2. Under **Incoming Webhooks**, activate and add a webhook to your `#data-insights` channel
3. Copy the webhook URL — it was already set in the `SLACK_WEBHOOK_URL` env var during deploy (step 3)

To update it later:

```bash
gcloud run services update data-agent \
  --region us-central1 \
  --set-env-vars "SLACK_WEBHOOK_URL=https://hooks.slack.com/services/NEW/URL/HERE"
```

## Verification

### Test the health endpoint (bypassing IAP, directly to Cloud Run)

```bash
SERVICE_URL=$(gcloud run services describe data-agent \
  --region us-central1 --format 'value(status.url)')

curl -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
  "${SERVICE_URL}/health"
```

### Test through IAP

Visit `https://agent.velky-brands.com` in a browser. You should see a Google sign-in prompt, then the React chat UI after authenticating.

### Test a scheduled job manually

```bash
gcloud scheduler jobs run data-agent-daily-trends --location=us-central1
```

Check Slack for the report, and verify it was saved:

```bash
curl -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
  "${SERVICE_URL}/api/scheduled/reports"
```

## Redeploying

After code changes, redeploy from the project root:

```bash
gcloud run deploy data-agent \
  --source . \
  --region us-central1
```

The load balancer, IAP, scheduler, and all other infrastructure stays in place. Only the container image is rebuilt and swapped.
