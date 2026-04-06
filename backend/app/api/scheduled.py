"""Scheduled/autonomous analysis endpoints — triggered by Cloud Scheduler."""

import logging

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from app.agent.core import run_autonomous
from app.agent.prompts import DAILY_TREND_SCAN_PROMPT, WEEKLY_DEEP_DIVE_PROMPT
from app.services.storage import save_trend_report
from app.services.slack import send_report

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/scheduled", tags=["scheduled"])


class ScheduledResponse(BaseModel):
    report_id: str
    message: str
    tool_calls_made: list[str]
    slack_sent: bool


def _verify_scheduler_token(auth_header: str | None):
    """
    In production, verify the OIDC token from Cloud Scheduler.
    For now, just check that *some* auth header is present.
    TODO: Validate the JWT against Google's OIDC endpoint.
    """
    if auth_header is None:
        raise HTTPException(status_code=401, detail="Missing authorization header")


@router.post("/daily-trends", response_model=ScheduledResponse)
async def daily_trends(authorization: str | None = Header(default=None)):
    """Run the daily trend scan. Called by Cloud Scheduler."""
    _verify_scheduler_token(authorization)

    logger.info("Starting daily trend scan")
    response = await run_autonomous(DAILY_TREND_SCAN_PROMPT)

    # Save to Firestore
    report_id = await save_trend_report({
        "type": "daily_trends",
        "message": response.message,
        "tool_calls_made": response.tool_calls_made,
    })

    # Send to Slack
    slack_sent = send_report("Daily Trend Scan", response.message)

    logger.info(f"Daily trend scan complete. Report ID: {report_id}")
    return ScheduledResponse(
        report_id=report_id,
        message=response.message,
        tool_calls_made=response.tool_calls_made,
        slack_sent=slack_sent,
    )


@router.post("/weekly-deep-dive", response_model=ScheduledResponse)
async def weekly_deep_dive(authorization: str | None = Header(default=None)):
    """Run the weekly deep-dive analysis. Called by Cloud Scheduler."""
    _verify_scheduler_token(authorization)

    logger.info("Starting weekly deep dive")
    response = await run_autonomous(WEEKLY_DEEP_DIVE_PROMPT)

    report_id = await save_trend_report({
        "type": "weekly_deep_dive",
        "message": response.message,
        "tool_calls_made": response.tool_calls_made,
    })

    slack_sent = send_report("Weekly Deep Dive", response.message)

    logger.info(f"Weekly deep dive complete. Report ID: {report_id}")
    return ScheduledResponse(
        report_id=report_id,
        message=response.message,
        tool_calls_made=response.tool_calls_made,
        slack_sent=slack_sent,
    )


@router.get("/reports")
async def get_reports():
    """List recent trend reports."""
    from app.services.storage import list_trend_reports
    return await list_trend_reports()
