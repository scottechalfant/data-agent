"""User identity resolution.

In production behind IAP: reads X-Goog-Authenticated-User-Email header.
Locally: falls back to the OS username.
"""

import getpass
import logging

from fastapi import Request

logger = logging.getLogger(__name__)


def get_user_id(request: Request) -> str:
    """Extract a user identifier from the request.

    IAP sets X-Goog-Authenticated-User-Email to something like
    "accounts.google.com:scott@velky-brands.com". We strip the prefix
    and use the email as the user ID.

    Locally (no IAP), falls back to the OS username.
    """
    iap_email = request.headers.get("X-Goog-Authenticated-User-Email")
    if iap_email:
        # Strip the "accounts.google.com:" prefix
        user_id = iap_email.split(":")[-1]
        return user_id

    # Local dev fallback
    return getpass.getuser()
