# Plan: [working title] — a real-time territory game over real Canberra

Working notes for the final project. Due **noon Monday 9 November 2026**.
This is the lore/world-building/mechanics layer; see below for open decisions
still to settle before implementation starts.

## The pitch

Near-future Canberra. An AI takeover has already happened — not Terminator
robots in the street, just infrastructure: whoever controls compute controls
everything downstream of it (logistics, finance, utilities, information).
What's left of organised human factions (and possibly rogue AI factions —
open decision) fight for physical control of the few **data centers** that
still run the show, because the AI doesn't care who it serves as long as
someone's feeding it power and territory.

Players don't fight over abstract tiles — they fight over **real Canberra
suburbs**, using **real roads** as the connective tissue, because the game's
core tension is physical: you cannot get compute out of a data center unless
you physically hold a contiguous corridor of territory to it. No corridor,
no cable, no cheap bandwidth — you're stuck exfiltrating data over the air
with heavy encryption overhead, which is slow and exposes you. This turns
"real-time territory control" into "real-time infrastructure siege", which
is the thing that's actually ours (the brief is clear the map, name and
combat rules need to be — using real geography as a board is fair game, the
rules built on top of it are what need to be original).

## Why real map data, not an abstract board

The original generic plan used a made-up 20–40 tile layout. The new idea
specifically wants:

- **Real roads** as the adjacency graph — you don't control a suburb, you
  control a *path*, and real road topology makes some corridors naturally
  chokepoints (bridges, single arterial roads) and others naturally
  defensible or contestable, for free, without us hand-designing it.
- **Real suburbs/LGA boundaries** as the territory units ("tiles") — Canberra
  has ~100+ gazetted suburbs, which is a lot more granular (and legible to a
  Canberra-based marker/audience) than an invented board.
- This is flavour *and* mechanics: a Canberran marker recognising "oh, they
  took Civic, that's why the Braddon corridor matters" is a more interesting
  co-presence moment than an abstract hex losing.

## Core mechanics (first pass — see Open decisions for what's still loose)

### Map & territory
- Base unit = a suburb (ABS/ACT gazetted suburb boundary). LGA is probably
  too coarse for Canberra (it's almost all one LGA — "Unincorporated ACT" —
  so **suburbs are the tile, not LGAs**; LGA framing might still matter if we
  ever add other cities later).
- Adjacency = **shares a road connection**, not just "shares a border" — two
  suburbs that touch but have no road crossing between them (e.g. split by a
  lake, a reserve, a highway with no interchange) are not adjacent for
  attack/path purposes. This is the detail that makes the map feel like
  Canberra rather than a generic polygon mesh.
- A player's **path to a data center** = a contiguous chain of owned,
  road-adjacent suburbs from their home base to that data center's suburb.

### Data centers (decided, see "Players & spawn balance" for the numbers)
- **32 fixed data centers in three power tiers**, not a handful of equal
  ones — real Canberra locations host stronger data centers, per the brief
  that key locations should be worth fighting over:
  - **5 mega** (100 TFLOPS): City (Civic), Kingston, Fyshwick — the
    real-world business/infrastructure cluster the fiction is built
    around — plus Belconnen and Phillip (Woden) as geographic
    counterweights, so the strongest tier isn't clustered in one corner.
  - **10 major** (40 TFLOPS): Gungahlin and Greenway (Tuggeranong) — the
    counterweight candidates that didn't become mega — plus 8 curated real
    town/group centres and business precincts (Weston Creek, Dickson,
    Braddon, Bruce, Mitchell, Hume, Pialligo, Symonston), so every district
    has at least one strong data center.
  - **17 standard** (15 TFLOPS): spread across the remaining suburbs.
- Each has a **power score in TFLOPS**, fixed per data center (not
  per-season variable, for v1).
