from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
import uuid

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5174"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── In-memory store (swap dict + list for SQLite rows later) ──────────────────
_pages: dict[str, dict] = {}
_order: list[str] = []          # maintains page sequence


# ── Schemas ───────────────────────────────────────────────────────────────────
class PageIn(BaseModel):
    id: Optional[str] = None    # client may supply its own UUID
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
    return [_pages[id] for id in _order if id in _pages]


@app.post("/pages", status_code=201)
def create_page(data: PageIn):
    page_id = data.id or str(uuid.uuid4())
    if page_id in _pages:
        raise HTTPException(status_code=409, detail="Page already exists")
    page = {"id": page_id, "html": data.html, "title": data.title, "collapsed": data.collapsed}
    _pages[page_id] = page
    _order.append(page_id)
    return page


@app.patch("/pages/{page_id}")
def update_page(page_id: str, data: PagePatch):
    if page_id not in _pages:
        raise HTTPException(status_code=404, detail="Page not found")
    page = _pages[page_id]
    if data.html is not None:
        page["html"] = data.html
    if data.title is not None:
        page["title"] = data.title
    if data.collapsed is not None:
        page["collapsed"] = data.collapsed
    return page


@app.delete("/pages/{page_id}", status_code=204)
def delete_page(page_id: str):
    if page_id not in _pages:
        raise HTTPException(status_code=404, detail="Page not found")
    del _pages[page_id]
    _order.remove(page_id)


@app.put("/pages/order")
def reorder_pages(data: OrderIn):
    for id in data.ids:
        if id not in _pages:
            raise HTTPException(status_code=404, detail=f"Page {id} not found")
    _order[:] = data.ids
    return {"ok": True}
