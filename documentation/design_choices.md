# Design choices

---

## Why module-level `_projectId` in api.js
Zero prop-drilling. Every `api.*` call appends the current project automatically. Switching projects = one `setProjectId(id)` call, nothing else needs to change. Would need to become a React context if multi-project views were ever needed.

## Why `display: none` instead of conditional rendering for views
ClassificationPage and SchedulePage are heavily stateful. Unmounting them on navigate would reset filters, scroll, selected milestones, etc. Keeping all four views mounted and toggling visibility preserves that state cheaply.

## Why before/after transactions instead of locks
The client already holds the milestone data — it knows what it touched. Sending that as the `before` snapshot turns conflict detection into a simple comparison. If two edits conflict, the second one gets a 409. No session, no lock, no version column. Works fine for a single-user local app.

## Why one big `main.py`
Everything in one file is fast to navigate when prototyping. Natural split when it grows: `db.py`, `transactions.py`, one router per resource.

## Why one big `SchedulePage.jsx`
Same reason. The Gantt's state (spacing, filters, perspectives, conflict state, undo history display) is tightly coupled. Splitting it prematurely would just create a lot of props or context. Revisit when the component is stable.

## Why perspectives are opaque JSON blobs
The frontend can add fields to perspective state without a DB migration — just include them in the capture and default-fallback on restore. Tradeoff: no versioning, so old perspectives can silently restore wrong state if the shape changes incompatibly.

## Notes Naming
The product language is now notes throughout the frontend, backend API, and database schema. `main.py` keeps a migration path for old local databases that still contain `pages` or `goal_id`.

## Progressive note search
Both the global header search and the Notes canvas search use `useProgressiveNoteSearch`. Title matches are returned synchronously as `strong` hits so the UI responds immediately. Description matches are then scanned asynchronously in small chunks and streamed into the same result list as `weak` hits. A note that matches both title and description is shown once as a strong result.

---

## Things that caused problems

**The `translateX` slider:** had all four views in a 400vw-wide strip, panned with `translateX(-view * 100vw)`. Caused misalignment on the Notes tab (gap on the left, content shifted right). Root issue: transforms create a new containing block for `position: fixed` children, making the BrainstormV2 float-ghost element behave differently depending on which tab was active. Replaced with `display: none` toggling — simpler and no geometry math.

**Dashboard having its own top bar:** when the dashboard was a standalone screen, it had its own back button and title bar. Moving it inside the workspace as view 0 created a double-header. Fixed by stripping its top bar — the main Header handles everything.

**Legacy note naming:** old snapshots may still contain `pages` or `goal_id`; the backend migrates those names to `notes` and `note_id`.

---

## Things not yet done but should be

- **Perspective versioning:** old perspectives break silently if the shape changes. A `version` field + migration function on restore would fix this.
- **Transaction 409 retry on frontend:** currently just logs the error. Should re-fetch state and show the user that their change conflicted.
- **Timeline column ceiling:** `totalCols` only grows, never shrinks. Very wide projects slow render over time.
- **`seed.py` is stale:** uses positional inserts that predate `project_id` and `order_idx`. Don't run it without updating first.
