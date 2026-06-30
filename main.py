import json
import os
import shutil
import sqlite3
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from threading import Lock
from typing import Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from jose import JWTError, jwt
from passlib.context import CryptContext
from pydantic import BaseModel, Field

DB_PATH = "notes.db"
LEGACY_DB_PATH = "goals.db"
MIN_TIME_SLOT_DURATION = 10
MINUTE_SCALE_UNIT = 10
DAY_MINUTES = 60 * 24
MONTH_MINUTES = DAY_MINUTES * 30
KANBAN_DIMENSION_PREFIX = "system:kanban:"
KANBAN_STATES = [
    ("scheduled", "Scheduled", "#3b82f6"),
    ("in_progress", "In progress", "#f97316"),
    ("review", "Review", "#8b5cf6"),
    ("done", "Done", "#22c55e"),
]
JWT_ALGORITHM = "HS256"
ACCESS_TOKEN_MINUTES = 30
REFRESH_TOKEN_DAYS = 30
LOGIN_REGISTER_LIMIT = 10
RATE_LIMIT_WINDOW_SECONDS = 60
SUPERUSER_EMAIL = "florian"
SUPERUSER_DISPLAY_NAME = "florian"
SUPERUSER_PASSWORD = "TestPassword123"

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto", bcrypt__rounds=12)
_rate_limit_lock = Lock()
_rate_limit_buckets: dict[tuple[str, str], list[float]] = {}

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:5174"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _load_local_env(path: str | None = None):
    if path is None:
        path = os.path.join(os.path.dirname(__file__), ".env")
    if not os.path.exists(path):
        return
    with open(path, "r", encoding="utf-8") as env_file:
        for line in env_file:
            raw = line.strip()
            if not raw or raw.startswith("#") or "=" not in raw:
                continue
            key, value = raw.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


_load_local_env()


def _bootstrap_database_file():
    def project_count(path: str) -> int:
        if not os.path.exists(path):
            return 0
        try:
            con = sqlite3.connect(path)
            count = con.execute("SELECT COUNT(*) FROM projects").fetchone()[0]
            con.close()
            return count
        except sqlite3.Error:
            return 0

    if os.path.exists(DB_PATH) and project_count(DB_PATH) > 0:
        return
    if os.path.exists(LEGACY_DB_PATH) and project_count(LEGACY_DB_PATH) > 0:
        if os.path.exists(DB_PATH):
            shutil.copyfile(DB_PATH, f"{DB_PATH}.empty-backup")
        shutil.copyfile(LEGACY_DB_PATH, DB_PATH)


_bootstrap_database_file()


# ── DB setup ──────────────────────────────────────────────────────────────────
@contextmanager
def _db():
    con = sqlite3.connect(DB_PATH, check_same_thread=False)
    con.row_factory = sqlite3.Row
    try:
        yield con
        con.commit()
    finally:
        con.close()

