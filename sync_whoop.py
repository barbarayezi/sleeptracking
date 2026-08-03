"""
Standalone Whoop sync script — safe for cron / scheduled automation.

Refreshes the Whoop access token (using stored refresh token) and pulls the
latest sleep + recovery data into the database. Exits 0 on success.

Usage:
    python sync_whoop.py [days_back]
"""
import sys
import os

# Ensure .env is loaded (whoop.client reads creds from env at init time)
from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

# Make project root importable
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from whoop.client import WhoopClient
from whoop.sync import sync_sleep_data


def main():
    days_back = int(sys.argv[1]) if len(sys.argv) > 1 else 30

    client = WhoopClient()
    if not client.is_authenticated():
        print("ERROR: Not authenticated with Whoop. Re-authorize in the app first.")
        sys.exit(2)

    # Ensure we have a valid (fresh) access token before syncing.
    try:
        client.get_valid_access_token()
    except Exception as e:
        print(f"ERROR: Token refresh failed: {e}")
        sys.exit(3)

    try:
        stats = sync_sleep_data(days_back=days_back)
        print(f"OK: {stats}")
        sys.exit(0)
    except Exception as e:
        print(f"ERROR: Sync failed: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
