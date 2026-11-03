# ADR 0001: SQLite on the Fly volume, Node `ws`, synchronous handlers

## Context

The brief's three fixed requirements — multi-user, real-time, persists — all
land on the backend. The course-provisioned infra (`fly.toml`) is one
`shared-cpu-1x` machine with one volume mounted at `/data`; its own comment
says "there's no separate database server" and calls a managed Postgres
"outside the course setup." The target for this project is **5+ players
playing concurrently**, not just the two-browser marker minimum.

The question: what stores persistent state, and what pushes real-time
updates to every open session?

## Options considered

**Managed cloud database (e.g. Supabase Postgres, free tier).**
Gives a client-server DB and built-in realtime subscriptions. Rejected:
- It's explicitly outside what the course infra assumes — `fly.toml` gives
  one machine and one volume, nothing else.
- Supabase's free tier pauses a project after a period of inactivity; this
  app's "persists" requirement is checked by a marker returning the next
  day, which is a risk window outside our control.
- It would still need a WebSocket (or equivalent) layer for sub-second
  broadcast on top of it — adding Supabase as a store doesn't remove the
  real-time problem, it adds a second system alongside solving it.
- It's extra infra to justify in `PROCESS.md` for a single-machine app whose
  actual write volume (a handful of players, a few actions per second each,
  at most) doesn't need a client-server database.

**SQLite file on the `/data` volume + an in-process WebSocket server.**
Chosen. One process holds all server-side state (both the DB connection and
every open WebSocket), which turns "multi-user real-time" into "broadcast
the mutation to every connection in this process's Map" rather than a
distributed-systems problem.

## Decision

Use `node:sqlite`'s `DatabaseSync` against a file under `DATA_DIR`
(`/data/game.db` in production), and `ws` for the WebSocket layer, both
inside the single Node process `fly.toml` already runs.

### Why `DatabaseSync` (synchronous) matters for concurrency, not just WAL

`fly.toml` runs exactly one machine, so there is exactly one process and one
`DatabaseSync` connection — there is no multi-instance race to guard
against. The concurrency guarantee instead comes from `DatabaseSync` being
**synchronous**: a WebSocket message handler reads state, validates, writes,
and broadcasts with no `await` in between, so Node's single-threaded event
loop can't interleave two handlers mid-mutation. That's what will make
"simultaneous attacks on the same suburb resolve consistently, units never
spent twice" true once that logic exists — it's a property of the handler
shape, not of SQLite's isolation level.

WAL mode (`PRAGMA journal_mode = WAL`) is turned on anyway, but for a
narrower reason: it lets reads proceed without blocking on a write lock,
which matters for responsiveness under concurrent traffic even though
there's only one writer. It is not what prevents a lost update — the
synchronous, no-`await`-in-the-critical-section handler shape is.

### Why timestamps, not timers, drive time-based state

`fly.toml` sets `auto_stop_machines = "stop"` / `min_machines_running = 0` —
the machine (and therefore any `setInterval`) stops when nobody's connected
and only starts again on the next request. Anything that's supposed to
accrue over time (TFLOPS income, unit regeneration, season clocks, once
those exist) has to be derived lazily from a stored `updated_at`-style
timestamp when it's next read or written, not advanced by a running timer —
a timer silently stops counting exactly when the machine sleeps. The
skeleton's `counter` table already carries an `updated_at` column for this
reason, even though the throwaway counter feature doesn't need it yet.

**Generalized by [[ANU-013]]** (`server/time.ts`'s `elapsedMs` helper) once
more than one subsystem needed this: capture progress ([[ANU-017]]),
production queues ([[ANU-015]]), unit travel ([[ANU-014]]), and TFLOPS/scrap
accrual all compute a duration as `elapsedMs(startedAt)` — real wall-clock
time since a stored ISO timestamp, scaled by a `GAME_TIME_SCALE` env var
(default `1`). The scale exists so `spec/` can exercise a multi-minute
design duration (a production queue, a capture bar) in real seconds without
changing the design numbers themselves — `spec/lib/spawn-server.ts` accepts
a `gameTimeScale` option that sets this env var on the spawned child.

### Shutdown

Fly stops a machine by sending SIGTERM. The server closes the WebSocket
server and the SQLite connection on `SIGTERM`/`SIGINT` so WAL checkpoints
cleanly, rather than leaving a `-wal` file for the next boot to replay.

## Consequences

- No external account, no network dependency, no separate service to keep
  alive or explain in `PROCESS.md` beyond this ADR.
- All server-side state lives in one process; game logic that needs to
  serialize conflicting writes can do so with plain synchronous JS, not
  locks or transactions across services.
- This does not scale past one machine. That's an accepted constraint of the
  course infra (`fly.toml` provisions exactly one), not a gap in this
  design — if a future requirement needed horizontal scaling, SQLite-on-a-
  single-volume would need revisiting, but the brief's actual target (5+
  concurrent players in one room) is well within what one `shared-cpu-1x`
  machine and one SQLite file handle.
- Verified empirically (see issues/ANU-005.md): 6 concurrent WebSocket
  connections all receive a broadcast from one connection's action; data
  written before a process restart (and a Docker container restart,
  standing in for a Fly machine restart) is still there after one.
