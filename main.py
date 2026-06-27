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
MIN_MILESTONE_DURATION = 10
MINUTE_SCALE_UNIT = 15
DAY_MINUTES = 60 * 24
MONTH_MINUTES = DAY_MINUTES * 30
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
                name        TEXT NOT NULL DEFAULT 'Untitled',
                description TEXT NOT NULL DEFAULT '',
                resize_warn_order_threshold REAL NOT NULL DEFAULT 2,
                resize_block_order_threshold REAL NOT NULL DEFAULT 2,
                resize_scale_crossing_warning_enabled INTEGER NOT NULL DEFAULT 1,
                created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        """)
        con.execute("""
            CREATE TABLE IF NOT EXISTS notes (
                id         TEXT PRIMARY KEY,
                project_id TEXT NOT NULL DEFAULT 'default',
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
            CREATE TABLE IF NOT EXISTS milestones (
                id         TEXT PRIMARY KEY,
                note_id    TEXT NOT NULL,
                start_col  INTEGER NOT NULL,
                duration   INTEGER NOT NULL DEFAULT 15,
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
                scale   TEXT NOT NULL DEFAULT 'day'
            )
        """)
        con.execute("""
            CREATE TABLE IF NOT EXISTS earliest_starts (
                id      TEXT PRIMARY KEY,
                note_id TEXT NOT NULL UNIQUE,
                col     INTEGER NOT NULL,
                scale   TEXT NOT NULL DEFAULT 'day'
            )
        """)
        con.execute("""
            CREATE TABLE IF NOT EXISTS note_inheritance (
                child_note_id  TEXT PRIMARY KEY,
                parent_note_id TEXT NOT NULL
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
                name       TEXT NOT NULL,
                state_json TEXT NOT NULL DEFAULT '{}'
            )
        """)
        con.execute("""
            CREATE TABLE IF NOT EXISTS classification_perspectives (
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
            CREATE TABLE IF NOT EXISTS persona_milestone_assignments (
                persona_id   TEXT NOT NULL,
                milestone_id TEXT NOT NULL,
                PRIMARY KEY (persona_id, milestone_id)
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

        for table in ("assignments", "milestones", "deadlines"):
            cols = [r[1] for r in con.execute(f"PRAGMA table_info({table})").fetchall()]
            if "goal_id" in cols and "note_id" not in cols:
                con.execute(f"ALTER TABLE {table} RENAME COLUMN goal_id TO note_id")

        con.execute("""
            CREATE TABLE IF NOT EXISTS note_inheritance (
                child_note_id  TEXT PRIMARY KEY,
                parent_note_id TEXT NOT NULL
            )
        """)

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
                FROM milestones
            )
            WHERE rn > 1
            """
        ).fetchall()
        duplicate_ms_ids = [row["id"] for row in duplicate_ms]
        if duplicate_ms_ids:
            ph = ",".join("?" for _ in duplicate_ms_ids)
            con.execute(f"DELETE FROM dependencies WHERE from_id IN ({ph}) OR to_id IN ({ph})", duplicate_ms_ids + duplicate_ms_ids)
            con.execute(f"DELETE FROM persona_milestone_assignments WHERE milestone_id IN ({ph})", duplicate_ms_ids)
            con.execute(f"DELETE FROM milestones WHERE id IN ({ph})", duplicate_ms_ids)

        for table, cols in {
            "schedule_perspectives": ("state_json",),
            "classification_perspectives": ("state_json",),
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
                    SET {col} = replace(replace(replace(replace(replace({col},
                        'goalId', 'noteId'),
                        'hiddenGoalsByLane', 'hiddenNotesByLane'),
                        'visibleGoalFilterIds', 'visibleNoteFilterIds'),
                        'revealedConflictGoalIds', 'revealedConflictNoteIds'),
                        'selectedGoalIds', 'selectedNoteIds')
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
        for table in ['notes', 'dimensions', 'saved_filters', 'schedule_perspectives', 'classification_perspectives']:
            cols = [r[1] for r in con.execute(f"PRAGMA table_info({table})").fetchall()]
            if 'project_id' not in cols:
                con.execute(f"ALTER TABLE {table} ADD COLUMN project_id TEXT NOT NULL DEFAULT 'default'")

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
            "UPDATE milestones SET duration = ? WHERE duration < ?",
            (MIN_MILESTONE_DURATION, MIN_MILESTONE_DURATION),
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
                            duration = MIN_MILESTONE_DURATION
                        if duration < MIN_MILESTONE_DURATION:
                            node["duration"] = MIN_MILESTONE_DURATION
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
        if 'color' in proj_cols:
            pass  # keep for compat, just don't use in UI

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

class ProjectPatch(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    resizeWarnOrderThreshold: Optional[float] = None
    resizeBlockOrderThreshold: Optional[float] = None
    resizeScaleCrossingWarningEnabled: Optional[bool] = None

class NoteIn(BaseModel):
    id: Optional[str] = None
    html: str = ""
    title: str = "Untitled"
    collapsed: bool = False

class NotePatch(BaseModel):
    html: Optional[str] = None
    title: Optional[str] = None
    collapsed: Optional[bool] = None

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

class MilestoneIn(BaseModel):
    id: Optional[str] = None
    noteId: str
    startCol: int
    duration: int = Field(default=MIN_MILESTONE_DURATION, ge=MIN_MILESTONE_DURATION)
    title: str = ''
    color: str = '#1a73e8'

class MilestonePatch(BaseModel):
    startCol: Optional[int] = None
    duration: Optional[int] = Field(default=None, ge=MIN_MILESTONE_DURATION)
    title: Optional[str] = None
    color: Optional[str] = None

class MilestoneBatch(BaseModel):
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
        "name": d["name"],
        "description": d.get("description", ""),
        "resizeWarnOrderThreshold": float(d.get("resize_warn_order_threshold", 2)),
        "resizeBlockOrderThreshold": float(d.get("resize_block_order_threshold", 2)),
        "resizeScaleCrossingWarningEnabled": bool(d.get("resize_scale_crossing_warning_enabled", 1)),
        "createdAt": d["created_at"],
    }

def _note(row) -> dict:
    d = dict(row)
    d["collapsed"] = bool(d["collapsed"])
    return d

def _cat(row) -> dict:
    d = dict(row)
    return {"id": d["id"], "dimensionId": d["dimension_id"], "name": d["name"], "color": d["color"]}

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

def _ms(row) -> dict:
    d = dict(row)
    return {"id": d["id"], "noteId": d["note_id"], "startCol": d["start_col"],
            "duration": d["duration"], "title": d["title"], "color": d["color"]}

def _dep(row) -> dict:
    d = dict(row)
    return {"id": d["id"], "fromId": d["from_id"], "toId": d["to_id"], "reason": d.get("reason", "")}

def _dl(row) -> dict:
    d = dict(row)
    return {"id": d["id"], "noteId": d["note_id"], "col": d["col"], "scale": _normalize_planning_scale(d.get("scale"), d["col"])}

def _es(row) -> dict:
    d = dict(row)
    return {"id": d["id"], "noteId": d["note_id"], "col": d["col"], "scale": _normalize_planning_scale(d.get("scale"), d["col"])}

def _inheritance(row) -> dict:
    d = dict(row)
    return {"childNoteId": d["child_note_id"], "parentNoteId": d["parent_note_id"]}

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

def _project_id_for_note(con, note_id: str) -> str:
    row = con.execute("SELECT project_id FROM notes WHERE id = ?", (note_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Note not found")
    return row["project_id"]

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

def _project_id_for_milestone(con, ms_id: str) -> str:
    row = con.execute(
        """SELECT p.project_id FROM milestones m
        JOIN notes p ON p.id = m.note_id
        WHERE m.id = ?""",
        (ms_id,),
    ).fetchone()
    if not row:
        raise HTTPException(404, "Milestone not found")
    return row["project_id"]

def _project_id_for_dependency(con, dep_id: str) -> str:
    row = con.execute(
        """SELECT p.project_id FROM dependencies d
        JOIN milestones m ON m.id = d.from_id
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

HISTORY_LIMIT = 20

def _milestone_duration_value(value) -> int:
    try:
        duration = int(value)
    except (TypeError, ValueError):
        raise HTTPException(422, f"Milestone duration must be at least {MIN_MILESTONE_DURATION} minutes")
    if duration < MIN_MILESTONE_DURATION:
        raise HTTPException(422, f"Milestone duration must be at least {MIN_MILESTONE_DURATION} minutes")
    return duration

def _planning_scale_for_duration(duration) -> str:
    value = max(MIN_MILESTONE_DURATION, int(duration or MIN_MILESTONE_DURATION))
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

def _planning_scale_for_milestone(milestone: dict) -> str:
    if _is_calendar_month_range(milestone.get("startCol", 0), milestone.get("duration", 0)):
        return "month"
    return _planning_scale_for_duration(milestone.get("duration", MIN_MILESTONE_DURATION))

def _planning_scale_index(scale: str) -> int:
    return {"minute": 0, "day": 1, "month": 2}.get(scale, -1)

def _is_parent_scale_for_child(parent_scale: str, child_scale: str) -> bool:
    return _planning_scale_index(parent_scale) == _planning_scale_index(child_scale) + 1

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

def _assert_scale_aligned_col(col: int, scale: str, kind: str = "Milestone"):
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
        or int(before.get("duration", MIN_MILESTONE_DURATION)) != int(after.get("duration", MIN_MILESTONE_DURATION))
    )

def _assert_milestone_scale_edit_allowed(before: dict | None, after: dict):
    after_scale = _planning_scale_for_milestone(after)
    if before is not None:
        before_scale = _planning_scale_for_milestone(before)
        if before_scale != after_scale:
            raise HTTPException(422, {
                "message": "Milestone planning scale cannot be changed by moving or resizing",
                "type": "milestone_scale_mismatch",
                "milestoneIds": [after["id"]],
                "fromScale": before_scale,
                "toScale": after_scale,
            })

    if after_scale == "month":
        return

    unit = _planning_scale_unit_minutes(after_scale)
    if int(after["startCol"]) % unit != 0 or int(after["duration"]) % unit != 0:
        raise HTTPException(422, {
            "message": "Milestone can only be moved or resized on its own planning scale",
            "type": "milestone_scale_alignment",
            "milestoneIds": [after["id"]],
            "scale": after_scale,
            "unitMinutes": unit,
        })

def _assert_note_milestone_scales_match(milestones: list[dict], note_ids: set[str] | None = None):
    scales_by_note: dict[str, dict[str, str]] = {}
    for milestone in milestones:
        note_id = milestone["noteId"]
        if note_ids is not None and note_id not in note_ids:
            continue
        scale = _planning_scale_for_milestone(milestone)
        scales_by_note.setdefault(note_id, {})[scale] = milestone["id"]
    for note_id, scale_ids in scales_by_note.items():
        if len(scale_ids) > 1:
            raise HTTPException(422, {
                "message": "A note row can only contain milestones on one planning scale",
                "type": "note_scale_mismatch",
                "noteId": note_id,
                "scales": sorted(scale_ids.keys()),
                "milestoneIds": list(scale_ids.values()),
            })

def _dependency_scale_mismatch(dep: dict, milestones: dict[str, dict]) -> dict | None:
    from_ms = milestones.get(dep["fromId"])
    to_ms = milestones.get(dep["toId"])
    if not from_ms or not to_ms:
        return None
    from_scale = _planning_scale_for_milestone(from_ms)
    to_scale = _planning_scale_for_milestone(to_ms)
    if from_scale == to_scale:
        return None
    return {
        "message": "Dependency scale mismatch",
        "type": "scale_mismatch",
        "dependencyIds": [dep["id"]],
        "milestoneIds": [dep["fromId"], dep["toId"]],
        "fromScale": from_scale,
        "toScale": to_scale,
    }

def _milestone_from_api(data: dict) -> dict:
    return {
        "id": data["id"],
        "noteId": data["noteId"],
        "startCol": int(data.get("startCol", 0)),
        "duration": _milestone_duration_value(data.get("duration", MIN_MILESTONE_DURATION)),
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
    return {
        "milestones": [_milestone_from_api(m) for m in state.get("milestones", [])],
        "dependencies": [_dependency_from_api(d) for d in state.get("dependencies", [])],
    }

def _ms_by_id(con, ids: set[str]) -> dict[str, dict]:
    if not ids:
        return {}
    rows = con.execute(
        f"SELECT * FROM milestones WHERE id IN ({','.join('?' for _ in ids)})",
        tuple(ids),
    ).fetchall()
    return {row["id"]: _ms(row) for row in rows}

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
    ms_ids = _state_ids(before, "milestones") | _state_ids(after, "milestones")
    dep_ids = _state_ids(before, "dependencies") | _state_ids(after, "dependencies")
    current_ms = _ms_by_id(con, ms_ids)
    current_deps = _deps_by_id(con, dep_ids)

    for item in before["milestones"]:
        if not _json_equal(current_ms.get(item["id"]), item):
            raise HTTPException(409, {"message": "Milestone changed before transaction applied", "id": item["id"]})
    for item in before["dependencies"]:
        if not _json_equal(current_deps.get(item["id"]), item):
            raise HTTPException(409, {"message": "Dependency changed before transaction applied", "id": item["id"]})

    before_ms_ids = _state_ids(before, "milestones")
    before_dep_ids = _state_ids(before, "dependencies")
    for item in after["milestones"]:
        if item["id"] not in before_ms_ids and item["id"] in current_ms:
            raise HTTPException(409, {"message": "Milestone already exists", "id": item["id"]})
    for item in after["dependencies"]:
        if item["id"] not in before_dep_ids and item["id"] in current_deps:
            raise HTTPException(409, {"message": "Dependency already exists", "id": item["id"]})

def _assert_final_state_valid(con, project_id: str, before: dict, after: dict):
    touched_ms = _state_ids(before, "milestones") | _state_ids(after, "milestones")
    touched_deps = _state_ids(before, "dependencies") | _state_ids(after, "dependencies")
    current_ms = {
        row["id"]: _ms(row)
        for row in con.execute(
            """
            SELECT m.* FROM milestones m
            JOIN notes n ON n.id = m.note_id
            WHERE n.project_id = ?
            """,
            (project_id,),
        ).fetchall()
    }
    final_ms = {
        mid: milestone
        for mid, milestone in current_ms.items()
        if mid not in touched_ms
    }
    final_deps = {
        row["id"]: _dep(row)
        for row in con.execute(
            """
            SELECT d.* FROM dependencies d
            JOIN milestones from_ms ON from_ms.id = d.from_id
            JOIN notes from_note ON from_note.id = from_ms.note_id
            JOIN milestones to_ms ON to_ms.id = d.to_id
            JOIN notes to_note ON to_note.id = to_ms.note_id
            WHERE from_note.project_id = ? AND to_note.project_id = ?
            """,
            (project_id, project_id),
        ).fetchall()
        if row["id"] not in touched_deps
    }
    final_ms.update({m["id"]: m for m in after["milestones"]})
    final_deps.update({d["id"]: d for d in after["dependencies"]})

    for milestone in final_ms.values():
        if milestone["startCol"] < 0:
            raise HTTPException(422, {"message": "Milestones must have a non-negative start", "id": milestone["id"]})
        if milestone["duration"] < MIN_MILESTONE_DURATION:
            raise HTTPException(422, {"message": f"Milestones must be at least {MIN_MILESTONE_DURATION} minutes long", "id": milestone["id"]})

    for milestone in after["milestones"]:
        before_milestone = current_ms.get(milestone["id"])
        if before_milestone is None or _schedule_fields_changed(before_milestone, milestone):
            _assert_milestone_scale_edit_allowed(before_milestone, milestone)

    touched_note_ids = {
        milestone["noteId"]
        for milestone in before["milestones"] + after["milestones"]
        if milestone.get("noteId")
    }
    _assert_note_milestone_scales_match(list(final_ms.values()), touched_note_ids)

    by_note = {}
    for milestone in final_ms.values():
        by_note.setdefault(milestone["noteId"], []).append(milestone)
    for note_id, note_milestones in by_note.items():
        if len(note_milestones) > 1:
            raise HTTPException(422, {
                "message": "A note can only contain one milestone",
                "type": "note_milestone_limit",
                "noteId": note_id,
                "milestoneIds": [m["id"] for m in note_milestones],
            })
    for lane_milestones in by_note.values():
        for i, first in enumerate(lane_milestones):
            for second in lane_milestones[i + 1:]:
                if first["startCol"] < second["startCol"] + second["duration"] and second["startCol"] < first["startCol"] + first["duration"]:
                    raise HTTPException(422, {
                        "message": "Milestones in the same note row cannot overlap",
                        "type": "overlap",
                        "milestoneIds": [first["id"], second["id"]],
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
                    "message": "Milestones in the same note row cannot pass each other",
                    "type": "overlap",
                    "milestoneIds": [first_id, second_id],
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

    for milestone in final_ms.values():
        milestone_scale = _planning_scale_for_milestone(milestone)
        deadline = deadlines.get((milestone["noteId"], milestone_scale))
        if (
            deadline is not None
            and milestone["startCol"] + milestone["duration"] > deadline["col"]
        ):
            raise HTTPException(422, {"message": "Milestone exceeds hard deadline", "type": "deadline", "id": milestone["id"]})

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

    inheritance_rows = [
        _inheritance(row)
        for row in con.execute(
            """
            SELECT ni.* FROM note_inheritance ni
            JOIN notes child ON child.id = ni.child_note_id
            JOIN notes parent ON parent.id = ni.parent_note_id
            WHERE child.project_id = ? AND parent.project_id = ?
            """,
            (project_id, project_id),
        ).fetchall()
    ]
    milestone_by_note = {}
    for milestone in final_ms.values():
        milestone_by_note[milestone["noteId"]] = milestone

    inherited_starts = {}
    inherited_deadlines = {}
    for item in inheritance_rows:
        child_ms = milestone_by_note.get(item["childNoteId"])
        parent_ms = milestone_by_note.get(item["parentNoteId"])
        if not child_ms or not parent_ms:
            continue
        child_scale = _planning_scale_for_milestone(child_ms)
        parent_scale = _planning_scale_for_milestone(parent_ms)
        if not _is_parent_scale_for_child(parent_scale, child_scale):
            raise HTTPException(422, {
                "message": "Inherited parent note must be exactly one planning scale broader than the child note",
                "type": "inheritance_scale_mismatch",
                "noteId": item["childNoteId"],
                "parentNoteId": item["parentNoteId"],
            })
        inherited_starts[item["childNoteId"]] = max(inherited_starts.get(item["childNoteId"], 0), parent_ms["startCol"])
        inherited_deadline = parent_ms["startCol"] + parent_ms["duration"]
        inherited_deadlines[item["childNoteId"]] = min(inherited_deadlines.get(item["childNoteId"], inherited_deadline), inherited_deadline)

    for milestone in final_ms.values():
        inherited_deadline = inherited_deadlines.get(milestone["noteId"])
        if inherited_deadline is not None and milestone["startCol"] + milestone["duration"] > inherited_deadline:
            raise HTTPException(422, {
                "message": "Milestone exceeds inherited hard deadline",
                "type": "inheritance_deadline",
                "id": milestone["id"],
                "noteId": milestone["noteId"],
            })

    for milestone in final_ms.values():
        milestone_scale = _planning_scale_for_milestone(milestone)
        es = earliest_starts.get((milestone["noteId"], milestone_scale))
        inherited_start = inherited_starts.get(milestone["noteId"])
        if (
            es is not None
            and milestone["startCol"] < es["col"]
        ):
            raise HTTPException(422, {"message": "Milestone violates earliest start date", "type": "earliest_start", "id": milestone["id"]})
        if inherited_start is not None and milestone["startCol"] < inherited_start:
            raise HTTPException(422, {
                "message": "Milestone violates inherited earliest start date",
                "type": "inheritance_earliest_start",
                "id": milestone["id"],
                "noteId": milestone["noteId"],
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
                "message": "A predecessor milestone must finish before its successor starts",
                "type": "dependency",
                "dependencyIds": [dep["id"]],
                "milestoneIds": [dep["fromId"], dep["toId"]],
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
    if before["milestones"] or after["milestones"]:
        return False

    before_deps = {d["id"]: d for d in before["dependencies"]}
    after_deps = {d["id"]: d for d in after["dependencies"]}
    if not before_deps or not (before_deps.keys() - after_deps.keys()):
        return False
    if not after_deps.keys() <= before_deps.keys():
        return False
    return all(_json_equal(before_deps[dep_id], dep) for dep_id, dep in after_deps.items())

def _apply_transaction_rows(con, before: dict, after: dict):
    before_ms = {m["id"]: m for m in before["milestones"]}
    after_ms = {m["id"]: m for m in after["milestones"]}
    before_deps = {d["id"]: d for d in before["dependencies"]}
    after_deps = {d["id"]: d for d in after["dependencies"]}

    for dep_id in before_deps.keys() - after_deps.keys():
        con.execute("DELETE FROM dependencies WHERE id = ?", (dep_id,))
    for ms_id in before_ms.keys() - after_ms.keys():
        con.execute("DELETE FROM dependencies WHERE from_id = ? OR to_id = ?", (ms_id, ms_id))
        con.execute("DELETE FROM milestones WHERE id = ?", (ms_id,))
    for m in after_ms.values():
        if m["id"] in before_ms:
            con.execute(
                "UPDATE milestones SET note_id = ?, start_col = ?, duration = ?, title = ?, color = ? WHERE id = ?",
                (m["noteId"], m["startCol"], m["duration"], m["title"], m["color"], m["id"]),
            )
        else:
            con.execute(
                "INSERT INTO milestones (id, note_id, start_col, duration, title, color) VALUES (?,?,?,?,?,?)",
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

def _assert_transaction_project_scope(con, project_id: str, before: dict, after: dict):
    for milestone in before["milestones"] + after["milestones"]:
        note_id = milestone.get("noteId")
        row = con.execute("SELECT project_id FROM notes WHERE id = ?", (note_id,)).fetchone()
        if not row or row["project_id"] != project_id:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Transaction milestone is outside this project")

    milestone_ids = {
        m["id"]
        for m in before["milestones"] + after["milestones"]
        if m.get("id")
    }
    dep_endpoint_ids = {
        endpoint
        for dep in before["dependencies"] + after["dependencies"]
        for endpoint in (dep.get("fromId"), dep.get("toId"))
        if endpoint
    }
    current_ms = _ms_by_id(con, milestone_ids | dep_endpoint_ids)
    after_ms = {m["id"]: m for m in after["milestones"] if m.get("id")}
    for dep in before["dependencies"] + after["dependencies"]:
        for endpoint in (dep.get("fromId"), dep.get("toId")):
            milestone = after_ms.get(endpoint) or current_ms.get(endpoint)
            if not milestone:
                continue
            row = con.execute("SELECT project_id FROM notes WHERE id = ?", (milestone["noteId"],)).fetchone()
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
    before = _normalize_tx_state(tx.get("before") or {})
    after = _normalize_tx_state(tx.get("after") or {})
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
        JOIN milestones from_ms ON from_ms.id = d.from_id
        JOIN notes from_note ON from_note.id = from_ms.note_id
        JOIN milestones to_ms ON to_ms.id = d.to_id
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
        from_scale = _planning_scale_for_milestone({"startCol": row["from_start"], "duration": row["from_duration"]})
        to_scale = _planning_scale_for_milestone({"startCol": row["to_start"], "duration": row["to_duration"]})
        base = {
            "dependencyId": row["dep_id"],
            "reason": row["reason"] or "",
            "from": {
                "milestoneId": row["from_id"],
                "milestoneTitle": row["from_title"] or "",
                "noteId": row["from_note_id"],
                "noteTitle": row["from_note_title"],
                "startCol": row["from_start"],
                "duration": row["from_duration"],
                "endCol": from_end,
                "scale": from_scale,
            },
            "to": {
                "milestoneId": row["to_id"],
                "milestoneTitle": row["to_title"] or "",
                "noteId": row["to_note_id"],
                "noteTitle": row["to_note_title"],
                "startCol": row["to_start"],
                "duration": row["to_duration"],
                "endCol": to_end,
                "scale": to_scale,
            },
        }
        if from_scale != to_scale:
            violations.append({
                **base,
                "type": "scale_mismatch",
                "message": "Dependency scale mismatch",
                "fromScale": from_scale,
                "toScale": to_scale,
            })
        if from_end > to_start:
            violations.append({
                **base,
                "type": "dependency",
                "message": "A predecessor milestone must finish before its successor starts",
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
            rows = con.execute("SELECT * FROM projects ORDER BY created_at").fetchall()
        else:
            rows = con.execute("SELECT * FROM projects WHERE user_id = ? ORDER BY created_at", (user["id"],)).fetchall()
    return [_project(r) for r in rows]

@app.post("/projects", status_code=201)
def create_project(data: ProjectIn, user: dict = Depends(current_user)):
    pid = data.id or str(uuid.uuid4())
    name = data.name.strip() or 'Untitled'
    with _db() as con:
        if con.execute("SELECT id FROM projects WHERE id = ?", (pid,)).fetchone():
            raise HTTPException(409, "Project already exists")
        con.execute(
            "INSERT INTO projects (id, user_id, name, description, resize_warn_order_threshold, resize_block_order_threshold, resize_scale_crossing_warning_enabled) VALUES (?, ?, ?, ?, 2, 2, 1)",
            (pid, user["id"], name, data.description or ''),
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
        if data.resizeWarnOrderThreshold is not None:
            fields.append("resize_warn_order_threshold = ?"); values.append(max(0, float(data.resizeWarnOrderThreshold)))
        if data.resizeBlockOrderThreshold is not None:
            fields.append("resize_block_order_threshold = ?"); values.append(max(0, float(data.resizeBlockOrderThreshold)))
        if data.resizeScaleCrossingWarningEnabled is not None:
            fields.append("resize_scale_crossing_warning_enabled = ?"); values.append(int(bool(data.resizeScaleCrossingWarningEnabled)))
        if fields:
            con.execute(f"UPDATE projects SET {', '.join(fields)} WHERE id = ?", (*values, project_id))
        row = con.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
    return _project(row)

@app.get("/projects/{project_id}/stats")
def get_project_stats(project_id: str, user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    with _db() as con:
        notes = con.execute(
            "SELECT COUNT(*) FROM notes WHERE project_id = ?", (project_id,)
        ).fetchone()[0]
        milestones = con.execute(
            "SELECT COUNT(*) FROM milestones WHERE note_id IN (SELECT id FROM notes WHERE project_id = ?)",
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
                SELECT id FROM milestones WHERE note_id IN (SELECT id FROM notes WHERE project_id = ?)
            )""",
            (project_id,)
        ).fetchone()[0]
        perspectives = con.execute(
            """SELECT
                (SELECT COUNT(*) FROM schedule_perspectives WHERE project_id = ?) +
                (SELECT COUNT(*) FROM classification_perspectives WHERE project_id = ?)""",
            (project_id, project_id)
        ).fetchone()[0]
    return {
        "notes": notes,
        "milestones": milestones,
        "dimensions": dimensions,
        "categories": categories,
        "dependencies": dependencies,
        "perspectives": perspectives,
    }

@app.delete("/projects/{project_id}", status_code=204)
def delete_project(project_id: str, user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    with _db() as con:
        # Cascade: notes and their milestones/deadlines/assignments
        note_rows = con.execute("SELECT id FROM notes WHERE project_id = ?", (project_id,)).fetchall()
        note_ids = [r["id"] for r in note_rows]
        if note_ids:
            ph = ','.join('?' * len(note_ids))
            ms_rows = con.execute(f"SELECT id FROM milestones WHERE note_id IN ({ph})", note_ids).fetchall()
            ms_ids = [r["id"] for r in ms_rows]
            if ms_ids:
                mph = ','.join('?' * len(ms_ids))
                con.execute(f"DELETE FROM dependencies WHERE from_id IN ({mph}) OR to_id IN ({mph})", ms_ids + ms_ids)
                con.execute(f"DELETE FROM persona_milestone_assignments WHERE milestone_id IN ({mph})", ms_ids)
                con.execute(f"DELETE FROM milestones WHERE id IN ({mph})", ms_ids)
            con.execute(f"DELETE FROM deadlines WHERE note_id IN ({ph})", note_ids)
            con.execute(f"DELETE FROM earliest_starts WHERE note_id IN ({ph})", note_ids)
            con.execute(f"DELETE FROM note_inheritance WHERE child_note_id IN ({ph}) OR parent_note_id IN ({ph})", note_ids + note_ids)
            con.execute(f"DELETE FROM assignments WHERE note_id IN ({ph})", note_ids)
            con.execute(f"DELETE FROM notes WHERE id IN ({ph})", note_ids)
        # Cascade: dimensions → categories → assignments
        dim_rows = con.execute("SELECT id FROM dimensions WHERE project_id = ?", (project_id,)).fetchall()
        dim_ids = [r["id"] for r in dim_rows]
        if dim_ids:
            ph = ','.join('?' * len(dim_ids))
            con.execute(f"DELETE FROM assignments WHERE dimension_id IN ({ph})", dim_ids)
            con.execute(f"DELETE FROM persona_assignments WHERE dimension_id IN ({ph})", dim_ids)
            con.execute(f"DELETE FROM categories WHERE dimension_id IN ({ph})", dim_ids)
            con.execute(f"DELETE FROM dimensions WHERE id IN ({ph})", dim_ids)
        con.execute("DELETE FROM persona_assignments WHERE persona_id IN (SELECT id FROM personas WHERE project_id = ?)", (project_id,))
        con.execute("DELETE FROM personas WHERE project_id = ?", (project_id,))
        con.execute("DELETE FROM saved_filters WHERE project_id = ?", (project_id,))
        con.execute("DELETE FROM schedule_perspectives WHERE project_id = ?", (project_id,))
        con.execute("DELETE FROM classification_perspectives WHERE project_id = ?", (project_id,))
        con.execute("DELETE FROM transaction_history WHERE project_id = ?", (project_id,))
        con.execute("DELETE FROM projects WHERE id = ?", (project_id,))


# ── Notes (notes) ─────────────────────────────────────────────────────────────
@app.get("/notes")
def list_notes(project_id: str = Query(default='default'), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    with _db() as con:
        rows = con.execute(
            "SELECT * FROM notes WHERE project_id = ? ORDER BY order_idx", (project_id,)
        ).fetchall()
    return [_note(r) for r in rows]

@app.post("/notes", status_code=201)
def create_note(data: NoteIn, project_id: str = Query(default='default'), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    pid = data.id or str(uuid.uuid4())
    with _db() as con:
        if con.execute("SELECT id FROM notes WHERE id = ?", (pid,)).fetchone():
            raise HTTPException(409, "Note already exists")
        max_ord = con.execute(
            "SELECT COALESCE(MAX(order_idx), -1) FROM notes WHERE project_id = ?", (project_id,)
        ).fetchone()[0]
        con.execute(
            "INSERT INTO notes (id, project_id, html, title, collapsed, order_idx) VALUES (?, ?, ?, ?, ?, ?)",
            (pid, project_id, data.html, data.title, int(data.collapsed), max_ord + 1),
        )
    return {"id": pid, "html": data.html, "title": data.title, "collapsed": data.collapsed}

@app.patch("/notes/{note_id}")
def update_note(note_id: str, data: NotePatch, user: dict = Depends(current_user)):
    with _db() as con:
        assert_project_access(_project_id_for_note(con, note_id), user)
        fields, values = [], []
        if data.html is not None:      fields.append("html = ?");      values.append(data.html)
        if data.title is not None:     fields.append("title = ?");     values.append(data.title)
        if data.collapsed is not None: fields.append("collapsed = ?"); values.append(int(data.collapsed))
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
            "INSERT INTO notes (id, project_id, html, title, collapsed, order_idx) VALUES (?, ?, ?, ?, ?, ?)",
            (new_note_id, project_id, source["html"], source["title"], source["collapsed"], source_order + 1),
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

        source_milestone_ids = []
        milestone_id_map = {}
        for row in con.execute("SELECT * FROM milestones WHERE note_id = ? ORDER BY start_col, rowid", (note_id,)).fetchall():
            new_ms_id = str(uuid.uuid4())
            source_milestone_ids.append(row["id"])
            milestone_id_map[row["id"]] = new_ms_id
            con.execute(
                "INSERT INTO milestones (id, note_id, start_col, duration, title, color) VALUES (?, ?, ?, ?, ?, ?)",
                (new_ms_id, new_note_id, row["start_col"], row["duration"], row["title"], row["color"]),
            )
            for pma in con.execute("SELECT persona_id FROM persona_milestone_assignments WHERE milestone_id = ?", (row["id"],)).fetchall():
                con.execute(
                    "INSERT OR IGNORE INTO persona_milestone_assignments (persona_id, milestone_id) VALUES (?, ?)",
                    (pma["persona_id"], new_ms_id),
                )

        if source_milestone_ids:
            ph = ",".join("?" for _ in source_milestone_ids)
            dep_rows = con.execute(
                f"SELECT * FROM dependencies WHERE from_id IN ({ph}) OR to_id IN ({ph})",
                source_milestone_ids + source_milestone_ids,
            ).fetchall()
            for dep in dep_rows:
                new_from_id = milestone_id_map.get(dep["from_id"], dep["from_id"])
                new_to_id = milestone_id_map.get(dep["to_id"], dep["to_id"])
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

        inheritance = con.execute("SELECT parent_note_id FROM note_inheritance WHERE child_note_id = ?", (note_id,)).fetchone()
        if inheritance:
            con.execute(
                "INSERT INTO note_inheritance (child_note_id, parent_note_id) VALUES (?, ?)",
                (new_note_id, inheritance["parent_note_id"]),
            )

        note = con.execute("SELECT * FROM notes WHERE id = ?", (new_note_id,)).fetchone()
        milestones = con.execute("SELECT * FROM milestones WHERE note_id = ? ORDER BY start_col", (new_note_id,)).fetchall()
        assignments = con.execute("SELECT * FROM assignments WHERE note_id = ?", (new_note_id,)).fetchall()
        deadlines = con.execute("SELECT * FROM deadlines WHERE note_id = ?", (new_note_id,)).fetchall()
        earliest_starts = con.execute("SELECT * FROM earliest_starts WHERE note_id = ?", (new_note_id,)).fetchall()
        inheritance_rows = con.execute("SELECT * FROM note_inheritance WHERE child_note_id = ?", (new_note_id,)).fetchall()
        dependencies = con.execute(
            """
            SELECT * FROM dependencies
            WHERE from_id IN (SELECT id FROM milestones WHERE note_id = ?)
               OR to_id IN (SELECT id FROM milestones WHERE note_id = ?)
            """,
            (new_note_id, new_note_id),
        ).fetchall()

    return {
        "note": _note(note),
        "milestones": [_ms(row) for row in milestones],
        "dependencies": [_dep(row) for row in dependencies],
        "assignments": [_assign(row) for row in assignments],
        "deadlines": [_dl(row) for row in deadlines],
        "earliestStarts": [_es(row) for row in earliest_starts],
        "noteInheritance": [_inheritance(row) for row in inheritance_rows],
    }

@app.delete("/notes/{note_id}", status_code=204)
def delete_note(note_id: str, user: dict = Depends(current_user)):
    with _db() as con:
        assert_project_access(_project_id_for_note(con, note_id), user)
        ms_rows = con.execute("SELECT id FROM milestones WHERE note_id = ?", (note_id,)).fetchall()
        ms_ids = [r["id"] for r in ms_rows]
        if ms_ids:
            ph = ','.join('?' * len(ms_ids))
            con.execute(f"DELETE FROM persona_milestone_assignments WHERE milestone_id IN ({ph})", ms_ids)
        con.execute("DELETE FROM persona_note_assignments WHERE note_id = ?", (note_id,))
        con.execute("DELETE FROM note_inheritance WHERE child_note_id = ? OR parent_note_id = ?", (note_id, note_id))
        con.execute("DELETE FROM notes WHERE id = ?", (note_id,))

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
def _single_milestone_for_note(con, note_id: str) -> dict | None:
    rows = con.execute("SELECT * FROM milestones WHERE note_id = ? ORDER BY start_col, rowid", (note_id,)).fetchall()
    if len(rows) > 1:
        raise HTTPException(422, {"message": "A note can only contain one milestone", "type": "note_milestone_limit", "noteId": note_id})
    return _ms(rows[0]) if rows else None

def _assert_valid_note_inheritance(con, child_note_id: str, parent_note_id: str):
    if child_note_id == parent_note_id:
        raise HTTPException(422, {"message": "A note cannot inherit from itself", "type": "inheritance_cycle"})
    child_project = _project_id_for_note(con, child_note_id)
    parent_project = _project_id_for_note(con, parent_note_id)
    if child_project != parent_project:
        raise HTTPException(400, "Cannot inherit across projects")

    current = parent_note_id
    seen = {child_note_id}
    while current:
        if current in seen:
            raise HTTPException(422, {"message": "Inheritance cannot create a cycle", "type": "inheritance_cycle"})
        seen.add(current)
        row = con.execute("SELECT parent_note_id FROM note_inheritance WHERE child_note_id = ?", (current,)).fetchone()
        current = row["parent_note_id"] if row else None

    child_ms = _single_milestone_for_note(con, child_note_id)
    parent_ms = _single_milestone_for_note(con, parent_note_id)
    if not child_ms or not parent_ms:
        raise HTTPException(422, {
            "message": "Both child and parent notes need one milestone before inheritance can be assigned",
            "type": "inheritance_missing_milestone",
        })
    child_scale = _planning_scale_for_milestone(child_ms)
    parent_scale = _planning_scale_for_milestone(parent_ms)
    if not _is_parent_scale_for_child(parent_scale, child_scale):
        raise HTTPException(422, {
            "message": "Inherited parent note must be exactly one planning scale broader than the child note",
            "type": "inheritance_scale_mismatch",
            "childScale": child_scale,
            "parentScale": parent_scale,
        })
    parent_start = parent_ms["startCol"]
    parent_end = parent_ms["startCol"] + parent_ms["duration"]
    if child_ms["startCol"] < parent_start or child_ms["startCol"] + child_ms["duration"] > parent_end:
        raise HTTPException(422, {
            "message": "Child milestone must fit inside the parent milestone window",
            "type": "inheritance_window",
            "milestoneIds": [child_ms["id"], parent_ms["id"]],
        })

@app.get("/note-inheritance")
def list_note_inheritance(project_id: str = Query(default='default'), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    with _db() as con:
        rows = con.execute(
            """
            SELECT ni.* FROM note_inheritance ni
            JOIN notes child ON child.id = ni.child_note_id
            JOIN notes parent ON parent.id = ni.parent_note_id
            WHERE child.project_id = ? AND parent.project_id = ?
            ORDER BY child.order_idx, parent.order_idx
            """,
            (project_id, project_id),
        ).fetchall()
    return [_inheritance(row) for row in rows]

@app.put("/notes/{child_note_id}/inheritance")
def set_note_inheritance(child_note_id: str, data: NoteInheritanceIn, user: dict = Depends(current_user)):
    with _db() as con:
        assert_project_access(_project_id_for_note(con, child_note_id), user)
        _assert_valid_note_inheritance(con, child_note_id, data.parentNoteId)
        con.execute(
            "INSERT OR REPLACE INTO note_inheritance (child_note_id, parent_note_id) VALUES (?, ?)",
            (child_note_id, data.parentNoteId),
        )
        row = con.execute("SELECT * FROM note_inheritance WHERE child_note_id = ?", (child_note_id,)).fetchone()
    return _inheritance(row)

@app.delete("/notes/{child_note_id}/inheritance", status_code=204)
def remove_note_inheritance(child_note_id: str, user: dict = Depends(current_user)):
    with _db() as con:
        assert_project_access(_project_id_for_note(con, child_note_id), user)
        con.execute("DELETE FROM note_inheritance WHERE child_note_id = ?", (child_note_id,))


# ── Dimensions ────────────────────────────────────────────────────────────────
@app.get("/dimensions")
def list_dimensions(project_id: str = Query(default='default'), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    with _db() as con:
        rows = con.execute(
            "SELECT * FROM dimensions WHERE project_id = ? ORDER BY order_idx, rowid", (project_id,)
        ).fetchall()
    return [dict(r) for r in rows]

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
            con.execute(
                "UPDATE dimensions SET order_idx = ? WHERE id = ? AND project_id = ?",
                (i, dim_id, project_id)
            )
    return {"ok": True}

@app.patch("/dimensions/{dim_id}")
def update_dimension(dim_id: str, data: DimensionPatch, user: dict = Depends(current_user)):
    with _db() as con:
        assert_project_access(_project_id_for_dimension(con, dim_id), user)
        fields, values = [], []
        if data.name is not None:
            fields.append("name = ?")
            values.append(data.name.strip() or "Untitled dimension")
        if fields:
            con.execute(f"UPDATE dimensions SET {', '.join(fields)} WHERE id = ?", (*values, dim_id))
        row = con.execute("SELECT * FROM dimensions WHERE id = ?", (dim_id,)).fetchone()
    return dict(row)

@app.delete("/dimensions/{dim_id}", status_code=204)
def delete_dimension(dim_id: str, user: dict = Depends(current_user)):
    with _db() as con:
        assert_project_access(_project_id_for_dimension(con, dim_id), user)
        con.execute("DELETE FROM assignments WHERE dimension_id = ?", (dim_id,))
        con.execute("DELETE FROM persona_assignments WHERE dimension_id = ?", (dim_id,))
        con.execute("DELETE FROM categories WHERE dimension_id = ?", (dim_id,))
        con.execute("DELETE FROM dimensions WHERE id = ?", (dim_id,))


# ── Categories ────────────────────────────────────────────────────────────────
@app.get("/categories")
def list_all_categories(project_id: str = Query(default='default'), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    with _db() as con:
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
        con.execute("DELETE FROM persona_milestone_assignments WHERE persona_id = ?", (persona_id,))
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
                FROM persona_milestone_assignments pma
                JOIN milestones m ON m.id = pma.milestone_id
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
                FROM persona_milestone_assignments pma
                JOIN milestones m ON m.id = pma.milestone_id
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


@app.get("/persona-milestone-assignments")
def list_persona_milestone_assignments(project_id: str = Query(default='default'), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    with _db() as con:
        rows = con.execute(
            "SELECT pma.persona_id, pma.milestone_id FROM persona_milestone_assignments pma "
            "JOIN milestones m ON m.id = pma.milestone_id "
            "JOIN notes n ON n.id = m.note_id WHERE n.project_id = ?",
            (project_id,),
        ).fetchall()
    return [{"personaId": r["persona_id"], "milestoneId": r["milestone_id"]} for r in rows]

@app.put("/personas/{persona_id}/milestone-assign/{milestone_id}", status_code=204)
def assign_persona_to_milestone(persona_id: str, milestone_id: str, user: dict = Depends(current_user)):
    with _db() as con:
        ms_row = con.execute(
            "SELECT n.project_id FROM milestones m JOIN notes n ON n.id = m.note_id WHERE m.id = ?",
            (milestone_id,),
        ).fetchone()
        if not ms_row:
            raise HTTPException(404, "Milestone not found")
        assert_project_access(ms_row["project_id"], user)
        persona_row = con.execute("SELECT project_id FROM personas WHERE id = ?", (persona_id,)).fetchone()
        if not persona_row:
            raise HTTPException(404, "Persona not found")
        if persona_row["project_id"] != ms_row["project_id"]:
            raise HTTPException(400, "Cannot assign persona across projects")
        con.execute(
            "INSERT OR IGNORE INTO persona_milestone_assignments (persona_id, milestone_id) VALUES (?, ?)",
            (persona_id, milestone_id),
        )
    return Response(status_code=204)

@app.delete("/personas/{persona_id}/milestone-assign/{milestone_id}", status_code=204)
def unassign_persona_from_milestone(persona_id: str, milestone_id: str, user: dict = Depends(current_user)):
    with _db() as con:
        ms_row = con.execute(
            "SELECT n.project_id FROM milestones m JOIN notes n ON n.id = m.note_id WHERE m.id = ?",
            (milestone_id,),
        ).fetchone()
        if not ms_row:
            raise HTTPException(404, "Milestone not found")
        assert_project_access(ms_row["project_id"], user)
        con.execute(
            "DELETE FROM persona_milestone_assignments WHERE persona_id = ? AND milestone_id = ?",
            (persona_id, milestone_id),
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
def list_schedule_perspectives(project_id: str = Query(default='default'), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    with _db() as con:
        rows = con.execute(
            "SELECT * FROM schedule_perspectives WHERE project_id = ? ORDER BY name COLLATE NOCASE", (project_id,)
        ).fetchall()
    return [_schedule_perspective(r) for r in rows]

@app.post("/schedule-perspectives", status_code=201)
def create_schedule_perspective(data: SchedulePerspectiveIn, project_id: str = Query(default='default'), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    pid = data.id or str(uuid.uuid4())
    name = data.name.strip() or "Untitled perspective"
    with _db() as con:
        if con.execute("SELECT id FROM schedule_perspectives WHERE id = ?", (pid,)).fetchone():
            raise HTTPException(409, "Perspective already exists")
        con.execute(
            "INSERT INTO schedule_perspectives (id, project_id, name, state_json) VALUES (?, ?, ?, ?)",
            (pid, project_id, name, json.dumps(data.state or {})),
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
def list_classification_perspectives(project_id: str = Query(default='default'), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    with _db() as con:
        rows = con.execute(
            "SELECT * FROM classification_perspectives WHERE project_id = ? ORDER BY name COLLATE NOCASE", (project_id,)
        ).fetchall()
    return [_classification_perspective(r) for r in rows]

@app.post("/classification-perspectives", status_code=201)
def create_classification_perspective(data: ClassificationPerspectiveIn, project_id: str = Query(default='default'), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    pid = data.id or str(uuid.uuid4())
    name = data.name.strip() or "Untitled perspective"
    with _db() as con:
        if con.execute("SELECT id FROM classification_perspectives WHERE id = ?", (pid,)).fetchone():
            raise HTTPException(409, "Perspective already exists")
        con.execute(
            "INSERT INTO classification_perspectives (id, project_id, name, state_json) VALUES (?, ?, ?, ?)",
            (pid, project_id, name, json.dumps(data.state or {})),
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


# ── Milestones ────────────────────────────────────────────────────────────────
@app.get("/milestones")
def list_milestones(project_id: str = Query(default='default'), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    with _db() as con:
        rows = con.execute(
            """SELECT * FROM milestones
            WHERE note_id IN (SELECT id FROM notes WHERE project_id = ?)
            ORDER BY start_col""",
            (project_id,)
        ).fetchall()
    return [_ms(r) for r in rows]

@app.post("/milestones", status_code=201)
def create_milestone(data: MilestoneIn, user: dict = Depends(current_user)):
    mid = data.id or str(uuid.uuid4())
    duration = _milestone_duration_value(data.duration)
    milestone = {
        "id": mid,
        "noteId": data.noteId,
        "startCol": data.startCol,
        "duration": duration,
        "title": data.title,
        "color": data.color,
    }
    _assert_milestone_scale_edit_allowed(None, milestone)
    with _db() as con:
        project_id = _project_id_for_note(con, data.noteId)
        assert_project_access(project_id, user)
        _assert_final_state_valid(con, project_id, {"milestones": [], "dependencies": []}, {"milestones": [milestone], "dependencies": []})
        con.execute(
            "INSERT INTO milestones (id, note_id, start_col, duration, title, color) VALUES (?,?,?,?,?,?)",
            (mid, data.noteId, data.startCol, duration, data.title, data.color),
        )
    return milestone

# Registered before /{ms_id} so "batch" is not captured as a path param
@app.put("/milestones/batch")
def batch_update_milestones(data: MilestoneBatch, user: dict = Depends(current_user)):
    with _db() as con:
        for u in data.updates:
            mid = u.get("id")
            if not mid:
                continue
            project_id = _project_id_for_milestone(con, mid)
            assert_project_access(project_id, user)
            row = con.execute("SELECT * FROM milestones WHERE id = ?", (mid,)).fetchone()
            before = _ms(row)
            after = {**before}
            fields, values = [], []
            if "startCol" in u:
                after["startCol"] = int(u["startCol"])
                fields.append("start_col = ?"); values.append(after["startCol"])
            if "duration" in u:
                after["duration"] = _milestone_duration_value(u["duration"])
                fields.append("duration = ?");  values.append(after["duration"])
            if "color"    in u: fields.append("color = ?");     values.append(u["color"])
            if "title"    in u: fields.append("title = ?");     values.append(u["title"])
            if _schedule_fields_changed(before, after):
                _assert_milestone_scale_edit_allowed(before, after)
                _assert_final_state_valid(con, project_id, {"milestones": [before], "dependencies": []}, {"milestones": [after], "dependencies": []})
            if fields:
                con.execute(f"UPDATE milestones SET {', '.join(fields)} WHERE id = ?", (*values, mid))
    return {"ok": True}

@app.patch("/milestones/{ms_id}")
def update_milestone(ms_id: str, data: MilestonePatch, user: dict = Depends(current_user)):
    with _db() as con:
        project_id = _project_id_for_milestone(con, ms_id)
        assert_project_access(project_id, user)
        row = con.execute("SELECT * FROM milestones WHERE id = ?", (ms_id,)).fetchone()
        before = _ms(row)
        after = {**before}
        fields, values = [], []
        if data.startCol is not None:
            after["startCol"] = data.startCol
            fields.append("start_col = ?"); values.append(data.startCol)
        if data.duration  is not None:
            after["duration"] = _milestone_duration_value(data.duration)
            fields.append("duration = ?");  values.append(after["duration"])
        if data.title     is not None: fields.append("title = ?");     values.append(data.title)
        if data.color     is not None: fields.append("color = ?");     values.append(data.color)
        if _schedule_fields_changed(before, after):
            _assert_milestone_scale_edit_allowed(before, after)
            _assert_final_state_valid(con, project_id, {"milestones": [before], "dependencies": []}, {"milestones": [after], "dependencies": []})
        if fields:
            con.execute(f"UPDATE milestones SET {', '.join(fields)} WHERE id = ?", (*values, ms_id))
        row = con.execute("SELECT * FROM milestones WHERE id = ?", (ms_id,)).fetchone()
    return _ms(row)

@app.delete("/milestones/{ms_id}", status_code=204)
def delete_milestone(ms_id: str, user: dict = Depends(current_user)):
    with _db() as con:
        assert_project_access(_project_id_for_milestone(con, ms_id), user)
        con.execute("DELETE FROM persona_milestone_assignments WHERE milestone_id = ?", (ms_id,))
        con.execute("DELETE FROM milestones WHERE id = ?", (ms_id,))


# ── Dependencies ──────────────────────────────────────────────────────────────
@app.get("/dependencies")
def list_dependencies(project_id: str = Query(default='default'), user: dict = Depends(current_user)):
    assert_project_access(project_id, user)
    with _db() as con:
        rows = con.execute(
            """SELECT * FROM dependencies WHERE from_id IN (
                SELECT id FROM milestones WHERE note_id IN (SELECT id FROM notes WHERE project_id = ?)
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
        from_project_id = _project_id_for_milestone(con, data.fromId)
        to_project_id = _project_id_for_milestone(con, data.toId)
        if from_project_id != to_project_id:
            raise HTTPException(400, "Dependency endpoints must belong to the same project")
        assert_project_access(from_project_id, user)
        milestones = _ms_by_id(con, {data.fromId, data.toId})
        scale_mismatch = _dependency_scale_mismatch(
            {"id": did, "fromId": data.fromId, "toId": data.toId},
            milestones,
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
            "SELECT * FROM milestones WHERE note_id = ?",
            (note_id,),
        ).fetchall()
        ms_scales = {_planning_scale_for_milestone(_ms(row)) for row in blocking}
        if ms_scales and scale not in ms_scales:
            row_scale = next(iter(ms_scales))
            raise HTTPException(422, {
                "message": f"This row contains {row_scale}-scale milestones. Switch to the {row_scale} view to set a deadline here.",
                "type": "deadline_scale_mismatch",
            })
        for row in blocking:
            milestone = _ms(row)
            if (
                _planning_scale_for_milestone(milestone) == scale
                and milestone["startCol"] + milestone["duration"] > data.col
            ):
                raise HTTPException(422, {
                    "message": "Hard deadline would conflict with an existing milestone on the same planning scale",
                    "type": "deadline",
                    "id": milestone["id"],
                })
        existing = con.execute("SELECT id FROM deadlines WHERE note_id = ?", (note_id,)).fetchone()
        if existing:
            con.execute("UPDATE deadlines SET col = ?, scale = ? WHERE note_id = ?", (data.col, scale, note_id))
        else:
            did = str(uuid.uuid4())
            con.execute("INSERT INTO deadlines (id, note_id, col, scale) VALUES (?, ?, ?, ?)", (did, note_id, data.col, scale))
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
            "SELECT * FROM milestones WHERE note_id = ?",
            (note_id,),
        ).fetchall()
        ms_scales = {_planning_scale_for_milestone(_ms(row)) for row in blocking}
        if ms_scales and scale not in ms_scales:
            row_scale = next(iter(ms_scales))
            raise HTTPException(422, {
                "message": f"This row contains {row_scale}-scale milestones. Switch to the {row_scale} view to set an earliest start here.",
                "type": "earliest_start_scale_mismatch",
            })
        for row in blocking:
            milestone = _ms(row)
            if (
                _planning_scale_for_milestone(milestone) == scale
                and milestone["startCol"] < data.col
            ):
                raise HTTPException(422, {
                    "message": "Earliest start date would conflict with an existing milestone that starts before it",
                    "type": "earliest_start",
                    "id": milestone["id"],
                })
        existing = con.execute("SELECT id FROM earliest_starts WHERE note_id = ?", (note_id,)).fetchone()
        if existing:
            con.execute("UPDATE earliest_starts SET col = ?, scale = ? WHERE note_id = ?", (data.col, scale, note_id))
        else:
            eid = str(uuid.uuid4())
            con.execute("INSERT INTO earliest_starts (id, note_id, col, scale) VALUES (?, ?, ?, ?)", (eid, note_id, data.col, scale))
        row = con.execute("SELECT * FROM earliest_starts WHERE note_id = ?", (note_id,)).fetchone()
    return _es(row)

@app.delete("/earliest-starts/{note_id}", status_code=204)
def remove_earliest_start(note_id: str, user: dict = Depends(current_user)):
    with _db() as con:
        assert_project_access(_project_id_for_note(con, note_id), user)
        con.execute("DELETE FROM earliest_starts WHERE note_id = ?", (note_id,))


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
            transaction_history = con.execute(f"SELECT * FROM transaction_history WHERE project_id IN ({project_ph})", project_ids).fetchall()
        else:
            notes = dimensions = saved_filters = schedule_perspectives = classification_perspectives = transaction_history = []

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
            milestones = con.execute(f"SELECT * FROM milestones WHERE note_id IN ({note_ph})", note_ids).fetchall()
            deadlines = con.execute(f"SELECT * FROM deadlines WHERE note_id IN ({note_ph})", note_ids).fetchall()
            earliest_starts = con.execute(f"SELECT * FROM earliest_starts WHERE note_id IN ({note_ph})", note_ids).fetchall()
            note_inheritance = con.execute(
                f"SELECT * FROM note_inheritance WHERE child_note_id IN ({note_ph}) OR parent_note_id IN ({note_ph})",
                note_ids + note_ids,
            ).fetchall()
        else:
            milestones = deadlines = earliest_starts = note_inheritance = []

        milestone_ids = [row["id"] for row in milestones]
        if milestone_ids:
            ms_ph = ','.join('?' for _ in milestone_ids)
            dependencies = con.execute(
                f"SELECT * FROM dependencies WHERE from_id IN ({ms_ph}) OR to_id IN ({ms_ph})",
                milestone_ids + milestone_ids,
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
                "milestones":                 rows(milestones),
                "dependencies":               rows(dependencies),
                "deadlines":                  rows(deadlines),
                "earliest_starts":            rows(earliest_starts),
                "note_inheritance":           rows(note_inheritance),
                "saved_filters":              rows(saved_filters,              ("selections_json",)),
                "schedule_perspectives":      rows(schedule_perspectives,      ("state_json",)),
                "classification_perspectives": rows(classification_perspectives, ("state_json",)),
                "transaction_history":        rows(transaction_history,        ("transaction_json", "before_json", "after_json")),
            },
        }
