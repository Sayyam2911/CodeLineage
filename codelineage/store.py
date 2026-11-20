"""Durable records for lineage, sessions, scan state and interview events."""

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path


class Records:
    def __init__(self, connection: sqlite3.Connection):
        self.connection = connection

    def get(self, namespace: str, key: str, default=None):
        row = self.connection.execute(
            "SELECT payload FROM records WHERE namespace = ? AND key = ?", (namespace, key)
        ).fetchone()
        return json.loads(row[0]) if row else default

    def items(self, namespace: str) -> list[tuple[str, dict]]:
        rows = self.connection.execute(
            "SELECT key, payload FROM records WHERE namespace = ? ORDER BY key", (namespace,)
        )
        return [(key, json.loads(payload)) for key, payload in rows]

    def put(self, namespace: str, key: str, value: dict) -> None:
        self.connection.execute(
            """INSERT INTO records VALUES (?, ?, ?)
               ON CONFLICT (namespace, key) DO UPDATE SET payload = excluded.payload""",
            (namespace, key, json.dumps(value)),
        )


class Database:
    def __init__(self, filename: Path):
        self.filename = filename
        with self.transaction(write=True) as records:
            records.connection.execute(
                """CREATE TABLE IF NOT EXISTS records (
                     namespace TEXT NOT NULL, key TEXT NOT NULL, payload TEXT NOT NULL,
                     PRIMARY KEY (namespace, key)
                   )"""
            )

    @contextmanager
    def transaction(self, *, write: bool = False):
        connection = sqlite3.connect(self.filename, timeout=15)
        try:
            connection.execute("BEGIN IMMEDIATE" if write else "BEGIN")
            yield Records(connection)
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    @staticmethod
    def ensure_snapshot(snapshots, snapshot: str) -> None:
        # The immutable graph is already stored alongside the local snapshot.
        return None

    @staticmethod
    def snapshot_graph(snapshots, snapshot: str) -> dict:
        return snapshots.graph(snapshot)
