# Project outline

This repository is a local prototype for **Orgarythmus**, a project/note planning app. It combines a FastAPI + SQLite backend with a Vite/React frontend. The product shape is: create projects, add notes, classify notes into dimensions/categories, and plan them on a Gantt-like schedule with milestones, dependencies, deadlines, filters, perspectives, undo, and redo.

## Runtime shape

- Backend: `main.py`
  - FastAPI app on `http://localhost:8000`.
  - SQLite database at `notes.db`.
  - CORS currently allows `http://localhost:5174`.
  - Database tables are created and migrated at import/startup time.
- Frontend: `src/`
  - Vite + React app.
  - API client lives in `src/api.js` and points to `http://localhost:8000`.
  - Project-scoped API calls add `?project_id=<active project id>` automatically.
- Build output: `dist/`
  - Generated static frontend bundle. Treat as build artifact unless intentionally shipping the built version.

Typical local commands:

```bash
uvicorn main:app --reload
npm run dev
npm run build
```

Python dependencies are in `requirements.txt`; Node dependencies and scripts are in `package.json`.

## Main user flow

1. `ProjectsPage` lists projects and creates/deletes projects.
2. Opening a project sets the active project id in `src/api.js`, then switches into the workspace.
3. The workspace has four horizontally sliding views:
   - Overview: project dashboard, stats, description, metric, database snapshot export.
   - Notes: quick note capture / brainstorming.
   - Classification: note grouping, coloring, dimensions/categories, filters, perspectives.
   - Schedule: Gantt-style milestone planning, dependencies, deadlines, filters, perspectives, transactions.
4. Note details open through `NotePopup`.

`App.jsx` owns the top-level screen state, active project, current workspace view, note list, quick-add behavior, and popup/toast plumbing.

## Key files

- `main.py`
  - Owns the API, schema setup, migrations, converters, transaction validation, undo/redo history, and export endpoint.
- `src/api.js`
  - Thin fetch wrapper plus grouped frontend API methods.
  - `projectsApi` is not project-scoped; `api` is project-scoped.
- `src/App.jsx`
  - Top-level React state machine: home vs workspace, active project, four workspace views, note popup, quick-add toast.
- `src/components/ProjectsPage.jsx`
  - Project list, project creation modal, delete confirmation.
- `src/components/ProjectDashboard.jsx`
  - Project overview, editable metadata, stats, JSON database export.
- `src/components/BrainstormV2.jsx`
  - Note capture / brainstorming surface.
- `src/components/ClassificationPage.jsx`
  - Dimensions, categories, assignments, category ordering, named filters, quick filters, visual perspectives, color painting.
- `src/components/SchedulePage.jsx`
  - Main Gantt planner. Contains most schedule UI state and interaction logic.
  - Handles milestones, dependencies, deadlines, lane grouping, filters, perspective save/apply, warning presentation, and transaction calls.
- `src/components/NotePopup.jsx`
  - Note editor popup and delete/update integration.
- `src/components/CategoryAssignmentPicker.jsx`
  - Category assignment UI used around note editing.
- `src/components/Header.jsx`
  - Workspace nav and quick-add entry.
- `src/components/*.module.css`
  - Component-scoped styles.
- `src/index.css` and `src/App.module.css`
  - Global app styling and top-level layout.
- `documentation/gant_warning_system.md`
  - Design notes for rule breaks, warning behavior, dependency conflicts, collapse/filter visibility dilemmas, and how transactions relate to warning display.

Note: the IDE referenced `documentation/gant_rule_system.md`, but that file is not present in the repository at the time this outline was written.

## Backend data model

The current schema in `main.py` creates these tables:

- `projects`
  - Project metadata: name, description, metric, created date.
- `notes`
  - Notes. Historical naming still says "notes"; in the UI these are notes.
  - Stores HTML body, title, collapsed state, order, and `project_id`.
- `dimensions`
  - Classification dimensions per project, such as Group or Priority.
- `categories`
  - Categories inside dimensions, with color and order.
- `assignments`
  - Note-to-category assignment per dimension.
  - Primary key is `(note_id, dimension_id)`, so one note has at most one category per dimension.
- `milestones`
  - Schedule blocks tied to a note row: start column, duration, title, color.
- `dependencies`
  - Directed milestone relationships: `from_id` must finish before `to_id` starts.
  - Includes an optional reason.
- `deadlines`
  - One hard deadline column per note.
- `saved_filters`
  - Named cross-dimensional filters with `AND`/`OR`, color, selections JSON, optional quick key.
- `schedule_perspectives`
  - Saved schedule view state as JSON.
- `classification_perspectives`
  - Saved classification view state as JSON.
- `transaction_history`
  - Undo/redo stacks for schedule transactions. History is capped by `HISTORY_LIMIT`.

Default dimensions are seeded for the default project: `Group` with `All`, and `Priority` with `High`, `Medium`, `Low`.

## API areas

The backend exposes grouped CRUD endpoints for:

- Projects: `/projects`, `/projects/{project_id}`, `/projects/{project_id}/stats`
- Notes: `/notes`, `/notes/{note_id}`, `/notes/order`
- Dimensions/categories: `/dimensions`, `/dimensions/{dim_id}`, `/dimensions/{dim_id}/categories`, `/categories`, `/categories/order`
- Assignments: `/assignments`, `/notes/{note_id}/assign/{dim_id}`, `/assignments/order`
- Filters: `/filters`
- Perspectives: `/schedule-perspectives`, `/classification-perspectives`
- Transactions: `/transactions`, `/transactions/history`, `/transactions/undo`, `/transactions/redo`
- Schedule data: `/milestones`, `/milestones/batch`, `/dependencies`, `/deadlines`
- Export: `/export/db`

