"""Slack notification service for scheduled reports."""

import logging

from slack_sdk.webhook import WebhookClient

from app.config import settings

logger = logging.getLogger(__name__)


def send_report(title: str, body: str) -> bool:
    """Send a trend report summary to Slack."""
    if not settings.slack_webhook_url:
        logger.warning("SLACK_WEBHOOK_URL not configured — skipping notification")
        return False

    webhook = WebhookClient(settings.slack_webhook_url)

    # Truncate body for Slack (max ~3000 chars in a section block)
    truncated = body[:2900] + "..." if len(body) > 2900 else body

    try:
        response = webhook.send(
            text=f"*{title}*\n{truncated}",
            blocks=[
                {
                    "type": "header",
                    "text": {"type": "plain_text", "text": title, "emoji": True},
                },
                {
                    "type": "section",
                    "text": {"type": "mrkdwn", "text": truncated},
                },
            ],
        )
        if response.status_code == 200:
            logger.info(f"Slack notification sent: {title}")
            return True
        else:
            logger.error(f"Slack webhook returned {response.status_code}: {response.body}")
            return False
    except Exception:
        logger.exception("Failed to send Slack notification")
        return False
