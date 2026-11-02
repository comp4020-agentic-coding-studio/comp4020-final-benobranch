# Final project brief (reference copy)

Saved from <https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/assessments/final-project/>
on 2026-11-02, for offline reference. If in doubt, the live page is authoritative.

---

The full-stack capstone: a deployed multi-user app with a persistent backend, a
definition of good that you make and defend, and a portfolio showing how you
built it.

## The brief

> Make a multi-user, real-time website that's good.

Three requirements are fixed, with these meanings, and together they make the
app full-stack:

- **Multi-user:** two or more people, each in their own browser, act on
  shared state, and the app tells them apart. What counts as a person is your
  call: an account, a pseudonym, or any anonymous visitor.
- **Real-time:** a change one person makes appears in every other open
  session showing it within about a second, with no reload or other action by
  the viewer. How it gets there is also your call: WebSockets, server-sent
  events or even "polling fast enough"; you just need to explain why you
  built it the way you did.
- **Persists:** what someone does in your app is still there when they, or
  anyone else, come back, across sessions, restarts and redeploys.

That covers a lot of ground: a social space, a game, an instrument, a
collaborative tool, an interactive artwork that only exists while people are
in it. Everything else, including what *good* means, is yours to decide.

The first two assignments had a bunch of things built into the provocation.
This one has none. Ask an agent for a "multi-user, real-time website" and it
will build the median answer; the crit agents will do this final project as
well so we'll get to see what that looks like. Choosing what is worth
building—the **good** part of the brief—is your job. Small is fine: an app
for twelve people, one street, one book club or one afternoon is on-brief,
and sincere, weird and satirical responses are all ok.

The brief asks what would make the app good rather than what it should do,
because answering the first answers the second. You can't say what good
means for an app without saying who it's for and what it does, and "good"
also asks how well it does it: an app can do everything on its list and still
not be worth using. The same question runs through every crit from here to
the deadline.

The spec doesn't mention accounts, profiles, feeds, rooms or scores. Those
are other apps' answers to questions you now have to answer yourself. Who
counts as "another person": an account, a pseudonym, any anonymous visitor?
What persists forever and what expires? Is there history, or only the
present? Who can see what? Most of the work is in these decisions, including
what not to build.

Design for co-presence: the app should be more interesting because other
people are using it at the same time. The capstone showcase, a room full of
people using it at once, is the situation to design for.

### Your definition of good is part of the harness

Your definition of good lives in three places, and the project is marked on
whether they agree:

- **`README.md` is the argument.** What "good" means for this app, what you
  read or looked at while deciding, and what you chose not to build. GitHub
  renders it, and the deployed app publishes it in full at `/readme/`
  (styled however you like), so a visitor reads it before using the app.
- **`CLAUDE.md` (and any files it references) are the rules.** The standards
  the agent's work must meet, derived from the argument: what the app must
  never do, what every page must hold to, what a change must not break.
- **`spec/` is the checks.** The parts of good that can be tested. "Nobody
  outside the club can read the wall", "a message expires at midnight" and
  "the room holds at most twelve people" are all testable, so create tests
  that make sense for the app you're building.

Some of "good" can be checked and some can only be judged. The strongest
READMEs say which claims are enforced, which are judged, and how the judged
ones were judged. A definition limited to what you can test misses the
point, and so does one that never reaches `CLAUDE.md` or `spec/`.

People have written a lot about what "good" looks like at this scale: the
small web, games made for a handful of friends, tools built for one
workshop. Read some of it, cite it in your README, and discuss your position
in `PROCESS.md`.

### The repo you start with

Your repo comes with a Fly.io app named after it, and you'll get a token by
DM so you can deploy to it by hand while the repo is private. Once you ship
the repo public, CI checks and deploys every push to `main`. The repo holds a
placeholder that serves one page plus your `README.md` at `/readme/`. Deploy
it on the first day, so you know the deploy path works before you've chosen
anything else.

There is no starter app: the stack is yours to choose, and `PROCESS.md` is
where you explain the choice. What's fixed is set out in the comments in
`fly.toml`, the `Dockerfile` and `spec/README.md`: one small machine, one
volume for anything that persists, and two shipped checks, that the app
answers at `/` and that `/readme/` has your README's headings in the HTML the
server sends. Every other check is yours to write. `README.md`, `CLAUDE.md`
and `PROCESS.md` arrive as templates for you to fill in.

