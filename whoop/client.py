"""
Whoop OAuth2 client — handles authentication, token refresh, and API calls.

Usage:
    client = WhoopClient()
    if not client.is_authenticated():
        # Redirect user to: client.get_authorization_url()
        # Then on callback: client.exchange_code(code)
    data = client.get_sleep_data(start_date="2026-07-01", end_date="2026-07-26")
"""

import os
import json
import time
import secrets
import urllib.parse
from datetime import datetime, date
import requests

# ── CSRF state (stored in memory, single-user app) ──
_auth_state = None

# ── Constants ────────────────────────────────────────

AUTH_URL = "https://api.prod.whoop.com/oauth/oauth2/auth"
TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token"
API_BASE = "https://api.prod.whoop.com/developer/v2"

# Default scopes needed for sleep + recovery + cycle data
SCOPES = ["read:sleep", "read:recovery", "read:cycles", "read:workout", "read:profile", "read:body_measurement"]

# ── Token helpers ────────────────────────────────────


def _load_tokens():
    """Load tokens from the database."""
    try:
        from sleep_traking.database import get_connection
        conn = get_connection()
        cursor = conn.execute("SELECT access_token, refresh_token, expires_at FROM whoop_tokens WHERE id = 1")
        row = cursor.fetchone()
        conn.close()
        if row:
            return {
                "access_token": row["access_token"],
                "refresh_token": row["refresh_token"],
                "expires_at": row["expires_at"],
            }
    except Exception:
        pass
    return None


def _save_tokens(tokens):
    """Save tokens to the database."""
    from sleep_traking.database import get_connection
    conn = get_connection()
    conn.execute(
        """INSERT OR REPLACE INTO whoop_tokens (id, access_token, refresh_token, expires_at, updated_at)
           VALUES (1, ?, ?, ?, datetime('now', 'localtime'))""",
        (tokens["access_token"], tokens["refresh_token"], tokens["expires_at"]),
    )
    conn.commit()
    conn.close()


def _delete_tokens():
    """Remove stored tokens (logout)."""
    try:
        from sleep_traking.database import get_connection
        conn = get_connection()
        conn.execute("DELETE FROM whoop_tokens WHERE id = 1")
        conn.commit()
        conn.close()
    except Exception:
        pass


# ── API helpers ──────────────────────────────────────


def _api_request(method, path, access_token, body=None):
    """Make an authenticated API request to Whoop using requests."""
    url = f"{API_BASE}{path}"
    headers = {
        "Authorization": f"Bearer {access_token}",
        "User-Agent": "SleepTracker/1.0",
    }
    try:
        if body is not None:
            resp = requests.request(method, url, headers=headers, json=body, timeout=30)
        else:
            resp = requests.request(method, url, headers=headers, timeout=30)
        resp.raise_for_status()
        return resp.json()
    except requests.exceptions.HTTPError as e:
        status = e.response.status_code
        text = e.response.text[:300]
        if status == 401:
            raise PermissionError("Access token expired or invalid")
        elif status == 429:
            raise RuntimeError("Rate limited by Whoop API")
        raise RuntimeError(f"Whoop API error {status}: {text}")


# ── Main Client ──────────────────────────────────────