Most frontend calls should go through `src/api.js` rather than calling `fetch` directly.

## Transaction and validation model

Schedule edits that need atomicity should use `/transactions`. A transaction includes:

- `before`: normalized milestones/dependencies expected to exist before applying.
- `after`: normalized milestones/dependencies desired after applying.
- metadata such as `type`, `label`, and optional `id`.

The backend validates:

- The current database state still matches `before`.
- New records do not collide with existing ids.
- Milestones have non-negative starts and positive durations.
- Milestones in the same note row do not overlap.
- Milestones in the same note row do not pass each other when both existed before and after.
- Milestones do not exceed hard deadlines.
- Dependencies do not point to themselves.
- Dependency endpoints exist.
- Duplicate dependency pairs are rejected.
- A predecessor must finish before its successor starts.
- Dependency cycles are rejected.

If validation passes, all touched milestone/dependency rows are applied together, redo history is cleared, and the transaction goes onto the undo stack. Undo and redo are implemented by replaying reversed/forward transaction states and moving history entries between stacks.

Important nuance: direct milestone/dependency endpoints also exist, but they do not provide the same complete atomic validation/history behavior as `/transactions`. Schedule interactions that must participate in warning behavior or undo/redo should prefer transactions.

## Frontend state concepts

Classification and Schedule both use similar concepts:

- Dimensions/categories define grouping and color semantics.
- Assignments map notes into dimensions.
- Named filters are persisted in `saved_filters`.
- Quick filters are local view-state filters.
- Perspectives save view configuration and restore it later.
- The selected default perspective id is stored in `localStorage`.

`ClassificationPage` has a compact classification-specific perspective state:

- grid sizing,
- selected container dimension,
- selected legend/color dimension,
- collapsed categories,
- unassigned collapsed state,
- active named filters,
- quick filters.

`SchedulePage` has a larger perspective state:

- spacing,
- axis/metric,
- dependency display options,
- lane grouping,
- collapsed categories,
- hidden notes by lane,
- scroll position,
- color dimension,
- active filters and quick filters.

## Warning-system design notes

The warning/rule design is partly implemented and partly documented in `documentation/gant_warning_system.md`.

Core rules:

- Milestones in the same note cannot overlap.
- Milestones cannot exceed their note deadline.
- Dependencies require predecessor end to be before successor start.
- Dependency cycles are invalid.

Frontend warning behavior in `SchedulePage` includes state for revealed conflict notes, pending conflict milestones, warning prompts, blinking dependencies/milestones, dependency conflict resolution selection, and temporary view changes to make hidden conflicts visible.

The central design tension is the "collapse/expand dilemma": conflicts may be hidden by collapsed lanes, collapsed notes, quick filters, named filters, or perspective state. The documented intended approach is to snapshot view state, reveal conflicts temporarily, then restore the previous perspective-like state after a short delay.

## Legacy and caution areas

- `seed.py` appears older than the current schema. It inserts into `dimensions`, `categories`, and `assignments` without naming columns and likely does not match the newer `project_id` and ordering fields. Review and update it before running.
- `notes.db` is tracked/present in the repo and can be modified by local app usage. Be careful not to commit accidental data changes unless they are intended.
- `dist/` is generated output. Update it only when you intentionally run a production build.
- Backend CORS allows `http://localhost:5174`, while Vite often defaults to `5173` unless another server is already using that port. If the frontend cannot call the backend, check the actual Vite port and CORS setting.
- Naming is mixed in places: "notes" in backend/API means "notes" in the product UI.

## Where to change common things

- Add/change a database field:
  - Update `_init_db`, `_migrate`, Pydantic schemas, converter helpers, endpoints, and `src/api.js` response usage.
- Add a project-scoped feature:
  - Ensure backend queries filter by `project_id` either directly or through project-owned notes/dimensions.
  - Add frontend method to `api`, not `projectsApi`, if it should use the active project query param.
- Change schedule rule behavior:
  - Backend source of truth: `_assert_final_state_valid`.
  - Frontend presentation/interaction: `SchedulePage.jsx`, especially transaction calls and warning/conflict state.
- Change classification behavior:
  - `ClassificationPage.jsx` plus `/dimensions`, `/categories`, `/assignments`, `/filters`, and `/classification-perspectives`.
- Change saved view behavior:
  - Schedule: `schedule_perspectives` table, `SchedulePage.jsx`, `/schedule-perspectives`.
  - Classification: `classification_perspectives` table, `ClassificationPage.jsx`, `/classification-perspectives`.
- Change quick-add or workspace navigation:
  - `App.jsx` and `Header.jsx`.

## Mental model

Think of the app as three layers:

1. Projects and notes provide the base content.
2. Classification dimensions/categories/filters provide alternate ways to organize and color that content.
3. Schedule milestones/dependencies/deadlines add temporal planning, with transactions enforcing valid Gantt state.

The most important architectural line is that the backend should remain the authority for valid schedule state, while the frontend owns rich interaction state, temporary warning visibility, and perspective restoration.
