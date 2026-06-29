# Architecture

FastAPI + SQLite backend (`main.py`) + Vite/React frontend (`src/`), both on localhost.

---

## Backend

**Startup:** `_init_db()` creates tables → `_migrate()` adds missing columns → `_seed_defaults()` inserts default project/dimensions. All automatic, runs every restart.

**Project scoping:** `notes`, `dimensions`, `saved_filters`, and perspectives have `project_id` directly. `categories`, `milestones`, `dependencies`, `deadlines` don't — they're reached via subqueries (e.g. `WHERE note_id IN (SELECT id FROM notes WHERE project_id = ?)`).

**Root-note model:** Each project has a `root_note_id`. The root note is the project-as-note: its title/body mirror the project name/description during the transitional UI. Normal `/notes` calls hide the root by default, while `/notes?include_root=true` returns it. Every non-root note has one structural `parent_note_id`; notes without an explicit parent are created as children of the project root. This is a tree model, separate from the existing scheduled `note_inheritance` links.

**Transaction system (most important part):** Schedule writes go through `POST /transactions` with a `before` + `after` snapshot. Backend validates:
1. Current DB matches `before` (optimistic locking — catches stale edits)
2. `after` state passes all schedule rules (no overlaps, no passing milestones, deadline enforcement, dependency constraints, no cycles)

If both pass → apply atomically + push to undo stack. Otherwise → reject, nothing written.

**Row converters:** Every table has a `_xxx(row)` helper that converts sqlite rows to camelCase JSON for the API response. The only place database naming leaks into the API contract.

---

## Frontend

**`api.js`:** Module-level `_projectId` gets appended to every `api.*` call. `setProjectId(id)` switches projects — no props need to change. `projectsApi` bypasses this for global endpoints (list projects, export).

**`App.jsx`:** Two screens: `home` (project list) or `workspace` (four views). State: `view` (0–3), `activeProject`, `notes`. All four views are always mounted — `display: flex | none` to switch. This keeps Classification and Schedule state alive when navigating away.

**Views:**
- `0` — ProjectDashboard: metadata, stats, export
- `1` — BrainstormV2: note capture
- `2` — ClassificationPage: dimensions, categories, filters, perspectives
- `3` — SchedulePage: Gantt, transactions, undo/redo, warning system

**SchedulePage key ideas:**
- Column indices only — `metric` controls what columns are labeled (days/weeks/months/hours), not what's stored
- Refs (`scrollLeftRef`, `spacingRef`, `milestonesRef`) for RAF callbacks to avoid stale closures
- `buildRowItems()` produces flat row model: lane headers, note rows, gaps
- Conflict reveal: when a transaction violates constraints, temporarily unhides the conflicting notes, blinks milestones, then restores prior view state

**Perspectives:** JSON blobs stored in the database. Frontend owns the structure — backend just stores/retrieves. Captured: spacing, grouping, hidden lanes, scroll position, filters, color settings.

---

## Files

| File | Owns |
|---|---|
| `main.py` | DB, migrations, validation, all endpoints, undo/redo |
| `src/api.js` | HTTP client, project scoping |
| `src/App.jsx` | Screen routing, note list, popup, quick-add |
| `src/components/Header.jsx` | Nav, quick-add popup |
| `src/components/ProjectDashboard.jsx` | Metadata editor, stats, JSON export |
| `src/components/SchedulePage.jsx` | Gantt (largest component) |
| `src/components/ClassificationPage.jsx` | Category grid, paint mode, filters |