class WhoopClient:
    """Whoop OAuth2 client with automatic token refresh."""

    def __init__(self):
        self.client_id = os.environ.get("WHOOP_CLIENT_ID", "")
        self.client_secret = os.environ.get("WHOOP_CLIENT_SECRET", "")
        self.redirect_uri = os.environ.get(
            "WHOOP_REDIRECT_URI",
            "http://localhost:5800/api/whoop/callback",
        )
        self._tokens = _load_tokens()

    # ── Auth flow ─────────────────────────────────────

    def get_authorization_url(self):
        """Return the URL the user must visit to authorize the app.
        Includes a CSRF state parameter (required by Whoop)."""
        global _auth_state
        _auth_state = secrets.token_hex(16)  # 32-char hex string
        params = {
            "client_id": self.client_id,
            "redirect_uri": self.redirect_uri,
            "response_type": "code",
            "scope": " ".join(SCOPES),
            "state": _auth_state,
        }
        return f"{AUTH_URL}?{urllib.parse.urlencode(params)}"

    def exchange_code(self, code, state=None):
        """Exchange an authorization code for access+refresh tokens.
        Validates the state parameter to prevent CSRF attacks."""
        global _auth_state
        if state and _auth_state and state != _auth_state:
            _auth_state = None
            raise PermissionError("State mismatch — possible CSRF attack")
        _auth_state = None  # Consumed

        data = {
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            "redirect_uri": self.redirect_uri,
            "grant_type": "authorization_code",
            "code": code,
        }
        result = self._token_request(data)
        tokens = {
            "access_token": result["access_token"],
            "refresh_token": result.get("refresh_token", ""),
            "expires_at": int(time.time()) + result.get("expires_in", 3600),
        }
        _save_tokens(tokens)
        self._tokens = tokens
        return tokens

    def refresh_access_token(self):
        """Refresh the access token using the refresh token."""
        if not self._tokens or not self._tokens.get("refresh_token"):
            raise PermissionError("No refresh token available — re-authenticate")

        data = {
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            "grant_type": "refresh_token",
            "refresh_token": self._tokens["refresh_token"],
        }
        result = self._token_request(data)
        self._tokens["access_token"] = result["access_token"]
        if "refresh_token" in result:
            self._tokens["refresh_token"] = result["refresh_token"]
        self._tokens["expires_at"] = int(time.time()) + result.get("expires_in", 3600)
        _save_tokens(self._tokens)
        return self._tokens

    def _token_request(self, data):
        """Make a token exchange request to the Whoop OAuth endpoint.
        Uses form-encoded POST with client credentials in body (matching official whoop-sdk)."""
        try:
            resp = requests.post(TOKEN_URL, data=data, timeout=30)
            resp.raise_for_status()
            return resp.json()
        except requests.exceptions.HTTPError as e:
            status = e.response.status_code
            text = e.response.text[:500]
            raise RuntimeError(f"Token request failed: {status} {text}")

    # ── Authentication state ──────────────────────────

    def is_authenticated(self):
        """Check if we have valid tokens."""
        return self._tokens is not None and bool(self._tokens.get("access_token"))

    def get_valid_access_token(self):
        """Return a valid access token, refreshing if needed."""
        if not self._tokens:
            raise PermissionError("Not authenticated")

        # If token expires in less than 60 seconds, refresh
        now = int(time.time())
        if self._tokens["expires_at"] - now < 60:
            self.refresh_access_token()

        return self._tokens["access_token"]

    def disconnect(self):
        """Remove stored tokens."""
        _delete_tokens()
        self._tokens = None

    # ── Data endpoints ────────────────────────────────

    def get_profile(self):
        """Get the user's Whoop profile."""
        token = self.get_valid_access_token()
        return _api_request("GET", "/user/profile/basic", token)

    def get_sleep_data(self, start_date=None, end_date=None, limit=25, next_token=None):
        """Get sleep data, optionally filtered by date range.

        Date args can be 'YYYY-MM-DD' or ISO 8601 with Z.
        Returns (records_list, next_token_or_None).
        """
        token = self.get_valid_access_token()
        params = {"limit": limit}
        if start_date:
            # Convert YYYY-MM-DD to ISO 8601 with Z (required by Whoop API v2)
            if len(start_date) == 10 and start_date[4] == '-':
                params["start"] = start_date + "T00:00:00.000Z"
            else:
                params["start"] = start_date
        if end_date:
            if len(end_date) == 10 and end_date[4] == '-':
                params["end"] = end_date + "T23:59:59.999Z"
            else:
                params["end"] = end_date
        if next_token:
            params["nextToken"] = next_token

        path = f"/activity/sleep?{urllib.parse.urlencode(params)}"
        result = _api_request("GET", path, token)
        records = result.get("records", [])
        next_tok = result.get("next_token")
        return records, next_tok

    def get_all_sleep_data(self, start_date=None, end_date=None):
        """Get ALL sleep data pages, returns combined list."""
        all_records = []
        next_token = None
        while True:
            records, next_token = self.get_sleep_data(
                start_date=start_date, end_date=end_date,
                limit=25, next_token=next_token,
            )
            all_records.extend(records)
            if not next_token:
                break
        return all_records

    def get_recovery_data(self, start_date=None, end_date=None, limit=25, next_token=None):
        """Get recovery data (HRV, resting heart rate, recovery score)."""
        token = self.get_valid_access_token()
        params = {"limit": limit}
        if start_date:
            if len(start_date) == 10 and start_date[4] == '-':
                params["start"] = start_date + "T00:00:00.000Z"
            else:
                params["start"] = start_date
        if end_date:
            if len(end_date) == 10 and end_date[4] == '-':
                params["end"] = end_date + "T23:59:59.999Z"
            else:
                params["end"] = end_date
        if next_token:
            params["nextToken"] = next_token

        path = f"/recovery?{urllib.parse.urlencode(params)}"
        result = _api_request("GET", path, token)
        return result.get("records", []), result.get("next_token")

    def get_all_recovery_data(self, start_date=None, end_date=None):
        """Get ALL recovery data pages."""
        all_records = []
        next_token = None
        while True:
            records, next_token = self.get_recovery_data(
                start_date=start_date, end_date=end_date,
                next_token=next_token,
            )
            all_records.extend(records)
            if not next_token:
                break
        return all_records
