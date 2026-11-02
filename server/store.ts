// Persistence layer: a single SQLite file on the Fly volume (DATA_DIR,
// defaulting to /data — see docs/adr/0001-persistence-and-realtime-stack.md
// for why SQLite-on-volume rather than a managed cloud database).
//
// node:sqlite's DatabaseSync is synchronous, which is what makes a handler
// like `bump` atomic on the event loop: there is no `await` between reading
// the current count and writing the new one, so two players bumping at the
// "same" moment still serialize through Node's single thread rather than
// racing. WAL mode is a durability/performance setting on top of that, not
// the concurrency story — see the ADR.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface CounterState {
  count: number;
  lastBumpedBy: string | null;
  updatedAt: string;
}

export interface Store {
  getCounter(): CounterState;
  bump(playerName: string): CounterState;
  close(): void;
}

export function openStore(dbPath: string): Store {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);

  // WAL survives the file being reopened (it's persisted in -wal/-shm
  // sidecar files next to the main one), so this only needs setting once
  // per connection, not per write.
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS counter (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      count INTEGER NOT NULL,
      last_bumped_by TEXT,
      updated_at TEXT NOT NULL
    )
  `);
  db.exec(`
    INSERT OR IGNORE INTO counter (id, count, last_bumped_by, updated_at)
    VALUES (1, 0, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `);

  const selectCounter = db.prepare(
    "SELECT count, last_bumped_by AS lastBumpedBy, updated_at AS updatedAt FROM counter WHERE id = 1",
  );
  const bumpCounter = db.prepare(`
    UPDATE counter
    SET count = count + 1, last_bumped_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = 1
  `);

  function readCounter(): CounterState {
    const row = selectCounter.get() as
      | { count: number; lastBumpedBy: string | null; updatedAt: string }
      | undefined;
    if (!row) throw new Error("counter row missing — schema init failed");
    return row;
  }

  return {
    getCounter: readCounter,
    bump(playerName: string): CounterState {
      bumpCounter.run(playerName);
      return readCounter();
    },
    close(): void {
      db.close();
    },
  };
}
