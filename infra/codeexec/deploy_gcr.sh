#!/usr/bin/env bash

# Deploy the code execution service to Google Cloud Run.
#
# This script builds the Docker image, pushes it to Artifact Registry
# and deploys a new Cloud Run revision.  Edit the variables below to
# suit your project.  You must be authenticated with gcloud and have
# the Artifact Registry and Cloud Run APIs enabled.

set -euo pipefail

###############################################################################
# Configuration
###############################################################################
# TODO: update these variables before running the script
PROJECT_ID="your-gcp-project"
REGION="europe-west1"
SERVICE_NAME="codeexec"
IMAGE_NAME="codeexec"
REPO="codeexec-repo"  # Artifact Registry repository
CODEEXEC_API_KEY=""   # e.g. set to your secret key
CODEEXEC_GCS_BUCKET=""  # If using GCS storage backend, specify the bucket

###############################################################################
# Build and push image
###############################################################################
echo "Building Docker image..."
gcloud builds submit \
  --project "$PROJECT_ID" \
  --tag "$REGION-docker.pkg.dev/$PROJECT_ID/$REPO/$IMAGE_NAME:latest" \
  ./infra/codeexec

###############################################################################
# Deploy to Cloud Run
###############################################################################
echo "Deploying to Cloud Run..."

# Construct environment variable flags
ENV_VARS="CODEEXEC_API_KEY=$CODEEXEC_API_KEY,CODEEXEC_STORAGE_BACKEND=gcs,CODEEXEC_GCS_BUCKET=$CODEEXEC_GCS_BUCKET"

gcloud run deploy "$SERVICE_NAME" \
  --project "$PROJECT_ID" \
  --image "$REGION-docker.pkg.dev/$PROJECT_ID/$REPO/$IMAGE_NAME:latest" \
  --region "$REGION" \
  --platform managed \
  --memory 2Gi \
  --cpu 2 \
  --timeout 300 \
  --set-env-vars "$ENV_VARS" \
  --no-allow-unauthenticated

echo "Deployment complete.  To retrieve the service URL run:"
echo "gcloud run services describe $SERVICE_NAME --project $PROJECT_ID --region $REGION --format='get(status.url)'"