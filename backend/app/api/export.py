"""Export endpoints — create Google Sheets from table data."""

import json
import logging
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/export", tags=["export"])


class SheetRequest(BaseModel):
    title: str
    headers: list[str]
    rows: list[list]
    col_formats: dict[str, str] | None = None  # col index (as string) → Sheets format pattern
    notes: list[str] | None = None  # lines for the Notes tab


@router.post("/gsheet")
async def create_gsheet(request: SheetRequest):
    """Create a Google Sheet with formatted data and optional Notes tab."""
    try:
        result = _create_sheet(
            title=request.title,
            headers=request.headers,
            rows=request.rows,
            col_formats=request.col_formats,
            notes=request.notes,
        )
        return result
    except Exception as e:
        logger.exception("Failed to create Google Sheet")
        raise HTTPException(status_code=500, detail=str(e))


def _create_sheet(
    title: str,
    headers: list[str],
    rows: list[list],
    col_formats: dict[str, str] | None = None,
    notes: list[str] | None = None,
) -> dict:
    """Create a Google Sheet via the Sheets API."""
    import google.auth
    from googleapiclient.discovery import build

    creds, project = google.auth.default(
        scopes=["https://www.googleapis.com/auth/spreadsheets"]
    )
    service = build("sheets", "v4", credentials=creds)

    # Build spreadsheet with Data sheet (and Notes sheet if needed)
    sheets_config = [{"properties": {"title": "Data", "sheetId": 0}}]
    if notes:
        sheets_config.append({"properties": {"title": "Notes", "sheetId": 1}})

    spreadsheet = service.spreadsheets().create(
        body={
            "properties": {"title": title},
            "sheets": sheets_config,
        }
    ).execute()

    spreadsheet_id = spreadsheet["spreadsheetId"]
    url = spreadsheet["spreadsheetUrl"]

    # Write Data sheet
    all_rows = [headers] + rows
    service.spreadsheets().values().update(
        spreadsheetId=spreadsheet_id,
        range="Data!A1",
        valueInputOption="RAW",
        body={"values": all_rows},
    ).execute()

    # Build batch update requests
    requests = []

    # Bold header row with grey background
    requests.append({
        "repeatCell": {
            "range": {"sheetId": 0, "startRowIndex": 0, "endRowIndex": 1},
            "cell": {
                "userEnteredFormat": {
                    "textFormat": {"bold": True},
                    "backgroundColor": {"red": 0.95, "green": 0.95, "blue": 0.95},
                }
            },
            "fields": "userEnteredFormat(textFormat,backgroundColor)",
        }
    })

    # Apply number formats per column
    if col_formats:
        for col_idx_str, pattern in col_formats.items():
            col_idx = int(col_idx_str)
            requests.append({
                "repeatCell": {
                    "range": {
                        "sheetId": 0,
                        "startRowIndex": 1,  # skip header
                        "endRowIndex": len(all_rows),
                        "startColumnIndex": col_idx,
                        "endColumnIndex": col_idx + 1,
                    },
                    "cell": {
                        "userEnteredFormat": {
                            "numberFormat": {
                                "type": "NUMBER",
                                "pattern": pattern,
                            }
                        }
                    },
                    "fields": "userEnteredFormat.numberFormat",
                }
            })

    # Freeze header row
    requests.append({
        "updateSheetProperties": {
            "properties": {
                "sheetId": 0,
                "gridProperties": {"frozenRowCount": 1},
            },
            "fields": "gridProperties.frozenRowCount",
        }
    })

    # Auto-resize columns
    requests.append({
        "autoResizeDimensions": {
            "dimensions": {
                "sheetId": 0,
                "dimension": "COLUMNS",
                "startIndex": 0,
                "endIndex": len(headers),
            }
        }
    })

    # Write Notes sheet if provided
    if notes:
        notes_rows = [[line] for line in notes]
        service.spreadsheets().values().update(
            spreadsheetId=spreadsheet_id,
            range="Notes!A1",
            valueInputOption="RAW",
            body={"values": notes_rows},
        ).execute()

        # Style the Notes sheet — wider column, wrap text
        requests.append({
            "updateDimensionProperties": {
                "range": {
                    "sheetId": 1,
                    "dimension": "COLUMNS",
                    "startIndex": 0,
                    "endIndex": 1,
                },
                "properties": {"pixelSize": 800},
                "fields": "pixelSize",
            }
        })
        requests.append({
            "repeatCell": {
                "range": {
                    "sheetId": 1,
                    "startRowIndex": 0,
                    "endRowIndex": len(notes_rows),
                    "startColumnIndex": 0,
                    "endColumnIndex": 1,
                },
                "cell": {
                    "userEnteredFormat": {
                        "wrapStrategy": "WRAP",
                    }
                },
                "fields": "userEnteredFormat.wrapStrategy",
            }
        })
        # Bold "Description:" and "SQL Queries:" labels
        for i, line in enumerate(notes):
            if line.endswith(":") and line in ("Description:", "SQL Queries:"):
                requests.append({
                    "repeatCell": {
                        "range": {
                            "sheetId": 1,
                            "startRowIndex": i,
                            "endRowIndex": i + 1,
                            "startColumnIndex": 0,
                            "endColumnIndex": 1,
                        },
                        "cell": {
                            "userEnteredFormat": {
                                "textFormat": {"bold": True, "fontSize": 11},
                            }
                        },
                        "fields": "userEnteredFormat.textFormat",
                    }
                })

    # Execute all formatting
    if requests:
        service.spreadsheets().batchUpdate(
            spreadsheetId=spreadsheet_id,
            body={"requests": requests},
        ).execute()

    logger.info(f"Created Google Sheet: {url}")
    return {"url": url, "spreadsheet_id": spreadsheet_id}
