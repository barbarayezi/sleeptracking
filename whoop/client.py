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
SCOPES = ["offline", "read:sleep", "read:recovery", "read:cycles", "read:workout", "read:profile", "read:body_measurement"]

# ── Token helpers ────────────────────────────────────


def _load_tokens():
    """Load tokens from the database."""
    try:
        from database import get_connection
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
    from database import get_connection
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
        from database import get_connection
        conn = get_connection()
        conn.execute("DELETE FROM whoop_tokens WHERE id = 1")
        conn.commit()
        conn.close()
    except Exception:
        pass


# ── Cross-instance coordination (Mac + Render share one Turso token) ──

def _get_whoop_meta(key, default=None):
    """Read a Whoop-specific flag from the shared _meta table (Turso)."""
    try:
        from database import get_connection
        conn = get_connection()
        try:
            conn.execute("CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT)")
            cur = conn.execute("SELECT value FROM _meta WHERE key = ?", (key,))
            row = cur.fetchone()
        finally:
            conn.close()
        return row[0] if row else default
    except Exception:
        return default


def _set_whoop_meta(key, value):
    """Write a Whoop-specific flag to the shared _meta table (Turso)."""
    try:
        from database import get_connection
        conn = get_connection()
        try:
            conn.execute("CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT)")
            conn.execute(
                "INSERT OR REPLACE INTO _meta (key, value) VALUES (?, ?)",
                (str(key), str(value)),
            )
            conn.commit()
        finally:
            conn.close()
    except Exception:
        pass


def _acquire_refresh_lock(ttl_seconds=120, wait_max_seconds=8):
    """Best-effort distributed lock so Mac + Render don't refresh the same
    Whoop refresh token concurrently.

    Whoop rotates refresh tokens on every refresh, so if two instances both
    refreshed with the same (now-stale) refresh token, the second refresh
    would be rejected by Whoop (4xx) and could poison the shared token. The
    lock serializes refreshes; after acquiring it we re-read the token so we
    pick up any rotation the other instance already performed.

    Returns True if we hold the lock (or it was already ours / stale).
    """
    import socket
    owner = f"{socket.gethostname()}:{os.getpid()}"
    deadline = time.time() + wait_max_seconds
    while True:
        held = _get_whoop_meta("whoop_refresh_lock")
        now = time.time()
        if not held:
            _set_whoop_meta("whoop_refresh_lock", f"{owner}|{now}")
            return True
        try:
            h_owner, h_ts = held.split("|", 1)
            h_ts = float(h_ts)
        except Exception:
            h_owner, h_ts = held, 0.0
        if now - h_ts > ttl_seconds:
            # Stale lock left behind by a crashed instance — take over.
            _set_whoop_meta("whoop_refresh_lock", f"{owner}|{now}")
            return True
        if h_owner == owner:
            return True  # reentrant
        if time.time() >= deadline:
            return False
        time.sleep(1)


