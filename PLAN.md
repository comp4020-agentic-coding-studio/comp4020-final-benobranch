# Plan: real-time territory game

Working notes for the final project. Due **noon Monday 9 November 2026**.

## The idea

A territory-control strategy game played in **real time** on one shared map.
Unlike turn-based territory games, there are no turns: any player can act at
any moment. Players must balance their troop reserves between **attacking**
neighbouring territories and **holding back** enough to defend against an
attack that could come at any time. Every action updates the board for all
connected players immediately.

The map, name and combat rules are our own (not a copy of any existing board
game).

## How it meets the brief

| Requirement | How |
|---|---|
| Multi-user | Every visitor joins the same shared map as a player |
| Real-time | Server-authoritative; every action is broadcast to all open sessions (target: under 1s) |
| Persists | One long-running world stored on the `/data` volume; past seasons are archived |
| Co-presence | The core tension only exists because others are acting at the same time |

## World and seasons

- **One persistent world**, played in **seasons**.
- A season ends when:
  - one player holds a **threshold share of the map** (e.g. 60%), or
  - the **weekly reset** arrives, whichever comes first.
- **Guards against a quick win:** the threshold only counts after a minimum
  season length (e.g. 24h), and neutral territories are strong and
  regenerate, so a lone player can't sweep an empty map.
- **Wipes never erase history.** At season end, store:
  - the final map snapshot
  - the winner and the season's length
  - per-player stats

  These are shown on a "Past seasons" page. The board shows "Season N, day D".
- The reset day/time is a config value, so it can be kept away from the
  marking window.
- A live **leader bar** (e.g. "Leader: 34% / 60%") is visible to everyone.

## Minimum viable version

1. A fixed map of about 20–40 territories (our own layout), usable at phone
   width.
2. Join with a name (a pseudonym, no accounts).
3. Troops regenerate over time.
4. Select one of your territories, then a neighbouring one, to attack; the
   server resolves the result with a simple rule.
5. Changes are broadcast to all clients over WebSockets.
6. State is stored in SQLite on `/data`.
7. The season threshold, the archive and the "Past seasons" page.

**Later, if there's time:** alliances, chat, fog of war, animations.

## Open decisions

- **Offline players.** Suggested: troops regenerate only while you're
  online; your territories stay yours while you're away but can be attacked,
  so logging off is a real risk.
- **Combat rule.** Deterministic (attacker troops vs defender troops) or with
  randomness?
- **Exact numbers:** the threshold percentage, the minimum season length,
  regeneration rates.
- **Stack:** Node + WebSockets + SQLite is the working assumption (it fits
  the 256 MB machine).

## Marker constraints to design for

- The marker uses **two incognito windows side by side**, possibly alone, so
  one person must be able to play as two players and see real-time updates
  between them.
- The marker returns the **next day after a restart**, so the world (or the
  archived season) must clearly still be there.
- The game must work at both marking viewports, including narrow ones.

## Definition of good (draft direction for README.md)

The good part is managing tension and attention under constant exposure:
being present with other people at the same time is what makes the game.
This needs to be argued from sources, and the README must say which claims
are enforced by checks and which are left to judgement.

## Candidate checks for `spec/`

- An attack made in session A appears in session B within 1 second.
- Simultaneous attacks on the same territory resolve consistently (troops
  are never spent twice).
- The board and the season archive survive a server restart.
