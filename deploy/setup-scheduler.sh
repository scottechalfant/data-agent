#!/bin/bash
# Set up Cloud Scheduler jobs for autonomous trend analysis.
# Run this after deploying to Cloud Run.
#
# Prerequisites:
#   - gcloud CLI authenticated
#   - Cloud Run service deployed (get URL from: gcloud run services describe data-agent --region us-central1 --format 'value(status.url)')
#   - Service account with Cloud Run Invoker role

set -euo pipefail

PROJECT_ID="${PROJECT_ID:-velky-brands}"
REGION="us-central1"
SERVICE_NAME="data-agent"

# Get the Cloud Run service URL
SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  --format 'value(status.url)')

echo "Cloud Run URL: $SERVICE_URL"

# Create a service account for the scheduler (if it doesn't exist)
SA_NAME="scheduler-agent"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud iam service-accounts describe "$SA_EMAIL" --project "$PROJECT_ID" 2>/dev/null || \
  gcloud iam service-accounts create "$SA_NAME" \
    --display-name="Cloud Scheduler for Data Agent" \
    --project "$PROJECT_ID"

# Grant it Cloud Run Invoker
gcloud run services add-iam-policy-binding "$SERVICE_NAME" \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/run.invoker"

# Daily trend scan — every morning at 8:00 AM CT
gcloud scheduler jobs create http "data-agent-daily-trends" \
  --location "$REGION" \
  --project "$PROJECT_ID" \
  --schedule "0 8 * * *" \
  --time-zone "America/Chicago" \
  --uri "${SERVICE_URL}/api/scheduled/daily-trends" \
  --http-method POST \
  --oidc-service-account-email "$SA_EMAIL" \
  --oidc-token-audience "$SERVICE_URL" \
  --attempt-deadline "600s" \
  --description "Daily trend scan at 8 AM CT" \
  2>/dev/null || \
gcloud scheduler jobs update http "data-agent-daily-trends" \
  --location "$REGION" \
  --project "$PROJECT_ID" \
  --schedule "0 8 * * *" \
  --time-zone "America/Chicago" \
  --uri "${SERVICE_URL}/api/scheduled/daily-trends" \
  --http-method POST \
  --oidc-service-account-email "$SA_EMAIL" \
  --oidc-token-audience "$SERVICE_URL" \
  --attempt-deadline "600s"

# Weekly deep dive — every Monday at 7:00 AM CT
gcloud scheduler jobs create http "data-agent-weekly-deep-dive" \
  --location "$REGION" \
  --project "$PROJECT_ID" \
  --schedule "0 7 * * 1" \
  --time-zone "America/Chicago" \
  --uri "${SERVICE_URL}/api/scheduled/weekly-deep-dive" \
  --http-method POST \
  --oidc-service-account-email "$SA_EMAIL" \
  --oidc-token-audience "$SERVICE_URL" \
  --attempt-deadline "600s" \
  --description "Weekly deep dive at 7 AM CT on Mondays" \
  2>/dev/null || \
gcloud scheduler jobs update http "data-agent-weekly-deep-dive" \
  --location "$REGION" \
  --project "$PROJECT_ID" \
  --schedule "0 7 * * 1" \
  --time-zone "America/Chicago" \
  --uri "${SERVICE_URL}/api/scheduled/weekly-deep-dive" \
  --http-method POST \
  --oidc-service-account-email "$SA_EMAIL" \
  --oidc-token-audience "$SERVICE_URL" \
  --attempt-deadline "600s"

echo ""
echo "Scheduler jobs configured:"
gcloud scheduler jobs list --location "$REGION" --project "$PROJECT_ID"