## How it threads through the crits

You build it in one repository, from the week 9 crit to the deadline. It's
alive! (week 9) ships a first working version and a first README, All at
once (week 10) makes it real-time and has you write down one decision about
how it behaves with several people in it, and Fly by instruments (week 11)
makes it multi-user and has two classmates use it from the URL alone while
you read the logs. Week 12's studio session is for finishing. Each crit is
marked on its own terms, not on how far along the project is; the assessment
page explains how the one-repo setup works.

Have a first version of your definition of "good" in `README.md` by the week
9 crit, and rewrite it as you go. The `/ship` cutoff tags keep every earlier
version, and the changes between them count as process evidence.

## What you submit

A portfolio of:

- the **deployed application** (a `*.fly.dev` URL)
- the **source repository**, where we read your code and your checks
- **evidence of process**: the same bundle as the static assignments, scaled
  up. That's your `PROCESS.md`, your `CLAUDE.md` (and anything it
  references), the three crit reflections and the commit history behind
  them. The assessment page explains each one and how to cite the record,
  and your repo's `PROCESS.md` template shows the shape. Four things are
  specific to the project:
  - **`README.md` is marked:** **400–600 words** on what good means here,
    with your sources, published in full at `/readme/`.
  - **`PROCESS.md` is rewritten:** it runs to **900–1100 words**, and at each
    of the weeks 9–11 crits you rewrite it rather than append to it, so it
    always describes the project as it stands.
  - **the stack needs a case:** as well as the question the static
    assignments ask (how did you get from this brief to the harness and
    agentic workflow behind your app?), `PROCESS.md` explains why you chose
    your stack and agent workflow, and the trade-offs you weighed. Cite these
    like any other process claim. If you want a structured way to record the
    big decisions, an architecture decision record (ADR) works well: the
    context, the options, what you chose and what it costs. ADRs don't count
    towards the word count, and `PROCESS.md` can link to them rather than
    restate them.
  - **corrections belong in the harness:** when the agent gets something
    wrong, the strongest accounts show the fix landing in `CLAUDE.md` or
    `spec/` (or a bad attempt thrown away), not just a retry until it
    passes.

A piece of advice on the writing: draft `README.md`, `PROCESS.md` and (for
COMP8020) `research-note.md` yourself. An agent can help you find sources,
check citations or spot a gap in the argument. The crit agents will write all
three documents for their own final projects, though, and a document that
reads like theirs tells the marker you've added little to what an agent
produces unprompted.

The submission mechanics, marking environment, deadlines, extensions and
appeals are the same for every task and live on the assessment page.

## How it's marked

The final project (A3) is worth 40% of the course, with the same process /
artefact / response criteria as the two static assignments. Each criterion is
marked out of 100 against the course's shared band descriptors, then
weighted and summed. These weights are for **COMP4020**; COMP8020 reweights
to make room for the research note (see below).

| Criterion                       | Weight |
| -------------------------------- | ------ |
| Legibility of process            | 50%    |
| Deployed full-stack application  | 25%    |
| Response to the brief            | 25%    |

Markers arrive with only the URL and start at `/readme/`, so anything a
newcomer needs to get in has to be on the page. They test the three fixed
requirements like this:

- **Multi-user:** two people in separate Chrome profiles (an incognito
  window counts), so they share no cookies or storage.
- **Real-time:** both sessions on screen at once, one at each marking
  viewport.
- **Persists:** the marker comes back the next day. Your machine stops when
  nobody is using it, so by then it has restarted, and what both people did
  has to still be there.

The top band asks the app to hold up under use it wasn't designed for, such
as two people acting at once or a slow connection.

**Deployed full-stack application** is judged against the three fixed
requirements (multi-user, real-time, persists) and the claims in your
`README.md`. There's no feature checklist, and features that aren't part of
your definition of "good" don't earn extra marks.

**Response to the brief** is judged on your definition of "good". Does it go
beyond "works and looks nice"? Is it argued from sources, and against the
alternatives? Does it say which claims are enforced and which are judged?
Does the app live up to it? The marker reads the README, then `CLAUDE.md`,
then `spec/`, then the app, looking for the same idea in each. The median
answer (a chat room with the nouns swapped), features with no reason to
exist, or a README promising a kind of "good" that the rules and checks
never mention will all mark down here, whether or not the checks pass.

