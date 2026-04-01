#!/usr/bin/env python3
"""Persistent Trino query server — reads NDJSON from stdin, writes NDJSON to stdout.

Usage: python3 scripts/trino-query.py
  Then send one JSON object per line on stdin:
    {"sql": "SELECT 1"}
  Receive one JSON object per line on stdout:
    {"columns": ["_col0"], "columnTypes": ["integer"], "rows": [{"_col0": 1}]}

On query error, returns {"error": "message"} and continues.
On EOF or empty line, exits gracefully.

Environment variables:
  TRINO_HOST    — Trino coordinator URL (default: https://lakehouse-router-prod.us-west-2.remitly.com)
  TRINO_PORT    — Port (default: 443)
  TRINO_CATALOG — Catalog (default: lakehouse)
"""

import json
import os
import sys
from contextlib import contextmanager

from trino.auth import OAuth2Authentication
from trino.dbapi import connect

# Keep a reference to the real stdout for our JSON output.
# The trino library prints OAuth URLs to stdout during auth — we redirect
# stdout to stderr during connection/query so those messages don't corrupt
# our NDJSON protocol.
_real_stdout = sys.stdout


@contextmanager
def stdout_to_stderr():
    """Temporarily redirect stdout to stderr so library prints don't corrupt NDJSON."""
    sys.stdout = sys.stderr
    try:
        yield
    finally:
        sys.stdout = _real_stdout


def make_connection():
    raw_host = os.environ.get("TRINO_HOST", "https://lakehouse-router-prod.us-west-2.remitly.com")
    port = int(os.environ.get("TRINO_PORT", "443"))
    catalog = os.environ.get("TRINO_CATALOG", os.environ.get("TRINO_DEFAULT_CATALOG", "lakehouse"))

    # Parse host: strip scheme if present, detect http_scheme from it
    if raw_host.startswith("https://"):
        host = raw_host[len("https://"):]
        http_scheme = "https"
    elif raw_host.startswith("http://"):
        host = raw_host[len("http://"):]
        http_scheme = "http"
    else:
        host = raw_host
        http_scheme = "https" if port == 443 else "http"

    with stdout_to_stderr():
        return connect(
            host=host,
            port=port,
            catalog=catalog,
            http_scheme=http_scheme,
            auth=OAuth2Authentication(),
            source="lakehouse-analytics",
        )


def execute_query(conn, sql):
    cursor = conn.cursor()
    try:
        with stdout_to_stderr():
            cursor.execute(sql)
            if cursor.description is None:
                return {"columns": [], "columnTypes": [], "rows": []}
            columns = [desc[0] for desc in cursor.description]
            column_types = [desc[1] if len(desc) > 1 and desc[1] else "varchar" for desc in cursor.description]
            raw_rows = cursor.fetchall()
        rows = [dict(zip(columns, row)) for row in raw_rows]
        return {"columns": columns, "columnTypes": column_types, "rows": rows}
    finally:
        cursor.close()


def main():
    conn = make_connection()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            break

        try:
            request = json.loads(line)
            sql = request.get("sql", "").strip()
        except (json.JSONDecodeError, AttributeError) as e:
            json.dump({"error": f"Invalid request: {e}"}, _real_stdout, default=str)
            _real_stdout.write("\n")
            _real_stdout.flush()
            continue

        if not sql:
            json.dump({"error": "No SQL provided"}, _real_stdout)
            _real_stdout.write("\n")
            _real_stdout.flush()
            continue

        try:
            result = execute_query(conn, sql)
            json.dump(result, _real_stdout, default=str)
        except Exception as e:
            # Try to reconnect once on connection-level errors
            try:
                conn.close()
            except Exception:
                pass
            try:
                conn = make_connection()
                result = execute_query(conn, sql)
                json.dump(result, _real_stdout, default=str)
            except Exception as retry_err:
                print(f"Trino query failed: {retry_err}", file=sys.stderr)
                json.dump({"error": str(retry_err)}, _real_stdout)

        _real_stdout.write("\n")
        _real_stdout.flush()

    try:
        conn.close()
    except Exception:
        pass


if __name__ == "__main__":
    main()
