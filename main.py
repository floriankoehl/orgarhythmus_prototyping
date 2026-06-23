import sqlite3
import uuid
from contextlib import contextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

DB_PATH = "goals.db"

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5174"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── DB setup ──────────────────────────────────────────────────────────────────
def _init_db():
    with _db() as con:
        con.execute("""
            CREATE TABLE IF NOT EXISTS pages (
                id       TEXT PRIMARY KEY,
                html     TEXT NOT NULL DEFAULT '',
                title    TEXT NOT NULL DEFAULT 'Untitled',
                collapsed INTEGER NOT NULL DEFAULT 0,
                order_idx INTEGER NOT NULL DEFAULT 0
            )
        """)

@contextmanager
def _db():
    con = sqlite3.connect(DB_PATH, check_same_thread=False)
    con.row_factory = sqlite3.Row
    try:
        yield con
        con.commit()
    finally:
        con.close()

def _row(row) -> dict:
    d = dict(row)
    d["collapsed"] = bool(d["collapsed"])
    return d

_init_db()


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


# ── Endpoints ─────────────────────────────────────────────────────────────────
@app.get("/pages")
def list_pages():
    with _db() as con:
        rows = con.execute("SELECT * FROM pages ORDER BY order_idx").fetchall()
    return [_row(r) for r in rows]


@app.post("/pages", status_code=201)
def create_page(data: PageIn):
    page_id = data.id or str(uuid.uuid4())
    with _db() as con:
        existing = con.execute("SELECT id FROM pages WHERE id = ?", (page_id,)).fetchone()
        if existing:
            raise HTTPException(status_code=409, detail="Page already exists")
        max_order = con.execute("SELECT COALESCE(MAX(order_idx), -1) FROM pages").fetchone()[0]
        con.execute(
            "INSERT INTO pages (id, html, title, collapsed, order_idx) VALUES (?, ?, ?, ?, ?)",
            (page_id, data.html, data.title, int(data.collapsed), max_order + 1),
        )
    return {"id": page_id, "html": data.html, "title": data.title, "collapsed": data.collapsed}


@app.patch("/pages/{page_id}")
def update_page(page_id: str, data: PagePatch):
    with _db() as con:
        row = con.execute("SELECT * FROM pages WHERE id = ?", (page_id,)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Page not found")
        fields, values = [], []
        if data.html is not None:
            fields.append("html = ?"); values.append(data.html)
        if data.title is not None:
            fields.append("title = ?"); values.append(data.title)
        if data.collapsed is not None:
            fields.append("collapsed = ?"); values.append(int(data.collapsed))
        if fields:
            con.execute(f"UPDATE pages SET {', '.join(fields)} WHERE id = ?", (*values, page_id))
        updated = con.execute("SELECT * FROM pages WHERE id = ?", (page_id,)).fetchone()
    return _row(updated)


@app.delete("/pages/{page_id}", status_code=204)
def delete_page(page_id: str):
    with _db() as con:
        if not con.execute("SELECT id FROM pages WHERE id = ?", (page_id,)).fetchone():
            raise HTTPException(status_code=404, detail="Page not found")
        con.execute("DELETE FROM pages WHERE id = ?", (page_id,))


@app.put("/pages/order")
def reorder_pages(data: OrderIn):
    with _db() as con:
        for i, page_id in enumerate(data.ids):
            if not con.execute("SELECT id FROM pages WHERE id = ?", (page_id,)).fetchone():
                raise HTTPException(status_code=404, detail=f"Page {page_id} not found")
            con.execute("UPDATE pages SET order_idx = ? WHERE id = ?", (i, page_id))
    return {"ok": True}
