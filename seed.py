import sqlite3, uuid

DB = "goals.db"

def uid(): return str(uuid.uuid4())

con = sqlite3.connect(DB)
con.row_factory = sqlite3.Row

# Clear existing data
con.execute("DELETE FROM assignments")
con.execute("DELETE FROM categories")
con.execute("DELETE FROM dimensions")
con.execute("DELETE FROM pages")

# ── Dimensions ────────────────────────────────────────────────────────────────
dim_phase    = uid()
dim_priority = uid()
dim_team     = uid()

con.executemany("INSERT INTO dimensions VALUES (?, ?)", [
    (dim_phase,    "Phase"),
    (dim_priority, "Priority"),
    (dim_team,     "Team"),
])

# ── Categories ────────────────────────────────────────────────────────────────
cat = {}

phase_cats = [("Planning", "#3b82f6"), ("Execution", "#22c55e"), ("Wrap-up", "#f97316")]
priority_cats = [("High", "#ef4444"), ("Medium", "#eab308"), ("Low", "#94a3b8")]
team_cats = [("Logistics", "#8b5cf6"), ("Marketing", "#ec4899"), ("Tech", "#3b82f6"), ("Venue", "#f97316")]

for name, color in phase_cats:
    cid = uid(); cat[name] = cid
    con.execute("INSERT INTO categories VALUES (?, ?, ?, ?)", (cid, dim_phase, name, color))

for name, color in priority_cats:
    cid = uid(); cat[name] = cid
    con.execute("INSERT INTO categories VALUES (?, ?, ?, ?)", (cid, dim_priority, name, color))

for name, color in team_cats:
    cid = uid(); cat[name] = cid
    con.execute("INSERT INTO categories VALUES (?, ?, ?, ?)", (cid, dim_team, name, color))

# ── Goals (pages) ─────────────────────────────────────────────────────────────
goals = [
    ("Book the venue",
     "<p>Confirm the event space, check capacity, sign the contract, and arrange parking access for attendees.</p>",
     "Planning", "High", "Venue"),

    ("Set up registration system",
     "<p>Choose a ticketing platform, configure registration form fields, set up confirmation emails, and test the full flow end to end.</p>",
     "Planning", "High", "Tech"),

    ("Define event schedule",
     "<p>Draft a detailed run-of-show with all session times, speaker slots, breaks, and buffer time between segments.</p>",
     "Planning", "Medium", "Logistics"),

    ("Coordinate catering",
     "<p>Get quotes from at least three catering companies, confirm dietary options, agree on quantities based on RSVPs, and arrange setup times.</p>",
     "Execution", "Medium", "Logistics"),

    ("Launch social media campaign",
     "<p>Create a content calendar for event promotion across Instagram, LinkedIn, and X. Schedule posts and track engagement metrics weekly.</p>",
     "Execution", "Medium", "Marketing"),

    ("Send speaker invitations",
     "<p>Reach out to confirmed speakers with schedule details, AV requirements form, and travel/accommodation info if applicable.</p>",
     "Planning", "High", "Marketing"),

    ("Set up AV equipment",
     "<p>Arrange microphones, projectors, and livestream setup. Run a full tech rehearsal the day before the event.</p>",
     "Execution", "High", "Tech"),

    ("Recruit and brief volunteers",
     "<p>Post volunteer call, select 12 volunteers, assign roles (registration desk, ushering, Q&A mics), and run a briefing session one week prior.</p>",
     "Planning", "Medium", "Logistics"),

    ("Send post-event survey",
     "<p>Draft a short satisfaction survey (5–8 questions), send to all attendees within 24 hours of the event closing.</p>",
     "Wrap-up", "Medium", "Marketing"),

    ("Settle vendor invoices",
     "<p>Collect all invoices from venue, catering, AV, and print vendors. Submit for approval and ensure payment within agreed terms.</p>",
     "Wrap-up", "High", "Logistics"),

    ("Publish event recap",
     "<p>Write a highlights post with photos and key takeaways. Publish on the company blog and share across social channels.</p>",
     "Wrap-up", "Low", "Marketing"),

    ("Archive event materials",
     "<p>Store final schedule, attendee list, vendor contracts, and budget actuals in the shared drive for future reference.</p>",
     "Wrap-up", "Low", "Logistics"),
]

for i, (title, html, phase, priority, team) in enumerate(goals):
    gid = uid()
    con.execute(
        "INSERT INTO pages (id, html, title, collapsed, order_idx) VALUES (?, ?, ?, 0, ?)",
        (gid, html, title, i)
    )
    con.execute("INSERT INTO assignments VALUES (?, ?, ?)", (gid, dim_phase,    cat[phase]))
    con.execute("INSERT INTO assignments VALUES (?, ?, ?)", (gid, dim_priority, cat[priority]))
    con.execute("INSERT INTO assignments VALUES (?, ?, ?)", (gid, dim_team,     cat[team]))

con.commit()
con.close()
print(f"Seeded {len(goals)} goals, 3 dimensions, {len(cat)} categories.")
