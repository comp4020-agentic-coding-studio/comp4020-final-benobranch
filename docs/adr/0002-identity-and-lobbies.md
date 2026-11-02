# ADR 0002: persistent player identity and multiple lobbies

## Context

ANU-005 shipped one shared global counter: every WebSocket connection got a
fresh `randomUUID()` playerId, and there was exactly one piece of state
(the counter), broadcast to every connection. That proved the three fixed
brief requirements (multi-user, real-time, persists) end to end, but it
can't support what the user wants next: a Home screen with a **Continue**
option (resume an existing game) and a **Server browse** option (create/join
one of several lobbies). Neither is possible without the server being able
to recognise a returning player and track more than one piece of shared
state at a time.

This is also a real shift in what the project's own planning doc said the
game would be: PLAN.md's brief-compliance table originally described "one
long-running world" as the persistence story. This ADR records that the
design has moved to **multiple concurrent lobbies**, each with its own
state — `README.md`'s eventual "good" argument should reflect this, not just
`CLAUDE.md`/`spec/`.

## Decisions

### Identity: opaque token in localStorage, not a cookie

On first `hello` (no token, or a token the server doesn't recognise), the
server mints a secret token and a public `playerId`, stores the mapping in a
`players` table, and returns the token in `welcome`. The client saves it in
`localStorage` and sends it back on every future `hello` to resume the same
`playerId`.

Chosen over an HttpOnly cookie because:
- No cookie-parsing or upgrade-handshake plumbing needed — `hello` is
  already the place client state is established.
- Consistent with the existing "anonymous visitor" identity model: this is
  still not an account system, just a way to recognise "the same browser
  came back," which is what the brief's "what counts as a person is your
  call" explicitly leaves open.
- The tradeoff — a cleared `localStorage`, or a different browser/device,
  loses the identity — is acceptable for this project: Continue is a
  convenience for coming back to the same device's session, not an account
  recovery feature.

The token is never broadcast. Only `playerId` appears in `lobbyState`/
`lobbyList`/`welcome` messages sent to other clients — a leaked `playerId`
lets someone see that player's presence, a leaked token lets someone
impersonate them, so they're kept strictly separate on the wire.

### Lobbies live in SQLite, seeded with one default, never deleted

`fly.toml`'s `auto_stop_machines` means any purely in-memory lobby registry
is gone the moment the machine idles out and restarts — exactly the
"marker comes back the next day" scenario the brief's persistence
requirement targets. Lobbies (`lobbies`, `lobby_members` tables) are
therefore real rows, not server-memory state, and the migration seeds one
`'default'` lobby so a fresh boot with an empty database still has
something to join and show on Server Browse — two marker windows land in
the same place with no out-of-band coordination needed.

Lobbies are **never deleted**, including when everyone leaves. The
project's seat model is intentionally simple for now: a `lobby_members` row
represents a standing seat in that lobby, not "currently connected to it" —
that's tracked separately (see below). Whether seats should expire, or
whether a lobby with zero members should eventually be cleaned up, is a
game-design question for ANU-009/later issues once there's an actual game
loop to hang that decision off; it does not block the identity/lobby
plumbing this ADR covers.

### Membership (SQLite) vs. online status (in-memory) are different things

A player has at most one lobby membership at a time (`lobby_members.player_id`
is the primary key — joining a different lobby is a move, implemented as a
single `INSERT OR REPLACE`, inside the same synchronous handler as the
capacity check, so a move is atomic). That membership is durable and
survives a restart with zero live connections.

Whether a member is currently *online*, however, is a property of this
server process's live `sockets` map, recomputed on every broadcast by
scanning for a live socket with that `playerId`. This split matters because:
- A restarted machine has lobbies with intact membership and zero online
  players — correct, and exactly the state a marker should find the next
  day.
- The HUD (carried over from ANU-007) needs to distinguish "a member of
  this lobby" from "currently connected," so a lobby's roster doesn't
  collapse into just whoever happens to be connected right now.

### Capacity check and join are one synchronous handler

`store.joinLobby()` checks the current member count against capacity and
writes the membership in the same `DatabaseSync` call, with no `await` in
between — the same reasoning as ADR 0001's `bump` handler. Two players
racing for the last seat in a lobby resolve consistently rather than both
succeeding and over-filling it.

## Consequences

- `server/protocol.ts`'s message set grew from
  `hello`/`bump`/`welcome`/`counter`/`presence` to include
  `createLobby`/`joinLobby`/`watchLobbies`/`unwatchLobbies` and
  `lobbyState`/`lobbyList`/`error`. `PlayerSummary`/`ServerCounterState`/
  `ServerPresence` were removed in favour of lobby-scoped equivalents
  (`PlayerPresence`, `LobbyState`, `LobbySummary`) — there is no remaining
  concept of a single global presence list.
- `server/store.ts` gained a `PRAGMA user_version`-gated migration, since
  this is the first schema change after ANU-005's initial `counter` table
  (now dropped — nothing had been deployed against it).
- The ANU-007 HUD client was adapted minimally (token storage, rendering
  `lobby.members` instead of a flat player list) rather than redesigned —
  the real Home/Server-Browse/HUD screens are ANU-009's job, built on top of
  this protocol.
- Capacity is a plain parameter on `createLobby` (2–16), not tied to any
  particular number — ANU-006 (map/faction work) hadn't landed a faction
  count at the time this was written, so lobby capacity and "number of
  factions in a game" are deliberately not coupled yet.