def _release_refresh_lock():
    """Drop the refresh lock (best-effort)."""
    try:
        from database import get_connection
        conn = get_connection()
        try:
            conn.execute("DELETE FROM _meta WHERE key = 'whoop_refresh_lock'")
            conn.commit()
        finally:
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
        # In-memory copy of the recorded hard-auth failure (if any). Loaded
        # from _meta so a freshly constructed client reflects the real state.
        self._auth_error = _get_whoop_meta("whoop_auth_error") or ""

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
        # Successful (re-)authorization clears any previous hard-auth-error flag.
        try:
            _set_whoop_meta("whoop_auth_error", "")
            self._auth_error = ""
        except Exception:
            pass
        return tokens

    def refresh_access_token(self):
        """Refresh the access token using the refresh token.

        Serialized across instances via a Turso lock: Whoop rotates refresh
        tokens, so if Mac and Render both refreshed concurrently the second
        refresh would be rejected and could poison the shared token. We also
        re-read the token after acquiring the lock in case the other instance
        already rotated it. On success the previous hard-auth-error flag is
        cleared so the app resumes as "connected"."""
        if not self._tokens or not self._tokens.get("refresh_token"):
            raise PermissionError("No refresh token available — re-authenticate")

        if not _acquire_refresh_lock():
            # Another instance is mid-refresh. Our in-memory token is still
            # valid for now; return it and let the next cycle pick up the
            # rotated token. This avoids a redundant concurrent refresh.
            return self._tokens

        try:
            # Re-read after acquiring the lock — the other instance may have
            # already refreshed and saved a newer refresh token.
            self._tokens = _load_tokens()
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
            # Refresh succeeded — clear any previous hard-auth-error flag.
            try:
                _set_whoop_meta("whoop_auth_error", "")
                self._auth_error = ""
            except Exception:
                pass
            return self._tokens
        finally:
            _release_refresh_lock()

    def _token_request(self, data):
        """Make a token exchange request to the Whoop OAuth endpoint.
        Uses form-encoded POST with client credentials in body (matching official whoop-sdk).

        4xx (other than 429 rate-limit) means the token/credentials were
        rejected by Whoop. Historically this wiped the stored token, which made
        a single transient failure (e.g. a refresh-token rotation race between
        the two auto-syncing instances) permanently disconnect the app. We now
        KEEP the token and record the exact Whoop error in _meta so the UI can
        surface it and the user re-authorizes deliberately; the app reports
        "not connected" via the whoop_auth_error flag instead of silently
        deleting the token."""
        try:
            resp = requests.post(TOKEN_URL, data=data, timeout=30)
            resp.raise_for_status()
            return resp.json()
        except requests.exceptions.HTTPError as e:
            status = e.response.status_code
            text = e.response.text[:500]
            if 400 <= status < 500 and status != 429:
                msg = f"Whoop 授权已失效（HTTP {status}），请重新连接"
                detail = f"Whoop 授权已失效（HTTP {status}）: {text}"
                try:
                    _set_whoop_meta("whoop_auth_error", detail)
                    self._auth_error = detail
                except Exception:
                    pass
                # Short message for the UI; full Whoop body kept in _meta.
                raise PermissionError(msg)
            raise RuntimeError(f"Token request failed: {status} {text}")

    # ── Authentication state ──────────────────────────

    def is_authenticated(self):
        """Check if we have valid tokens AND no recorded hard-auth failure.

        If a refresh was rejected by Whoop (recorded in _meta whoop_auth_error),
        we report "not connected" so the UI prompts re-authorization instead of
        showing "connected" with a dead token."""
        if not self._tokens or not self._tokens.get("access_token"):
            return False
        if self._auth_error:
            return False
        return True

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
        try:
            _set_whoop_meta("whoop_auth_error", "")
            self._auth_error = ""
        except Exception:
            pass

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

    def get_cycle_data(self, start_date=None, end_date=None, limit=25, next_token=None):
        """Get physiological cycle data (daily strain, kilojoule, avg/max HR)."""
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

        path = f"/cycle?{urllib.parse.urlencode(params)}"
        result = _api_request("GET", path, token)
        return result.get("records", []), result.get("next_token")

    def get_all_cycle_data(self, start_date=None, end_date=None):
        """Get ALL cycle data pages."""
        all_records = []
        next_token = None
        while True:
            records, next_token = self.get_cycle_data(
                start_date=start_date, end_date=end_date,
                next_token=next_token,
            )
            all_records.extend(records)
            if not next_token:
                break
        return all_records

    def get_workout_data(self, start_date=None, end_date=None, limit=25, next_token=None):
        """Get workout data (sport, strain, HR, kilojoule, distance)."""
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

        path = f"/activity/workout?{urllib.parse.urlencode(params)}"
        result = _api_request("GET", path, token)
        return result.get("records", []), result.get("next_token")

    def get_all_workout_data(self, start_date=None, end_date=None):
        """Get ALL workout data pages."""
        all_records = []
        next_token = None
        while True:
            records, next_token = self.get_workout_data(
                start_date=start_date, end_date=end_date,
                next_token=next_token,
            )
            all_records.extend(records)
            if not next_token:
                break
        return all_records