def _init_db():
    with _db() as con:
        con.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id                  TEXT PRIMARY KEY,
                email               TEXT NOT NULL UNIQUE,
                display_name        TEXT NOT NULL,
                hashed_password     TEXT,
                created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                google_oauth        INTEGER NOT NULL DEFAULT 0,
                is_superuser        INTEGER NOT NULL DEFAULT 0
            )
        """)
        con.execute("""
            CREATE TABLE IF NOT EXISTS projects (
                id          TEXT PRIMARY KEY,
                user_id     TEXT NOT NULL REFERENCES users(id),
                root_note_id TEXT,
                name        TEXT NOT NULL DEFAULT 'Untitled',
                description TEXT NOT NULL DEFAULT '',
                resize_warn_order_threshold REAL NOT NULL DEFAULT 2,
                resize_block_order_threshold REAL NOT NULL DEFAULT 2,
                resize_scale_crossing_warning_enabled INTEGER NOT NULL DEFAULT 1,
                created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                archived_at TEXT
            )
        """)
        con.execute("""
            CREATE TABLE IF NOT EXISTS notes (
                id         TEXT PRIMARY KEY,
                project_id TEXT NOT NULL DEFAULT 'default',
                parent_note_id TEXT,
                html       TEXT NOT NULL DEFAULT '',
                title      TEXT NOT NULL DEFAULT 'Untitled',
                collapsed  INTEGER NOT NULL DEFAULT 0,
                order_idx  INTEGER NOT NULL DEFAULT 0
            )
        """)
        con.execute("""
            CREATE TABLE IF NOT EXISTS dimensions (
                id         TEXT PRIMARY KEY,
                project_id TEXT NOT NULL DEFAULT 'default',
                name       TEXT NOT NULL
            )
        """)
        con.execute("""
            CREATE TABLE IF NOT EXISTS categories (
                id           TEXT PRIMARY KEY,
                dimension_id TEXT NOT NULL,
                name         TEXT NOT NULL,
                color        TEXT NOT NULL DEFAULT '#94a3b8',
                order_idx    INTEGER NOT NULL DEFAULT 0
            )
        """)
        con.execute("""
            CREATE TABLE IF NOT EXISTS assignments (
                note_id      TEXT NOT NULL,
                dimension_id TEXT NOT NULL,
                category_id  TEXT NOT NULL,
                order_idx    INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (note_id, dimension_id)
            )
        """)
        con.execute("""
            CREATE TABLE IF NOT EXISTS time_slots (
                id         TEXT PRIMARY KEY,
                note_id    TEXT NOT NULL,
                start_col  INTEGER NOT NULL,
                duration   INTEGER NOT NULL DEFAULT 10,
                title      TEXT NOT NULL DEFAULT '',
                color      TEXT NOT NULL DEFAULT '#1a73e8'
            )
        """)
        con.execute("""
            CREATE TABLE IF NOT EXISTS dependencies (
                id      TEXT PRIMARY KEY,
                from_id TEXT NOT NULL,
                to_id   TEXT NOT NULL,
                reason  TEXT NOT NULL DEFAULT '',
                UNIQUE (from_id, to_id)
            )
        """)
        con.execute("""
            CREATE TABLE IF NOT EXISTS deadlines (
                id      TEXT PRIMARY KEY,
                note_id TEXT NOT NULL UNIQUE,
                col     INTEGER NOT NULL,
                scale   TEXT NOT NULL DEFAULT 'day',
                reason  TEXT NOT NULL DEFAULT ''
            )
        """)
        con.execute("""
            CREATE TABLE IF NOT EXISTS earliest_starts (
                id      TEXT PRIMARY KEY,
                note_id TEXT NOT NULL UNIQUE,
                col     INTEGER NOT NULL,
                scale   TEXT NOT NULL DEFAULT 'day',
                reason  TEXT NOT NULL DEFAULT ''
            )
        """)
        con.execute("""
            CREATE TABLE IF NOT EXISTS note_inheritance (
                child_note_id  TEXT NOT NULL,
                parent_note_id TEXT NOT NULL,
                PRIMARY KEY (child_note_id, parent_note_id)
            )
        """)
        con.execute("""
            CREATE TABLE IF NOT EXISTS saved_filters (
                id              TEXT PRIMARY KEY,
                project_id      TEXT NOT NULL DEFAULT 'default',
                name            TEXT NOT NULL,
                gate            TEXT NOT NULL DEFAULT 'AND',
                color           TEXT NOT NULL DEFAULT '#64748b',
                selections_json TEXT NOT NULL DEFAULT '{}',
                quick_key       TEXT
            )
        """)
        con.execute("""
            CREATE TABLE IF NOT EXISTS schedule_perspectives (
                id         TEXT PRIMARY KEY,
                project_id TEXT NOT NULL DEFAULT 'default',
                context_id TEXT,
                name       TEXT NOT NULL,
                state_json TEXT NOT NULL DEFAULT '{}'
            )
        """)
        con.execute("""
            CREATE TABLE IF NOT EXISTS classification_perspectives (
                id         TEXT PRIMARY KEY,
                project_id TEXT NOT NULL DEFAULT 'default',
                context_id TEXT,
                name       TEXT NOT NULL,
                state_json TEXT NOT NULL DEFAULT '{}'
            )
        """)
        con.execute("""
            CREATE TABLE IF NOT EXISTS calendar_perspectives (
                id         TEXT PRIMARY KEY,
                project_id TEXT NOT NULL DEFAULT 'default',
                context_id TEXT,
                name       TEXT NOT NULL,
                state_json TEXT NOT NULL DEFAULT '{}'
            )
        """)
        con.execute("""
            CREATE TABLE IF NOT EXISTS project_contexts (
                id         TEXT PRIMARY KEY,
                project_id TEXT NOT NULL DEFAULT 'default',
                name       TEXT NOT NULL,
                state_json TEXT NOT NULL DEFAULT '{}'
            )
        """)
        con.execute("""
            CREATE TABLE IF NOT EXISTS transaction_history (
                id               TEXT PRIMARY KEY,
                project_id       TEXT NOT NULL DEFAULT 'default',
                stack            TEXT NOT NULL CHECK (stack IN ('undo', 'redo')),
                seq              INTEGER NOT NULL,
                transaction_json TEXT NOT NULL,
                before_json      TEXT NOT NULL,
                after_json       TEXT NOT NULL,
                created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        """)
        con.execute("""
            CREATE TABLE IF NOT EXISTS note_archive (
                id            TEXT PRIMARY KEY,
                project_id    TEXT NOT NULL,
                root_note_id  TEXT NOT NULL,
                title         TEXT NOT NULL DEFAULT 'Untitled',
                snapshot_json TEXT NOT NULL,
                archived_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        """)
        project_cols = [r[1] for r in con.execute("PRAGMA table_info(projects)").fetchall()]
        if 'archived_at' not in project_cols:
            con.execute("ALTER TABLE projects ADD COLUMN archived_at TEXT")
        con.execute("""
            CREATE TABLE IF NOT EXISTS personas (
                id         TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                name       TEXT NOT NULL,
                model_key  TEXT NOT NULL DEFAULT 'a',
                color      TEXT NOT NULL DEFAULT '#4f8ef7',
                pos_x      REAL NOT NULL DEFAULT 0,
                pos_z      REAL NOT NULL DEFAULT 0
            )
        """)
        con.execute("""
            CREATE TABLE IF NOT EXISTS persona_assignments (
                persona_id   TEXT NOT NULL,
                dimension_id TEXT NOT NULL,
                category_id  TEXT NOT NULL,
                PRIMARY KEY (persona_id, dimension_id, category_id)
            )
        """)
        con.execute("""
            CREATE TABLE IF NOT EXISTS persona_note_assignments (
                persona_id TEXT NOT NULL,
                note_id    TEXT NOT NULL,
                PRIMARY KEY (persona_id, note_id)
            )
        """)
        con.execute("""
            CREATE TABLE IF NOT EXISTS persona_time_slot_assignments (
                persona_id   TEXT NOT NULL,
                time_slot_id TEXT NOT NULL,
                PRIMARY KEY (persona_id, time_slot_id)
            )
        """)
        con.execute("""
            CREATE TABLE IF NOT EXISTS category_leaders (
                persona_id  TEXT NOT NULL,
                category_id TEXT NOT NULL,
                PRIMARY KEY (persona_id, category_id)
            )
        """)

_init_db()


def _migrate():
    with _db() as con:
        tables = {row[0] for row in con.execute("SELECT name FROM sqlite_master WHERE type = 'table'").fetchall()}
        if "notes" not in tables and "pages" in tables:
            con.execute("ALTER TABLE pages RENAME TO notes")
            tables.add("notes")
        elif "pages" in tables and "notes" in tables:
            con.execute("""
                INSERT OR IGNORE INTO notes (id, project_id, html, title, collapsed, order_idx)
                SELECT id, project_id, html, title, collapsed, order_idx FROM pages
            """)
            con.execute("DROP TABLE pages")

        if "milestones" in tables:
            legacy_time_slot_cols = [r[1] for r in con.execute("PRAGMA table_info(milestones)").fetchall()]
            note_col = "note_id" if "note_id" in legacy_time_slot_cols else "goal_id"
            con.execute(f"""
                INSERT OR IGNORE INTO time_slots (id, note_id, start_col, duration, title, color)
                SELECT id, {note_col}, start_col, duration, title, color FROM milestones
            """)
            con.execute("DROP TABLE milestones")
            tables.discard("milestones")
            tables.add("time_slots")

        if "persona_milestone_assignments" in tables:
            con.execute("""
                INSERT OR IGNORE INTO persona_time_slot_assignments (persona_id, time_slot_id)
                SELECT persona_id, milestone_id FROM persona_milestone_assignments
            """)
            con.execute("DROP TABLE persona_milestone_assignments")
            tables.discard("persona_milestone_assignments")
            tables.add("persona_time_slot_assignments")

        persona_time_slot_cols = [r[1] for r in con.execute("PRAGMA table_info(persona_time_slot_assignments)").fetchall()]
        if "milestone_id" in persona_time_slot_cols and "time_slot_id" not in persona_time_slot_cols:
            con.execute("ALTER TABLE persona_time_slot_assignments RENAME COLUMN milestone_id TO time_slot_id")

        for table in ("assignments", "time_slots", "deadlines"):
            cols = [r[1] for r in con.execute(f"PRAGMA table_info({table})").fetchall()]
            if "goal_id" in cols and "note_id" not in cols:
                con.execute(f"ALTER TABLE {table} RENAME COLUMN goal_id TO note_id")

        con.execute("""
            CREATE TABLE IF NOT EXISTS note_inheritance (
                child_note_id  TEXT NOT NULL,
                parent_note_id TEXT NOT NULL,
                PRIMARY KEY (child_note_id, parent_note_id)
            )
        """)
        inheritance_pk = [r["name"] for r in con.execute("PRAGMA table_info(note_inheritance)").fetchall() if r["pk"]]
        if inheritance_pk == ["child_note_id"]:
            con.execute("ALTER TABLE note_inheritance RENAME TO note_inheritance_old")
            con.execute("""
                CREATE TABLE note_inheritance (
                    child_note_id  TEXT NOT NULL,
                    parent_note_id TEXT NOT NULL,
                    PRIMARY KEY (child_note_id, parent_note_id)
                )
            """)
            con.execute("""
                INSERT OR IGNORE INTO note_inheritance (child_note_id, parent_note_id)
                SELECT child_note_id, parent_note_id FROM note_inheritance_old
            """)
            con.execute("DROP TABLE note_inheritance_old")

        deadline_cols = [r[1] for r in con.execute("PRAGMA table_info(deadlines)").fetchall()]
        if "scale" not in deadline_cols:
            con.execute("ALTER TABLE deadlines ADD COLUMN scale TEXT NOT NULL DEFAULT 'day'")
            con.execute(
                """
                UPDATE deadlines
                SET scale = CASE
                    WHEN col % ? = 0 THEN 'month'
                    WHEN col % ? = 0 THEN 'day'
                    ELSE 'minute'
                END
                """,
                (MONTH_MINUTES, DAY_MINUTES),
            )

        duplicate_ms = con.execute(
            """
            SELECT id FROM (
                SELECT id, ROW_NUMBER() OVER (
                    PARTITION BY note_id
                    ORDER BY start_col, rowid
                ) AS rn
                FROM time_slots
            )
            WHERE rn > 1
            """
        ).fetchall()
        duplicate_ms_ids = [row["id"] for row in duplicate_ms]
        if duplicate_ms_ids:
            ph = ",".join("?" for _ in duplicate_ms_ids)
            con.execute(f"DELETE FROM dependencies WHERE from_id IN ({ph}) OR to_id IN ({ph})", duplicate_ms_ids + duplicate_ms_ids)
            con.execute(f"DELETE FROM persona_time_slot_assignments WHERE time_slot_id IN ({ph})", duplicate_ms_ids)
            con.execute(f"DELETE FROM time_slots WHERE id IN ({ph})", duplicate_ms_ids)

        for table, cols in {
            "schedule_perspectives": ("state_json",),
            "classification_perspectives": ("state_json",),
            "calendar_perspectives": ("state_json",),
            "transaction_history": ("transaction_json", "before_json", "after_json"),
        }.items():
            table_exists = con.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)).fetchone()
            if not table_exists:
                continue
            for col in cols:
                if col not in [r[1] for r in con.execute(f"PRAGMA table_info({table})").fetchall()]:
                    continue
                con.execute(f"""
                    UPDATE {table}
                    SET {col} = replace(replace(replace(replace(replace(replace(replace(replace(replace({col},
                        'goalId', 'noteId'),
                        'hiddenGoalsByLane', 'hiddenNotesByLane'),
                        'visibleGoalFilterIds', 'visibleNoteFilterIds'),
                        'revealedConflictGoalIds', 'revealedConflictNoteIds'),
                        'selectedGoalIds', 'selectedNoteIds'),
                        'milestones', 'timeSlots'),
                        'Milestones', 'Time slots'),
                        'milestone', 'timeSlot'),
                        'Milestone', 'Time slot')
                    WHERE {col} IS NOT NULL
                """)

        con.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id                  TEXT PRIMARY KEY,
                email               TEXT NOT NULL UNIQUE,
                display_name        TEXT NOT NULL,
                hashed_password     TEXT,
                created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                google_oauth        INTEGER NOT NULL DEFAULT 0,
                is_superuser        INTEGER NOT NULL DEFAULT 0
            )
        """)

        user_cols = [r[1] for r in con.execute("PRAGMA table_info(users)").fetchall()]
        if 'is_superuser' not in user_cols:
            con.execute("ALTER TABLE users ADD COLUMN is_superuser INTEGER NOT NULL DEFAULT 0")

        # Add project_id to tables that need it
        for table in ['notes', 'dimensions', 'saved_filters', 'schedule_perspectives', 'classification_perspectives', 'calendar_perspectives']:
            cols = [r[1] for r in con.execute(f"PRAGMA table_info({table})").fetchall()]
            if 'project_id' not in cols:
                con.execute(f"ALTER TABLE {table} ADD COLUMN project_id TEXT NOT NULL DEFAULT 'default'")

        for table in ['schedule_perspectives', 'classification_perspectives', 'calendar_perspectives']:
            cols = [r[1] for r in con.execute(f"PRAGMA table_info({table})").fetchall()]
            if 'context_id' not in cols:
                con.execute(f"ALTER TABLE {table} ADD COLUMN context_id TEXT")

        note_cols = [r[1] for r in con.execute("PRAGMA table_info(notes)").fetchall()]
        if 'created_at' not in note_cols:
            con.execute("ALTER TABLE notes ADD COLUMN created_at TEXT NOT NULL DEFAULT ''")
            con.execute("UPDATE notes SET created_at = CURRENT_TIMESTAMP WHERE created_at = ''")

        dim_cols = [r[1] for r in con.execute("PRAGMA table_info(dimensions)").fetchall()]
        if 'order_idx' not in dim_cols:
            con.execute("ALTER TABLE dimensions ADD COLUMN order_idx INTEGER NOT NULL DEFAULT 0")
            rows = con.execute("SELECT id FROM dimensions ORDER BY rowid").fetchall()
            for i, row in enumerate(rows):
                con.execute("UPDATE dimensions SET order_idx = ? WHERE id = ?", (i, row[0]))

        cols = [r[1] for r in con.execute("PRAGMA table_info(categories)").fetchall()]
        if 'order_idx' not in cols:
            con.execute("ALTER TABLE categories ADD COLUMN order_idx INTEGER NOT NULL DEFAULT 0")
            rows = con.execute("SELECT id FROM categories ORDER BY rowid").fetchall()
            for i, row in enumerate(rows):
                con.execute("UPDATE categories SET order_idx = ? WHERE id = ?", (i, row[0]))

        assignment_cols = [r[1] for r in con.execute("PRAGMA table_info(assignments)").fetchall()]
        if 'order_idx' not in assignment_cols:
            con.execute("ALTER TABLE assignments ADD COLUMN order_idx INTEGER NOT NULL DEFAULT 0")
            rows = con.execute(
                "SELECT note_id, dimension_id, category_id FROM assignments ORDER BY dimension_id, category_id, rowid"
            ).fetchall()
            counters = {}
            for row in rows:
                key = (row["dimension_id"], row["category_id"])
                idx = counters.get(key, 0)
                counters[key] = idx + 1
                con.execute(
                    "UPDATE assignments SET order_idx = ? WHERE note_id = ? AND dimension_id = ?",
                    (idx, row["note_id"], row["dimension_id"]),
                )

        filter_cols = [r[1] for r in con.execute("PRAGMA table_info(saved_filters)").fetchall()]
        if 'color' not in filter_cols:
            con.execute("ALTER TABLE saved_filters ADD COLUMN color TEXT NOT NULL DEFAULT '#64748b'")

        dep_cols = [r[1] for r in con.execute("PRAGMA table_info(dependencies)").fetchall()]
        if 'reason' not in dep_cols:
            con.execute("ALTER TABLE dependencies ADD COLUMN reason TEXT NOT NULL DEFAULT ''")

        deadline_cols = [r[1] for r in con.execute("PRAGMA table_info(deadlines)").fetchall()]
        if 'reason' not in deadline_cols:
            con.execute("ALTER TABLE deadlines ADD COLUMN reason TEXT NOT NULL DEFAULT ''")

        earliest_start_cols = [r[1] for r in con.execute("PRAGMA table_info(earliest_starts)").fetchall()]
        if 'reason' not in earliest_start_cols:
            con.execute("ALTER TABLE earliest_starts ADD COLUMN reason TEXT NOT NULL DEFAULT ''")

        con.execute("""
            CREATE TABLE IF NOT EXISTS transaction_history (
                id               TEXT PRIMARY KEY,
                project_id       TEXT NOT NULL DEFAULT 'default',
                stack            TEXT NOT NULL CHECK (stack IN ('undo', 'redo')),
                seq              INTEGER NOT NULL,
                transaction_json TEXT NOT NULL,
                before_json      TEXT NOT NULL,
                after_json       TEXT NOT NULL,
                created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        """)
        con.execute(
            "UPDATE time_slots SET duration = ? WHERE duration < ?",
            (MIN_TIME_SLOT_DURATION, MIN_TIME_SLOT_DURATION),
        )

        def clamp_history_durations(value):
            changed = False

            def visit(node):
                nonlocal changed
                if isinstance(node, dict):
                    if "duration" in node and ("startCol" in node or "noteId" in node):
                        try:
                            duration = int(node["duration"])
                        except (TypeError, ValueError):
                            duration = MIN_TIME_SLOT_DURATION
                        if duration < MIN_TIME_SLOT_DURATION:
                            node["duration"] = MIN_TIME_SLOT_DURATION
                            changed = True
                    for child in node.values():
                        visit(child)
                elif isinstance(node, list):
                    for child in node:
                        visit(child)

            visit(value)
            return changed

        history_rows = con.execute(
            "SELECT id, transaction_json, before_json, after_json FROM transaction_history"
        ).fetchall()
        for row in history_rows:
            updates = {}
            for column in ("transaction_json", "before_json", "after_json"):
                try:
                    payload = json.loads(row[column])
                except (TypeError, json.JSONDecodeError):
                    continue
                if clamp_history_durations(payload):
                    updates[column] = json.dumps(payload)
            if updates:
                assignments = ", ".join(f"{column} = ?" for column in updates)
                con.execute(
                    f"UPDATE transaction_history SET {assignments} WHERE id = ?",
                    (*updates.values(), row["id"]),
                )
        con.execute("""
            CREATE TABLE IF NOT EXISTS persona_assignments (
                persona_id   TEXT NOT NULL,
                dimension_id TEXT NOT NULL,
                category_id  TEXT NOT NULL,
                PRIMARY KEY (persona_id, dimension_id, category_id)
            )
        """)

        # Migrate projects table columns
        proj_cols = [r[1] for r in con.execute("PRAGMA table_info(projects)").fetchall()]
        proj_fks = con.execute("PRAGMA foreign_key_list(projects)").fetchall()
        has_user_fk = any(row[2] == "users" and row[3] == "user_id" for row in proj_fks)
        if 'user_id' not in proj_cols:
            con.execute("ALTER TABLE projects ADD COLUMN user_id TEXT")
            proj_cols = [r[1] for r in con.execute("PRAGMA table_info(projects)").fetchall()]
        if 'description' not in proj_cols:
            con.execute("ALTER TABLE projects ADD COLUMN description TEXT NOT NULL DEFAULT ''")
            proj_cols = [r[1] for r in con.execute("PRAGMA table_info(projects)").fetchall()]
        if 'metric' in proj_cols:
            con.execute("ALTER TABLE projects RENAME TO projects_old")
            con.execute("""
                CREATE TABLE projects (
                    id          TEXT PRIMARY KEY,
                    user_id     TEXT NOT NULL REFERENCES users(id),
                    name        TEXT NOT NULL DEFAULT 'Untitled',
                    description TEXT NOT NULL DEFAULT '',
                    resize_warn_order_threshold REAL NOT NULL DEFAULT 2,
                    resize_block_order_threshold REAL NOT NULL DEFAULT 2,
                    resize_scale_crossing_warning_enabled INTEGER NOT NULL DEFAULT 1,
                    created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
            """)
            con.execute("""
                INSERT INTO projects (id, user_id, name, description, resize_warn_order_threshold, resize_block_order_threshold, resize_scale_crossing_warning_enabled, created_at)
                SELECT id, COALESCE(user_id, ''), name, COALESCE(description, ''), 2, 2, 1, created_at
                FROM projects_old
            """)
            con.execute("DROP TABLE projects_old")
            proj_cols = [r[1] for r in con.execute("PRAGMA table_info(projects)").fetchall()]
        if 'resize_warn_order_threshold' not in proj_cols:
            con.execute("ALTER TABLE projects ADD COLUMN resize_warn_order_threshold REAL NOT NULL DEFAULT 2")
            proj_cols = [r[1] for r in con.execute("PRAGMA table_info(projects)").fetchall()]
        if 'resize_block_order_threshold' not in proj_cols:
            con.execute("ALTER TABLE projects ADD COLUMN resize_block_order_threshold REAL NOT NULL DEFAULT 2")
            proj_cols = [r[1] for r in con.execute("PRAGMA table_info(projects)").fetchall()]
        if 'resize_scale_crossing_warning_enabled' not in proj_cols:
            con.execute("ALTER TABLE projects ADD COLUMN resize_scale_crossing_warning_enabled INTEGER NOT NULL DEFAULT 1")
        con.execute("UPDATE projects SET resize_warn_order_threshold = 2 WHERE resize_warn_order_threshold = 1")
        con.execute("UPDATE projects SET resize_block_order_threshold = 2 WHERE resize_block_order_threshold = 3")
        if 'start_date' not in proj_cols:
            con.execute("ALTER TABLE projects ADD COLUMN start_date TEXT NOT NULL DEFAULT ''")
            con.execute("UPDATE projects SET start_date = DATE('now') WHERE start_date = ''")
            proj_cols = [r[1] for r in con.execute("PRAGMA table_info(projects)").fetchall()]
        if 'end_date' not in proj_cols:
            con.execute("ALTER TABLE projects ADD COLUMN end_date TEXT NOT NULL DEFAULT ''")
            proj_cols = [r[1] for r in con.execute("PRAGMA table_info(projects)").fetchall()]
        if 'root_note_id' not in proj_cols:
            con.execute("ALTER TABLE projects ADD COLUMN root_note_id TEXT")
            proj_cols = [r[1] for r in con.execute("PRAGMA table_info(projects)").fetchall()]
        if 'color' in proj_cols:
            pass  # keep for compat, just don't use in UI

        note_cols = [r[1] for r in con.execute("PRAGMA table_info(notes)").fetchall()]
        if 'parent_note_id' not in note_cols:
            con.execute("ALTER TABLE notes ADD COLUMN parent_note_id TEXT")

        for project in con.execute("SELECT id, name, description, root_note_id FROM projects").fetchall():
            root_note_id = project["root_note_id"]
            root_exists = root_note_id and con.execute(
                "SELECT 1 FROM notes WHERE id = ? AND project_id = ?",
                (root_note_id, project["id"]),
            ).fetchone()
            if not root_exists:
                root_note_id = str(uuid.uuid4())
                root_title = project["name"] or "Untitled"
                root_html = project["description"] or ""
                con.execute(
                    "INSERT INTO notes (id, project_id, parent_note_id, html, title, collapsed, order_idx) VALUES (?, ?, NULL, ?, ?, 0, ?)",
                    (root_note_id, project["id"], root_html, root_title, -1),
                )
                con.execute("UPDATE projects SET root_note_id = ? WHERE id = ?", (root_note_id, project["id"]))
            con.execute(
                """
                UPDATE notes
                SET parent_note_id = ?
                WHERE project_id = ?
                  AND id != ?
                  AND (parent_note_id IS NULL OR parent_note_id = '')
                """,
                (root_note_id, project["id"], root_note_id),
            )

_migrate()


def _ensure_superuser():
    hashed_password = pwd_context.hash(SUPERUSER_PASSWORD)
    with _db() as con:
        row = con.execute("SELECT id FROM users WHERE email = ?", (SUPERUSER_EMAIL,)).fetchone()
        if row:
            user_id = row["id"]
            con.execute(
                """
                UPDATE users
                SET display_name = ?, hashed_password = ?, google_oauth = 0, is_superuser = 1
                WHERE id = ?
                """,
                (SUPERUSER_DISPLAY_NAME, hashed_password, user_id),
            )
            con.execute("UPDATE projects SET user_id = ? WHERE user_id IS NULL OR user_id = ''", (user_id,))
            return
        user_id = str(uuid.uuid4())
        con.execute(
            """
            INSERT INTO users (id, email, display_name, hashed_password, google_oauth, is_superuser)
            VALUES (?, ?, ?, ?, 0, 1)
            """,
            (user_id, SUPERUSER_EMAIL, SUPERUSER_DISPLAY_NAME, hashed_password),
        )
        con.execute("UPDATE projects SET user_id = ? WHERE user_id IS NULL OR user_id = ''", (user_id,))


_ensure_superuser()


def _seed_defaults(project_id: str = 'default'):
    defaults = [
        ("Group",    [("All",    "#94a3b8")]),
        ("Priority", [("High",   "#ef4444"), ("Medium", "#eab308"), ("Low", "#94a3b8")]),
        ("Type",     [("Idea",   "#8b5cf6"), ("Goal",   "#22c55e"), ("Task", "#1a73e8")]),
    ]
    with _db() as con:
        if not con.execute("SELECT id FROM projects WHERE id = ?", (project_id,)).fetchone():
            return
        for dim_name, cats in defaults:
            if con.execute(
                "SELECT id FROM dimensions WHERE name = ? AND project_id = ?", (dim_name, project_id)
            ).fetchone():
                continue
            dim_id = str(uuid.uuid4())
            con.execute("INSERT INTO dimensions (id, name, project_id) VALUES (?, ?, ?)", (dim_id, dim_name, project_id))
            for cat_name, color in cats:
                con.execute(
                    "INSERT INTO categories (id, dimension_id, name, color) VALUES (?, ?, ?, ?)",
                    (str(uuid.uuid4()), dim_id, cat_name, color),
                )

def _seed_defaults_for_all_projects():
    with _db() as con:
        project_ids = [row["id"] for row in con.execute("SELECT id FROM projects").fetchall()]
    for project_id in project_ids:
        _seed_defaults(project_id)


_seed_defaults_for_all_projects()


# ── Schemas ───────────────────────────────────────────────────────────────────
class RegisterIn(BaseModel):
    email: str
    displayName: str
    password: str

class LoginIn(BaseModel):
    email: str
    password: str

class RefreshIn(BaseModel):
    refreshToken: str

class TokenOut(BaseModel):
    accessToken: str
    refreshToken: str
    tokenType: str = "bearer"
    expiresIn: int = ACCESS_TOKEN_MINUTES * 60

class AccessTokenOut(BaseModel):
    accessToken: str
    tokenType: str = "bearer"
    expiresIn: int = ACCESS_TOKEN_MINUTES * 60

class ProjectIn(BaseModel):
    id: Optional[str] = None
    name: str
    description: str = ''
    endDate: Optional[str] = None

class ProjectPatch(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    endDate: Optional[str] = None
    resizeWarnOrderThreshold: Optional[float] = None
    resizeBlockOrderThreshold: Optional[float] = None
    resizeScaleCrossingWarningEnabled: Optional[bool] = None

class NoteIn(BaseModel):
    id: Optional[str] = None
    html: str = ""
    title: str = "Untitled"
    collapsed: bool = False
    parentNoteId: Optional[str] = None

class NotePatch(BaseModel):
    html: Optional[str] = None
    title: Optional[str] = None
    collapsed: Optional[bool] = None
    parentNoteId: Optional[str] = None

class OrderIn(BaseModel):
    ids: list[str]

class DimensionIn(BaseModel):
    id: Optional[str] = None
    name: str

class DimensionPatch(BaseModel):
    name: Optional[str] = None

class CategoryIn(BaseModel):
    id: Optional[str] = None
    name: str
    color: str = "#94a3b8"

class CategoryPatch(BaseModel):
    name: Optional[str] = None
    color: Optional[str] = None

class AssignIn(BaseModel):
    categoryId: str

class TimeSlotIn(BaseModel):
    id: Optional[str] = None
    noteId: str
    startCol: int
    duration: int = Field(default=MIN_TIME_SLOT_DURATION, ge=MIN_TIME_SLOT_DURATION)
    title: str = ''
    color: str = '#1a73e8'

class TimeSlotPatch(BaseModel):
    startCol: Optional[int] = None
    duration: Optional[int] = Field(default=None, ge=MIN_TIME_SLOT_DURATION)
    title: Optional[str] = None
    color: Optional[str] = None

class TimeSlotBatch(BaseModel):
    updates: list[dict]

class DependencyIn(BaseModel):
    id: Optional[str] = None
    fromId: str
    toId: str
    reason: Optional[str] = ''

class DependencyPatchIn(BaseModel):
    reason: str

class DeadlineColIn(BaseModel):
    col: int
    scale: Optional[str] = None
    reason: Optional[str] = ''

class TimeLockIn(BaseModel):
    reason: Optional[str] = ''

class NoteInheritanceIn(BaseModel):
    parentNoteId: str

class SavedFilterIn(BaseModel):
    id: Optional[str] = None
    name: str
    gate: str = "AND"
    color: str = "#64748b"
    selections: dict[str, list[str]] = {}
    quickKey: Optional[str] = None

class SavedFilterPatch(BaseModel):
    name: Optional[str] = None
    gate: Optional[str] = None
    color: Optional[str] = None
    selections: Optional[dict[str, list[str]]] = None
    quickKey: Optional[str] = None

class PersonaIn(BaseModel):
    id:        Optional[str] = None
    name:      str
    model_key: str  = 'a'
    color:     str  = '#4f8ef7'
    pos_x:     float = 0.0
    pos_z:     float = 0.0

class PersonaPatch(BaseModel):
    name:      Optional[str]   = None
    model_key: Optional[str]   = None
    color:     Optional[str]   = None
    pos_x:     Optional[float] = None
    pos_z:     Optional[float] = None

class PersonaAssignIn(BaseModel):
    dimensionId: str
    categoryId: str

class SchedulePerspectiveIn(BaseModel):
    id: Optional[str] = None
    name: str
    state: dict = {}

class SchedulePerspectivePatch(BaseModel):
    name: Optional[str] = None
    state: Optional[dict] = None

class ClassificationPerspectiveIn(BaseModel):
    id: Optional[str] = None
    name: str
    state: dict = {}

class ClassificationPerspectivePatch(BaseModel):
    name: Optional[str] = None
    state: Optional[dict] = None

class CalendarPerspectiveIn(BaseModel):
    id: Optional[str] = None
    name: str
    state: dict = {}

class CalendarPerspectivePatch(BaseModel):
    name: Optional[str] = None
    state: Optional[dict] = None

class ProjectContextIn(BaseModel):
    id: Optional[str] = None
    name: str
    state: dict = {}

class ProjectContextPatch(BaseModel):
    name: Optional[str] = None
    state: Optional[dict] = None

class TransactionPayload(BaseModel):
    id: Optional[str] = None
    type: str
    label: Optional[str] = None
    before: dict = Field(default_factory=dict)
    after: dict = Field(default_factory=dict)

class TransactionApplyIn(BaseModel):
    transaction: TransactionPayload


# ── Helper converters ─────────────────────────────────────────────────────────
def _project(row) -> dict:
    d = dict(row)
    return {
        "id": d["id"],
        "userId": d.get("user_id", ""),
        "rootNoteId": d.get("root_note_id"),
        "name": d["name"],
        "description": d.get("description", ""),
        "endDate": d.get("end_date", ""),
        "resizeWarnOrderThreshold": float(d.get("resize_warn_order_threshold", 2)),
        "resizeBlockOrderThreshold": float(d.get("resize_block_order_threshold", 2)),
        "resizeScaleCrossingWarningEnabled": bool(d.get("resize_scale_crossing_warning_enabled", 1)),
        "createdAt": d["created_at"],
        "archivedAt": d.get("archived_at"),
    }

def _note(row) -> dict:
    d = dict(row)
    return {
        "id": d["id"],
        "projectId": d["project_id"],
        "parentNoteId": d.get("parent_note_id"),
        "html": d["html"],
        "title": d["title"],
        "collapsed": bool(d["collapsed"]),
        "orderIdx": d["order_idx"],
        **({"createdAt": d["created_at"]} if "created_at" in d else {}),
    }

def _kanban_dimension_id(project_id: str) -> str:
    return f"{KANBAN_DIMENSION_PREFIX}{project_id}"

def _kanban_category_id(project_id: str, state: str) -> str:
    return f"{_kanban_dimension_id(project_id)}:{state}"

def _kanban_state_from_category_id(cat_id: str) -> str | None:
    prefix = KANBAN_DIMENSION_PREFIX
    if not cat_id.startswith(prefix):
        return None
    suffix = cat_id.removeprefix(prefix)
    if ":" not in suffix:
        return None
    state = suffix.rsplit(":", 1)[1]
    return state if any(key == state for key, _, _ in KANBAN_STATES) else None

def _is_kanban_dimension_id(dim_id: str) -> bool:
    return dim_id.startswith(KANBAN_DIMENSION_PREFIX)

def _is_kanban_category_id(cat_id: str) -> bool:
    return _kanban_state_from_category_id(cat_id) is not None

def _dimension(row) -> dict:
    d = dict(row)
    out = {"id": d["id"], "name": d["name"], "project_id": d["project_id"], "order_idx": d["order_idx"]}
    if _is_kanban_dimension_id(d["id"]):
        out.update({"system": True, "systemType": "kanban", "readOnly": True})
    return out

def _cat(row) -> dict:
    d = dict(row)
    out = {"id": d["id"], "dimensionId": d["dimension_id"], "name": d["name"], "color": d["color"]}
    state = _kanban_state_from_category_id(d["id"])
    if state:
        out.update({"system": True, "systemType": "kanban", "kanbanState": state})
    return out

def _persona(row) -> dict:
    d = dict(row)
    return {"id": d["id"], "projectId": d["project_id"], "name": d["name"],
            "modelKey": d["model_key"], "color": d["color"],
            "posX": d["pos_x"], "posZ": d["pos_z"]}

def _persona_assign(row) -> dict:
    d = dict(row)
    return {"personaId": d["persona_id"], "dimensionId": d["dimension_id"], "categoryId": d["category_id"]}

def _assign(row) -> dict:
    d = dict(row)
    return {"noteId": d["note_id"], "dimensionId": d["dimension_id"], "categoryId": d["category_id"], "orderIdx": d["order_idx"]}

def _time_slot(row) -> dict:
    d = dict(row)
    return {"id": d["id"], "noteId": d["note_id"], "startCol": d["start_col"],
            "duration": d["duration"], "title": d["title"], "color": d["color"]}

def _dep(row) -> dict:
    d = dict(row)
    return {"id": d["id"], "fromId": d["from_id"], "toId": d["to_id"], "reason": d.get("reason", "")}

def _dl(row) -> dict:
    d = dict(row)
    return {
        "id": d["id"],
        "noteId": d["note_id"],
        "col": d["col"],
        "scale": _normalize_planning_scale(d.get("scale"), d["col"]),
        "reason": d.get("reason", "") or "",
    }

def _es(row) -> dict:
    d = dict(row)
    return {
        "id": d["id"],
        "noteId": d["note_id"],
        "col": d["col"],
        "scale": _normalize_planning_scale(d.get("scale"), d["col"]),
        "reason": d.get("reason", "") or "",
    }

def _inheritance(row) -> dict:
    d = dict(row)
    return {
        "childNoteId": d["child_note_id"],
        "parentNoteId": d["parent_note_id"],
        "structural": bool(d.get("structural", False)),
    }

def _combined_note_inheritance(con, project_id: str) -> list[dict]:
    links = []
    seen = set()

    for row in con.execute(
        """
        SELECT
          n.id AS child_note_id,
          n.parent_note_id AS parent_note_id,
          1 AS structural,
          n.order_idx AS child_order_idx,
          parent.order_idx AS parent_order_idx
        FROM notes n
        JOIN notes parent ON parent.id = n.parent_note_id
        WHERE n.project_id = ? AND parent.project_id = ?
        ORDER BY n.order_idx, parent.order_idx
        """,
        (project_id, project_id),
    ).fetchall():
        item = _inheritance(row)
        key = (item["childNoteId"], item["parentNoteId"])
        if key in seen:
            continue
        seen.add(key)
        links.append(item)

    for row in con.execute(
        """
        SELECT ni.*, 0 AS structural, child.order_idx AS child_order_idx, parent.order_idx AS parent_order_idx
        FROM note_inheritance ni
        JOIN notes child ON child.id = ni.child_note_id
        JOIN notes parent ON parent.id = ni.parent_note_id
        WHERE child.project_id = ? AND parent.project_id = ?
        ORDER BY child.order_idx, parent.order_idx
        """,
        (project_id, project_id),
    ).fetchall():
        item = _inheritance(row)
        key = (item["childNoteId"], item["parentNoteId"])
        if key in seen:
            continue
        seen.add(key)
        links.append(item)

    return links

def _filter(row) -> dict:
    d = dict(row)
    try:
        selections = json.loads(d["selections_json"] or "{}")
    except json.JSONDecodeError:
        selections = {}
    return {
        "id": d["id"],
        "name": d["name"],
        "gate": d["gate"],
        "color": d["color"],
        "selections": selections,
        "quickKey": d["quick_key"],
    }

def _schedule_perspective(row) -> dict:
    d = dict(row)
    try:
        state = json.loads(d["state_json"] or "{}")
    except json.JSONDecodeError:
        state = {}
    return {"id": d["id"], "name": d["name"], "state": state}

def _classification_perspective(row) -> dict:
    d = dict(row)
    try:
        state = json.loads(d["state_json"] or "{}")
    except json.JSONDecodeError:
        state = {}
    return {"id": d["id"], "name": d["name"], "state": state}

def _calendar_perspective(row) -> dict:
    d = dict(row)
    try:
        state = json.loads(d["state_json"] or "{}")
    except json.JSONDecodeError:
        state = {}
    return {"id": d["id"], "name": d["name"], "state": state}

def _project_context(row) -> dict:
    d = dict(row)
    try:
        state = json.loads(d["state_json"] or "{}")
    except json.JSONDecodeError:
        state = {}
    return {"id": d["id"], "name": d["name"], "state": state}

def _ensure_default_context(con, project_id: str) -> dict:
    row = con.execute(
        "SELECT * FROM project_contexts WHERE project_id = ? ORDER BY rowid LIMIT 1",
        (project_id,),
    ).fetchone()
    if not row:
        context_id = str(uuid.uuid4())
        con.execute(
            "INSERT INTO project_contexts (id, project_id, name, state_json) VALUES (?, ?, ?, ?)",
            (context_id, project_id, "Default context", json.dumps({"archivedDimensionIds": []})),
        )
        row = con.execute("SELECT * FROM project_contexts WHERE id = ?", (context_id,)).fetchone()
    for table in ("schedule_perspectives", "classification_perspectives", "calendar_perspectives"):
        con.execute(
            f"UPDATE {table} SET context_id = ? WHERE project_id = ? AND (context_id IS NULL OR context_id = '')",
            (row["id"], project_id),
        )
    return _project_context(row)

def _context_id_for_project(con, project_id: str, context_id: str | None = None) -> str:
    if context_id:
        row = con.execute(
            "SELECT id FROM project_contexts WHERE id = ? AND project_id = ?",
            (context_id, project_id),
        ).fetchone()
        if not row:
            raise HTTPException(404, "Context not found")
        return row["id"]
    return _ensure_default_context(con, project_id)["id"]

def _normalize_filter_payload(data) -> tuple[str, str, str | None]:
    gate = data.gate if data.gate in ("AND", "OR") else "AND"
    selections = {}
    for dim_id, cat_ids in (data.selections or {}).items():
        ids = []
        for cat_id in cat_ids:
            if cat_id and cat_id not in ids:
                ids.append(cat_id)
        if ids:
            selections[dim_id] = ids
    return gate, json.dumps(selections), data.quickKey

def assert_project_access(project_id: str, user: dict):
    with _db() as con:
        row = con.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Project not found")
    if user.get("isSuperuser"):
        return _project(row)
    if row["user_id"] != user["id"]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Project access denied")
    return _project(row)

def _ensure_project_root_note(con, project_id: str) -> str:
    project = con.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
    if not project:
        raise HTTPException(404, "Project not found")
    root_note_id = project["root_note_id"] if "root_note_id" in project.keys() else None
    if root_note_id:
        row = con.execute("SELECT id FROM notes WHERE id = ? AND project_id = ?", (root_note_id, project_id)).fetchone()
        if row:
            return root_note_id

    root_note_id = str(uuid.uuid4())
    con.execute(
        "INSERT INTO notes (id, project_id, parent_note_id, html, title, collapsed, order_idx) VALUES (?, ?, NULL, ?, ?, 0, ?)",
        (root_note_id, project_id, project["description"] or "", project["name"] or "Untitled", -1),
    )
    con.execute("UPDATE projects SET root_note_id = ? WHERE id = ?", (root_note_id, project_id))
    return root_note_id

def _project_id_for_note(con, note_id: str) -> str:
    row = con.execute("SELECT project_id FROM notes WHERE id = ?", (note_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Note not found")
    return row["project_id"]

def _assert_valid_structural_parent(con, note_id: str, project_id: str, parent_note_id: str | None) -> str | None:
    project = con.execute("SELECT root_note_id FROM projects WHERE id = ?", (project_id,)).fetchone()
    if project and project["root_note_id"] == note_id:
        raise HTTPException(422, {"message": "The project root note cannot be moved", "type": "root_note_move"})
    if not parent_note_id:
        return None
    if note_id == parent_note_id:
        raise HTTPException(422, {"message": "A note cannot be its own parent", "type": "note_parent_cycle"})
    parent = con.execute("SELECT id, project_id, parent_note_id FROM notes WHERE id = ?", (parent_note_id,)).fetchone()
    if not parent:
        raise HTTPException(404, "Parent note not found")
    if parent["project_id"] != project_id:
        raise HTTPException(400, "Cannot parent notes across projects")

    current = parent["parent_note_id"]
    seen = {note_id, parent_note_id}
    while current:
        if current in seen:
            raise HTTPException(422, {"message": "Parenting cannot create a cycle", "type": "note_parent_cycle"})
        seen.add(current)
        row = con.execute("SELECT parent_note_id FROM notes WHERE id = ? AND project_id = ?", (current, project_id)).fetchone()
        current = row["parent_note_id"] if row else None
    return parent_note_id

def _project_id_for_dimension(con, dim_id: str) -> str:
    row = con.execute("SELECT project_id FROM dimensions WHERE id = ?", (dim_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Dimension not found")
    return row["project_id"]

def _project_id_for_category(con, cat_id: str) -> str:
    row = con.execute(
        """SELECT d.project_id FROM categories c
        JOIN dimensions d ON d.id = c.dimension_id
        WHERE c.id = ?""",
        (cat_id,),
    ).fetchone()
    if not row:
        raise HTTPException(404, "Category not found")
    return row["project_id"]

def _project_id_for_persona(con, persona_id: str) -> str:
    row = con.execute("SELECT project_id FROM personas WHERE id = ?", (persona_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Persona not found")
    return row["project_id"]

def _project_id_for_time_slot(con, ms_id: str) -> str:
    row = con.execute(
        """SELECT p.project_id FROM time_slots m
        JOIN notes p ON p.id = m.note_id
        WHERE m.id = ?""",
        (ms_id,),
    ).fetchone()
    if not row:
        raise HTTPException(404, "Time slot not found")
    return row["project_id"]

def _ensure_kanban_dimension(con, project_id: str):
    dim_id = _kanban_dimension_id(project_id)
    next_order = con.execute(
        "SELECT COALESCE(MAX(order_idx), -1) + 1 FROM dimensions WHERE project_id = ?",
        (project_id,),
    ).fetchone()[0]
    con.execute(
        "INSERT OR IGNORE INTO dimensions (id, name, project_id, order_idx) VALUES (?, ?, ?, ?)",
        (dim_id, "Kanban", project_id, next_order),
    )
    con.execute("UPDATE dimensions SET name = ?, project_id = ? WHERE id = ?", ("Kanban", project_id, dim_id))

    for idx, (state, name, color) in enumerate(KANBAN_STATES):
        cat_id = _kanban_category_id(project_id, state)
        con.execute(
            "INSERT OR IGNORE INTO categories (id, dimension_id, name, color, order_idx) VALUES (?, ?, ?, ?, ?)",
            (cat_id, dim_id, name, color, idx),
        )
        con.execute(
            "UPDATE categories SET dimension_id = ?, name = ?, color = ?, order_idx = ? WHERE id = ?",
            (dim_id, name, color, idx, cat_id),
        )

def _unassign_scheduled_if_unslotted(con, note_id: str, project_id: str | None = None):
    if project_id is None:
        project_id = _project_id_for_note(con, note_id)
    if con.execute("SELECT 1 FROM time_slots WHERE note_id = ? LIMIT 1", (note_id,)).fetchone():
        return
    con.execute(
        "DELETE FROM assignments WHERE note_id = ? AND dimension_id = ? AND category_id = ?",
        (note_id, _kanban_dimension_id(project_id), _kanban_category_id(project_id, "scheduled")),
    )

def _project_id_for_dependency(con, dep_id: str) -> str:
    row = con.execute(
        """SELECT p.project_id FROM dependencies d
        JOIN time_slots m ON m.id = d.from_id
        JOIN notes p ON p.id = m.note_id
        WHERE d.id = ?""",
        (dep_id,),
    ).fetchone()
    if not row:
        raise HTTPException(404, "Dependency not found")
    return row["project_id"]

def _project_id_for_filter(con, filter_id: str) -> str:
    row = con.execute("SELECT project_id FROM saved_filters WHERE id = ?", (filter_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Filter not found")
    return row["project_id"]

def _project_id_for_schedule_perspective(con, perspective_id: str) -> str:
    row = con.execute("SELECT project_id FROM schedule_perspectives WHERE id = ?", (perspective_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Perspective not found")
    return row["project_id"]

def _project_id_for_classification_perspective(con, perspective_id: str) -> str:
    row = con.execute("SELECT project_id FROM classification_perspectives WHERE id = ?", (perspective_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Perspective not found")
    return row["project_id"]

def _project_id_for_calendar_perspective(con, perspective_id: str) -> str:
    row = con.execute("SELECT project_id FROM calendar_perspectives WHERE id = ?", (perspective_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Perspective not found")
    return row["project_id"]

def _project_id_for_context(con, context_id: str) -> str:
    row = con.execute("SELECT project_id FROM project_contexts WHERE id = ?", (context_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Context not found")
    return row["project_id"]

HISTORY_LIMIT = 20

def _time_slot_duration_value(value) -> int:
    try:
        duration = int(value)
    except (TypeError, ValueError):
        raise HTTPException(422, f"Time slot duration must be at least {MIN_TIME_SLOT_DURATION} minutes")
    if duration < MIN_TIME_SLOT_DURATION:
        raise HTTPException(422, f"Time slot duration must be at least {MIN_TIME_SLOT_DURATION} minutes")
    return duration

def _planning_scale_for_duration(duration) -> str:
    value = max(MIN_TIME_SLOT_DURATION, int(duration or MIN_TIME_SLOT_DURATION))
    if value >= MONTH_MINUTES:
        return "month"
    if value >= DAY_MINUTES:
        return "day"
    return "minute"

def _timeline_start_date() -> datetime:
    return datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)

def _calendar_month_boundary_minute(col: int) -> int:
    today = _timeline_start_date()
    year = today.year + (today.month - 1 + col) // 12
    month = (today.month - 1 + col) % 12 + 1
    target = datetime(year, month, 1)
    return round((target - today).total_seconds() / 60)

def _calendar_month_col_for_minute(minute: int, mode: str = "floor") -> int:
    value = max(0, int(minute or 0))
    col = max(0, value // MONTH_MINUTES)
    while _calendar_month_boundary_minute(col + 1) <= value:
        col += 1
    while col > 0 and _calendar_month_boundary_minute(col) > value:
        col -= 1
    if mode == "ceil" and _calendar_month_boundary_minute(col) < value:
        col += 1
    return col

def _is_calendar_month_boundary(minute: int) -> bool:
    value = max(0, int(minute or 0))
    return _calendar_month_boundary_minute(_calendar_month_col_for_minute(value)) == value

def _is_calendar_month_range(start_col: int, duration: int) -> bool:
    start = max(0, int(start_col or 0))
    end = start + max(0, int(duration or 0))
    return end > start and _is_calendar_month_boundary(start) and _is_calendar_month_boundary(end)

def _planning_scale_for_time_slot(time_slot: dict) -> str:
    if _is_calendar_month_range(time_slot.get("startCol", 0), time_slot.get("duration", 0)):
        return "month"
    return _planning_scale_for_duration(time_slot.get("duration", MIN_TIME_SLOT_DURATION))

def _planning_scale_index(scale: str) -> int:
    return {"minute": 0, "day": 1, "month": 2}.get(scale, -1)

def _is_parent_scale_for_child(parent_scale: str, child_scale: str) -> bool:
    parent_idx = _planning_scale_index(parent_scale)
    child_idx = _planning_scale_index(child_scale)
    return parent_idx == child_idx or parent_idx == child_idx + 1

def _normalize_planning_scale(scale: str | None, col: int | None = None) -> str:
    if scale in ("minutes", "minute"):
        return "minute"
    if scale in ("days", "day"):
        return "day"
    if scale in ("months", "month"):
        return "month"
    value = int(col or 0)
    if _is_calendar_month_boundary(value):
        return "month"
    if value % DAY_MINUTES == 0:
        return "day"
    return "minute"

def _planning_scale_unit_minutes(scale: str) -> int:
    if scale == "month":
        return 1
    if scale == "day":
        return DAY_MINUTES
    return 1

def _deadline_scale_unit_minutes(scale: str) -> int:
    if scale == "month":
        return 1
    if scale == "day":
        return DAY_MINUTES
    return MINUTE_SCALE_UNIT

def _assert_scale_aligned_col(col: int, scale: str, kind: str = "Time slot"):
    if scale == "month":
        if not _is_calendar_month_boundary(col):
            raise HTTPException(422, {
                "message": f"{kind} can only be placed on calendar month boundaries",
                "type": f"{kind.lower()}_scale_alignment",
                "scale": scale,
                "unitMinutes": MONTH_MINUTES,
            })
        return
    unit = _deadline_scale_unit_minutes(scale) if kind.lower() == "deadline" else _planning_scale_unit_minutes(scale)
    if int(col) % unit != 0:
        raise HTTPException(422, {
            "message": f"{kind} can only be placed on its own planning scale",
            "type": f"{kind.lower()}_scale_alignment",
            "scale": scale,
            "unitMinutes": unit,
        })

def _schedule_fields_changed(before: dict, after: dict) -> bool:
    return (
        int(before.get("startCol", 0)) != int(after.get("startCol", 0))
        or int(before.get("duration", MIN_TIME_SLOT_DURATION)) != int(after.get("duration", MIN_TIME_SLOT_DURATION))
    )

def _assert_time_slot_scale_edit_allowed(before: dict | None, after: dict):
    return

def _assert_note_time_slot_scales_match(time_slots: list[dict], note_ids: set[str] | None = None):
    return

def _dependency_scale_mismatch(dep: dict, time_slots: dict[str, dict]) -> dict | None:
    return None

def _time_slot_from_api(data: dict) -> dict:
    return {
        "id": data["id"],
        "noteId": data["noteId"],
        "startCol": int(data.get("startCol", 0)),
        "duration": _time_slot_duration_value(data.get("duration", MIN_TIME_SLOT_DURATION)),
        "title": data.get("title", ""),
        "color": data.get("color", "#1a73e8"),
    }

def _dependency_from_api(data: dict) -> dict:
    return {
        "id": data["id"],
        "fromId": data["fromId"],
        "toId": data["toId"],
        "reason": data.get("reason", "") or "",
    }

def _normalize_tx_state(state: dict) -> dict:
    raw_time_slots = (
        state.get("timeSlots")
        or state.get("time_slots")
        or state.get("milestones")
        or []
    )
    return {
        "time_slots": [_time_slot_from_api(m) for m in raw_time_slots],
        "dependencies": [_dependency_from_api(d) for d in state.get("dependencies", [])],
    }

def _time_slots_by_id(con, ids: set[str]) -> dict[str, dict]:
    if not ids:
        return {}
    rows = con.execute(
        f"SELECT * FROM time_slots WHERE id IN ({','.join('?' for _ in ids)})",
        tuple(ids),
    ).fetchall()
    return {row["id"]: _time_slot(row) for row in rows}

def _deps_by_id(con, ids: set[str]) -> dict[str, dict]:
    if not ids:
        return {}
    rows = con.execute(
        f"SELECT * FROM dependencies WHERE id IN ({','.join('?' for _ in ids)})",
        tuple(ids),
    ).fetchall()
    return {row["id"]: _dep(row) for row in rows}

def _state_ids(state: dict, key: str) -> set[str]:
    return {item["id"] for item in state.get(key, []) if item.get("id")}

def _json_equal(left, right) -> bool:
    return json.dumps(left, sort_keys=True) == json.dumps(right, sort_keys=True)

def _assert_before_matches(con, before: dict, after: dict):
    ms_ids = _state_ids(before, "time_slots") | _state_ids(after, "time_slots")
    dep_ids = _state_ids(before, "dependencies") | _state_ids(after, "dependencies")
    current_ms = _time_slots_by_id(con, ms_ids)
    current_deps = _deps_by_id(con, dep_ids)

    for item in before["time_slots"]:
        if not _json_equal(current_ms.get(item["id"]), item):
            raise HTTPException(409, {"message": "Time slot changed before transaction applied", "id": item["id"]})
    for item in before["dependencies"]:
        if not _json_equal(current_deps.get(item["id"]), item):
            raise HTTPException(409, {"message": "Dependency changed before transaction applied", "id": item["id"]})

    before_ms_ids = _state_ids(before, "time_slots")
    before_dep_ids = _state_ids(before, "dependencies")
    for item in after["time_slots"]:
        if item["id"] not in before_ms_ids and item["id"] in current_ms:
            raise HTTPException(409, {"message": "Time slot already exists", "id": item["id"]})
    for item in after["dependencies"]:
        if item["id"] not in before_dep_ids and item["id"] in current_deps:
            raise HTTPException(409, {"message": "Dependency already exists", "id": item["id"]})

def _assert_final_state_valid(con, project_id: str, before: dict, after: dict):
    touched_ms = _state_ids(before, "time_slots") | _state_ids(after, "time_slots")
    touched_deps = _state_ids(before, "dependencies") | _state_ids(after, "dependencies")
    current_ms = {
        row["id"]: _time_slot(row)
        for row in con.execute(
            """
            SELECT m.* FROM time_slots m
            JOIN notes n ON n.id = m.note_id
            WHERE n.project_id = ?
            """,
            (project_id,),
        ).fetchall()
    }
    final_ms = {
        mid: time_slot
        for mid, time_slot in current_ms.items()
        if mid not in touched_ms
    }
    final_deps = {
        row["id"]: _dep(row)
        for row in con.execute(
            """
            SELECT d.* FROM dependencies d
            JOIN time_slots from_ms ON from_ms.id = d.from_id
            JOIN notes from_note ON from_note.id = from_ms.note_id
            JOIN time_slots to_ms ON to_ms.id = d.to_id
            JOIN notes to_note ON to_note.id = to_ms.note_id
            WHERE from_note.project_id = ? AND to_note.project_id = ?
            """,
            (project_id, project_id),
        ).fetchall()
        if row["id"] not in touched_deps
    }
    final_ms.update({m["id"]: m for m in after["time_slots"]})
    final_deps.update({d["id"]: d for d in after["dependencies"]})

    for time_slot in final_ms.values():
        if time_slot["startCol"] < 0:
            raise HTTPException(422, {"message": "Time slots must have a non-negative start", "id": time_slot["id"]})
        if time_slot["duration"] < MIN_TIME_SLOT_DURATION:
            raise HTTPException(422, {"message": f"Time slots must be at least {MIN_TIME_SLOT_DURATION} minutes long", "id": time_slot["id"]})

    for time_slot in after["time_slots"]:
        before_time_slot = current_ms.get(time_slot["id"])
        if before_time_slot is None or _schedule_fields_changed(before_time_slot, time_slot):
            _assert_time_slot_scale_edit_allowed(before_time_slot, time_slot)

    touched_note_ids = {
        time_slot["noteId"]
        for time_slot in before["time_slots"] + after["time_slots"]
        if time_slot.get("noteId")
    }
    _assert_note_time_slot_scales_match(list(final_ms.values()), touched_note_ids)

    by_note = {}
    for time_slot in final_ms.values():
        by_note.setdefault(time_slot["noteId"], []).append(time_slot)
    for note_id, note_time_slots in by_note.items():
        if len(note_time_slots) > 1:
            raise HTTPException(422, {
                "message": "A note can only contain one time slot",
                "type": "note_time_slot_limit",
                "noteId": note_id,
                "timeSlotIds": [m["id"] for m in note_time_slots],
            })
    for lane_time_slots in by_note.values():
        for i, first in enumerate(lane_time_slots):
            for second in lane_time_slots[i + 1:]:
                if first["startCol"] < second["startCol"] + second["duration"] and second["startCol"] < first["startCol"] + first["duration"]:
                    raise HTTPException(422, {
                        "message": "Time slots in the same note row cannot overlap",
                        "type": "overlap",
                        "timeSlotIds": [first["id"], second["id"]],
                    })

    comparable_ids = [mid for mid in current_ms.keys() if mid in final_ms]
    for i, first_id in enumerate(comparable_ids):
        for second_id in comparable_ids[i + 1:]:
            if first_id not in touched_ms and second_id not in touched_ms:
                continue
            first_before = current_ms[first_id]
            second_before = current_ms[second_id]
            first_after = final_ms[first_id]
            second_after = final_ms[second_id]
            if first_before["noteId"] != second_before["noteId"] or first_after["noteId"] != second_after["noteId"]:
                continue
            before_relation = None
            if first_before["startCol"] + first_before["duration"] <= second_before["startCol"]:
                before_relation = "first-before-second"
            elif second_before["startCol"] + second_before["duration"] <= first_before["startCol"]:
                before_relation = "second-before-first"
            after_relation = None
            if first_after["startCol"] + first_after["duration"] <= second_after["startCol"]:
                after_relation = "first-before-second"
            elif second_after["startCol"] + second_after["duration"] <= first_after["startCol"]:
                after_relation = "second-before-first"
            if before_relation and after_relation and before_relation != after_relation:
                raise HTTPException(422, {
                    "message": "Time slots in the same note row cannot pass each other",
                    "type": "overlap",
                    "timeSlotIds": [first_id, second_id],
                })

    deadlines = {}
    for row in con.execute(
        """
        SELECT d.note_id, d.col, d.scale FROM deadlines d
        JOIN notes n ON n.id = d.note_id
        WHERE n.project_id = ?
        """,
        (project_id,),
    ).fetchall():
        scale = _normalize_planning_scale(row["scale"], row["col"])
        key = (row["note_id"], scale)
        current = deadlines.get(key)
        if current is None or row["col"] < current["col"]:
            deadlines[key] = {"col": row["col"], "scale": scale}

    for time_slot in final_ms.values():
        time_slot_scale = _planning_scale_for_time_slot(time_slot)
        deadline = deadlines.get((time_slot["noteId"], time_slot_scale))
        if (
            deadline is not None
            and time_slot["startCol"] + time_slot["duration"] > deadline["col"]
        ):
            raise HTTPException(422, {"message": "Time slot exceeds hard deadline", "type": "deadline", "id": time_slot["id"]})

    earliest_starts = {}
    for row in con.execute(
        """
        SELECT es.note_id, es.col, es.scale FROM earliest_starts es
        JOIN notes n ON n.id = es.note_id
        WHERE n.project_id = ?
        """,
        (project_id,),
    ).fetchall():
        scale = _normalize_planning_scale(row["scale"], row["col"])
        key = (row["note_id"], scale)
        current = earliest_starts.get(key)
        if current is None or row["col"] > current["col"]:
            earliest_starts[key] = {"col": row["col"], "scale": scale}

    inheritance_rows = _combined_note_inheritance(con, project_id)
    time_slot_by_note = {}
    for time_slot in final_ms.values():
        time_slot_by_note[time_slot["noteId"]] = time_slot

    parent_ids_by_child = {}
    for item in inheritance_rows:
        child_note_id = item["childNoteId"]
        parent_note_id = item["parentNoteId"]
        if not child_note_id or not parent_note_id or child_note_id == parent_note_id:
            continue
        parent_ids_by_child.setdefault(child_note_id, []).append(parent_note_id)

    def ancestor_note_ids(note_id: str) -> list[str]:
        ancestors = []
        stack = list(parent_ids_by_child.get(note_id, []))
        seen = set()
        while stack:
            parent_note_id = stack.pop()
            if not parent_note_id or parent_note_id in seen:
                continue
            seen.add(parent_note_id)
            ancestors.append(parent_note_id)
            stack.extend(parent_ids_by_child.get(parent_note_id, []))
        return ancestors

    inherited_starts = {}
    inherited_deadlines = {}
    for time_slot in final_ms.values():
        child_note_id = time_slot["noteId"]
        for parent_note_id in ancestor_note_ids(child_note_id):
            parent_ms = time_slot_by_note.get(parent_note_id)
            if not parent_ms:
                continue
            inherited_starts[child_note_id] = max(inherited_starts.get(child_note_id, 0), parent_ms["startCol"])
            inherited_deadline = parent_ms["startCol"] + parent_ms["duration"]
            inherited_deadlines[child_note_id] = min(inherited_deadlines.get(child_note_id, inherited_deadline), inherited_deadline)

    for time_slot in final_ms.values():
        inherited_deadline = inherited_deadlines.get(time_slot["noteId"])
        if inherited_deadline is not None and time_slot["startCol"] + time_slot["duration"] > inherited_deadline:
            raise HTTPException(422, {
                "message": "Time slot exceeds its inherited parent end boundary",
                "type": "inheritance_deadline",
                "id": time_slot["id"],
                "noteId": time_slot["noteId"],
            })

    for time_slot in final_ms.values():
        time_slot_scale = _planning_scale_for_time_slot(time_slot)
        es = earliest_starts.get((time_slot["noteId"], time_slot_scale))
        inherited_start = inherited_starts.get(time_slot["noteId"])
        if (
            es is not None
            and time_slot["startCol"] < es["col"]
        ):
            raise HTTPException(422, {"message": "Time slot violates earliest start date", "type": "earliest_start", "id": time_slot["id"]})
        if inherited_start is not None and time_slot["startCol"] < inherited_start:
            raise HTTPException(422, {
                "message": "Time slot starts before its inherited parent start boundary",
                "type": "inheritance_earliest_start",
                "id": time_slot["id"],
                "noteId": time_slot["noteId"],
            })

    pairs = set()
    adjacency = {}
    for dep in final_deps.values():
        if dep["fromId"] == dep["toId"]:
            raise HTTPException(422, {"message": "Dependency cannot point to itself", "id": dep["id"]})
        if dep["fromId"] not in final_ms or dep["toId"] not in final_ms:
            raise HTTPException(422, {"message": "Dependency endpoint is missing", "id": dep["id"]})
        pair = (dep["fromId"], dep["toId"])
        if pair in pairs:
            raise HTTPException(409, {"message": "Dependency already exists", "id": dep["id"]})
        scale_mismatch = _dependency_scale_mismatch(dep, final_ms)
        if scale_mismatch:
            raise HTTPException(422, scale_mismatch)
        if final_ms[dep["fromId"]]["startCol"] + final_ms[dep["fromId"]]["duration"] > final_ms[dep["toId"]]["startCol"]:
            raise HTTPException(422, {
                "message": "A predecessor time slot must finish before its successor starts",
                "type": "dependency",
                "dependencyIds": [dep["id"]],
                "timeSlotIds": [dep["fromId"], dep["toId"]],
            })
        pairs.add(pair)
        adjacency.setdefault(dep["fromId"], []).append(dep["toId"])

    visiting, visited = set(), set()
    def visit(node):
        if node in visiting:
            return True
        if node in visited:
            return False
        visiting.add(node)
        for child in adjacency.get(node, []):
            if visit(child):
                return True
        visiting.remove(node)
        visited.add(node)
        return False

    for node in list(adjacency):
        if visit(node):
            raise HTTPException(422, {"message": "Dependency cycle detected"})

def _is_pure_dependency_removal(before: dict, after: dict) -> bool:
    if before["time_slots"] or after["time_slots"]:
        return False

    before_deps = {d["id"]: d for d in before["dependencies"]}
    after_deps = {d["id"]: d for d in after["dependencies"]}
    if not before_deps or not (before_deps.keys() - after_deps.keys()):
        return False
    if not after_deps.keys() <= before_deps.keys():
        return False
    return all(_json_equal(before_deps[dep_id], dep) for dep_id, dep in after_deps.items())

def _apply_transaction_rows(con, before: dict, after: dict):
    before_ms = {m["id"]: m for m in before["time_slots"]}
    after_ms = {m["id"]: m for m in after["time_slots"]}
    before_deps = {d["id"]: d for d in before["dependencies"]}
    after_deps = {d["id"]: d for d in after["dependencies"]}
    deleted_slot_notes: list[tuple[str, str]] = []

    for dep_id in before_deps.keys() - after_deps.keys():
        con.execute("DELETE FROM dependencies WHERE id = ?", (dep_id,))
    for ms_id in before_ms.keys() - after_ms.keys():
        deleted_time_slot = before_ms[ms_id]
        row = con.execute("SELECT project_id FROM notes WHERE id = ?", (deleted_time_slot["noteId"],)).fetchone()
        con.execute("DELETE FROM dependencies WHERE from_id = ? OR to_id = ?", (ms_id, ms_id))
        con.execute("DELETE FROM time_slots WHERE id = ?", (ms_id,))
        if row:
            deleted_slot_notes.append((deleted_time_slot["noteId"], row["project_id"]))
    for m in after_ms.values():
        if m["id"] in before_ms:
            con.execute(
                "UPDATE time_slots SET note_id = ?, start_col = ?, duration = ?, title = ?, color = ? WHERE id = ?",
                (m["noteId"], m["startCol"], m["duration"], m["title"], m["color"], m["id"]),
            )
        else:
            con.execute(
                "INSERT INTO time_slots (id, note_id, start_col, duration, title, color) VALUES (?,?,?,?,?,?)",
                (m["id"], m["noteId"], m["startCol"], m["duration"], m["title"], m["color"]),
            )
    for d in after_deps.values():
        if d["id"] in before_deps:
            con.execute(
                "UPDATE dependencies SET from_id = ?, to_id = ?, reason = ? WHERE id = ?",
                (d["fromId"], d["toId"], d["reason"], d["id"]),
            )
        else:
            con.execute(
                "INSERT INTO dependencies (id, from_id, to_id, reason) VALUES (?, ?, ?, ?)",
                (d["id"], d["fromId"], d["toId"], d["reason"]),
            )
    for note_id, project_id in deleted_slot_notes:
        _unassign_scheduled_if_unslotted(con, note_id, project_id)

def _assert_transaction_project_scope(con, project_id: str, before: dict, after: dict):
    for time_slot in before["time_slots"] + after["time_slots"]:
        note_id = time_slot.get("noteId")
        row = con.execute("SELECT project_id FROM notes WHERE id = ?", (note_id,)).fetchone()
        if not row or row["project_id"] != project_id:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Transaction time slot is outside this project")

    time_slot_ids = {
        m["id"]
        for m in before["time_slots"] + after["time_slots"]
        if m.get("id")
    }
    dep_endpoint_ids = {
        endpoint
        for dep in before["dependencies"] + after["dependencies"]
        for endpoint in (dep.get("fromId"), dep.get("toId"))
        if endpoint
    }
    current_ms = _time_slots_by_id(con, time_slot_ids | dep_endpoint_ids)
    after_ms = {m["id"]: m for m in after["time_slots"] if m.get("id")}
    for dep in before["dependencies"] + after["dependencies"]:
        for endpoint in (dep.get("fromId"), dep.get("toId")):
            time_slot = after_ms.get(endpoint) or current_ms.get(endpoint)
            if not time_slot:
                continue
            row = con.execute("SELECT project_id FROM notes WHERE id = ?", (time_slot["noteId"],)).fetchone()
            if not row or row["project_id"] != project_id:
                raise HTTPException(status.HTTP_403_FORBIDDEN, "Transaction dependency is outside this project")

def _push_history(con, project_id: str, transaction: dict, before: dict, after: dict):
    con.execute(
        "DELETE FROM transaction_history WHERE project_id = ? AND stack = 'redo'",
        (project_id,),
    )
    seq = con.execute(
        "SELECT COALESCE(MAX(seq), 0) + 1 FROM transaction_history WHERE project_id = ? AND stack = 'undo'",
        (project_id,),
    ).fetchone()[0]
    con.execute(
        """
        INSERT INTO transaction_history (id, project_id, stack, seq, transaction_json, before_json, after_json)
        VALUES (?, ?, 'undo', ?, ?, ?, ?)
        """,
        (transaction["id"], project_id, seq, json.dumps(transaction), json.dumps(before), json.dumps(after)),
    )
    overflow = con.execute(
        """
        SELECT id FROM transaction_history
        WHERE project_id = ? AND stack = 'undo'
        ORDER BY seq DESC LIMIT -1 OFFSET ?
        """,
        (project_id, HISTORY_LIMIT),
    ).fetchall()
    if overflow:
        con.execute(
            f"DELETE FROM transaction_history WHERE id IN ({','.join('?' for _ in overflow)})",
            tuple(row["id"] for row in overflow),
        )

def _move_history_entry(con, project_id: str, row, target_stack: str):
    seq = con.execute(
        "SELECT COALESCE(MAX(seq), 0) + 1 FROM transaction_history WHERE project_id = ? AND stack = ?",
        (project_id, target_stack),
    ).fetchone()[0]
    con.execute(
        "UPDATE transaction_history SET stack = ?, seq = ? WHERE id = ?",
        (target_stack, seq, row["id"]),
    )

def _history_summary(con, project_id: str) -> dict:
    rows = con.execute(
        "SELECT id, stack, seq, transaction_json FROM transaction_history WHERE project_id = ? ORDER BY stack, seq",
        (project_id,),
    ).fetchall()
    undo, redo = [], []
    for row in rows:
        tx = json.loads(row["transaction_json"])
        item = {"id": row["id"], "type": tx.get("type"), "label": tx.get("label"), "seq": row["seq"]}
        if row["stack"] == "undo":
            undo.append(item)
        else:
            redo.append(item)
    undo.sort(key=lambda item: item["seq"])
    redo.sort(key=lambda item: item["seq"])
    return {"undo": undo, "redo": redo}

def _apply_transaction(con, project_id: str, transaction: TransactionPayload, record_history: bool = True):
    tx = transaction.dict()
    tx["id"] = tx.get("id") or str(uuid.uuid4())
    raw_before = tx.get("before") or {}
    raw_after = tx.get("after") or {}
    if "noteTree" in raw_before or "noteTree" in raw_after:
        _apply_note_tree_state_change(con, project_id, raw_before, raw_after)
        if record_history:
            tx["before"] = raw_before
            tx["after"] = raw_after
            _push_history(con, project_id, tx, raw_before, raw_after)
        return {"ok": True, "transaction": tx, "history": _history_summary(con, project_id)}

    before = _normalize_tx_state(raw_before)
    after = _normalize_tx_state(raw_after)
    _assert_transaction_project_scope(con, project_id, before, after)
    _assert_before_matches(con, before, after)
    if not _is_pure_dependency_removal(before, after):
        _assert_final_state_valid(con, project_id, before, after)
    _apply_transaction_rows(con, before, after)
    if record_history:
        tx["before"] = before
        tx["after"] = after
        _push_history(con, project_id, tx, before, after)
    return {"ok": True, "transaction": tx, "history": _history_summary(con, project_id)}

def _dependency_violations_for_project(con, project_id: str) -> list[dict]:
    rows = con.execute(
        """
        SELECT
            d.id AS dep_id,
            d.reason AS reason,
            from_ms.id AS from_id,
            from_ms.title AS from_title,
            from_ms.start_col AS from_start,
            from_ms.duration AS from_duration,
            from_note.id AS from_note_id,
            from_note.title AS from_note_title,
            to_ms.id AS to_id,
            to_ms.title AS to_title,
            to_ms.start_col AS to_start,
            to_ms.duration AS to_duration,
            to_note.id AS to_note_id,
            to_note.title AS to_note_title
        FROM dependencies d
        JOIN time_slots from_ms ON from_ms.id = d.from_id
        JOIN notes from_note ON from_note.id = from_ms.note_id
        JOIN time_slots to_ms ON to_ms.id = d.to_id
        JOIN notes to_note ON to_note.id = to_ms.note_id
        WHERE from_note.project_id = ? AND to_note.project_id = ?
        ORDER BY from_note.order_idx, from_ms.start_col, to_note.order_idx, to_ms.start_col
        """,
        (project_id, project_id),
    ).fetchall()
    violations = []
    for row in rows:
        from_end = int(row["from_start"]) + int(row["from_duration"])
        to_start = int(row["to_start"])
        to_end = int(row["to_start"]) + int(row["to_duration"])
        from_scale = _planning_scale_for_time_slot({"startCol": row["from_start"], "duration": row["from_duration"]})
        to_scale = _planning_scale_for_time_slot({"startCol": row["to_start"], "duration": row["to_duration"]})
        base = {
            "dependencyId": row["dep_id"],
            "reason": row["reason"] or "",
            "from": {
                "timeSlotId": row["from_id"],
                "timeSlotTitle": row["from_title"] or "",
                "noteId": row["from_note_id"],
                "noteTitle": row["from_note_title"],
                "startCol": row["from_start"],
                "duration": row["from_duration"],
                "endCol": from_end,
                "scale": from_scale,
            },
            "to": {
                "timeSlotId": row["to_id"],
                "timeSlotTitle": row["to_title"] or "",
                "noteId": row["to_note_id"],
                "noteTitle": row["to_note_title"],
                "startCol": row["to_start"],
                "duration": row["to_duration"],
                "endCol": to_end,
                "scale": to_scale,
            },
        }
        if from_end > to_start:
            violations.append({
                **base,
                "type": "dependency",
                "message": "A predecessor time slot must finish before its successor starts",
                "overlapMinutes": from_end - to_start,
            })
    return violations


# ── Auth helpers ──────────────────────────────────────────────────────────────
def _auth_secret() -> str:
    secret = os.getenv("JWT_SECRET_KEY") or os.getenv("AUTH_SECRET_KEY")
    if not secret:
        raise HTTPException(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "JWT secret is not configured",
        )
    return secret

def _normalize_email(email: str) -> str:
    return (email or "").strip().lower()

def _user(row) -> dict:
    d = dict(row)
    return {
        "id": d["id"],
        "email": d["email"],
        "displayName": d["display_name"],
        "createdAt": d["created_at"],
        "googleOauth": bool(d["google_oauth"]),
        "isSuperuser": bool(d.get("is_superuser", 0)),
    }

def _hash_password(password: str) -> str:
    return pwd_context.hash(password)

def _verify_password(password: str, hashed_password: str | None) -> bool:
    if not hashed_password:
        return False
    return pwd_context.verify(password, hashed_password)

def _create_access_token(user_id: str) -> str:
    exp = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_MINUTES)
    return jwt.encode({"sub": user_id, "exp": exp}, _auth_secret(), algorithm=JWT_ALGORITHM)

def _create_refresh_token(user_id: str) -> str:
    exp = datetime.now(timezone.utc) + timedelta(days=REFRESH_TOKEN_DAYS)
    return jwt.encode({"sub": user_id, "exp": exp, "typ": "refresh"}, _auth_secret(), algorithm=JWT_ALGORITHM)

def _token_pair(user_id: str) -> dict:
    return {
        "accessToken": _create_access_token(user_id),
        "refreshToken": _create_refresh_token(user_id),
        "tokenType": "bearer",
        "expiresIn": ACCESS_TOKEN_MINUTES * 60,
    }

def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",", 1)[0].strip()
    return request.client.host if request.client else "unknown"

def _check_rate_limit(request: Request, bucket: str):
    ip = _client_ip(request)
    key = (bucket, ip)
    now = time.monotonic()
    cutoff = now - RATE_LIMIT_WINDOW_SECONDS
    with _rate_limit_lock:
        attempts = [ts for ts in _rate_limit_buckets.get(key, []) if ts >= cutoff]
        if len(attempts) >= LOGIN_REGISTER_LIMIT:
            _rate_limit_buckets[key] = attempts
            raise HTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS,
                "Too many attempts. Please try again later.",
            )
        attempts.append(now)
        _rate_limit_buckets[key] = attempts

def current_user(authorization: str | None = Header(default=None)) -> dict:
    if not authorization:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing authorization header")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid authorization header")
    try:
        payload = jwt.decode(token, _auth_secret(), algorithms=[JWT_ALGORITHM])
    except JWTError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired token")
    user_id = payload.get("sub")
    if not user_id or payload.get("typ") == "refresh":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid token")
    with _db() as con:
        row = con.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    if not row:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid token")
    return _user(row)


# ── Auth ──────────────────────────────────────────────────────────────────────
@app.post("/auth/register", response_model=TokenOut, status_code=201)
def register(data: RegisterIn, request: Request):
    _check_rate_limit(request, "register")
    _auth_secret()
    email = _normalize_email(data.email)
    display_name = (data.displayName or "").strip()
    password = data.password or ""
    if "@" not in email or "." not in email.rsplit("@", 1)[-1]:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Valid email is required")
    if not display_name:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Display name is required")
    if len(password) < 8:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Password must be at least 8 characters")

    user_id = str(uuid.uuid4())
    hashed_password = _hash_password(password)
    with _db() as con:
        if con.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone():
            raise HTTPException(status.HTTP_409_CONFLICT, "Email is already registered")
        con.execute(
            """
            INSERT INTO users (id, email, display_name, hashed_password, google_oauth)
            VALUES (?, ?, ?, ?, 0)
            """,
            (user_id, email, display_name, hashed_password),
        )
    return _token_pair(user_id)

@app.post("/auth/login", response_model=TokenOut)
def login(data: LoginIn, request: Request):
    _check_rate_limit(request, "login")
    _auth_secret()
    email = _normalize_email(data.email)
    with _db() as con:
        row = con.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
    if not row or not _verify_password(data.password or "", row["hashed_password"]):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid email or password")
    return _token_pair(row["id"])

@app.post("/auth/refresh", response_model=AccessTokenOut)
def refresh_token(data: RefreshIn):
    _auth_secret()
    try:
        payload = jwt.decode(data.refreshToken, _auth_secret(), algorithms=[JWT_ALGORITHM])
    except JWTError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired refresh token")
    if payload.get("typ") != "refresh" or not payload.get("sub"):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid refresh token")
    user_id = payload["sub"]
    with _db() as con:
        if not con.execute("SELECT id FROM users WHERE id = ?", (user_id,)).fetchone():
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid refresh token")
    return {
        "accessToken": _create_access_token(user_id),
        "tokenType": "bearer",
        "expiresIn": ACCESS_TOKEN_MINUTES * 60,
    }

@app.get("/auth/me")
def me(user: dict = Depends(current_user)):
    return user


# ── Projects ──────────────────────────────────────────────────────────────────
@app.get("/projects")
def list_projects(user: dict = Depends(current_user)):
    with _db() as con:
        if user.get("isSuperuser"):
            rows = con.execute("SELECT * FROM projects WHERE archived_at IS NULL ORDER BY created_at").fetchall()
        else:
            rows = con.execute("SELECT * FROM projects WHERE user_id = ? AND archived_at IS NULL ORDER BY created_at", (user["id"],)).fetchall()
        for row in rows:
            _ensure_project_root_note(con, row["id"])
        if user.get("isSuperuser"):
            rows = con.execute("SELECT * FROM projects WHERE archived_at IS NULL ORDER BY created_at").fetchall()
        else:
            rows = con.execute("SELECT * FROM projects WHERE user_id = ? AND archived_at IS NULL ORDER BY created_at", (user["id"],)).fetchall()
    return [_project(r) for r in rows]

@app.post("/projects", status_code=201)
def create_project(data: ProjectIn, user: dict = Depends(current_user)):
    pid = data.id or str(uuid.uuid4())
    name = data.name.strip() or 'Untitled'
    end_date = data.endDate or ''
    root_note_id = str(uuid.uuid4())
    with _db() as con:
        if con.execute("SELECT id FROM projects WHERE id = ?", (pid,)).fetchone():
            raise HTTPException(409, "Project already exists")
        con.execute(
            "INSERT INTO projects (id, user_id, root_note_id, name, description, end_date, resize_warn_order_threshold, resize_block_order_threshold, resize_scale_crossing_warning_enabled) VALUES (?, ?, ?, ?, ?, ?, 2, 2, 1)",
            (pid, user["id"], root_note_id, name, data.description or '', end_date),
        )
        con.execute(
            "INSERT INTO notes (id, project_id, parent_note_id, html, title, collapsed, order_idx) VALUES (?, ?, NULL, ?, ?, 0, ?)",
            (root_note_id, pid, data.description or '', name, -1),
        )
        row = con.execute("SELECT * FROM projects WHERE id = ?", (pid,)).fetchone()
    _seed_defaults(pid)
    return _project(row)

@app.patch("/projects/{project_id}")
def update_project(project_id: str, data: ProjectPatch, user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    with _db() as con:
        fields, values = [], []
        if data.name is not None:
            fields.append("name = ?");  values.append(data.name.strip() or 'Untitled')
        if data.description is not None:
            fields.append("description = ?"); values.append(data.description)
        if data.endDate is not None:
            fields.append("end_date = ?"); values.append(data.endDate)
        if data.resizeWarnOrderThreshold is not None:
            fields.append("resize_warn_order_threshold = ?"); values.append(max(0, float(data.resizeWarnOrderThreshold)))
        if data.resizeBlockOrderThreshold is not None:
            fields.append("resize_block_order_threshold = ?"); values.append(max(0, float(data.resizeBlockOrderThreshold)))
        if data.resizeScaleCrossingWarningEnabled is not None:
            fields.append("resize_scale_crossing_warning_enabled = ?"); values.append(int(bool(data.resizeScaleCrossingWarningEnabled)))
        if fields:
            con.execute(f"UPDATE projects SET {', '.join(fields)} WHERE id = ?", (*values, project_id))
        row = con.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
        root_note_id = _ensure_project_root_note(con, project_id)
        note_fields, note_values = [], []
        if data.name is not None:
            note_fields.append("title = ?"); note_values.append(data.name.strip() or 'Untitled')
        if data.description is not None:
            note_fields.append("html = ?"); note_values.append(data.description)
        if note_fields:
            con.execute(f"UPDATE notes SET {', '.join(note_fields)} WHERE id = ?", (*note_values, root_note_id))
        row = con.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
    return _project(row)

@app.get("/projects/{project_id}/stats")
def get_project_stats(project_id: str, user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    with _db() as con:
        root_note_id = _ensure_project_root_note(con, project_id)
        notes = con.execute(
            "SELECT COUNT(*) FROM notes WHERE project_id = ? AND id != ?", (project_id, root_note_id)
        ).fetchone()[0]
        time_slots = con.execute(
            "SELECT COUNT(*) FROM time_slots WHERE note_id IN (SELECT id FROM notes WHERE project_id = ?)",
            (project_id,)
        ).fetchone()[0]
        dimensions = con.execute(
            "SELECT COUNT(*) FROM dimensions WHERE project_id = ?", (project_id,)
        ).fetchone()[0]
        categories = con.execute(
            """SELECT COUNT(*) FROM categories
            WHERE dimension_id IN (SELECT id FROM dimensions WHERE project_id = ?)""",
            (project_id,)
        ).fetchone()[0]
        dependencies = con.execute(
            """SELECT COUNT(*) FROM dependencies WHERE from_id IN (
                SELECT id FROM time_slots WHERE note_id IN (SELECT id FROM notes WHERE project_id = ?)
            )""",
            (project_id,)
        ).fetchone()[0]
        perspectives = con.execute(
            """SELECT
                (SELECT COUNT(*) FROM schedule_perspectives WHERE project_id = ?) +
                (SELECT COUNT(*) FROM classification_perspectives WHERE project_id = ?) +
                (SELECT COUNT(*) FROM calendar_perspectives WHERE project_id = ?)""",
            (project_id, project_id, project_id)
        ).fetchone()[0]
    return {
        "notes": notes,
        "timeSlots": time_slots,
        "dimensions": dimensions,
        "categories": categories,
        "dependencies": dependencies,
        "perspectives": perspectives,
    }

@app.delete("/projects/{project_id}", status_code=204)
def delete_project(project_id: str, user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    with _db() as con:
        con.execute("UPDATE projects SET archived_at = CURRENT_TIMESTAMP WHERE id = ?", (project_id,))

@app.get("/archive")
def list_archive(user: dict = Depends(current_user)):
    with _db() as con:
        owner_clause = "" if user.get("isSuperuser") else "WHERE p.user_id = ?"
        owner_args = () if user.get("isSuperuser") else (user["id"],)
        archived_projects = con.execute(
            f"SELECT p.* FROM projects p {owner_clause} {'AND' if owner_clause else 'WHERE'} p.archived_at IS NOT NULL ORDER BY p.archived_at DESC",
            owner_args,
        ).fetchall()
        archived_notes = con.execute(
            f"""
            SELECT a.*, p.name AS project_name, p.archived_at AS project_archived_at
            FROM note_archive a
            JOIN projects p ON p.id = a.project_id
            {owner_clause}
            ORDER BY a.archived_at DESC
            """,
            owner_args,
        ).fetchall()
    return {
        "projects": [_project(row) for row in archived_projects],
        "noteTrees": [{
            "id": row["id"],
            "projectId": row["project_id"],
            "projectName": row["project_name"],
            "projectArchived": bool(row["project_archived_at"]),
            "rootNoteId": row["root_note_id"],
            "title": row["title"],
            "archivedAt": row["archived_at"],
            "noteCount": len((json.loads(row["snapshot_json"]) or {}).get("notes") or []),
        } for row in archived_notes],
    }

@app.post("/archive/projects/{project_id}/restore")
def restore_archived_project(project_id: str, user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    with _db() as con:
        con.execute("UPDATE projects SET archived_at = NULL WHERE id = ?", (project_id,))
        row = con.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
    return _project(row)

@app.post("/archive/notes/{archive_id}/restore")
def restore_archived_note_tree(archive_id: str, user: dict = Depends(current_user)):
    with _db() as con:
        row = con.execute("SELECT * FROM note_archive WHERE id = ?", (archive_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Archived note tree not found")
        project_id = row["project_id"]
        assert_project_access(project_id, user)
        project = con.execute("SELECT archived_at FROM projects WHERE id = ?", (project_id,)).fetchone()
        if project and project["archived_at"]:
            raise HTTPException(409, "Restore the containing project before restoring this note tree")
        snapshot = json.loads(row["snapshot_json"])
        _restore_note_tree_snapshot(con, project_id, snapshot)
        transaction = {
            "id": str(uuid.uuid4()),
            "type": "note.restore-tree",
            "label": f"Restore {row['title'] or 'Untitled'}",
            "before": {"noteTree": None},
            "after": {"noteTree": snapshot},
        }
        _push_history(con, project_id, transaction, transaction["before"], transaction["after"])
    return {"ok": True, "projectId": project_id, "rootNoteId": snapshot["rootNoteId"]}


# ── Notes (notes) ─────────────────────────────────────────────────────────────
@app.get("/notes")
def list_notes(
    project_id: str = Query(default='default'),
    include_root: bool = False,
    user: dict = Depends(current_user),
):
    assert_project_access(project_id, user)
    with _db() as con:
        root_note_id = _ensure_project_root_note(con, project_id)
        if include_root:
            rows = con.execute(
                "SELECT * FROM notes WHERE project_id = ? ORDER BY order_idx", (project_id,)
            ).fetchall()
        else:
            rows = con.execute(
                "SELECT * FROM notes WHERE project_id = ? AND id != ? ORDER BY order_idx",
                (project_id, root_note_id),
            ).fetchall()
    return [_note(r) for r in rows]

@app.post("/notes", status_code=201)
def create_note(data: NoteIn, project_id: str = Query(default='default'), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    pid = data.id or str(uuid.uuid4())
    with _db() as con:
        if con.execute("SELECT id FROM notes WHERE id = ?", (pid,)).fetchone():
            raise HTTPException(409, "Note already exists")
        parent_note_id = data.parentNoteId or _ensure_project_root_note(con, project_id)
        _assert_valid_structural_parent(con, pid, project_id, parent_note_id)
        max_ord = con.execute(
            "SELECT COALESCE(MAX(order_idx), -1) FROM notes WHERE project_id = ? AND parent_note_id IS ?",
            (project_id, parent_note_id),
        ).fetchone()[0]
        con.execute(
            "INSERT INTO notes (id, project_id, parent_note_id, html, title, collapsed, order_idx) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (pid, project_id, parent_note_id, data.html, data.title, int(data.collapsed), max_ord + 1),
        )
        row = con.execute("SELECT * FROM notes WHERE id = ?", (pid,)).fetchone()
    return _note(row)

@app.patch("/notes/{note_id}")
def update_note(note_id: str, data: NotePatch, user: dict = Depends(current_user)):
    with _db() as con:
        project_id = _project_id_for_note(con, note_id)
        assert_project_access(project_id, user)
        fields, values = [], []
        if data.html is not None:      fields.append("html = ?");      values.append(data.html)
        if data.title is not None:     fields.append("title = ?");     values.append(data.title)
        if data.collapsed is not None: fields.append("collapsed = ?"); values.append(int(data.collapsed))
        if data.parentNoteId is not None:
            parent_note_id = _assert_valid_structural_parent(con, note_id, project_id, data.parentNoteId)
            _assert_structural_time_window_if_scheduled(con, note_id, parent_note_id)
            fields.append("parent_note_id = ?"); values.append(parent_note_id)
        if fields:
            con.execute(f"UPDATE notes SET {', '.join(fields)} WHERE id = ?", (*values, note_id))
        row = con.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
    return _note(row)

@app.post("/notes/{note_id}/duplicate", status_code=201)
def duplicate_note(note_id: str, user: dict = Depends(current_user)):
    with _db() as con:
        project_id = _project_id_for_note(con, note_id)
        assert_project_access(project_id, user)
        source = con.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
        if not source:
            raise HTTPException(404, "Note not found")

        new_note_id = str(uuid.uuid4())
        source_order = int(source["order_idx"] or 0)
        con.execute(
            "UPDATE notes SET order_idx = order_idx + 1 WHERE project_id = ? AND order_idx > ?",
            (project_id, source_order),
        )
        con.execute(
            "INSERT INTO notes (id, project_id, parent_note_id, html, title, collapsed, order_idx) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (new_note_id, project_id, source["parent_note_id"], source["html"], source["title"], source["collapsed"], source_order + 1),
        )

        for row in con.execute("SELECT dimension_id, category_id, order_idx FROM assignments WHERE note_id = ?", (note_id,)).fetchall():
            con.execute(
                "INSERT INTO assignments (note_id, dimension_id, category_id, order_idx) VALUES (?, ?, ?, ?)",
                (new_note_id, row["dimension_id"], row["category_id"], row["order_idx"]),
            )

        for row in con.execute("SELECT persona_id FROM persona_note_assignments WHERE note_id = ?", (note_id,)).fetchall():
            con.execute(
                "INSERT OR IGNORE INTO persona_note_assignments (persona_id, note_id) VALUES (?, ?)",
                (row["persona_id"], new_note_id),
            )

        source_time_slot_ids = []
        time_slot_id_map = {}
        for row in con.execute("SELECT * FROM time_slots WHERE note_id = ? ORDER BY start_col, rowid", (note_id,)).fetchall():
            new_ms_id = str(uuid.uuid4())
            source_time_slot_ids.append(row["id"])
            time_slot_id_map[row["id"]] = new_ms_id
            con.execute(
                "INSERT INTO time_slots (id, note_id, start_col, duration, title, color) VALUES (?, ?, ?, ?, ?, ?)",
                (new_ms_id, new_note_id, row["start_col"], row["duration"], row["title"], row["color"]),
            )
            for pma in con.execute("SELECT persona_id FROM persona_time_slot_assignments WHERE time_slot_id = ?", (row["id"],)).fetchall():
                con.execute(
                    "INSERT OR IGNORE INTO persona_time_slot_assignments (persona_id, time_slot_id) VALUES (?, ?)",
                    (pma["persona_id"], new_ms_id),
                )

        if source_time_slot_ids:
            ph = ",".join("?" for _ in source_time_slot_ids)
            dep_rows = con.execute(
                f"SELECT * FROM dependencies WHERE from_id IN ({ph}) OR to_id IN ({ph})",
                source_time_slot_ids + source_time_slot_ids,
            ).fetchall()
            for dep in dep_rows:
                new_from_id = time_slot_id_map.get(dep["from_id"], dep["from_id"])
                new_to_id = time_slot_id_map.get(dep["to_id"], dep["to_id"])
                if new_from_id == new_to_id:
                    continue
                con.execute(
                    "INSERT OR IGNORE INTO dependencies (id, from_id, to_id, reason) VALUES (?, ?, ?, ?)",
                    (str(uuid.uuid4()), new_from_id, new_to_id, dep["reason"]),
                )

        deadline = con.execute("SELECT * FROM deadlines WHERE note_id = ?", (note_id,)).fetchone()
        if deadline:
            con.execute(
                "INSERT INTO deadlines (id, note_id, col, scale) VALUES (?, ?, ?, ?)",
                (str(uuid.uuid4()), new_note_id, deadline["col"], deadline["scale"]),
            )

        earliest_start = con.execute("SELECT * FROM earliest_starts WHERE note_id = ?", (note_id,)).fetchone()
        if earliest_start:
            con.execute(
                "INSERT INTO earliest_starts (id, note_id, col, scale) VALUES (?, ?, ?, ?)",
                (str(uuid.uuid4()), new_note_id, earliest_start["col"], earliest_start["scale"]),
            )

        inheritance_rows = con.execute("SELECT parent_note_id FROM note_inheritance WHERE child_note_id = ?", (note_id,)).fetchall()
        for inheritance in inheritance_rows:
            con.execute(
                "INSERT OR IGNORE INTO note_inheritance (child_note_id, parent_note_id) VALUES (?, ?)",
                (new_note_id, inheritance["parent_note_id"]),
            )

        note = con.execute("SELECT * FROM notes WHERE id = ?", (new_note_id,)).fetchone()
        time_slots = con.execute("SELECT * FROM time_slots WHERE note_id = ? ORDER BY start_col", (new_note_id,)).fetchall()
        assignments = con.execute("SELECT * FROM assignments WHERE note_id = ?", (new_note_id,)).fetchall()
        deadlines = con.execute("SELECT * FROM deadlines WHERE note_id = ?", (new_note_id,)).fetchall()
        earliest_starts = con.execute("SELECT * FROM earliest_starts WHERE note_id = ?", (new_note_id,)).fetchall()
        inheritance_rows = con.execute("SELECT * FROM note_inheritance WHERE child_note_id = ?", (new_note_id,)).fetchall()
        dependencies = con.execute(
            """
            SELECT * FROM dependencies
            WHERE from_id IN (SELECT id FROM time_slots WHERE note_id = ?)
               OR to_id IN (SELECT id FROM time_slots WHERE note_id = ?)
            """,
            (new_note_id, new_note_id),
        ).fetchall()

    return {
        "note": _note(note),
        "timeSlots": [_time_slot(row) for row in time_slots],
        "dependencies": [_dep(row) for row in dependencies],
        "assignments": [_assign(row) for row in assignments],
        "deadlines": [_dl(row) for row in deadlines],
        "earliestStarts": [_es(row) for row in earliest_starts],
        "noteInheritance": [_inheritance(row) for row in inheritance_rows],
    }

def _rows_as_dicts(rows) -> list[dict]:
    return [dict(row) for row in rows]

def _note_tree_snapshot(con, project_id: str, note_id: str, cascade: bool) -> dict:
    root = con.execute(
        "SELECT * FROM notes WHERE id = ? AND project_id = ?",
        (note_id, project_id),
    ).fetchone()
    if not root:
        raise HTTPException(404, "Note not found")

    note_ids = [note_id]
    if cascade:
        seen = {note_id}
        pending = [note_id]
        while pending:
            parent_id = pending.pop()
            for row in con.execute(
                "SELECT id FROM notes WHERE project_id = ? AND parent_note_id = ?",
                (project_id, parent_id),
            ).fetchall():
                child_id = row["id"]
                if child_id in seen:
                    continue
                seen.add(child_id)
                note_ids.append(child_id)
                pending.append(child_id)

    note_ph = ",".join("?" for _ in note_ids)
    time_slots = con.execute(
        f"SELECT * FROM time_slots WHERE note_id IN ({note_ph})",
        note_ids,
    ).fetchall()
    time_slot_ids = [row["id"] for row in time_slots]
    dependencies = []
    persona_time_slot_assignments = []
    if time_slot_ids:
        slot_ph = ",".join("?" for _ in time_slot_ids)
        dependencies = con.execute(
            f"SELECT * FROM dependencies WHERE from_id IN ({slot_ph}) OR to_id IN ({slot_ph})",
            time_slot_ids + time_slot_ids,
        ).fetchall()
        persona_time_slot_assignments = con.execute(
            f"SELECT * FROM persona_time_slot_assignments WHERE time_slot_id IN ({slot_ph})",
            time_slot_ids,
        ).fetchall()

    return {
        "archiveId": str(uuid.uuid4()),
        "rootNoteId": note_id,
        "cascade": cascade,
        "notes": _rows_as_dicts(con.execute(
            f"SELECT * FROM notes WHERE id IN ({note_ph}) ORDER BY order_idx",
            note_ids,
        ).fetchall()),
        "timeSlots": _rows_as_dicts(time_slots),
        "dependencies": _rows_as_dicts(dependencies),
        "assignments": _rows_as_dicts(con.execute(
            f"SELECT * FROM assignments WHERE note_id IN ({note_ph})",
            note_ids,
        ).fetchall()),
        "deadlines": _rows_as_dicts(con.execute(
            f"SELECT * FROM deadlines WHERE note_id IN ({note_ph})",
            note_ids,
        ).fetchall()),
        "earliestStarts": _rows_as_dicts(con.execute(
            f"SELECT * FROM earliest_starts WHERE note_id IN ({note_ph})",
            note_ids,
        ).fetchall()),
        "personaNoteAssignments": _rows_as_dicts(con.execute(
            f"SELECT * FROM persona_note_assignments WHERE note_id IN ({note_ph})",
            note_ids,
        ).fetchall()),
        "personaTimeSlotAssignments": _rows_as_dicts(persona_time_slot_assignments),
        "noteInheritance": _rows_as_dicts(con.execute(
            f"SELECT * FROM note_inheritance WHERE child_note_id IN ({note_ph}) OR parent_note_id IN ({note_ph})",
            note_ids + note_ids,
        ).fetchall()),
        "reparentedChildren": [] if cascade else _rows_as_dicts(con.execute(
            "SELECT id, parent_note_id FROM notes WHERE project_id = ? AND parent_note_id = ?",
            (project_id, note_id),
        ).fetchall()),
    }

def _delete_note_tree_snapshot(con, project_id: str, snapshot: dict):
    notes = snapshot.get("notes") or []
    note_ids = [row["id"] for row in notes]
    if not note_ids:
        return
    existing = con.execute(
        f"SELECT id FROM notes WHERE project_id = ? AND id IN ({','.join('?' for _ in note_ids)})",
        (project_id, *note_ids),
    ).fetchall()
    if len(existing) != len(note_ids):
        raise HTTPException(409, "The note tree changed before the transaction could be applied")

    root_note_id = snapshot["rootNoteId"]
    root_row = next((row for row in notes if row["id"] == root_note_id), None)
    archive_id = snapshot.get("archiveId") or str(uuid.uuid4())
    snapshot["archiveId"] = archive_id
    con.execute(
        """
        INSERT OR REPLACE INTO note_archive (id, project_id, root_note_id, title, snapshot_json, archived_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        """,
        (archive_id, project_id, root_note_id, (root_row or {}).get("title") or "Untitled", json.dumps(snapshot)),
    )

    fallback_parent_id = (root_row or {}).get("parent_note_id") or _ensure_project_root_note(con, project_id)
    if not snapshot.get("cascade"):
        con.execute("UPDATE notes SET parent_note_id = ? WHERE parent_note_id = ?", (fallback_parent_id, root_note_id))

    note_ph = ",".join("?" for _ in note_ids)
    time_slot_ids = [row["id"] for row in snapshot.get("timeSlots") or []]
    if time_slot_ids:
        slot_ph = ",".join("?" for _ in time_slot_ids)
        con.execute(f"DELETE FROM dependencies WHERE from_id IN ({slot_ph}) OR to_id IN ({slot_ph})", time_slot_ids + time_slot_ids)
        con.execute(f"DELETE FROM persona_time_slot_assignments WHERE time_slot_id IN ({slot_ph})", time_slot_ids)
        con.execute(f"DELETE FROM time_slots WHERE id IN ({slot_ph})", time_slot_ids)
    con.execute(f"DELETE FROM deadlines WHERE note_id IN ({note_ph})", note_ids)
    con.execute(f"DELETE FROM earliest_starts WHERE note_id IN ({note_ph})", note_ids)
    con.execute(f"DELETE FROM assignments WHERE note_id IN ({note_ph})", note_ids)
    con.execute(f"DELETE FROM persona_note_assignments WHERE note_id IN ({note_ph})", note_ids)
    con.execute(
        f"DELETE FROM note_inheritance WHERE child_note_id IN ({note_ph}) OR parent_note_id IN ({note_ph})",
        note_ids + note_ids,
    )
    con.execute(f"DELETE FROM notes WHERE id IN ({note_ph})", note_ids)

def _insert_snapshot_rows(con, table: str, columns: tuple[str, ...], rows: list[dict]):
    if not rows:
        return
    placeholders = ",".join("?" for _ in columns)
    column_sql = ",".join(columns)
    con.executemany(
        f"INSERT INTO {table} ({column_sql}) VALUES ({placeholders})",
        [tuple(row.get(column) for column in columns) for row in rows],
    )

def _restore_note_tree_snapshot(con, project_id: str, snapshot: dict):
    notes = snapshot.get("notes") or []
    if not notes:
        raise HTTPException(422, "The deleted note snapshot is empty")
    if any(row.get("project_id") != project_id for row in notes):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "The note snapshot is outside this project")
    note_ids = [row["id"] for row in notes]
    existing = con.execute(
        f"SELECT id FROM notes WHERE id IN ({','.join('?' for _ in note_ids)})",
        note_ids,
    ).fetchall()
    if existing:
        raise HTTPException(409, "A note from the deleted tree already exists")

    _insert_snapshot_rows(con, "notes", ("id", "project_id", "parent_note_id", "html", "title", "collapsed", "order_idx", "created_at"), notes)
    for child in snapshot.get("reparentedChildren") or []:
        con.execute("UPDATE notes SET parent_note_id = ? WHERE id = ? AND project_id = ?", (child["parent_note_id"], child["id"], project_id))
    _insert_snapshot_rows(con, "time_slots", ("id", "note_id", "start_col", "duration", "title", "color"), snapshot.get("timeSlots") or [])
    _insert_snapshot_rows(con, "assignments", ("note_id", "dimension_id", "category_id", "order_idx"), snapshot.get("assignments") or [])
    archived_deadlines = [
        {**row, "reason": row.get("reason") or ""}
        for row in snapshot.get("deadlines") or []
    ]
    _insert_snapshot_rows(con, "deadlines", ("id", "note_id", "col", "scale", "reason"), archived_deadlines)
    archived_earliest_starts = [
        {**row, "reason": row.get("reason") or ""}
        for row in snapshot.get("earliestStarts") or []
    ]
    _insert_snapshot_rows(con, "earliest_starts", ("id", "note_id", "col", "scale", "reason"), archived_earliest_starts)
    _insert_snapshot_rows(con, "persona_note_assignments", ("persona_id", "note_id"), snapshot.get("personaNoteAssignments") or [])
    _insert_snapshot_rows(con, "persona_time_slot_assignments", ("persona_id", "time_slot_id"), snapshot.get("personaTimeSlotAssignments") or [])
    _insert_snapshot_rows(con, "note_inheritance", ("child_note_id", "parent_note_id"), snapshot.get("noteInheritance") or [])
    _insert_snapshot_rows(con, "dependencies", ("id", "from_id", "to_id", "reason"), snapshot.get("dependencies") or [])
    if snapshot.get("archiveId"):
        con.execute("DELETE FROM note_archive WHERE id = ?", (snapshot["archiveId"],))
    else:
        con.execute(
            "DELETE FROM note_archive WHERE project_id = ? AND root_note_id = ?",
            (project_id, snapshot.get("rootNoteId")),
        )

def _apply_note_tree_state_change(con, project_id: str, before: dict, after: dict):
    before_tree = before.get("noteTree")
    after_tree = after.get("noteTree")
    if before_tree and not after_tree:
        _delete_note_tree_snapshot(con, project_id, before_tree)
        return
    if after_tree and not before_tree:
        _restore_note_tree_snapshot(con, project_id, after_tree)
        return
    raise HTTPException(422, "A note-tree transaction must either delete or restore one snapshot")

@app.delete("/notes/{note_id}", status_code=204)
def delete_note(note_id: str, cascade: bool = Query(default=True), user: dict = Depends(current_user)):
    with _db() as con:
        project_id = _project_id_for_note(con, note_id)
        assert_project_access(project_id, user)
        project = con.execute("SELECT root_note_id FROM projects WHERE id = ?", (project_id,)).fetchone()
        if project and project["root_note_id"] == note_id:
            raise HTTPException(422, {"message": "The project root note cannot be deleted", "type": "root_note_delete"})
        # Archive always keeps the complete subtree. A note's children are never
        # silently reparented as a side effect of deletion.
        snapshot = _note_tree_snapshot(con, project_id, note_id, True)
        _delete_note_tree_snapshot(con, project_id, snapshot)
        deleted_root = next((row for row in snapshot["notes"] if row["id"] == note_id), snapshot["notes"][0])
        label = deleted_root.get("title") or "Untitled"
        transaction = {
            "id": str(uuid.uuid4()),
            "type": "note.delete-tree",
            "label": f"Delete {label}",
            "before": {"noteTree": snapshot},
            "after": {"noteTree": None},
        }
        _push_history(con, project_id, transaction, transaction["before"], transaction["after"])

@app.put("/notes/order")
def reorder_notes(data: OrderIn, user: dict = Depends(current_user)):
    with _db() as con:
        project_ids = set()
        for i, pid in enumerate(data.ids):
            row = con.execute("SELECT project_id FROM notes WHERE id = ?", (pid,)).fetchone()
            if not row:
                raise HTTPException(404, f"Note {pid} not found")
            project_ids.add(row["project_id"])
            assert_project_access(row["project_id"], user)
            con.execute("UPDATE notes SET order_idx = ? WHERE id = ?", (i, pid))
        if len(project_ids) > 1:
            raise HTTPException(400, "Cannot reorder notes across projects")
    return {"ok": True}


# ── Note inheritance ──────────────────────────────────────────────────────────
def _single_time_slot_for_note(con, note_id: str) -> dict | None:
    rows = con.execute("SELECT * FROM time_slots WHERE note_id = ? ORDER BY start_col, rowid", (note_id,)).fetchall()
    if len(rows) > 1:
        raise HTTPException(422, {"message": "A note can only contain one time slot", "type": "note_time_slot_limit", "noteId": note_id})
    return _time_slot(rows[0]) if rows else None

def _assert_valid_note_inheritance(con, child_note_id: str, parent_note_id: str):
    if child_note_id == parent_note_id:
        raise HTTPException(422, {"message": "A note cannot inherit from itself", "type": "inheritance_cycle"})
    child_project = _project_id_for_note(con, child_note_id)
    parent_project = _project_id_for_note(con, parent_note_id)
    if child_project != parent_project:
        raise HTTPException(400, "Cannot inherit across projects")

    stack = [parent_note_id]
    seen = {child_note_id}
    while stack:
        current = stack.pop()
        if current in seen:
            raise HTTPException(422, {"message": "Inheritance cannot create a cycle", "type": "inheritance_cycle"})
        seen.add(current)
        rows = con.execute("SELECT parent_note_id FROM note_inheritance WHERE child_note_id = ?", (current,)).fetchall()
        stack.extend(row["parent_note_id"] for row in rows)

    child_ms = _single_time_slot_for_note(con, child_note_id)
    parent_ms = _single_time_slot_for_note(con, parent_note_id)
    if not child_ms or not parent_ms:
        raise HTTPException(422, {
            "message": "Both child and parent notes need one time slot before inheritance can be assigned",
            "type": "inheritance_missing_time_slot",
        })
    child_scale = _planning_scale_for_time_slot(child_ms)
    parent_scale = _planning_scale_for_time_slot(parent_ms)
    if not _is_parent_scale_for_child(parent_scale, child_scale):
        raise HTTPException(422, {
            "message": "Inherited parent note must be on the same planning scale or exactly one planning scale broader than the child note",
            "type": "inheritance_scale_mismatch",
            "childScale": child_scale,
            "parentScale": parent_scale,
        })
    parent_start = parent_ms["startCol"]
    parent_end = parent_ms["startCol"] + parent_ms["duration"]
    if child_ms["startCol"] < parent_start or child_ms["startCol"] + child_ms["duration"] > parent_end:
        raise HTTPException(422, {
            "message": "Child time slot must fit inside the parent time slot window",
            "type": "inheritance_window",
            "timeSlotIds": [child_ms["id"], parent_ms["id"]],
        })

def _assert_structural_time_window_if_scheduled(con, child_note_id: str, parent_note_id: str):
    child_ms = _single_time_slot_for_note(con, child_note_id)
    parent_ms = _single_time_slot_for_note(con, parent_note_id)
    if not child_ms:
        return
    child_scale = _planning_scale_for_time_slot(child_ms)
    child_start = child_ms["startCol"]
    child_end = child_start + child_ms["duration"]

    if parent_ms:
        parent_scale = _planning_scale_for_time_slot(parent_ms)
        if not _is_parent_scale_for_child(parent_scale, child_scale):
            raise HTTPException(422, {
                "message": "A child note inherits its parent note window, so both scheduled notes must be on compatible planning scales",
                "type": "inheritance_scale_mismatch",
                "childScale": child_scale,
                "parentScale": parent_scale,
            })
        parent_start = parent_ms["startCol"]
        parent_end = parent_ms["startCol"] + parent_ms["duration"]
        if child_start < parent_start or child_end > parent_end:
            raise HTTPException(422, {
                "message": "This note cannot be moved there because its time slot does not fit inside the destination note's time slot",
                "type": "inheritance_window",
                "timeSlotIds": [child_ms["id"], parent_ms["id"]],
            })

    deadline = con.execute(
        "SELECT col, scale FROM deadlines WHERE note_id = ?",
        (parent_note_id,),
    ).fetchone()
    if deadline and _normalize_planning_scale(deadline["scale"], deadline["col"]) == child_scale and child_end > deadline["col"]:
        raise HTTPException(422, {
            "message": "This note cannot be moved there because its time slot exceeds the destination note's hard deadline",
            "type": "inheritance_deadline",
            "timeSlotIds": [child_ms["id"]],
        })

    earliest_start = con.execute(
        "SELECT col, scale FROM earliest_starts WHERE note_id = ?",
        (parent_note_id,),
    ).fetchone()
    if earliest_start and _normalize_planning_scale(earliest_start["scale"], earliest_start["col"]) == child_scale and child_start < earliest_start["col"]:
        raise HTTPException(422, {
            "message": "This note cannot be moved there because its time slot starts before the destination note's earliest start date",
            "type": "inheritance_earliest_start",
            "timeSlotIds": [child_ms["id"]],
        })

@app.get("/note-inheritance")
def list_note_inheritance(project_id: str = Query(default='default'), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    with _db() as con:
        links = _combined_note_inheritance(con, project_id)
    return links

@app.put("/notes/{child_note_id}/inheritance")
def set_note_inheritance(child_note_id: str, data: NoteInheritanceIn, user: dict = Depends(current_user)):
    with _db() as con:
        assert_project_access(_project_id_for_note(con, child_note_id), user)
        _assert_valid_note_inheritance(con, child_note_id, data.parentNoteId)
        con.execute(
            "INSERT OR IGNORE INTO note_inheritance (child_note_id, parent_note_id) VALUES (?, ?)",
            (child_note_id, data.parentNoteId),
        )
        row = con.execute(
            "SELECT * FROM note_inheritance WHERE child_note_id = ? AND parent_note_id = ?",
            (child_note_id, data.parentNoteId),
        ).fetchone()
    return _inheritance(row)

@app.delete("/notes/{child_note_id}/inheritance", status_code=204)
def remove_note_inheritance(child_note_id: str, parent_note_id: Optional[str] = Query(default=None), user: dict = Depends(current_user)):
    with _db() as con:
        assert_project_access(_project_id_for_note(con, child_note_id), user)
        if parent_note_id:
            con.execute(
                "DELETE FROM note_inheritance WHERE child_note_id = ? AND parent_note_id = ?",
                (child_note_id, parent_note_id),
            )
        else:
            con.execute("DELETE FROM note_inheritance WHERE child_note_id = ?", (child_note_id,))


# ── Dimensions ────────────────────────────────────────────────────────────────
@app.get("/dimensions")
def list_dimensions(project_id: str = Query(default='default'), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    with _db() as con:
        _ensure_kanban_dimension(con, project_id)
        rows = con.execute(
            "SELECT * FROM dimensions WHERE project_id = ? ORDER BY order_idx, rowid", (project_id,)
        ).fetchall()
    return [_dimension(r) for r in rows]

@app.post("/dimensions", status_code=201)
def create_dimension(data: DimensionIn, project_id: str = Query(default='default'), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    did = data.id or str(uuid.uuid4())
    with _db() as con:
        if con.execute("SELECT id FROM dimensions WHERE id = ?", (did,)).fetchone():
            raise HTTPException(409, "Dimension already exists")
        next_order = con.execute(
            "SELECT COALESCE(MAX(order_idx), -1) + 1 FROM dimensions WHERE project_id = ?", (project_id,)
        ).fetchone()[0]
        con.execute("INSERT INTO dimensions (id, name, project_id, order_idx) VALUES (?, ?, ?, ?)", (did, data.name, project_id, next_order))
    return {"id": did, "name": data.name, "project_id": project_id, "order_idx": next_order}

@app.put("/dimensions/reorder")
def reorder_dimensions(data: dict, project_id: str = Query(default='default'), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    ids = data.get("ids", [])
    with _db() as con:
        for i, dim_id in enumerate(ids):
            if _is_kanban_dimension_id(dim_id):
                continue
            con.execute(
                "UPDATE dimensions SET order_idx = ? WHERE id = ? AND project_id = ?",
                (i, dim_id, project_id)
            )
    return {"ok": True}

@app.patch("/dimensions/{dim_id}")
def update_dimension(dim_id: str, data: DimensionPatch, user: dict = Depends(current_user)):
    with _db() as con:
        assert_project_access(_project_id_for_dimension(con, dim_id), user)
        if _is_kanban_dimension_id(dim_id):
            raise HTTPException(400, "Kanban is a system dimension and cannot be renamed")
        fields, values = [], []
        if data.name is not None:
            fields.append("name = ?")
            values.append(data.name.strip() or "Untitled dimension")
        if fields:
            con.execute(f"UPDATE dimensions SET {', '.join(fields)} WHERE id = ?", (*values, dim_id))
        row = con.execute("SELECT * FROM dimensions WHERE id = ?", (dim_id,)).fetchone()
    return _dimension(row)

@app.delete("/dimensions/{dim_id}", status_code=204)
def delete_dimension(dim_id: str, user: dict = Depends(current_user)):
    with _db() as con:
        assert_project_access(_project_id_for_dimension(con, dim_id), user)
        if _is_kanban_dimension_id(dim_id):
            raise HTTPException(400, "Kanban is a system dimension and cannot be deleted")
        con.execute("DELETE FROM assignments WHERE dimension_id = ?", (dim_id,))
        con.execute("DELETE FROM persona_assignments WHERE dimension_id = ?", (dim_id,))
        con.execute("DELETE FROM categories WHERE dimension_id = ?", (dim_id,))
        con.execute("DELETE FROM dimensions WHERE id = ?", (dim_id,))


# ── Categories ────────────────────────────────────────────────────────────────
@app.get("/categories")
def list_all_categories(project_id: str = Query(default='default'), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    with _db() as con:
        _ensure_kanban_dimension(con, project_id)
        rows = con.execute(
            """SELECT * FROM categories
            WHERE dimension_id IN (SELECT id FROM dimensions WHERE project_id = ?)
            ORDER BY order_idx""",
            (project_id,)
        ).fetchall()
    return [_cat(r) for r in rows]

@app.post("/dimensions/{dim_id}/categories", status_code=201)
def create_category(dim_id: str, data: CategoryIn, user: dict = Depends(current_user)):
    if not data.name.strip():
        raise HTTPException(400, "Category name required")
    cid = data.id or str(uuid.uuid4())
    with _db() as con:
        assert_project_access(_project_id_for_dimension(con, dim_id), user)
        if _is_kanban_dimension_id(dim_id):
            raise HTTPException(400, "Kanban categories are system-owned")
        max_ord = con.execute(
            "SELECT COALESCE(MAX(order_idx), -1) FROM categories WHERE dimension_id = ?", (dim_id,)
        ).fetchone()[0]
        con.execute(
            "INSERT INTO categories (id, dimension_id, name, color, order_idx) VALUES (?, ?, ?, ?, ?)",
            (cid, dim_id, data.name.strip(), data.color, max_ord + 1),
        )
    return {"id": cid, "dimensionId": dim_id, "name": data.name.strip(), "color": data.color}


@app.put("/categories/order")
def reorder_categories(data: dict, user: dict = Depends(current_user)):
    ids = data.get("ids", [])
    with _db() as con:
        project_ids = set()
        for i, cid in enumerate(ids):
            if _is_kanban_category_id(cid):
                continue
            project_id = _project_id_for_category(con, cid)
            project_ids.add(project_id)
            assert_project_access(project_id, user)
            con.execute("UPDATE categories SET order_idx = ? WHERE id = ?", (i, cid))
        if len(project_ids) > 1:
            raise HTTPException(400, "Cannot reorder categories across projects")
    return {"ok": True}

@app.patch("/categories/{cat_id}")
def update_category(cat_id: str, data: CategoryPatch, user: dict = Depends(current_user)):
    with _db() as con:
        assert_project_access(_project_id_for_category(con, cat_id), user)
        if _is_kanban_category_id(cat_id):
            raise HTTPException(400, "Kanban categories are system-owned")
        fields, values = [], []
        if data.name is not None:  fields.append("name = ?");  values.append(data.name.strip())
        if data.color is not None: fields.append("color = ?"); values.append(data.color)
        if fields:
            con.execute(f"UPDATE categories SET {', '.join(fields)} WHERE id = ?", (*values, cat_id))
        row = con.execute("SELECT * FROM categories WHERE id = ?", (cat_id,)).fetchone()
    return _cat(row)

@app.delete("/categories/{cat_id}", status_code=204)
def delete_category(cat_id: str, user: dict = Depends(current_user)):
    with _db() as con:
        assert_project_access(_project_id_for_category(con, cat_id), user)
        if _is_kanban_category_id(cat_id):
            raise HTTPException(400, "Kanban categories are system-owned")
        con.execute("DELETE FROM assignments WHERE category_id = ?", (cat_id,))
        con.execute("DELETE FROM persona_assignments WHERE category_id = ?", (cat_id,))
        con.execute("DELETE FROM category_leaders WHERE category_id = ?", (cat_id,))
        con.execute("DELETE FROM categories WHERE id = ?", (cat_id,))


# ── Personas ──────────────────────────────────────────────────────────────────
@app.get("/personas")
def list_personas(project_id: str = Query(default='default'), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    with _db() as con:
        rows = con.execute(
            "SELECT * FROM personas WHERE project_id = ? ORDER BY rowid", (project_id,)
        ).fetchall()
    return [_persona(r) for r in rows]

@app.post("/personas", status_code=201)
def create_persona(data: PersonaIn, project_id: str = Query(default='default'), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    if not data.name.strip():
        raise HTTPException(400, "Name required")
    pid = data.id or str(uuid.uuid4())
    with _db() as con:
        con.execute(
            "INSERT INTO personas (id, project_id, name, model_key, color, pos_x, pos_z) VALUES (?,?,?,?,?,?,?)",
            (pid, project_id, data.name.strip(), data.model_key, data.color, data.pos_x, data.pos_z),
        )
    return _persona({"id": pid, "project_id": project_id, "name": data.name.strip(),
                     "model_key": data.model_key, "color": data.color,
                     "pos_x": data.pos_x, "pos_z": data.pos_z})

@app.patch("/personas/{persona_id}")
def update_persona(persona_id: str, data: PersonaPatch, user: dict = Depends(current_user)):
    with _db() as con:
        row = con.execute("SELECT * FROM personas WHERE id = ?", (persona_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Persona not found")
        assert_project_access(row["project_id"], user)
        fields: dict = {}
        if data.name      is not None: fields["name"]      = data.name.strip()
        if data.model_key is not None: fields["model_key"] = data.model_key
        if data.color     is not None: fields["color"]     = data.color
        if data.pos_x     is not None: fields["pos_x"]     = data.pos_x
        if data.pos_z     is not None: fields["pos_z"]     = data.pos_z
        if fields:
            sets = ", ".join(f"{k} = ?" for k in fields)
            con.execute(f"UPDATE personas SET {sets} WHERE id = ?", (*fields.values(), persona_id))
        row = con.execute("SELECT * FROM personas WHERE id = ?", (persona_id,)).fetchone()
    return _persona(row)

@app.delete("/personas/{persona_id}", status_code=204)
def delete_persona(persona_id: str, user: dict = Depends(current_user)):
    with _db() as con:
        row = con.execute("SELECT * FROM personas WHERE id = ?", (persona_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Persona not found")
        assert_project_access(row["project_id"], user)
        con.execute("DELETE FROM persona_assignments WHERE persona_id = ?", (persona_id,))
        con.execute("DELETE FROM persona_note_assignments WHERE persona_id = ?", (persona_id,))
        con.execute("DELETE FROM persona_time_slot_assignments WHERE persona_id = ?", (persona_id,))
        con.execute("DELETE FROM category_leaders WHERE persona_id = ?", (persona_id,))
        con.execute("DELETE FROM personas WHERE id = ?", (persona_id,))
    return Response(status_code=204)

@app.get("/persona-assignments")
def list_persona_assignments(project_id: str = Query(default='default'), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    with _db() as con:
        rows = con.execute(
            """
            WITH note_links AS (
                SELECT pna.persona_id, pna.note_id
                FROM persona_note_assignments pna
                JOIN notes n ON n.id = pna.note_id
                WHERE n.project_id = ?

                UNION

                SELECT pma.persona_id, m.note_id
                FROM persona_time_slot_assignments pma
                JOIN time_slots m ON m.id = pma.time_slot_id
                JOIN notes n ON n.id = m.note_id
                WHERE n.project_id = ?
            ),
            category_links AS (
                SELECT pa.persona_id, pa.dimension_id, pa.category_id
                FROM persona_assignments pa
                JOIN personas p ON p.id = pa.persona_id
                WHERE p.project_id = ?

                UNION

                SELECT nl.persona_id, a.dimension_id, a.category_id
                FROM note_links nl
                JOIN assignments a ON a.note_id = nl.note_id
            )
            SELECT persona_id, dimension_id, category_id
            FROM category_links
            ORDER BY dimension_id, category_id, persona_id
            """,
            (project_id, project_id, project_id),
        ).fetchall()
    return [_persona_assign(r) for r in rows]

@app.get("/persona-assignments/direct")
def list_direct_persona_assignments(project_id: str = Query(default='default'), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    with _db() as con:
        rows = con.execute(
            """SELECT pa.persona_id, pa.dimension_id, pa.category_id
            FROM persona_assignments pa
            JOIN personas p ON p.id = pa.persona_id
            WHERE p.project_id = ?
            ORDER BY pa.dimension_id, pa.category_id, pa.persona_id""",
            (project_id,),
        ).fetchall()
    return [_persona_assign(r) for r in rows]

@app.put("/personas/{persona_id}/assign")
def assign_persona(persona_id: str, data: PersonaAssignIn, user: dict = Depends(current_user)):
    with _db() as con:
        persona_project = _project_id_for_persona(con, persona_id)
        category_project = _project_id_for_category(con, data.categoryId)
        dimension_project = _project_id_for_dimension(con, data.dimensionId)
        assert_project_access(persona_project, user)
        if persona_project != category_project or persona_project != dimension_project:
            raise HTTPException(400, "Cannot assign persona across projects")
        row = con.execute("SELECT dimension_id FROM categories WHERE id = ?", (data.categoryId,)).fetchone()
        if not row or row["dimension_id"] != data.dimensionId:
            raise HTTPException(400, "Category does not belong to dimension")
        con.execute(
            "INSERT OR IGNORE INTO persona_assignments (persona_id, dimension_id, category_id) VALUES (?, ?, ?)",
            (persona_id, data.dimensionId, data.categoryId),
        )
        out = con.execute(
            "SELECT * FROM persona_assignments WHERE persona_id = ? AND dimension_id = ? AND category_id = ?",
            (persona_id, data.dimensionId, data.categoryId),
        ).fetchone()
    return _persona_assign(out)

@app.delete("/personas/{persona_id}/assign/{dim_id}/{cat_id}", status_code=204)
def unassign_persona(persona_id: str, dim_id: str, cat_id: str, user: dict = Depends(current_user)):
    with _db() as con:
        persona_project = _project_id_for_persona(con, persona_id)
        category_project = _project_id_for_category(con, cat_id)
        assert_project_access(persona_project, user)
        if persona_project != category_project:
            raise HTTPException(400, "Cannot unassign persona across projects")
        con.execute(
            "DELETE FROM persona_assignments WHERE persona_id = ? AND dimension_id = ? AND category_id = ?",
            (persona_id, dim_id, cat_id),
        )
    return Response(status_code=204)


@app.get("/persona-note-assignments")
def list_persona_note_assignments(project_id: str = Query(default='default'), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    with _db() as con:
        rows = con.execute(
            """
            SELECT persona_id, note_id
            FROM (
                SELECT pna.persona_id, pna.note_id
                FROM persona_note_assignments pna
                JOIN notes n ON n.id = pna.note_id
                WHERE n.project_id = ?

                UNION

                SELECT pma.persona_id, m.note_id
                FROM persona_time_slot_assignments pma
                JOIN time_slots m ON m.id = pma.time_slot_id
                JOIN notes n ON n.id = m.note_id
                WHERE n.project_id = ?
            )
            ORDER BY note_id, persona_id
            """,
            (project_id, project_id),
        ).fetchall()
    return [{"personaId": r["persona_id"], "noteId": r["note_id"]} for r in rows]

@app.get("/persona-note-assignments/direct")
def list_direct_persona_note_assignments(project_id: str = Query(default='default'), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    with _db() as con:
        rows = con.execute(
            "SELECT pna.persona_id, pna.note_id FROM persona_note_assignments pna "
            "JOIN notes n ON n.id = pna.note_id WHERE n.project_id = ? "
            "ORDER BY pna.note_id, pna.persona_id",
            (project_id,),
        ).fetchall()
    return [{"personaId": r["persona_id"], "noteId": r["note_id"]} for r in rows]

@app.put("/personas/{persona_id}/note-assign/{note_id}", status_code=204)
def assign_persona_to_note(persona_id: str, note_id: str, user: dict = Depends(current_user)):
    with _db() as con:
        note_row = con.execute("SELECT project_id FROM notes WHERE id = ?", (note_id,)).fetchone()
        if not note_row:
            raise HTTPException(404, "Note not found")
        assert_project_access(note_row["project_id"], user)
        persona_row = con.execute("SELECT project_id FROM personas WHERE id = ?", (persona_id,)).fetchone()
        if not persona_row:
            raise HTTPException(404, "Persona not found")
        if persona_row["project_id"] != note_row["project_id"]:
            raise HTTPException(400, "Cannot assign persona across projects")
        con.execute(
            "INSERT OR IGNORE INTO persona_note_assignments (persona_id, note_id) VALUES (?, ?)",
            (persona_id, note_id),
        )
    return Response(status_code=204)

@app.delete("/personas/{persona_id}/note-assign/{note_id}", status_code=204)
def unassign_persona_from_note(persona_id: str, note_id: str, user: dict = Depends(current_user)):
    with _db() as con:
        note_row = con.execute("SELECT project_id FROM notes WHERE id = ?", (note_id,)).fetchone()
        if not note_row:
            raise HTTPException(404, "Note not found")
        assert_project_access(note_row["project_id"], user)
        con.execute(
            "DELETE FROM persona_note_assignments WHERE persona_id = ? AND note_id = ?",
            (persona_id, note_id),
        )
    return Response(status_code=204)


@app.get("/persona-time-slot-assignments")
def list_persona_time_slot_assignments(project_id: str = Query(default='default'), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    with _db() as con:
        rows = con.execute(
            "SELECT pma.persona_id, pma.time_slot_id FROM persona_time_slot_assignments pma "
            "JOIN time_slots m ON m.id = pma.time_slot_id "
            "JOIN notes n ON n.id = m.note_id WHERE n.project_id = ?",
            (project_id,),
        ).fetchall()
    return [{"personaId": r["persona_id"], "timeSlotId": r["time_slot_id"]} for r in rows]

@app.put("/personas/{persona_id}/time-slot-assign/{time_slot_id}", status_code=204)
def assign_persona_to_time_slot(persona_id: str, time_slot_id: str, user: dict = Depends(current_user)):
    with _db() as con:
        ms_row = con.execute(
            "SELECT n.project_id FROM time_slots m JOIN notes n ON n.id = m.note_id WHERE m.id = ?",
            (time_slot_id,),
        ).fetchone()
        if not ms_row:
            raise HTTPException(404, "Time slot not found")
        assert_project_access(ms_row["project_id"], user)
        persona_row = con.execute("SELECT project_id FROM personas WHERE id = ?", (persona_id,)).fetchone()
        if not persona_row:
            raise HTTPException(404, "Persona not found")
        if persona_row["project_id"] != ms_row["project_id"]:
            raise HTTPException(400, "Cannot assign persona across projects")
        con.execute(
            "INSERT OR IGNORE INTO persona_time_slot_assignments (persona_id, time_slot_id) VALUES (?, ?)",
            (persona_id, time_slot_id),
        )
    return Response(status_code=204)

@app.delete("/personas/{persona_id}/time-slot-assign/{time_slot_id}", status_code=204)
def unassign_persona_from_time_slot(persona_id: str, time_slot_id: str, user: dict = Depends(current_user)):
    with _db() as con:
        ms_row = con.execute(
            "SELECT n.project_id FROM time_slots m JOIN notes n ON n.id = m.note_id WHERE m.id = ?",
            (time_slot_id,),
        ).fetchone()
        if not ms_row:
            raise HTTPException(404, "Time slot not found")
        assert_project_access(ms_row["project_id"], user)
        con.execute(
            "DELETE FROM persona_time_slot_assignments WHERE persona_id = ? AND time_slot_id = ?",
            (persona_id, time_slot_id),
        )
    return Response(status_code=204)


@app.get("/category-leaders")
def list_category_leaders(project_id: str = Query(default='default'), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    with _db() as con:
        rows = con.execute(
            "SELECT cl.persona_id, cl.category_id FROM category_leaders cl "
            "JOIN categories c ON c.id = cl.category_id "
            "JOIN dimensions d ON d.id = c.dimension_id "
            "WHERE d.project_id = ?",
            (project_id,),
        ).fetchall()
    return [{"personaId": r["persona_id"], "categoryId": r["category_id"]} for r in rows]

@app.put("/categories/{cat_id}/leaders/{persona_id}", status_code=204)
def add_category_leader(cat_id: str, persona_id: str, user: dict = Depends(current_user)):
    with _db() as con:
        cat_project = _project_id_for_category(con, cat_id)
        persona_row = con.execute("SELECT project_id FROM personas WHERE id = ?", (persona_id,)).fetchone()
        if not persona_row:
            raise HTTPException(404, "Persona not found")
        assert_project_access(cat_project, user)
        if persona_row["project_id"] != cat_project:
            raise HTTPException(400, "Cannot assign leader across projects")
        con.execute(
            "INSERT OR IGNORE INTO category_leaders (persona_id, category_id) VALUES (?, ?)",
            (persona_id, cat_id),
        )
    return Response(status_code=204)

@app.delete("/categories/{cat_id}/leaders/{persona_id}", status_code=204)
def remove_category_leader(cat_id: str, persona_id: str, user: dict = Depends(current_user)):
    with _db() as con:
        assert_project_access(_project_id_for_category(con, cat_id), user)
        con.execute(
            "DELETE FROM category_leaders WHERE persona_id = ? AND category_id = ?",
            (persona_id, cat_id),
        )
    return Response(status_code=204)


# ── Assignments ───────────────────────────────────────────────────────────────
@app.get("/assignments")
def list_assignments(project_id: str = Query(default='default'), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    with _db() as con:
        rows = con.execute(
            """SELECT * FROM assignments
            WHERE note_id IN (SELECT id FROM notes WHERE project_id = ?)
            ORDER BY dimension_id, category_id, order_idx""",
            (project_id,)
        ).fetchall()
    return [_assign(r) for r in rows]

@app.put("/notes/{note_id}/assign/{dim_id}")
def assign_category(note_id: str, dim_id: str, data: AssignIn, user: dict = Depends(current_user)):
    with _db() as con:
        note_project_id = _project_id_for_note(con, note_id)
        dim_project_id = _project_id_for_dimension(con, dim_id)
        cat_project_id = _project_id_for_category(con, data.categoryId)
        if len({note_project_id, dim_project_id, cat_project_id}) != 1:
            raise HTTPException(400, "Assignment resources must belong to the same project")
        assert_project_access(note_project_id, user)
        cat_row = con.execute("SELECT dimension_id FROM categories WHERE id = ?", (data.categoryId,)).fetchone()
        if not cat_row or cat_row["dimension_id"] != dim_id:
            raise HTTPException(400, "Category does not belong to dimension")
        if dim_id == _kanban_dimension_id(note_project_id) and data.categoryId == _kanban_category_id(note_project_id, "scheduled"):
            if not con.execute("SELECT 1 FROM time_slots WHERE note_id = ? LIMIT 1", (note_id,)).fetchone():
                raise HTTPException(
                    422,
                    {
                        "message": "A note needs a time slot before it can be moved to Scheduled",
                        "type": "kanban_scheduled_requires_time_slot",
                        "noteId": note_id,
                    },
                )
        existing = con.execute(
            "SELECT category_id, order_idx FROM assignments WHERE note_id = ? AND dimension_id = ?",
            (note_id, dim_id),
        ).fetchone()
        if existing and existing["category_id"] == data.categoryId:
            order_idx = existing["order_idx"]
        else:
            order_idx = con.execute(
                "SELECT COALESCE(MAX(order_idx), -1) + 1 FROM assignments WHERE dimension_id = ? AND category_id = ?",
                (dim_id, data.categoryId),
            ).fetchone()[0]
        con.execute(
            "INSERT OR REPLACE INTO assignments (note_id, dimension_id, category_id, order_idx) VALUES (?, ?, ?, ?)",
            (note_id, dim_id, data.categoryId, order_idx),
        )
    return {"noteId": note_id, "dimensionId": dim_id, "categoryId": data.categoryId, "orderIdx": order_idx}

@app.put("/assignments/order")
def reorder_assignments(data: dict, user: dict = Depends(current_user)):
    dim_id = data.get("dimensionId")
    cat_id = data.get("categoryId")
    note_ids = data.get("noteIds", [])
    if not dim_id:
        raise HTTPException(400, "dimensionId is required")
    with _db() as con:
        project_id = _project_id_for_dimension(con, dim_id)
        assert_project_access(project_id, user)
        if cat_id is not None and _project_id_for_category(con, cat_id) != project_id:
            raise HTTPException(400, "Category does not belong to dimension project")
        for note_id in note_ids:
            if _project_id_for_note(con, note_id) != project_id:
                raise HTTPException(400, "Note does not belong to dimension project")
        if cat_id is None:
            return {"ok": True}
        for i, note_id in enumerate(note_ids):
            con.execute(
                """
                UPDATE assignments
                SET order_idx = ?
                WHERE note_id = ? AND dimension_id = ? AND category_id = ?
                """,
                (i, note_id, dim_id, cat_id),
            )
    return {"ok": True}

@app.delete("/notes/{note_id}/assign/{dim_id}", status_code=204)
def unassign_category(note_id: str, dim_id: str, user: dict = Depends(current_user)):
    with _db() as con:
        note_project_id = _project_id_for_note(con, note_id)
        dim_project_id = _project_id_for_dimension(con, dim_id)
        if note_project_id != dim_project_id:
            raise HTTPException(400, "Note and dimension must belong to the same project")
        assert_project_access(note_project_id, user)
        con.execute(
            "DELETE FROM assignments WHERE note_id = ? AND dimension_id = ?",
            (note_id, dim_id),
        )


# ── Saved filters ─────────────────────────────────────────────────────────────
@app.get("/filters")
def list_filters(project_id: str = Query(default='default'), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    with _db() as con:
        rows = con.execute(
            "SELECT * FROM saved_filters WHERE project_id = ? ORDER BY name COLLATE NOCASE", (project_id,)
        ).fetchall()
    return [_filter(r) for r in rows]

@app.post("/filters", status_code=201)
def create_filter(data: SavedFilterIn, project_id: str = Query(default='default'), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    fid = data.id or str(uuid.uuid4())
    name = data.name.strip() or "Untitled filter"
    gate, selections_json, quick_key = _normalize_filter_payload(data)
    color = data.color or "#64748b"
    with _db() as con:
        if con.execute("SELECT id FROM saved_filters WHERE id = ?", (fid,)).fetchone():
            raise HTTPException(409, "Filter already exists")
        con.execute(
            """
            INSERT INTO saved_filters (id, project_id, name, gate, color, selections_json, quick_key)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (fid, project_id, name, gate, color, selections_json, quick_key),
        )
        row = con.execute("SELECT * FROM saved_filters WHERE id = ?", (fid,)).fetchone()
    return _filter(row)

@app.patch("/filters/{filter_id}")
def update_filter(filter_id: str, data: SavedFilterPatch, user: dict = Depends(current_user)):
    with _db() as con:
        assert_project_access(_project_id_for_filter(con, filter_id), user)
        fields, values = [], []
        if data.name is not None:
            fields.append("name = ?")
            values.append(data.name.strip() or "Untitled filter")
        if data.gate is not None:
            fields.append("gate = ?")
            values.append(data.gate if data.gate in ("AND", "OR") else "AND")
        if data.color is not None:
            fields.append("color = ?")
            values.append(data.color or "#64748b")
        if data.selections is not None:
            fields.append("selections_json = ?")
            values.append(json.dumps({
                dim_id: list(dict.fromkeys(cat_ids))
                for dim_id, cat_ids in data.selections.items()
                if cat_ids
            }))
        if data.quickKey is not None:
            fields.append("quick_key = ?")
            values.append(data.quickKey)
        if fields:
            con.execute(f"UPDATE saved_filters SET {', '.join(fields)} WHERE id = ?", (*values, filter_id))
        row = con.execute("SELECT * FROM saved_filters WHERE id = ?", (filter_id,)).fetchone()
    return _filter(row)

@app.delete("/filters/{filter_id}", status_code=204)
def delete_filter(filter_id: str, user: dict = Depends(current_user)):
    with _db() as con:
        assert_project_access(_project_id_for_filter(con, filter_id), user)
        con.execute("DELETE FROM saved_filters WHERE id = ?", (filter_id,))


# ── Schedule perspectives ─────────────────────────────────────────────────────
@app.get("/schedule-perspectives")
def list_schedule_perspectives(project_id: str = Query(default='default'), context_id: str | None = Query(default=None), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    with _db() as con:
        scoped_context_id = _context_id_for_project(con, project_id, context_id)
        rows = con.execute(
            "SELECT * FROM schedule_perspectives WHERE project_id = ? AND context_id = ? ORDER BY name COLLATE NOCASE",
            (project_id, scoped_context_id),
        ).fetchall()
    return [_schedule_perspective(r) for r in rows]

@app.post("/schedule-perspectives", status_code=201)
def create_schedule_perspective(data: SchedulePerspectiveIn, project_id: str = Query(default='default'), context_id: str | None = Query(default=None), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    pid = data.id or str(uuid.uuid4())
    name = data.name.strip() or "Untitled perspective"
    with _db() as con:
        scoped_context_id = _context_id_for_project(con, project_id, context_id)
        if con.execute("SELECT id FROM schedule_perspectives WHERE id = ?", (pid,)).fetchone():
            raise HTTPException(409, "Perspective already exists")
        con.execute(
            "INSERT INTO schedule_perspectives (id, project_id, context_id, name, state_json) VALUES (?, ?, ?, ?, ?)",
            (pid, project_id, scoped_context_id, name, json.dumps(data.state or {})),
        )
        row = con.execute("SELECT * FROM schedule_perspectives WHERE id = ?", (pid,)).fetchone()
    return _schedule_perspective(row)

@app.patch("/schedule-perspectives/{perspective_id}")
def update_schedule_perspective(perspective_id: str, data: SchedulePerspectivePatch, user: dict = Depends(current_user)):
    with _db() as con:
        assert_project_access(_project_id_for_schedule_perspective(con, perspective_id), user)
        fields, values = [], []
        if data.name is not None:
            fields.append("name = ?")
            values.append(data.name.strip() or "Untitled perspective")
        if data.state is not None:
            fields.append("state_json = ?")
            values.append(json.dumps(data.state or {}))
        if fields:
            con.execute(f"UPDATE schedule_perspectives SET {', '.join(fields)} WHERE id = ?", (*values, perspective_id))
        row = con.execute("SELECT * FROM schedule_perspectives WHERE id = ?", (perspective_id,)).fetchone()
    return _schedule_perspective(row)

@app.delete("/schedule-perspectives/{perspective_id}", status_code=204)
def delete_schedule_perspective(perspective_id: str, user: dict = Depends(current_user)):
    with _db() as con:
        assert_project_access(_project_id_for_schedule_perspective(con, perspective_id), user)
        con.execute("DELETE FROM schedule_perspectives WHERE id = ?", (perspective_id,))


# ── Classification perspectives ───────────────────────────────────────────────
@app.get("/classification-perspectives")
def list_classification_perspectives(project_id: str = Query(default='default'), context_id: str | None = Query(default=None), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    with _db() as con:
        scoped_context_id = _context_id_for_project(con, project_id, context_id)
        rows = con.execute(
            "SELECT * FROM classification_perspectives WHERE project_id = ? AND context_id = ? ORDER BY name COLLATE NOCASE",
            (project_id, scoped_context_id),
        ).fetchall()
    return [_classification_perspective(r) for r in rows]

@app.post("/classification-perspectives", status_code=201)
def create_classification_perspective(data: ClassificationPerspectiveIn, project_id: str = Query(default='default'), context_id: str | None = Query(default=None), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    pid = data.id or str(uuid.uuid4())
    name = data.name.strip() or "Untitled perspective"
    with _db() as con:
        scoped_context_id = _context_id_for_project(con, project_id, context_id)
        if con.execute("SELECT id FROM classification_perspectives WHERE id = ?", (pid,)).fetchone():
            raise HTTPException(409, "Perspective already exists")
        con.execute(
            "INSERT INTO classification_perspectives (id, project_id, context_id, name, state_json) VALUES (?, ?, ?, ?, ?)",
            (pid, project_id, scoped_context_id, name, json.dumps(data.state or {})),
        )
        row = con.execute("SELECT * FROM classification_perspectives WHERE id = ?", (pid,)).fetchone()
    return _classification_perspective(row)

@app.patch("/classification-perspectives/{perspective_id}")
def update_classification_perspective(perspective_id: str, data: ClassificationPerspectivePatch, user: dict = Depends(current_user)):
    with _db() as con:
        assert_project_access(_project_id_for_classification_perspective(con, perspective_id), user)
        fields, values = [], []
        if data.name is not None:
            fields.append("name = ?")
            values.append(data.name.strip() or "Untitled perspective")
        if data.state is not None:
            fields.append("state_json = ?")
            values.append(json.dumps(data.state or {}))
        if fields:
            con.execute(f"UPDATE classification_perspectives SET {', '.join(fields)} WHERE id = ?", (*values, perspective_id))
        row = con.execute("SELECT * FROM classification_perspectives WHERE id = ?", (perspective_id,)).fetchone()
    return _classification_perspective(row)

@app.delete("/classification-perspectives/{perspective_id}", status_code=204)
def delete_classification_perspective(perspective_id: str, user: dict = Depends(current_user)):
    with _db() as con:
        assert_project_access(_project_id_for_classification_perspective(con, perspective_id), user)
        con.execute("DELETE FROM classification_perspectives WHERE id = ?", (perspective_id,))


# ── Calendar perspectives ─────────────────────────────────────────────────────
@app.get("/calendar-perspectives")
def list_calendar_perspectives(project_id: str = Query(default='default'), context_id: str | None = Query(default=None), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    with _db() as con:
        scoped_context_id = _context_id_for_project(con, project_id, context_id)
        rows = con.execute(
            "SELECT * FROM calendar_perspectives WHERE project_id = ? AND context_id = ? ORDER BY name COLLATE NOCASE",
            (project_id, scoped_context_id),
        ).fetchall()
    return [_calendar_perspective(row) for row in rows]

@app.post("/calendar-perspectives", status_code=201)
def create_calendar_perspective(data: CalendarPerspectiveIn, project_id: str = Query(default='default'), context_id: str | None = Query(default=None), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    perspective_id = data.id or str(uuid.uuid4())
    name = data.name.strip() or "Untitled perspective"
    with _db() as con:
        scoped_context_id = _context_id_for_project(con, project_id, context_id)
        if con.execute("SELECT id FROM calendar_perspectives WHERE id = ?", (perspective_id,)).fetchone():
            raise HTTPException(409, "Perspective already exists")
        con.execute(
            "INSERT INTO calendar_perspectives (id, project_id, context_id, name, state_json) VALUES (?, ?, ?, ?, ?)",
            (perspective_id, project_id, scoped_context_id, name, json.dumps(data.state or {})),
        )
        row = con.execute("SELECT * FROM calendar_perspectives WHERE id = ?", (perspective_id,)).fetchone()
    return _calendar_perspective(row)

@app.patch("/calendar-perspectives/{perspective_id}")
def update_calendar_perspective(perspective_id: str, data: CalendarPerspectivePatch, user: dict = Depends(current_user)):
    with _db() as con:
        assert_project_access(_project_id_for_calendar_perspective(con, perspective_id), user)
        fields, values = [], []
        if data.name is not None:
            fields.append("name = ?")
            values.append(data.name.strip() or "Untitled perspective")
        if data.state is not None:
            fields.append("state_json = ?")
            values.append(json.dumps(data.state or {}))
        if fields:
            con.execute(f"UPDATE calendar_perspectives SET {', '.join(fields)} WHERE id = ?", (*values, perspective_id))
        row = con.execute("SELECT * FROM calendar_perspectives WHERE id = ?", (perspective_id,)).fetchone()
    return _calendar_perspective(row)

@app.delete("/calendar-perspectives/{perspective_id}", status_code=204)
def delete_calendar_perspective(perspective_id: str, user: dict = Depends(current_user)):
    with _db() as con:
        assert_project_access(_project_id_for_calendar_perspective(con, perspective_id), user)
        con.execute("DELETE FROM calendar_perspectives WHERE id = ?", (perspective_id,))


# ── Project contexts ──────────────────────────────────────────────────────────
@app.get("/project-contexts")
def list_project_contexts(project_id: str = Query(default='default'), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    with _db() as con:
        _ensure_default_context(con, project_id)
        rows = con.execute(
            "SELECT * FROM project_contexts WHERE project_id = ? ORDER BY name COLLATE NOCASE", (project_id,)
        ).fetchall()
    return [_project_context(row) for row in rows]

@app.post("/project-contexts", status_code=201)
def create_project_context(data: ProjectContextIn, project_id: str = Query(default='default'), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    context_id = data.id or str(uuid.uuid4())
    name = data.name.strip() or "Untitled context"
    perspective_ids = {
        "classification": str(uuid.uuid4()),
        "schedule": str(uuid.uuid4()),
        "calendar": str(uuid.uuid4()),
    }
    state = dict(data.state or {})
    state.update({
        "classificationPerspectiveId": perspective_ids["classification"],
        "schedulePerspectiveId": perspective_ids["schedule"],
        "calendarPerspectiveId": perspective_ids["calendar"],
    })
    with _db() as con:
        if con.execute("SELECT id FROM project_contexts WHERE id = ?", (context_id,)).fetchone():
            raise HTTPException(409, "Context already exists")
        con.execute(
            "INSERT INTO project_contexts (id, project_id, name, state_json) VALUES (?, ?, ?, ?)",
            (context_id, project_id, name, json.dumps(state)),
        )
        for page, table in (
            ("classification", "classification_perspectives"),
            ("schedule", "schedule_perspectives"),
            ("calendar", "calendar_perspectives"),
        ):
            con.execute(
                f"INSERT INTO {table} (id, project_id, context_id, name, state_json) VALUES (?, ?, ?, ?, ?)",
                (perspective_ids[page], project_id, context_id, name, "{}"),
            )
        row = con.execute("SELECT * FROM project_contexts WHERE id = ?", (context_id,)).fetchone()
    return _project_context(row)

@app.patch("/project-contexts/{context_id}")
def update_project_context(context_id: str, data: ProjectContextPatch, user: dict = Depends(current_user)):
    with _db() as con:
        assert_project_access(_project_id_for_context(con, context_id), user)
        fields, values = [], []
        if data.name is not None:
            fields.append("name = ?")
            values.append(data.name.strip() or "Untitled context")
        if data.state is not None:
            fields.append("state_json = ?")
            values.append(json.dumps(data.state or {}))
        if fields:
            con.execute(f"UPDATE project_contexts SET {', '.join(fields)} WHERE id = ?", (*values, context_id))
        row = con.execute("SELECT * FROM project_contexts WHERE id = ?", (context_id,)).fetchone()
    return _project_context(row)

@app.delete("/project-contexts/{context_id}", status_code=204)
def delete_project_context(context_id: str, user: dict = Depends(current_user)):
    with _db() as con:
        assert_project_access(_project_id_for_context(con, context_id), user)
        con.execute("DELETE FROM schedule_perspectives WHERE context_id = ?", (context_id,))
        con.execute("DELETE FROM classification_perspectives WHERE context_id = ?", (context_id,))
        con.execute("DELETE FROM calendar_perspectives WHERE context_id = ?", (context_id,))
        con.execute("DELETE FROM project_contexts WHERE id = ?", (context_id,))


# ── Transactions ──────────────────────────────────────────────────────────────
@app.get("/transactions/history")
def get_transaction_history(project_id: str = Query(default='default'), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    with _db() as con:
        return _history_summary(con, project_id)

@app.post("/transactions")
def apply_transaction(data: TransactionApplyIn, project_id: str = Query(default='default'), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    with _db() as con:
        return _apply_transaction(con, project_id, data.transaction)

@app.post("/transactions/undo")
def undo_transaction(project_id: str = Query(default='default'), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    with _db() as con:
        row = con.execute(
            """
            SELECT * FROM transaction_history
            WHERE project_id = ? AND stack = 'undo'
            ORDER BY seq DESC LIMIT 1
            """,
            (project_id,),
        ).fetchone()
        if not row:
            raise HTTPException(409, "Nothing to undo")
        transaction = json.loads(row["transaction_json"])
        reverse = TransactionPayload(
            id=str(uuid.uuid4()),
            type=f"undo:{transaction.get('type', 'transaction')}",
            label=f"Undo {transaction.get('label') or transaction.get('type') or 'transaction'}",
            before=json.loads(row["after_json"]),
            after=json.loads(row["before_json"]),
        )
        _apply_transaction(con, project_id, reverse, record_history=False)
        _move_history_entry(con, project_id, row, "redo")
        return {"ok": True, "transaction": transaction, "history": _history_summary(con, project_id)}

@app.post("/transactions/redo")
def redo_transaction(project_id: str = Query(default='default'), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    with _db() as con:
        row = con.execute(
            """
            SELECT * FROM transaction_history
            WHERE project_id = ? AND stack = 'redo'
            ORDER BY seq DESC LIMIT 1
            """,
            (project_id,),
        ).fetchone()
        if not row:
            raise HTTPException(409, "Nothing to redo")
        transaction = json.loads(row["transaction_json"])
        forward = TransactionPayload(
            id=str(uuid.uuid4()),
            type=f"redo:{transaction.get('type', 'transaction')}",
            label=f"Redo {transaction.get('label') or transaction.get('type') or 'transaction'}",
            before=json.loads(row["before_json"]),
            after=json.loads(row["after_json"]),
        )
        _apply_transaction(con, project_id, forward, record_history=False)
        _move_history_entry(con, project_id, row, "undo")
        return {"ok": True, "transaction": transaction, "history": _history_summary(con, project_id)}


# ── Time Slots ───────────────────────────────────────────────────────────────
@app.get("/time-slots")
def list_time_slots(project_id: str = Query(default='default'), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    with _db() as con:
        rows = con.execute(
            """SELECT * FROM time_slots
            WHERE note_id IN (SELECT id FROM notes WHERE project_id = ?)
            ORDER BY start_col""",
            (project_id,)
        ).fetchall()
    return [_time_slot(r) for r in rows]

@app.post("/time-slots", status_code=201)
def create_time_slot(data: TimeSlotIn, user: dict = Depends(current_user)):
    mid = data.id or str(uuid.uuid4())
    duration = _time_slot_duration_value(data.duration)
    time_slot = {
        "id": mid,
        "noteId": data.noteId,
        "startCol": data.startCol,
        "duration": duration,
        "title": data.title,
        "color": data.color,
    }
    _assert_time_slot_scale_edit_allowed(None, time_slot)
    with _db() as con:
        project_id = _project_id_for_note(con, data.noteId)
        assert_project_access(project_id, user)
        _assert_final_state_valid(con, project_id, {"time_slots": [], "dependencies": []}, {"time_slots": [time_slot], "dependencies": []})
        con.execute(
            "INSERT INTO time_slots (id, note_id, start_col, duration, title, color) VALUES (?,?,?,?,?,?)",
            (mid, data.noteId, data.startCol, duration, data.title, data.color),
        )
    return time_slot

# Registered before /{time_slot_id} so "batch" is not captured as a path param
@app.put("/time-slots/batch")
def batch_update_time_slots(data: TimeSlotBatch, user: dict = Depends(current_user)):
    with _db() as con:
        for u in data.updates:
            mid = u.get("id")
            if not mid:
                continue
            project_id = _project_id_for_time_slot(con, mid)
            assert_project_access(project_id, user)
            row = con.execute("SELECT * FROM time_slots WHERE id = ?", (mid,)).fetchone()
            before = _time_slot(row)
            after = {**before}
            fields, values = [], []
            if "startCol" in u:
                after["startCol"] = int(u["startCol"])
                fields.append("start_col = ?"); values.append(after["startCol"])
            if "duration" in u:
                after["duration"] = _time_slot_duration_value(u["duration"])
                fields.append("duration = ?");  values.append(after["duration"])
            if "color"    in u: fields.append("color = ?");     values.append(u["color"])
            if "title"    in u: fields.append("title = ?");     values.append(u["title"])
            if _schedule_fields_changed(before, after):
                _assert_time_slot_scale_edit_allowed(before, after)
                _assert_final_state_valid(con, project_id, {"time_slots": [before], "dependencies": []}, {"time_slots": [after], "dependencies": []})
            if fields:
                con.execute(f"UPDATE time_slots SET {', '.join(fields)} WHERE id = ?", (*values, mid))
    return {"ok": True}

@app.patch("/time-slots/{time_slot_id}")
def update_time_slot(time_slot_id: str, data: TimeSlotPatch, user: dict = Depends(current_user)):
    with _db() as con:
        project_id = _project_id_for_time_slot(con, time_slot_id)
        assert_project_access(project_id, user)
        row = con.execute("SELECT * FROM time_slots WHERE id = ?", (time_slot_id,)).fetchone()
        before = _time_slot(row)
        after = {**before}
        fields, values = [], []
        if data.startCol is not None:
            after["startCol"] = data.startCol
            fields.append("start_col = ?"); values.append(data.startCol)
        if data.duration  is not None:
            after["duration"] = _time_slot_duration_value(data.duration)
            fields.append("duration = ?");  values.append(after["duration"])
        if data.title     is not None: fields.append("title = ?");     values.append(data.title)
        if data.color     is not None: fields.append("color = ?");     values.append(data.color)
        if _schedule_fields_changed(before, after):
            _assert_time_slot_scale_edit_allowed(before, after)
            _assert_final_state_valid(con, project_id, {"time_slots": [before], "dependencies": []}, {"time_slots": [after], "dependencies": []})
        if fields:
            con.execute(f"UPDATE time_slots SET {', '.join(fields)} WHERE id = ?", (*values, time_slot_id))
        row = con.execute("SELECT * FROM time_slots WHERE id = ?", (time_slot_id,)).fetchone()
    return _time_slot(row)

@app.delete("/time-slots/{time_slot_id}", status_code=204)
def delete_time_slot(time_slot_id: str, user: dict = Depends(current_user)):
    with _db() as con:
        row = con.execute(
            "SELECT m.note_id, n.project_id FROM time_slots m JOIN notes n ON n.id = m.note_id WHERE m.id = ?",
            (time_slot_id,),
        ).fetchone()
        if not row:
            raise HTTPException(404, "Time slot not found")
        assert_project_access(row["project_id"], user)
        con.execute("DELETE FROM persona_time_slot_assignments WHERE time_slot_id = ?", (time_slot_id,))
        con.execute("DELETE FROM time_slots WHERE id = ?", (time_slot_id,))
        _unassign_scheduled_if_unslotted(con, row["note_id"], row["project_id"])


# ── Dependencies ──────────────────────────────────────────────────────────────
@app.get("/dependencies")
def list_dependencies(project_id: str = Query(default='default'), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    with _db() as con:
        rows = con.execute(
            """SELECT * FROM dependencies WHERE from_id IN (
                SELECT id FROM time_slots WHERE note_id IN (SELECT id FROM notes WHERE project_id = ?)
            )""",
            (project_id,)
        ).fetchall()
    return [_dep(r) for r in rows]

@app.get("/dependencies/violations")
def list_dependency_violations(project_id: str = Query(default='default'), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    with _db() as con:
        return {"violations": _dependency_violations_for_project(con, project_id)}

@app.post("/dependencies", status_code=201)
def create_dependency(data: DependencyIn, user: dict = Depends(current_user)):
    did = data.id or str(uuid.uuid4())
    reason = data.reason or ''
    with _db() as con:
        from_project_id = _project_id_for_time_slot(con, data.fromId)
        to_project_id = _project_id_for_time_slot(con, data.toId)
        if from_project_id != to_project_id:
            raise HTTPException(400, "Dependency endpoints must belong to the same project")
        assert_project_access(from_project_id, user)
        time_slots = _time_slots_by_id(con, {data.fromId, data.toId})
        scale_mismatch = _dependency_scale_mismatch(
            {"id": did, "fromId": data.fromId, "toId": data.toId},
            time_slots,
        )
        if scale_mismatch:
            raise HTTPException(422, scale_mismatch)
        try:
            con.execute("INSERT INTO dependencies (id, from_id, to_id, reason) VALUES (?, ?, ?, ?)",
                        (did, data.fromId, data.toId, reason))
        except sqlite3.IntegrityError:
            raise HTTPException(409, "Dependency already exists")
    return _dep({"id": did, "from_id": data.fromId, "to_id": data.toId, "reason": reason})

@app.patch("/dependencies/{dep_id}")
def update_dependency(dep_id: str, data: DependencyPatchIn, user: dict = Depends(current_user)):
    with _db() as con:
        assert_project_access(_project_id_for_dependency(con, dep_id), user)
        con.execute("UPDATE dependencies SET reason = ? WHERE id = ?", (data.reason, dep_id))
        row = con.execute("SELECT * FROM dependencies WHERE id = ?", (dep_id,)).fetchone()
    if not row:
        raise HTTPException(404)
    return _dep(row)

@app.delete("/dependencies/{dep_id}", status_code=204)
def delete_dependency(dep_id: str, user: dict = Depends(current_user)):
    with _db() as con:
        assert_project_access(_project_id_for_dependency(con, dep_id), user)
        con.execute("DELETE FROM dependencies WHERE id = ?", (dep_id,))


# ── Deadlines ─────────────────────────────────────────────────────────────────
@app.get("/deadlines")
def list_deadlines(project_id: str = Query(default='default'), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    with _db() as con:
        rows = con.execute(
            "SELECT * FROM deadlines WHERE note_id IN (SELECT id FROM notes WHERE project_id = ?)",
            (project_id,)
        ).fetchall()
    return [_dl(r) for r in rows]

@app.put("/deadlines/{note_id}")
def set_deadline(note_id: str, data: DeadlineColIn, user: dict = Depends(current_user)):
    scale = _normalize_planning_scale(data.scale, data.col)
    _assert_scale_aligned_col(data.col, scale, "Deadline")
    with _db() as con:
        assert_project_access(_project_id_for_note(con, note_id), user)
        blocking = con.execute(
            "SELECT * FROM time_slots WHERE note_id = ?",
            (note_id,),
        ).fetchall()
        ms_scales = {_planning_scale_for_time_slot(_time_slot(row)) for row in blocking}
        if ms_scales and scale not in ms_scales:
            row_scale = next(iter(ms_scales))
            raise HTTPException(422, {
                "message": f"This row contains {row_scale}-scale time slots. Switch to the {row_scale} view to set a deadline here.",
                "type": "deadline_scale_mismatch",
            })
        for row in blocking:
            time_slot = _time_slot(row)
            if (
                _planning_scale_for_time_slot(time_slot) == scale
                and time_slot["startCol"] + time_slot["duration"] > data.col
            ):
                raise HTTPException(422, {
                    "message": "Hard deadline would conflict with an existing time slot on the same planning scale",
                    "type": "deadline",
                    "id": time_slot["id"],
                })
        existing = con.execute("SELECT id FROM deadlines WHERE note_id = ?", (note_id,)).fetchone()
        if existing:
            con.execute(
                "UPDATE deadlines SET col = ?, scale = ?, reason = ? WHERE note_id = ?",
                (data.col, scale, data.reason or "", note_id),
            )
        else:
            did = str(uuid.uuid4())
            con.execute(
                "INSERT INTO deadlines (id, note_id, col, scale, reason) VALUES (?, ?, ?, ?, ?)",
                (did, note_id, data.col, scale, data.reason or ""),
            )
        row = con.execute("SELECT * FROM deadlines WHERE note_id = ?", (note_id,)).fetchone()
    return _dl(row)

@app.delete("/deadlines/{note_id}", status_code=204)
def remove_deadline(note_id: str, user: dict = Depends(current_user)):
    with _db() as con:
        assert_project_access(_project_id_for_note(con, note_id), user)
        con.execute("DELETE FROM deadlines WHERE note_id = ?", (note_id,))


# ── Earliest starts ────────────────────────────────────────────────────────────
@app.get("/earliest-starts")
def list_earliest_starts(project_id: str = Query(default='default'), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    with _db() as con:
        rows = con.execute(
            "SELECT * FROM earliest_starts WHERE note_id IN (SELECT id FROM notes WHERE project_id = ?)",
            (project_id,)
        ).fetchall()
    return [_es(r) for r in rows]

@app.put("/earliest-starts/{note_id}")
def set_earliest_start(note_id: str, data: DeadlineColIn, user: dict = Depends(current_user)):
    scale = _normalize_planning_scale(data.scale, data.col)
    _assert_scale_aligned_col(data.col, scale, "Earliest start")
    with _db() as con:
        assert_project_access(_project_id_for_note(con, note_id), user)
        blocking = con.execute(
            "SELECT * FROM time_slots WHERE note_id = ?",
            (note_id,),
        ).fetchall()
        ms_scales = {_planning_scale_for_time_slot(_time_slot(row)) for row in blocking}
        if ms_scales and scale not in ms_scales:
            row_scale = next(iter(ms_scales))
            raise HTTPException(422, {
                "message": f"This row contains {row_scale}-scale time slots. Switch to the {row_scale} view to set an earliest start here.",
                "type": "earliest_start_scale_mismatch",
            })
        for row in blocking:
            time_slot = _time_slot(row)
            if (
                _planning_scale_for_time_slot(time_slot) == scale
                and time_slot["startCol"] < data.col
            ):
                raise HTTPException(422, {
                    "message": "Earliest start date would conflict with an existing time slot that starts before it",
                    "type": "earliest_start",
                    "id": time_slot["id"],
                })
        existing = con.execute("SELECT id FROM earliest_starts WHERE note_id = ?", (note_id,)).fetchone()
        if existing:
            con.execute(
                "UPDATE earliest_starts SET col = ?, scale = ?, reason = ? WHERE note_id = ?",
                (data.col, scale, data.reason or "", note_id),
            )
        else:
            eid = str(uuid.uuid4())
            con.execute(
                "INSERT INTO earliest_starts (id, note_id, col, scale, reason) VALUES (?, ?, ?, ?, ?)",
                (eid, note_id, data.col, scale, data.reason or ""),
            )
        row = con.execute("SELECT * FROM earliest_starts WHERE note_id = ?", (note_id,)).fetchone()
    return _es(row)

@app.delete("/earliest-starts/{note_id}", status_code=204)
def remove_earliest_start(note_id: str, user: dict = Depends(current_user)):
    with _db() as con:
        assert_project_access(_project_id_for_note(con, note_id), user)
        con.execute("DELETE FROM earliest_starts WHERE note_id = ?", (note_id,))

@app.put("/time-slots/{time_slot_id}/time-lock")
def lock_time_slot(time_slot_id: str, data: TimeLockIn, user: dict = Depends(current_user)):
    with _db() as con:
        project_id = _project_id_for_time_slot(con, time_slot_id)
        assert_project_access(project_id, user)
        row = con.execute("SELECT * FROM time_slots WHERE id = ?", (time_slot_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Time slot not found")
        time_slot = _time_slot(row)
        note_id = time_slot["noteId"]
        scale = _planning_scale_for_time_slot(time_slot)
        reason = data.reason or ""
        con.execute(
            """
            INSERT INTO earliest_starts (id, note_id, col, scale, reason)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(note_id) DO UPDATE SET col = excluded.col, scale = excluded.scale, reason = excluded.reason
            """,
            (str(uuid.uuid4()), note_id, time_slot["startCol"], scale, reason),
        )
        con.execute(
            """
            INSERT INTO deadlines (id, note_id, col, scale, reason)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(note_id) DO UPDATE SET col = excluded.col, scale = excluded.scale, reason = excluded.reason
            """,
            (str(uuid.uuid4()), note_id, time_slot["startCol"] + time_slot["duration"], scale, reason),
        )
        earliest_start = con.execute("SELECT * FROM earliest_starts WHERE note_id = ?", (note_id,)).fetchone()
        deadline = con.execute("SELECT * FROM deadlines WHERE note_id = ?", (note_id,)).fetchone()
    return {"earliestStart": _es(earliest_start), "deadline": _dl(deadline)}

@app.delete("/time-slots/{time_slot_id}/time-lock", status_code=204)
def unlock_time_slot(time_slot_id: str, user: dict = Depends(current_user)):
    with _db() as con:
        project_id = _project_id_for_time_slot(con, time_slot_id)
        assert_project_access(project_id, user)
        row = con.execute("SELECT note_id FROM time_slots WHERE id = ?", (time_slot_id,)).fetchone()
        if not row:
            raise HTTPException(404, "Time slot not found")
        con.execute("DELETE FROM earliest_starts WHERE note_id = ?", (row["note_id"],))
        con.execute("DELETE FROM deadlines WHERE note_id = ?", (row["note_id"],))


# ── Project export ─────────────────────────────────────────────────────────────
@app.get("/export/db")
def export_database(project_id: str = Query(...), user: dict = Depends(current_user)):
    def rows(query_rows, json_cols=()):
        out = []
        for row in query_rows:
            d = dict(row)
            for col in json_cols:
                if col in d and d[col]:
                    try:
                        d[col] = json.loads(d[col])
                    except Exception:
                        pass
            out.append(d)
        return out

    with _db() as con:
        project = assert_project_access(project_id, user)
        projects = con.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchall()
        owner = con.execute("SELECT * FROM users WHERE id = ?", (project["userId"],)).fetchone()
        exported_users = [_user(owner)] if owner else []
        project_ids = [row["id"] for row in projects]
        if project_ids:
            project_ph = ','.join('?' for _ in project_ids)
            notes = con.execute(f"SELECT * FROM notes WHERE project_id IN ({project_ph})", project_ids).fetchall()
            dimensions = con.execute(f"SELECT * FROM dimensions WHERE project_id IN ({project_ph})", project_ids).fetchall()
            saved_filters = con.execute(f"SELECT * FROM saved_filters WHERE project_id IN ({project_ph})", project_ids).fetchall()
            schedule_perspectives = con.execute(f"SELECT * FROM schedule_perspectives WHERE project_id IN ({project_ph})", project_ids).fetchall()
            classification_perspectives = con.execute(f"SELECT * FROM classification_perspectives WHERE project_id IN ({project_ph})", project_ids).fetchall()
            calendar_perspectives = con.execute(f"SELECT * FROM calendar_perspectives WHERE project_id IN ({project_ph})", project_ids).fetchall()
            transaction_history = con.execute(f"SELECT * FROM transaction_history WHERE project_id IN ({project_ph})", project_ids).fetchall()
        else:
            notes = dimensions = saved_filters = schedule_perspectives = classification_perspectives = calendar_perspectives = transaction_history = []

        note_ids = [row["id"] for row in notes]
        dim_ids = [row["id"] for row in dimensions]

        if dim_ids:
            dim_ph = ','.join('?' for _ in dim_ids)
            categories = con.execute(f"SELECT * FROM categories WHERE dimension_id IN ({dim_ph})", dim_ids).fetchall()
            assignments = con.execute(f"SELECT * FROM assignments WHERE dimension_id IN ({dim_ph})", dim_ids).fetchall()
        else:
            categories = assignments = []

        if note_ids:
            note_ph = ','.join('?' for _ in note_ids)
            time_slots = con.execute(f"SELECT * FROM time_slots WHERE note_id IN ({note_ph})", note_ids).fetchall()
            deadlines = con.execute(f"SELECT * FROM deadlines WHERE note_id IN ({note_ph})", note_ids).fetchall()
            earliest_starts = con.execute(f"SELECT * FROM earliest_starts WHERE note_id IN ({note_ph})", note_ids).fetchall()
            note_inheritance = con.execute(
                f"SELECT * FROM note_inheritance WHERE child_note_id IN ({note_ph}) OR parent_note_id IN ({note_ph})",
                note_ids + note_ids,
            ).fetchall()
        else:
            time_slots = deadlines = earliest_starts = note_inheritance = []

        time_slot_ids = [row["id"] for row in time_slots]
        if time_slot_ids:
            ms_ph = ','.join('?' for _ in time_slot_ids)
            dependencies = con.execute(
                f"SELECT * FROM dependencies WHERE from_id IN ({ms_ph}) OR to_id IN ({ms_ph})",
                time_slot_ids + time_slot_ids,
            ).fetchall()
        else:
            dependencies = []

        return {
            "exported_at": con.execute("SELECT datetime('now')").fetchone()[0] + "Z",
            "version": 1,
            "tables": {
                "users":                      exported_users,
                "projects":                   rows(projects),
                "notes":                      rows(notes),
                "dimensions":                 rows(dimensions),
                "categories":                 rows(categories),
                "assignments":                rows(assignments),
                "timeSlots":                  rows(time_slots),
                "dependencies":               rows(dependencies),
                "deadlines":                  rows(deadlines),
                "earliest_starts":            rows(earliest_starts),
                "note_inheritance":           rows(note_inheritance),
                "saved_filters":              rows(saved_filters,              ("selections_json",)),
                "schedule_perspectives":      rows(schedule_perspectives,      ("state_json",)),
                "classification_perspectives": rows(classification_perspectives, ("state_json",)),
                "calendar_perspectives":      rows(calendar_perspectives,      ("state_json",)),
                "transaction_history":        rows(transaction_history,        ("transaction_json", "before_json", "after_json")),
            },
        }
