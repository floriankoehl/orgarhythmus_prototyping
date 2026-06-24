import json
import sqlite3
import uuid
from contextlib import contextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

DB_PATH = "goals.db"

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5174"],
    allow_methods=["*"],
    allow_headers=["*"],
)


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
            CREATE TABLE IF NOT EXISTS pages (
                id        TEXT PRIMARY KEY,
                html      TEXT NOT NULL DEFAULT '',
                title     TEXT NOT NULL DEFAULT 'Untitled',
                collapsed INTEGER NOT NULL DEFAULT 0,
                order_idx INTEGER NOT NULL DEFAULT 0
            )
        """)
        con.execute("""
            CREATE TABLE IF NOT EXISTS dimensions (
                id   TEXT PRIMARY KEY,
                name TEXT NOT NULL
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
                goal_id      TEXT NOT NULL,
                dimension_id TEXT NOT NULL,
                category_id  TEXT NOT NULL,
                order_idx    INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (goal_id, dimension_id)
            )
        """)
        con.execute("""
            CREATE TABLE IF NOT EXISTS milestones (
                id         TEXT PRIMARY KEY,
                goal_id    TEXT NOT NULL,
                start_col  INTEGER NOT NULL,
                duration   INTEGER NOT NULL DEFAULT 1,
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
                goal_id TEXT NOT NULL UNIQUE,
                col     INTEGER NOT NULL
            )
        """)
        con.execute("""
            CREATE TABLE IF NOT EXISTS saved_filters (
                id              TEXT PRIMARY KEY,
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
                name       TEXT NOT NULL,
                state_json TEXT NOT NULL DEFAULT '{}'
            )
        """)
        con.execute("""
            CREATE TABLE IF NOT EXISTS classification_perspectives (
                id         TEXT PRIMARY KEY,
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

_init_db()


def _migrate():
    with _db() as con:
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
                "SELECT goal_id, dimension_id, category_id FROM assignments ORDER BY dimension_id, category_id, rowid"
            ).fetchall()
            counters = {}
            for row in rows:
                key = (row["dimension_id"], row["category_id"])
                idx = counters.get(key, 0)
                counters[key] = idx + 1
                con.execute(
                    "UPDATE assignments SET order_idx = ? WHERE goal_id = ? AND dimension_id = ?",
                    (idx, row["goal_id"], row["dimension_id"]),
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

_migrate()


def _seed_defaults():
    defaults = [
        ("Group",    [("All",    "#94a3b8")]),
        ("Priority", [("High",   "#ef4444"), ("Medium", "#eab308"), ("Low", "#94a3b8")]),
    ]
    with _db() as con:
        for dim_name, cats in defaults:
            if con.execute("SELECT id FROM dimensions WHERE name = ?", (dim_name,)).fetchone():
                continue
            dim_id = str(uuid.uuid4())
            con.execute("INSERT INTO dimensions (id, name) VALUES (?, ?)", (dim_id, dim_name))
            for cat_name, color in cats:
                con.execute(
                    "INSERT INTO categories (id, dimension_id, name, color) VALUES (?, ?, ?, ?)",
                    (str(uuid.uuid4()), dim_id, cat_name, color),
                )

_seed_defaults()


# ── Schemas ───────────────────────────────────────────────────────────────────
class PageIn(BaseModel):
    id: Optional[str] = None
    html: str = ""
    title: str = "Untitled"
    collapsed: bool = False

class PagePatch(BaseModel):
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
    goal_id: str
    start_col: int
    duration: int = 1
    title: str = ''
    color: str = '#1a73e8'

class MilestonePatch(BaseModel):
    start_col: Optional[int] = None
    duration: Optional[int] = None
    title: Optional[str] = None
    color: Optional[str] = None

class MilestoneBatch(BaseModel):
    updates: list[dict]

class DependencyIn(BaseModel):
    id: Optional[str] = None
    from_id: str
    to_id: str
    reason: Optional[str] = ''

class DependencyPatchIn(BaseModel):
    reason: str

class DeadlineColIn(BaseModel):
    col: int

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
def _page(row) -> dict:
    d = dict(row)
    d["collapsed"] = bool(d["collapsed"])
    return d

def _cat(row) -> dict:
    d = dict(row)
    return {"id": d["id"], "dimensionId": d["dimension_id"], "name": d["name"], "color": d["color"]}

def _assign(row) -> dict:
    d = dict(row)
    return {"goalId": d["goal_id"], "dimensionId": d["dimension_id"], "categoryId": d["category_id"], "orderIdx": d["order_idx"]}

def _ms(row) -> dict:
    d = dict(row)
    return {"id": d["id"], "goalId": d["goal_id"], "startCol": d["start_col"],
            "duration": d["duration"], "title": d["title"], "color": d["color"]}

def _dep(row) -> dict:
    d = dict(row)
    return {"id": d["id"], "fromId": d["from_id"], "toId": d["to_id"], "reason": d.get("reason", "")}

def _dl(row) -> dict:
    d = dict(row)
    return {"id": d["id"], "goalId": d["goal_id"], "col": d["col"]}

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

HISTORY_LIMIT = 20
DEFAULT_PROJECT_ID = "default"

def _milestone_from_api(data: dict) -> dict:
    return {
        "id": data["id"],
        "goalId": data["goalId"],
        "startCol": int(data.get("startCol", 0)),
        "duration": max(1, int(data.get("duration", 1))),
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

def _assert_final_state_valid(con, before: dict, after: dict):
    touched_ms = _state_ids(before, "milestones") | _state_ids(after, "milestones")
    touched_deps = _state_ids(before, "dependencies") | _state_ids(after, "dependencies")
    final_ms = {
        row["id"]: _ms(row)
        for row in con.execute("SELECT * FROM milestones").fetchall()
        if row["id"] not in touched_ms
    }
    final_deps = {
        row["id"]: _dep(row)
        for row in con.execute("SELECT * FROM dependencies").fetchall()
        if row["id"] not in touched_deps
    }
    final_ms.update({m["id"]: m for m in after["milestones"]})
    final_deps.update({d["id"]: d for d in after["dependencies"]})

    for milestone in final_ms.values():
        if milestone["startCol"] < 0 or milestone["duration"] < 1:
            raise HTTPException(422, {"message": "Milestones must have a non-negative start and positive duration", "id": milestone["id"]})

    by_goal = {}
    for milestone in final_ms.values():
        by_goal.setdefault(milestone["goalId"], []).append(milestone)
    for lane_milestones in by_goal.values():
        for i, first in enumerate(lane_milestones):
            for second in lane_milestones[i + 1:]:
                if first["startCol"] < second["startCol"] + second["duration"] and second["startCol"] < first["startCol"] + first["duration"]:
                    raise HTTPException(422, {
                        "message": "Milestones in the same goal row cannot overlap",
                        "type": "overlap",
                        "milestoneIds": [first["id"], second["id"]],
                    })

    deadlines = {row["goal_id"]: row["col"] for row in con.execute("SELECT goal_id, col FROM deadlines").fetchall()}
    for milestone in final_ms.values():
        deadline = deadlines.get(milestone["goalId"])
        if deadline is not None and milestone["startCol"] + milestone["duration"] > deadline:
            raise HTTPException(422, {"message": "Milestone exceeds hard deadline", "type": "deadline", "id": milestone["id"]})

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
                "UPDATE milestones SET goal_id = ?, start_col = ?, duration = ?, title = ?, color = ? WHERE id = ?",
                (m["goalId"], m["startCol"], m["duration"], m["title"], m["color"], m["id"]),
            )
        else:
            con.execute(
                "INSERT INTO milestones (id, goal_id, start_col, duration, title, color) VALUES (?,?,?,?,?,?)",
                (m["id"], m["goalId"], m["startCol"], m["duration"], m["title"], m["color"]),
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

def _push_history(con, transaction: dict, before: dict, after: dict):
    con.execute(
        "DELETE FROM transaction_history WHERE project_id = ? AND stack = 'redo'",
        (DEFAULT_PROJECT_ID,),
    )
    seq = con.execute(
        "SELECT COALESCE(MAX(seq), 0) + 1 FROM transaction_history WHERE project_id = ? AND stack = 'undo'",
        (DEFAULT_PROJECT_ID,),
    ).fetchone()[0]
    con.execute(
        """
        INSERT INTO transaction_history (id, project_id, stack, seq, transaction_json, before_json, after_json)
        VALUES (?, ?, 'undo', ?, ?, ?, ?)
        """,
        (transaction["id"], DEFAULT_PROJECT_ID, seq, json.dumps(transaction), json.dumps(before), json.dumps(after)),
    )
    overflow = con.execute(
        """
        SELECT id FROM transaction_history
        WHERE project_id = ? AND stack = 'undo'
        ORDER BY seq DESC LIMIT -1 OFFSET ?
        """,
        (DEFAULT_PROJECT_ID, HISTORY_LIMIT),
    ).fetchall()
    if overflow:
        con.execute(
            f"DELETE FROM transaction_history WHERE id IN ({','.join('?' for _ in overflow)})",
            tuple(row["id"] for row in overflow),
        )

def _move_history_entry(con, row, target_stack: str):
    seq = con.execute(
        "SELECT COALESCE(MAX(seq), 0) + 1 FROM transaction_history WHERE project_id = ? AND stack = ?",
        (DEFAULT_PROJECT_ID, target_stack),
    ).fetchone()[0]
    con.execute(
        "UPDATE transaction_history SET stack = ?, seq = ? WHERE id = ?",
        (target_stack, seq, row["id"]),
    )

def _history_summary(con) -> dict:
    rows = con.execute(
        "SELECT id, stack, seq, transaction_json FROM transaction_history WHERE project_id = ? ORDER BY stack, seq",
        (DEFAULT_PROJECT_ID,),
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

def _apply_transaction(con, transaction: TransactionPayload, record_history: bool = True):
    tx = transaction.dict()
    tx["id"] = tx.get("id") or str(uuid.uuid4())
    before = _normalize_tx_state(tx.get("before") or {})
    after = _normalize_tx_state(tx.get("after") or {})
    _assert_before_matches(con, before, after)
    _assert_final_state_valid(con, before, after)
    _apply_transaction_rows(con, before, after)
    if record_history:
        tx["before"] = before
        tx["after"] = after
        _push_history(con, tx, before, after)
    return {"ok": True, "transaction": tx, "history": _history_summary(con)}


# ── Pages (goals) ─────────────────────────────────────────────────────────────
@app.get("/pages")
def list_pages():
    with _db() as con:
        rows = con.execute("SELECT * FROM pages ORDER BY order_idx").fetchall()
    return [_page(r) for r in rows]

@app.post("/pages", status_code=201)
def create_page(data: PageIn):
    pid = data.id or str(uuid.uuid4())
    with _db() as con:
        if con.execute("SELECT id FROM pages WHERE id = ?", (pid,)).fetchone():
            raise HTTPException(409, "Page already exists")
        max_ord = con.execute("SELECT COALESCE(MAX(order_idx), -1) FROM pages").fetchone()[0]
        con.execute(
            "INSERT INTO pages (id, html, title, collapsed, order_idx) VALUES (?, ?, ?, ?, ?)",
            (pid, data.html, data.title, int(data.collapsed), max_ord + 1),
        )
    return {"id": pid, "html": data.html, "title": data.title, "collapsed": data.collapsed}

@app.patch("/pages/{page_id}")
def update_page(page_id: str, data: PagePatch):
    with _db() as con:
        if not con.execute("SELECT id FROM pages WHERE id = ?", (page_id,)).fetchone():
            raise HTTPException(404, "Page not found")
        fields, values = [], []
        if data.html is not None:      fields.append("html = ?");      values.append(data.html)
        if data.title is not None:     fields.append("title = ?");     values.append(data.title)
        if data.collapsed is not None: fields.append("collapsed = ?"); values.append(int(data.collapsed))
        if fields:
            con.execute(f"UPDATE pages SET {', '.join(fields)} WHERE id = ?", (*values, page_id))
        row = con.execute("SELECT * FROM pages WHERE id = ?", (page_id,)).fetchone()
    return _page(row)

@app.delete("/pages/{page_id}", status_code=204)
def delete_page(page_id: str):
    with _db() as con:
        if not con.execute("SELECT id FROM pages WHERE id = ?", (page_id,)).fetchone():
            raise HTTPException(404, "Page not found")
        con.execute("DELETE FROM pages WHERE id = ?", (page_id,))

@app.put("/pages/order")
def reorder_pages(data: OrderIn):
    with _db() as con:
        for i, pid in enumerate(data.ids):
            if not con.execute("SELECT id FROM pages WHERE id = ?", (pid,)).fetchone():
                raise HTTPException(404, f"Page {pid} not found")
            con.execute("UPDATE pages SET order_idx = ? WHERE id = ?", (i, pid))
    return {"ok": True}


# ── Dimensions ────────────────────────────────────────────────────────────────
@app.get("/dimensions")
def list_dimensions():
    with _db() as con:
        rows = con.execute("SELECT * FROM dimensions").fetchall()
    return [dict(r) for r in rows]

@app.post("/dimensions", status_code=201)
def create_dimension(data: DimensionIn):
    did = data.id or str(uuid.uuid4())
    with _db() as con:
        if con.execute("SELECT id FROM dimensions WHERE id = ?", (did,)).fetchone():
            raise HTTPException(409, "Dimension already exists")
        con.execute("INSERT INTO dimensions (id, name) VALUES (?, ?)", (did, data.name))
    return {"id": did, "name": data.name}

@app.patch("/dimensions/{dim_id}")
def update_dimension(dim_id: str, data: DimensionPatch):
    with _db() as con:
        if not con.execute("SELECT id FROM dimensions WHERE id = ?", (dim_id,)).fetchone():
            raise HTTPException(404, "Dimension not found")
        fields, values = [], []
        if data.name is not None:
            fields.append("name = ?")
            values.append(data.name.strip() or "Untitled dimension")
        if fields:
            con.execute(f"UPDATE dimensions SET {', '.join(fields)} WHERE id = ?", (*values, dim_id))
        row = con.execute("SELECT * FROM dimensions WHERE id = ?", (dim_id,)).fetchone()
    return dict(row)

@app.delete("/dimensions/{dim_id}", status_code=204)
def delete_dimension(dim_id: str):
    with _db() as con:
        if not con.execute("SELECT id FROM dimensions WHERE id = ?", (dim_id,)).fetchone():
            raise HTTPException(404, "Dimension not found")
        con.execute("DELETE FROM assignments WHERE dimension_id = ?", (dim_id,))
        con.execute("DELETE FROM categories WHERE dimension_id = ?", (dim_id,))
        con.execute("DELETE FROM dimensions WHERE id = ?", (dim_id,))


# ── Categories ────────────────────────────────────────────────────────────────
@app.get("/categories")
def list_all_categories():
    with _db() as con:
        rows = con.execute("SELECT * FROM categories ORDER BY order_idx").fetchall()
    return [_cat(r) for r in rows]

@app.post("/dimensions/{dim_id}/categories", status_code=201)
def create_category(dim_id: str, data: CategoryIn):
    if not data.name.strip():
        raise HTTPException(400, "Category name required")
    cid = data.id or str(uuid.uuid4())
    with _db() as con:
        if not con.execute("SELECT id FROM dimensions WHERE id = ?", (dim_id,)).fetchone():
            raise HTTPException(404, "Dimension not found")
        max_ord = con.execute(
            "SELECT COALESCE(MAX(order_idx), -1) FROM categories WHERE dimension_id = ?", (dim_id,)
        ).fetchone()[0]
        con.execute(
            "INSERT INTO categories (id, dimension_id, name, color, order_idx) VALUES (?, ?, ?, ?, ?)",
            (cid, dim_id, data.name.strip(), data.color, max_ord + 1),
        )
    return {"id": cid, "dimensionId": dim_id, "name": data.name.strip(), "color": data.color}


@app.put("/categories/order")
def reorder_categories(data: dict):
    ids = data.get("ids", [])
    with _db() as con:
        for i, cid in enumerate(ids):
            if not con.execute("SELECT id FROM categories WHERE id = ?", (cid,)).fetchone():
                raise HTTPException(404, f"Category {cid} not found")
            con.execute("UPDATE categories SET order_idx = ? WHERE id = ?", (i, cid))
    return {"ok": True}

@app.patch("/categories/{cat_id}")
def update_category(cat_id: str, data: CategoryPatch):
    with _db() as con:
        if not con.execute("SELECT id FROM categories WHERE id = ?", (cat_id,)).fetchone():
            raise HTTPException(404, "Category not found")
        fields, values = [], []
        if data.name is not None:  fields.append("name = ?");  values.append(data.name.strip())
        if data.color is not None: fields.append("color = ?"); values.append(data.color)
        if fields:
            con.execute(f"UPDATE categories SET {', '.join(fields)} WHERE id = ?", (*values, cat_id))
        row = con.execute("SELECT * FROM categories WHERE id = ?", (cat_id,)).fetchone()
    return _cat(row)

@app.delete("/categories/{cat_id}", status_code=204)
def delete_category(cat_id: str):
    with _db() as con:
        if not con.execute("SELECT id FROM categories WHERE id = ?", (cat_id,)).fetchone():
            raise HTTPException(404, "Category not found")
        con.execute("DELETE FROM assignments WHERE category_id = ?", (cat_id,))
        con.execute("DELETE FROM categories WHERE id = ?", (cat_id,))


# ── Assignments ───────────────────────────────────────────────────────────────
@app.get("/assignments")
def list_assignments():
    with _db() as con:
        rows = con.execute("SELECT * FROM assignments ORDER BY dimension_id, category_id, order_idx").fetchall()
    return [_assign(r) for r in rows]

@app.put("/goals/{goal_id}/assign/{dim_id}")
def assign_category(goal_id: str, dim_id: str, data: AssignIn):
    with _db() as con:
        existing = con.execute(
            "SELECT category_id, order_idx FROM assignments WHERE goal_id = ? AND dimension_id = ?",
            (goal_id, dim_id),
        ).fetchone()
        if existing and existing["category_id"] == data.categoryId:
            order_idx = existing["order_idx"]
        else:
            order_idx = con.execute(
                "SELECT COALESCE(MAX(order_idx), -1) + 1 FROM assignments WHERE dimension_id = ? AND category_id = ?",
                (dim_id, data.categoryId),
            ).fetchone()[0]
        con.execute(
            "INSERT OR REPLACE INTO assignments (goal_id, dimension_id, category_id, order_idx) VALUES (?, ?, ?, ?)",
            (goal_id, dim_id, data.categoryId, order_idx),
        )
    return {"goalId": goal_id, "dimensionId": dim_id, "categoryId": data.categoryId, "orderIdx": order_idx}

@app.put("/assignments/order")
def reorder_assignments(data: dict):
    dim_id = data.get("dimensionId")
    cat_id = data.get("categoryId")
    goal_ids = data.get("goalIds", [])
    if not dim_id:
        raise HTTPException(400, "dimensionId is required")
    with _db() as con:
        if cat_id is None:
            return {"ok": True}
        for i, goal_id in enumerate(goal_ids):
            con.execute(
                """
                UPDATE assignments
                SET order_idx = ?
                WHERE goal_id = ? AND dimension_id = ? AND category_id = ?
                """,
                (i, goal_id, dim_id, cat_id),
            )
    return {"ok": True}

@app.delete("/goals/{goal_id}/assign/{dim_id}", status_code=204)
def unassign_category(goal_id: str, dim_id: str):
    with _db() as con:
        con.execute(
            "DELETE FROM assignments WHERE goal_id = ? AND dimension_id = ?",
            (goal_id, dim_id),
        )


# ── Saved filters ─────────────────────────────────────────────────────────────
@app.get("/filters")
def list_filters():
    with _db() as con:
        rows = con.execute("SELECT * FROM saved_filters ORDER BY name COLLATE NOCASE").fetchall()
    return [_filter(r) for r in rows]

@app.post("/filters", status_code=201)
def create_filter(data: SavedFilterIn):
    fid = data.id or str(uuid.uuid4())
    name = data.name.strip() or "Untitled filter"
    gate, selections_json, quick_key = _normalize_filter_payload(data)
    color = data.color or "#64748b"
    with _db() as con:
        if con.execute("SELECT id FROM saved_filters WHERE id = ?", (fid,)).fetchone():
            raise HTTPException(409, "Filter already exists")
        con.execute(
            """
            INSERT INTO saved_filters (id, name, gate, color, selections_json, quick_key)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (fid, name, gate, color, selections_json, quick_key),
        )
        row = con.execute("SELECT * FROM saved_filters WHERE id = ?", (fid,)).fetchone()
    return _filter(row)

@app.patch("/filters/{filter_id}")
def update_filter(filter_id: str, data: SavedFilterPatch):
    with _db() as con:
        if not con.execute("SELECT id FROM saved_filters WHERE id = ?", (filter_id,)).fetchone():
            raise HTTPException(404, "Filter not found")
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
def delete_filter(filter_id: str):
    with _db() as con:
        if not con.execute("SELECT id FROM saved_filters WHERE id = ?", (filter_id,)).fetchone():
            raise HTTPException(404, "Filter not found")
        con.execute("DELETE FROM saved_filters WHERE id = ?", (filter_id,))


# ── Schedule perspectives ────────────────────────────────────────────────────
@app.get("/schedule-perspectives")
def list_schedule_perspectives():
    with _db() as con:
        rows = con.execute("SELECT * FROM schedule_perspectives ORDER BY name COLLATE NOCASE").fetchall()
    return [_schedule_perspective(r) for r in rows]

@app.post("/schedule-perspectives", status_code=201)
def create_schedule_perspective(data: SchedulePerspectiveIn):
    pid = data.id or str(uuid.uuid4())
    name = data.name.strip() or "Untitled perspective"
    with _db() as con:
        if con.execute("SELECT id FROM schedule_perspectives WHERE id = ?", (pid,)).fetchone():
            raise HTTPException(409, "Perspective already exists")
        con.execute(
            "INSERT INTO schedule_perspectives (id, name, state_json) VALUES (?, ?, ?)",
            (pid, name, json.dumps(data.state or {})),
        )
        row = con.execute("SELECT * FROM schedule_perspectives WHERE id = ?", (pid,)).fetchone()
    return _schedule_perspective(row)

@app.patch("/schedule-perspectives/{perspective_id}")
def update_schedule_perspective(perspective_id: str, data: SchedulePerspectivePatch):
    with _db() as con:
        if not con.execute("SELECT id FROM schedule_perspectives WHERE id = ?", (perspective_id,)).fetchone():
            raise HTTPException(404, "Perspective not found")
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
def delete_schedule_perspective(perspective_id: str):
    with _db() as con:
        if not con.execute("SELECT id FROM schedule_perspectives WHERE id = ?", (perspective_id,)).fetchone():
            raise HTTPException(404, "Perspective not found")
        con.execute("DELETE FROM schedule_perspectives WHERE id = ?", (perspective_id,))


# ── Classification perspectives ──────────────────────────────────────────────
@app.get("/classification-perspectives")
def list_classification_perspectives():
    with _db() as con:
        rows = con.execute("SELECT * FROM classification_perspectives ORDER BY name COLLATE NOCASE").fetchall()
    return [_classification_perspective(r) for r in rows]

@app.post("/classification-perspectives", status_code=201)
def create_classification_perspective(data: ClassificationPerspectiveIn):
    pid = data.id or str(uuid.uuid4())
    name = data.name.strip() or "Untitled perspective"
    with _db() as con:
        if con.execute("SELECT id FROM classification_perspectives WHERE id = ?", (pid,)).fetchone():
            raise HTTPException(409, "Perspective already exists")
        con.execute(
            "INSERT INTO classification_perspectives (id, name, state_json) VALUES (?, ?, ?)",
            (pid, name, json.dumps(data.state or {})),
        )
        row = con.execute("SELECT * FROM classification_perspectives WHERE id = ?", (pid,)).fetchone()
    return _classification_perspective(row)

@app.patch("/classification-perspectives/{perspective_id}")
def update_classification_perspective(perspective_id: str, data: ClassificationPerspectivePatch):
    with _db() as con:
        if not con.execute("SELECT id FROM classification_perspectives WHERE id = ?", (perspective_id,)).fetchone():
            raise HTTPException(404, "Perspective not found")
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
def delete_classification_perspective(perspective_id: str):
    with _db() as con:
        if not con.execute("SELECT id FROM classification_perspectives WHERE id = ?", (perspective_id,)).fetchone():
            raise HTTPException(404, "Perspective not found")
        con.execute("DELETE FROM classification_perspectives WHERE id = ?", (perspective_id,))


# ── Transactions ──────────────────────────────────────────────────────────────
@app.get("/transactions/history")
def get_transaction_history():
    with _db() as con:
        return _history_summary(con)

@app.post("/transactions")
def apply_transaction(data: TransactionApplyIn):
    with _db() as con:
        return _apply_transaction(con, data.transaction)

@app.post("/transactions/undo")
def undo_transaction():
    with _db() as con:
        row = con.execute(
            """
            SELECT * FROM transaction_history
            WHERE project_id = ? AND stack = 'undo'
            ORDER BY seq DESC LIMIT 1
            """,
            (DEFAULT_PROJECT_ID,),
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
        _apply_transaction(con, reverse, record_history=False)
        _move_history_entry(con, row, "redo")
        return {"ok": True, "transaction": transaction, "history": _history_summary(con)}

@app.post("/transactions/redo")
def redo_transaction():
    with _db() as con:
        row = con.execute(
            """
            SELECT * FROM transaction_history
            WHERE project_id = ? AND stack = 'redo'
            ORDER BY seq DESC LIMIT 1
            """,
            (DEFAULT_PROJECT_ID,),
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
        _apply_transaction(con, forward, record_history=False)
        _move_history_entry(con, row, "undo")
        return {"ok": True, "transaction": transaction, "history": _history_summary(con)}


# ── Milestones ────────────────────────────────────────────────────────────────
@app.get("/milestones")
def list_milestones():
    with _db() as con:
        rows = con.execute("SELECT * FROM milestones ORDER BY start_col").fetchall()
    return [_ms(r) for r in rows]

@app.post("/milestones", status_code=201)
def create_milestone(data: MilestoneIn):
    mid = data.id or str(uuid.uuid4())
    with _db() as con:
        con.execute(
            "INSERT INTO milestones (id, goal_id, start_col, duration, title, color) VALUES (?,?,?,?,?,?)",
            (mid, data.goal_id, data.start_col, max(1, data.duration), data.title, data.color),
        )
    return _ms({"id": mid, "goal_id": data.goal_id, "start_col": data.start_col,
                "duration": max(1, data.duration), "title": data.title, "color": data.color})

# Registered before /{ms_id} so "batch" is not captured as a path param
@app.put("/milestones/batch")
def batch_update_milestones(data: MilestoneBatch):
    with _db() as con:
        for u in data.updates:
            mid = u.get("id")
            if not mid:
                continue
            fields, values = [], []
            if "startCol" in u: fields.append("start_col = ?"); values.append(u["startCol"])
            if "duration" in u: fields.append("duration = ?");  values.append(max(1, u["duration"]))
            if "color"    in u: fields.append("color = ?");     values.append(u["color"])
            if "title"    in u: fields.append("title = ?");     values.append(u["title"])
            if fields:
                con.execute(f"UPDATE milestones SET {', '.join(fields)} WHERE id = ?", (*values, mid))
    return {"ok": True}

@app.patch("/milestones/{ms_id}")
def update_milestone(ms_id: str, data: MilestonePatch):
    with _db() as con:
        if not con.execute("SELECT id FROM milestones WHERE id = ?", (ms_id,)).fetchone():
            raise HTTPException(404, "Milestone not found")
        fields, values = [], []
        if data.start_col is not None: fields.append("start_col = ?"); values.append(data.start_col)
        if data.duration  is not None: fields.append("duration = ?");  values.append(max(1, data.duration))
        if data.title     is not None: fields.append("title = ?");     values.append(data.title)
        if data.color     is not None: fields.append("color = ?");     values.append(data.color)
        if fields:
            con.execute(f"UPDATE milestones SET {', '.join(fields)} WHERE id = ?", (*values, ms_id))
        row = con.execute("SELECT * FROM milestones WHERE id = ?", (ms_id,)).fetchone()
    return _ms(row)

@app.delete("/milestones/{ms_id}", status_code=204)
def delete_milestone(ms_id: str):
    with _db() as con:
        con.execute("DELETE FROM milestones WHERE id = ?", (ms_id,))


# ── Dependencies ──────────────────────────────────────────────────────────────
@app.get("/dependencies")
def list_dependencies():
    with _db() as con:
        rows = con.execute("SELECT * FROM dependencies").fetchall()
    return [_dep(r) for r in rows]

@app.post("/dependencies", status_code=201)
def create_dependency(data: DependencyIn):
    did = data.id or str(uuid.uuid4())
    reason = data.reason or ''
    with _db() as con:
        try:
            con.execute("INSERT INTO dependencies (id, from_id, to_id, reason) VALUES (?, ?, ?, ?)",
                        (did, data.from_id, data.to_id, reason))
        except sqlite3.IntegrityError:
            raise HTTPException(409, "Dependency already exists")
    return _dep({"id": did, "from_id": data.from_id, "to_id": data.to_id, "reason": reason})

@app.patch("/dependencies/{dep_id}")
def update_dependency(dep_id: str, data: DependencyPatchIn):
    with _db() as con:
        con.execute("UPDATE dependencies SET reason = ? WHERE id = ?", (data.reason, dep_id))
        row = con.execute("SELECT * FROM dependencies WHERE id = ?", (dep_id,)).fetchone()
    if not row:
        raise HTTPException(404)
    return _dep(row)

@app.delete("/dependencies/{dep_id}", status_code=204)
def delete_dependency(dep_id: str):
    with _db() as con:
        con.execute("DELETE FROM dependencies WHERE id = ?", (dep_id,))


# ── Deadlines ─────────────────────────────────────────────────────────────────
@app.get("/deadlines")
def list_deadlines():
    with _db() as con:
        rows = con.execute("SELECT * FROM deadlines").fetchall()
    return [_dl(r) for r in rows]

@app.put("/deadlines/{goal_id}")
def set_deadline(goal_id: str, data: DeadlineColIn):
    with _db() as con:
        existing = con.execute("SELECT id FROM deadlines WHERE goal_id = ?", (goal_id,)).fetchone()
        if existing:
            con.execute("UPDATE deadlines SET col = ? WHERE goal_id = ?", (data.col, goal_id))
        else:
            did = str(uuid.uuid4())
            con.execute("INSERT INTO deadlines (id, goal_id, col) VALUES (?, ?, ?)", (did, goal_id, data.col))
        row = con.execute("SELECT * FROM deadlines WHERE goal_id = ?", (goal_id,)).fetchone()
    return _dl(row)

@app.delete("/deadlines/{goal_id}", status_code=204)
def remove_deadline(goal_id: str):
    with _db() as con:
        con.execute("DELETE FROM deadlines WHERE goal_id = ?", (goal_id,))
