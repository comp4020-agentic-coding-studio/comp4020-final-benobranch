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

### Data centers
- A handful of fixed suburbs (e.g. based loosely on real Canberra data
  infrastructure / business park locations — Hume, Fyshwick, Civic, Bruce)
  host a data center each.
- Each has a **power score in TFLOPS** (fixed per data center, maybe variable
  over time/seasons later).
- **Connected (cable) vs disconnected (air):** if you hold a live path to a
  data center, you draw its full TFLOPS at full speed. If you don't, you can
  still reach it remotely but at a steep multiplier penalty (the "advanced
  encryption to avoid other players reading your traffic" framing) —
  disconnected use is a fallback, not a dead end, so losing your corridor is
  bad but not instantly fatal.
- TFLOPS earned fund the **skill tree**: more compute = faster research, not
  a different currency. This is the single resource that ties territory,
  economy and tech progression together — worth protecting as the one
  through-line when we get into implementation detail.

### Bases, drones, skill tree
- Each player has one **home base** (their factory). All players start
  identical: same starting drone roster, same base.
- The factory produces autonomous units (drones/bots) used to attack
  neighbouring suburbs and to defend owned ones.
- The skill tree (funded by TFLOPS, faster with more compute) unlocks:
  - new unit types,
  - faster/cheaper unit production,
  - misc perks (scouting, defense bonuses, path efficiency, etc. — TBD).
- Attack = send units from an owned suburb into an adjacent one (adjacency
  as defined above); resolution rule still TBD (see Open decisions — this is
  shared with the original plan's "combat rule" question).

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

## Players & spawn balance (decided)

- **Fixed factions, not open join.** The map has a small, fixed roster of
  factions (count TBD — see Open decisions), each with one pre-placed home
  base. A visitor joins by taking an unclaimed faction (or the one with the
  fewest active players, if we ever allow >1 person per faction — TBD); they
  don't spawn a new base wherever they happen to show up. This is what makes
  "no spawn has an advantage" a property we can actually guarantee, rather
  than one that depends on join order or luck.
- **Balance metric: equal shortest-hop distance to every data center.** For
  each data center, every faction's home base should be the same number of
  road-adjacency hops away (or as close to equal as the real graph allows —
  Canberra won't be perfectly symmetric). This is computed **once, offline,
  during map preprocessing**: search candidate home-base suburbs and pick the
  set that minimises the variance in hop-distance-to-each-data-center across
  factions. Chosen over "equal reachable TFLOPS" (more accurate but more
  complex to justify) and "equal local connectivity" (simpler but ignores
  the resource — data center access — that actually matters).
- **This also settles data center placement.** Rather than picking data
  center suburbs for real-world flavour (an actual business park) and hoping
  spawns balance around them, placement is **balance-driven first**: data
  center suburbs and faction home-base suburbs are chosen *together* by the
  same preprocessing search, so the configuration is symmetric by
  construction. Real-world flavour becomes a tie-breaker — if multiple
  balanced configurations exist, prefer the one that lands a data center on
  a real Canberra business-park/infrastructure suburb (Hume, Fyshwick, etc.)
  — not the primary driver.
- Since this is computed once and baked in with the rest of the map graph
  (see "Map data" below), it costs nothing at runtime and is something we
  can point to directly in `README.md`/`spec/` as an enforced ("checked")
  claim rather than just an asserted design intention — e.g. a test that
  loads the baked map and asserts the hop-distance variance across spawns is
  within some tolerance.

## How it still meets the brief

| Requirement | How |
|---|---|
| Multi-user | Every visitor joins the shared Canberra map by taking one of the fixed factions |
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
  dataset**, Edition 4 (2026, GDA2020), GeoPackage/Shapefile, CC BY 4.0. Chosen
  over ACT Gov/Geoscape's own boundaries (same underlying data lineage)
  because ABS SAL is built with guaranteed no gaps/overlaps nationwide —
  the property that matters most for a tiling game, where every square
  metre of the map needs to belong to exactly one suburb, never zero or two.
- **Road network: OpenStreetMap**, via a Geofabrik "New South Wales (with ACT
  and JBT)" `.osm.pbf` extract, clipped down to the ACT boundary (ACT isn't
  split out separately at Geofabrik) using Osmium/osmconvert. ODbL license —
  free, redistribution-friendly for derived facts like a road-adjacency
  graph; needs attribution. **Do not use OSM's own suburb/locality
  boundaries** — they're informal and community-drawn for Canberra,
  inconsistent with the official ABS data used for the tiles themselves.
- Adjacency between two suburbs = they share a road connection in the OSM
  extract, not just a shared polygon border (see "Map & territory" above) —
  this is computed once in preprocessing, not at runtime.
- **Scope: all ACT suburbs**, not a curated subset. More suburbs than
  originally planned (~100+ vs. the 20–40 the original generic plan assumed)
  — raises the bar on keeping the UI legible at phone width (see Marker
  constraints) and on making sure the preprocessing pipeline (not hand
  layout) is doing the heavy lifting, since hand-curating ~100+ tiles isn't
  viable in a week.

## Open decisions

**World-building / scope (new, from this session):**
- **Faction count.** How many fixed factions/home bases — 4 (one per
  compass-ish quadrant of the map) is the obvious starting guess, but it
  needs checking against the actual balance search: can the real ACT road
  graph even support N equally-balanced spawns for a given N and a given
  number/placement of data centers? Fewer factions is easier to balance
  perfectly; more factions is more interesting for co-presence (more
  simultaneous actors, which is the thing the brief rewards) but harder to
  keep fair. Needs the preprocessing spike to answer with real numbers
  rather than guessing.
- **Number of data centers**, similarly — tied to the same balance search as
  faction count, not a separate decision.
- **Faction framing.** Are players literally "the AI's competing
  franchisees", human resistance cells, corporate remnants, something else?
  Affects naming, unit flavour text, and the README's "good" argument (is
  this satire of AI/compute hype, or a straighter siege game with a skin?).
- **Drone roster for v1.** Needs a short, flavourful starting list (e.g.
  scout drone, attack drone, defense turret-bot) before the skill tree can
  be designed — tree unlocks are only meaningful once there's a baseline to
  diverge from.

**Carried over from the original generic plan, still unresolved:**
- **Combat rule.** Deterministic (attacker units vs defender units) or with
  randomness?
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
  must be able to play as two players/factions and see real-time updates
  between them. Two incognito windows from the *same* Chrome session are not
  enough to test this — they share storage with each other, so anything
  keyed off localStorage (session tokens, "Continue") would wrongly resume
  as the same player in both.
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