- **Connected (cable) vs disconnected (air):** if you hold a live path to a
  data center, you draw its full TFLOPS at full speed. If you don't, you can
  still reach it remotely but at a steep multiplier penalty (the "advanced
  encryption to avoid other players reading your traffic" framing) —
  disconnected use is a fallback, not a dead end, so losing your corridor is
  bad but not instantly fatal.
- TFLOPS speeds up the **skill tree**: more compute = faster research, not
  more affordable research — see "Two resources: TFLOPS and scrap" below for
  why TFLOPS is a rate, not a currency (revised by [[ANU-019]], correcting
  [[ANU-016]]'s original spend-based reading of this same section).

### Two resources: TFLOPS and scrap (revised — see [[ANU-013]], [[ANU-019]])

This section originally said TFLOPS was "the single resource that ties
territory, economy and tech progression together... not a different
currency." [[ANU-013]] revised that once: the user's own request for
factories and a skill tree names a second resource explicitly — "resources
gained by destroying enemy troups" funding more factories, and a skill-tree
perk for "more scrap gained by killing enemy troops." Both phrases only make
sense if there's a combat currency distinct from the compute resource. So:

- **TFLOPS** (from data centers, per "Data centers" above) **speeds up the
  skill tree's research rate** — it is a live multiplier derived from the
  data centers a player currently holds, not a balance that accrues or gets
  spent. A node researches itself over time once started (one node
  researching at a time); holding more/stronger data centers shortens that
  time, it never gates whether research can start at all.
- **Scrap** (earned by destroying enemy units) funds **factory/unit
  production** — building more factories and more troops. Scrap remains the
  only resource actually spent in the game.

[[ANU-016]] (the skill tree) originally built this as a spend-based shop —
TFLOPS deducted per node purchase, `insufficient-tflops` a rejection reason —
on the strength of this section's now-corrected first revision. [[ANU-019]]
replaced that with the time-gated design above once the user clarified the
intent directly: a data center's TFLOPS rating was always meant to be a
speed multiplier on unlock rate, mirroring "more compute = faster research"
literally, never a currency.

This keeps each resource tied to a distinct loop (hold territory → more
TFLOPS → faster tech; win fights → earn scrap → build more army) rather than
one number doing both jobs.

### Bases, drones, skill tree
- Each player has one **home base** (their factory, placed at their spawn
  suburb — see "Players & spawn balance"). All players start identical: same
  starting drone roster, same base. Players can build additional factories
  in **any suburb they own** — no adjacency-to-an-existing-factory
  restriction (confirmed with the user — see [[ANU-015]]'s Resolution) —
  for a flat scrap cost. Capturing a suburb with an enemy factory in it
  **transfers** that factory to the capturing player (including any
  in-progress build) rather than destroying it.
- The factory produces autonomous units (drones/bots) used to attack
  neighbouring suburbs and to defend owned ones, paid for in **scrap**.
- The skill tree (researched over time, sped up by **TFLOPS** — more compute
  = faster, never cheaper, since nothing is spent) unlocks:
  - new unit types,
  - faster/cheaper unit production,
  - misc perks (scouting, defense bonuses, path efficiency, more scrap per
    kill, faster zone capture, etc. — see [[ANU-016]]).
- Attack = send units from an owned suburb into an adjacent one (adjacency
  as defined above; drones ignore this restriction — see [[ANU-014]]).
  Resolution rule (decided in [[ANU-014]], confirmed with the user via
  AskUserQuestion): random element — attacker damage varies +/-20% per
  hit, floored at 1, rather than a fixed deterministic value.

## Art direction

Clean, high-contrast, "tech flashy" UI chrome (HUD-like overlays, sharp
sans-serif, glow/accent colours for ownership) over a dystopian, cyberpunk
tone in the fiction and map styling itself — e.g. a desaturated/dark base
map with neon faction-colour overlays per suburb, so the real OSM geography
reads as "surveilled infrastructure" rather than a tourist map. Avoid
cyberpunk cliché overload (no need for rain/neon-everywhere pastiche); the
dystopia comes more from the premise (AI already won, humans are fighting
over its scraps) than from maximalist visual noise — keep it legible at
phone width per the marker constraints below.

## Players & spawn balance (decided — revised after [[ANU-006]]'s spike)

The original plan here (a small fixed faction roster, equal hop-distance to
every data center) is **superseded**. Mid-spike, the brief's actual game
design wanted something different: a variable-size lobby, many data centers
of differing power, and "no spawn way better" rather than exact symmetry.
`scripts/map/balance_search.py` (the old exact-equidistance search) is kept
as process evidence; `scripts/map/build_lobby_config.py` is what's live now.

- **Lobby-based games, not fixed factions.** A game has **4–12 players**,
  minimum 4 to start, no late join once a game begins. The real, scheduled
  game starts **Sunday 5pm Australia/Sydney**; players queue in a lobby
  beforehand. Because that schedule means the marker (who may be alone,
  testing with two incognito windows, any day of the week) could otherwise
  never start a game, a lobby with fewer than 4 humans at kickoff is
  **filled with bots** up to the minimum — the weekly Sunday lobby is the
  "real" competitive game, marking/testing always has a path to 4+ players
  on demand.
- **Data centers are fixed across lobbies** (see "Data centers" above);
  **spawns are computed per lobby** from its player count, not baked into
  the map. The original idea — fan spawns at literal `360/N` degree
  intervals around the map — doesn't work geometrically: urban Canberra is
  roughly twice as long north–south as east–west, so equal compass sectors
  leave some directions (the east, which is mostly airport/NSW border) with
  no suburb in them once N gets past about 8. Instead, spawns are spaced
  evenly (by rotating a start offset) along a **ring** of suburbs at
  **4–6 road-hops from the map's "hop-center"** (the suburb minimising
  worst-case hop-distance to everywhere else — computed to be Acton) — same
  visual effect as a fan around the outside of the map, parameterised by
  the real road graph's shape instead of raw compass bearing.
- **Balance metric: bounded soft-access-score imbalance, not equidistance.**
  With three data-center power tiers, "equal hop-distance to every DC"
  stopped being meaningful (being equidistant from a mega and a standard DC
  isn't equal access). Instead each spawn gets a **soft access score** =
  Σ over all data centers of `tflops × 0.5^hop_distance` — rewards nearby
  *and* powerful data centers, decaying smoothly with distance. For each
  lobby size, the spawn rotation minimising the **max/min score ratio**
  across players is chosen, subject to a hard floor of ≥2 hops pairwise
  separation between spawns. Measured worst case across all lobby sizes
  4–12: **~2.7×** (typical/smaller lobbies, e.g. the 4-player bot-filled
  marker case, are tighter — ~1.8×). Confirmed acceptable against "doesn't
  need to be 100% balanced, just no spawn way better than others" rather
  than chasing exact symmetry.
- **Known artifact:** the "ACT Remainder" tiles (large rural/bushland buffer
  suburbs — Cotter River, Rendezvous Creek, Tuggeranong-remainder, etc.) are
  kept as real (ownable, ABS SAL) graph nodes rather than dropped, since
  dropping them would reintroduce the gaps/overlaps the whole point of
  using ABS SAL data was to avoid (see "Map data" below). They're excluded
  from spawn- and data-center-candidacy, but still traversable for
  adjacency/corridor purposes — i.e. **wilderness tiles are ownable but
  hold no data center and can't host a spawn.** One side-effect: the large
  multi-hundred-km² Tuggeranong-remainder tile borders 16 real suburbs,
  acting as a high-degree hub in the hop graph; this is a known artifact of
  real Canberra's geography (a genuinely enormous rural buffer), not a bug,
  but worth flagging if hop-distances there look surprising.
- Since this is computed once and baked in with the rest of the map graph
  (see "Map data" below), it costs nothing at runtime and is something we
  can point to directly in `README.md`/`spec/` as an enforced ("checked")
  claim rather than just an asserted design intention —
  `spec/map-balance.test.ts` loads the baked map, recomputes BFS hop
  distances and soft-access scores from scratch (not from precomputed
  numbers in the file), and asserts the agreed bound for every lobby size.

## How it still meets the brief

| Requirement | How |
|---|---|
| Multi-user | Every visitor joins a lobby (4–12 players, bot-filled to the minimum if needed); the weekly game starts Sunday 5pm Australia/Sydney |
| Real-time | Server-authoritative; attacks, ownership changes and TFLOPS flows broadcast to all open sessions (target: under 1s) |
| Persists | One long-running world on the `/data` volume; seasons archived |
| Co-presence | Corridors can be cut by someone else acting *right now* — the whole compute-routing mechanic only has teeth because other players are live on the board |

(World/season structure, win condition, offline-player handling, and the
"past seasons" archive from the original plan likely still apply almost
unchanged — revisit once the above is settled, rather than redoing that
thinking from scratch.)

## Map data (decided)

Fully static, one-time download — no live API calls, no key, no ongoing
dependency. Preprocessed once into a baked suburb-adjacency-and-road graph
that ships in the repo.

- **Suburb polygons (the tiles): ABS SAL ("Suburbs and Localities") boundary
  dataset**, Edition 3 (2021, GDA2020), CC BY 4.0, fetched via ABS's own
  ArcGIS REST endpoint (`geo.abs.gov.au/arcgis/rest/services/ASGS2021/SAL`,
  filtered to `state_code_2021='8'`) rather than downloading the national
  GeoPackage/Shapefile — same data, simpler one-time fetch for an ACT-only
  subset ([[ANU-006]], `scripts/map/fetch_suburbs.py`). Chosen over ACT
  Gov/Geoscape's own boundaries (same underlying data lineage) because ABS
  SAL is built with guaranteed no gaps/overlaps nationwide — the property
  that matters most for a tiling game, where every square metre of the map
  needs to belong to exactly one suburb, never zero or two. 136 ACT
  suburb/locality polygons (2 non-geographic rows — "No usual address",
  "Migratory" — dropped; they have no geometry).
- **Road network: OpenStreetMap**, fetched live via the Overpass API
  ([[ANU-006]], `scripts/map/fetch_roads.py`) rather than a Geofabrik
  `.osm.pbf` extract + Osmium — a direct bounding-box query for a
  `highway=*` whitelist (motorway down to residential/living_street,
  excluding footway/cycleway/path/track/service, which would wrongly
  reconnect suburbs split by a lake or reserve) was simpler for an
  ACT-sized area and avoids the extra offline-conversion tooling. ODbL
  license — free, redistribution-friendly for derived facts like a
  road-adjacency graph; needs attribution. **Do not use OSM's own
  suburb/locality boundaries** — they're informal and community-drawn for
  Canberra, inconsistent with the official ABS data used for the tiles
  themselves.
- Adjacency between two suburbs = a road segment's consecutive points fall
  in different suburb polygons (STRtree point-in-polygon lookup, with a
  ~1m boundary-snap tolerance and a hard break — not a skip — on any point
  falling outside the ACT boundary, so a road that dips into NSW/Queanbeyan
  can't fabricate an edge between two ACT suburbs not actually linked
  inside ACT) — computed once in preprocessing
  (`scripts/map/build_adjacency.py`), not at runtime.
- **Large rural "ACT Remainder" tiles are kept as real graph nodes, not
  dropped or contracted** — see "Players & spawn balance" for why, and for
  the contraction approach that was tried and abandoned (spurious
  long-hop edges between suburbs that only share a scattered reserve
  polygon, not an actual road).
- **Scope: all ACT suburbs**, not a curated subset. More suburbs than
  originally planned (~100+ vs. the 20–40 the original generic plan assumed)
  — raises the bar on keeping the UI legible at phone width (see Marker
  constraints) and on making sure the preprocessing pipeline (not hand
  layout) is doing the heavy lifting, since hand-curating ~100+ tiles isn't
  viable in a week.
- **Baked output:** `scripts/map/data/map.json` — the adjacency graph (139
  nodes incl. split multi-part remainder tiles, 317 edges), the 32 data
  centers with tiers/power, the per-lobby-size spawn table, and the search
  parameters, with source attribution. `scripts/map/build_lobby_config.py`
  regenerates it from the raw ABS/OSM fetches.
- **Geometry ([[ANU-010]]):** `scripts/map/data/map-geometry.json` — the
  same 139 nodes' polygon boundaries, pre-flattened to SVG path strings
  (EPSG:7855 projected, y-flipped, topology-simplified so shared suburb
  borders stay gap/overlap-free) — no client-side projection library
  needed. `scripts/map/build_geometry.py` regenerates it, reusing
  `build_adjacency.py`'s exact node-splitting logic so the two files' node
  sets never drift apart.

## Open decisions

**Resolved by [[ANU-006]]'s preprocessing spike:**
- ~~Faction count~~ → superseded by the lobby model: **4–12 players per
  game**, not a fixed faction count (see "Players & spawn balance").
- ~~Number of data centers~~ → **32**, in 3 power tiers (see "Data
  centers").

**World-building / scope (new, from this session):**
- **Lobby lifecycle backend work.** The lobby model (queueing, the Sunday
  5pm Australia/Sydney start, the 4-player minimum, no late join, bot
  fill) needs its own implementation — tracked separately, see the issue
  this spike opened for it.
- **Player framing within a lobby.** Are players literally "the AI's competing
  franchisees", human resistance cells, corporate remnants, something else?
  Affects naming, unit flavour text, and the README's "good" argument (is
  this satire of AI/compute hype, or a straighter siege game with a skin?).
- **Drone roster for v1.** Needs a short, flavourful starting list (e.g.
  scout drone, attack drone, defense turret-bot) before the skill tree can
  be designed — tree unlocks are only meaningful once there's a baseline to
  diverge from.

**Carried over from the original generic plan, still unresolved:**
- **Offline players.** Suggested: units/compute regenerate only while
  online; territory stays owned while away but stays attackable.
- **Exact numbers:** TFLOPS-to-research-speed curve, unit production rates,
  season threshold %, minimum season length.
- **Stack:** Node + WebSockets + SQLite was the working assumption; now also
  needs to account for storing a static derived map graph (suburbs + roads +
  adjacency), which is read-heavy and basically immutable per season —
  probably fine as a one-time preprocessed JSON/SQLite table rather than
  live API calls per request.

## Marker constraints to design for

- The marker uses **two separate Chrome profiles side by side** (an
  incognito window counts as one of the two), possibly alone, so one person
  must be able to play as two players in the same lobby and see real-time
  updates between them. Two incognito windows from the *same* Chrome session
  are not enough to test this — they share storage with each other, so
  anything keyed off localStorage (session tokens, "Continue") would wrongly
  resume as the same player in both. The lobby's remaining slots down to the
  4-player minimum are bot-filled (see "Players & spawn balance"), so a
  marker testing with just these two profiles still sees a startable game.
- The marker returns the **next day after a restart**, so the world (or the
  archived season) must clearly still be there.
- The game must work at both marking viewports, including narrow ones — a
  real, detailed city map is the main risk here and needs an explicit
  mobile-layout answer (e.g. list/HUD view vs. full pan-zoom map).

## Candidate checks for `spec/` (to refine once mechanics settle)

- An attack/ownership change made in session A appears in session B within
  1 second.
- A suburb's "connected" (cable) vs "disconnected" (air) status updates
  correctly the moment its path to a data center is cut or restored.
- Simultaneous attacks on the same suburb resolve consistently (units are
  never spent twice).
- The board, TFLOPS totals and the season archive survive a server restart.
- **Done ([[ANU-006]]):** `spec/map-balance.test.ts` — the baked map graph
  is one connected component covering every suburb; all 32 data centers
  resolve to real (non-wilderness) suburbs; for every lobby size 4–12, the
  spawn set has the right count, the pairwise hop-separation floor holds,
  and the recomputed soft-access-score imbalance ratio stays within the
  agreed bound.