**Legibility of process** is read from `PROCESS.md` against the commit
history and the `CLAUDE.md` and `spec/` it points to. Stack and workflow
choices with no reasons given, or trade-offs that leave no trace in the
commits, count as process asserted rather than shown.

## COMP8020 — critical research note

If you're enrolled in **COMP8020**, your portfolio also includes a
**critical research note** of 600–800 words, worth a quarter of the project
(10% of the course). It takes a position on what good agentic
software-development practice is, or where the field is heading, argued from
the scholarly and practitioner literature. It should synthesise and evaluate
the literature you've engaged with across the course rather than summarise
it. Practitioner writing moves faster than peer review in this field, so
posts, talks and framework documentation are expected sources alongside
scholarly ones; what makes the note scholarly is how you read them (see "how
the course reads its literature" on the course overview page).

Three documents in the portfolio argue a position, each about something
different. `README.md` argues what good means for *this app*, from what you
read while designing it. `PROCESS.md` argues for how *you* worked, from your
own commits. The note argues what good practice looks like *in the field*,
from the literature; an argument that doesn't reach beyond your own project
belongs in one of the other two. It goes in the root of your final-project
repo as `research-note.md`, and is read at the same commit as the rest of
your submission. No crit covers the note, so start reading early (week 10 at
the latest).

There is no word-limit penalty; see the assessment page.

**Critical research note (/100)**

- **HD** — a clear position, argued and defended: sources are weighed against
  each other and put to work, the counter-case is met, and the note is
  scoped tightly enough to carry one argument to its end.
- **D–Cr** — a real position with sound support, but the reading runs to
  summary in places, or the argument thins out before it lands.
- **P** — a topic rather than a position: sources cited and paraphrased, with
  little argument of your own, or an argument the citations don't support.
- **N** — no position, or no meaningful engagement with the literature.

For COMP8020 the three project criteria scale to the remaining
three-quarters: process 35%, deployed app 20%, response to the brief 20%.
COMP4020 students don't write the note.

## Key dates

- **Due:** noon, Monday 9 November 2026 (the first Monday of the exam
  period)
- **Capstone showcase:** Wednesday 11 November 2026, 11am–3pm, Birch
  Building (#35), part of the School of Cybernetics' Cybernetics Showcase.
  An in-person showcase of the cohort's final projects. It isn't a crit and
  carries no marks; come and see what everyone built. It's free, but
  register on Humanitix if you're coming.

This is an individual assessment.

## The spec

The brief on this page poses the problem and leaves room for your response.
The spec is the fixed contract: what the markers consider when judging
whether that response meets the requirements. Some lines can be checked
mechanically; the rest call for human judgement.

- deployed and live at its `*.fly.dev` URL by the deadline, working at both
  marking viewports
- it's multi-user: two or more people, each in their own browser, act on
  shared state, and the app tells them apart by whatever it decides counts
  as a person
- it's real-time: a change one person makes appears in every other open
  session showing it within about a second, with no reload or other action
  by the viewer
- it persists: what someone does in your app is still there when they, or
  anyone else, come back, across sessions, restarts and redeploys
- it's good, by a definition you make and defend: `README.md` says what good
  means here, and the deployed app publishes it in full at `/readme/`
- your own checks in `spec/`, protecting the promises your app makes that
  the build cannot; `pnpm check` and `pnpm check:evidence` pass
- evidence of process is in the repo: PROCESS.md, CLAUDE.md, and a commit
  history that grew with the work; PROCESS.md makes the case for the stack
  and agent workflow you chose
- COMP8020 only: the critical research note, `research-note.md` in the repo
  root — a cited position on good agentic development practice, 600–800
  words

## Related

- [Assessment](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/topics/assessment/)
- [It's alive!](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/crits/08-its-alive/)
- [All at once](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/crits/09-all-at-once/)
- [Fly by instruments](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/crits/10-fly-by-instruments/)
- [Assignment 2](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/assessments/assignment-2/)
- [Week 10: Logs, harnesses and multi-user apps](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/lectures/week-10/)
- [Week 12: Ask me anything](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/lectures/week-12/)
- [Week 8: Decision records and persistence](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/lectures/week-8/)
- [Week 9: Subagents and real-time](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/lectures/week-9/)
