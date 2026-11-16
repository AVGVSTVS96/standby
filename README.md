# standby

Runs a service on exactly one of several machines, and moves it when that machine goes away.

One rule: **the service runs only on the machine that holds the lease.**

The lease is one small object in S3-compatible storage. Only one machine can win it (a conditional write), and it runs out unless the holder keeps renewing it. Machines never ask each other anything: each one wins the lease or waits. A SQLite database follows the lease through [Litestream](https://litestream.io) and the same bucket, and every waiter keeps a warm copy of it, so a planned move starts the service on the new machine within a second or two of its last write on the old one.

```
            bucket
   lease.json      db/<tenure>/…
      │  ▲              ▲  │
 renew│  │watch   stream│  │follow
      ▼  │              │  ▼
  ┌─────────┐       ┌─────────┐
  │ holder  │       │ waiter  │
  │ standby │       │ standby │
  │ target ↑│       │ copy    │
  └─────────┘       └─────────┘
```

## The lease

`lease.json`: `{ holder, tenure, from?, free?, claim?, moving?, handoff?, left?, retired?, beat }`. Every write is a compare-and-swap on the object's ETag (`If-Match`), and carries a random `beat`, since a store may give identical bodies identical ETags. The lease is made once, by `standby init` on the machine that should hold it: a lease that went missing is never started again at tenure 1 by itself. `standby retire` takes it out of use: its holder stops at its next renewal, no waiter takes it, and the next `standby init` makes the tenure after it.

- **Holding.** The holder rewrites the lease every `TTL/6`. If no write has succeeded for `2/3 TTL`, or a write comes back 412 and the lease now names someone else, it stops being the holder at once. Both the monotonic and the wall clock count, so a machine that slept or froze knows.
- **Waiting.** A waiter reads the lease every `TTL/60` (reads are cheap, and it takes a passed lease within a second), every `TTL/600` for a `TTL` after it claimed the lease. Once it has seen the same ETag for a full `TTL` on its own clock, the holder is gone and the waiter writes itself in. No clocks are compared between machines. A lease passed to it since its last read was written after that read was sent, so it may run the service from then for `2/3 TTL`, as after a renewal: it starts at once and renews as it does.
- **Tenure** goes up by one each time the holder changes. It names the database's replica path, `db/<tenure>`, so a machine that froze and woke after losing the lease can only write where nobody reads.
- **Passing it on.** A holder that is shutting down, or can't keep what its target `Upholds=` up for `UNHEALTHY` seconds, stops the service and writes the next holder in: the machine in `claim`, or nobody. One that gave up on its service then sits out `STABLE`, doubled for each tenure in a row it gave up (up to 16 times), so a machine that can't run the service doesn't keep taking it back. With the lease goes `handoff`, the last transaction the database's stream sent as it stopped.
- **Moving.** `standby move` marks the lease `moving` and keeps the service running. A waiter whose copy of the database is current writes its name into `claim`, and the holder, looking every `TTL/60` while it waits, stops the service and passes the lease to it. A move nobody claims within `TTL/2` passes the lease to nobody, for the first waiter to take; the machine that passed it takes it back only after `TTL/6`.
- **Home.** A machine with `HOME_MACHINE=1` that has waited healthily for `STABLE` seconds writes its name into `claim`. The holder sees it at its next renewal and passes the lease on.

## systemd is the state

`standby.service` runs on every machine. While it holds the lease, `$XDG_RUNTIME_DIR/standby/held` exists (an env file: `TENURE`, `FROM`, the tenure before, `LEFT`, a machine that went away, and `HANDOFF`, the last transaction of the tenure before) and standby starts `UNIT`, a target you define:

```ini
# your.target
[Unit]
After=standby.service
ConditionPathExists=%t/standby/held
# What must be up to keep the lease: systemd starts it again whenever it's down, and standby passes the lease on when it can't.
Upholds=your.service
```

Everything that must run on one machine binds to that target, in a drop-in:

```ini
[Unit]
BindsTo=your.target
After=your.target
ConditionPathExists=%t/standby/held
```

So nothing starts it without the lease, it stops before standby passes the lease on (and before standby itself, when the machine goes down), and when the lease is lost standby kills it outright, whatever its own stop would take. A unit is up because the lease is held.

**When standby itself dies**, crashes, hangs past `WatchdogSec` or fails to start, what it holds runs on while its last renewal covers it, `2/3 TTL`, and systemd starts standby again, which renews the same tenure. `ExecStopPost` (`standby fence`) sets a timer for the moment that renewal runs out: `standby lapse` then stops everything, as a lost lease would, unless a renewal came since. Only a stop on purpose (`systemctl stop`, or the machine going down) stops it at once. `WatchdogSec` must be at most `TTL/3`, so a standby that hangs is replaced, and renews, in time; standby refuses to run otherwise.

The target is only ordered after standby, never bound to it, and nothing in it depends on another unit's restart: a `daemon-reload`, a restart of standby or of one service in the target, stops nothing else. systemd stops what is bound to a target that is inactive at a reload, so a target with units bound to it is never left inactive while they run.

**Restarting standby** (an update: `systemctl restart`, `RuntimeDirectoryPreserve=restart` keeps the held file) is the same: what it holds runs on, and the new run renews the same tenure. A plain `systemctl stop` stops what it holds and lets the lease run out.

## The database

The database is three units in that target, ordered before the service: `db-arrive`, `litestream replicate` to `db/<TENURE>`, then the service, which stops first so its last writes are streamed. As the stream stops, `db-handoff` records the last transaction it sent, which standby passes on with the lease.

On every other machine a fourth unit, `FOLLOW` (`db-follow`), keeps a copy of the holder's database at `<db>.follow-<tenure>` with `litestream restore -f`: it looks for new transactions every `EVERY` (60s), and every `NEAR_EVERY` (250ms) once this machine may take over any moment: the lease is free, moving, claimed by it or wanted home, or its holder hasn't renewed it for `TTL/2`. standby restarts it, with that tenure and that pace in `%t/standby/following`, whenever either changes, and counts the copy current, so this machine may claim a move, once its start completes (`Type=notify`): when the copy has the newest transaction the bucket had as it started, and once near, the newest a fresh look finds.

`db-arrive` makes the database the lease's tenure runs on:

1. A disk that ran this tenure, or the one just before it, keeps its copy.
2. Otherwise it takes the warm copy once that has `HANDOFF`, or after a crash all the bucket has, waiting up to `PATIENCE` (10s). It stops the follower holding a read lock on the copy, so a page can't be half written, and uses the copy only if the transaction the follower last finished is that one: a copy the follower was killed in the middle of writing is always behind it, and one that fell behind is never started.
3. Otherwise it restores the newest earlier tenure that has a snapshot in the bucket.

What a disk wrote that never reached the bucket is kept beside it as `<db>.ran-<tenure>`.

The follower needs Litestream with [#1606](https://github.com/benbjohnson/litestream/pull/1606) (after 0.5.18): before it, each look that finds nothing new lists every compaction level, 9 requests instead of 1, which costs a third of R2's free requests at one look a minute and slows a near follower to one look every couple of seconds.

## One hook

`ON_CHANGE` runs whenever the lease this machine sees changes, with `HOLDER`, `TENURE` and `MINE` in its environment, `LEFT` (a machine that went down or to sleep holding it) and `LOST` (how this machine stopped holding it: `passed`, `left` or `fenced`). Notifications, DNS names, resizing a cloud machine before it takes over (`BEFORE_HOLD`) live there, outside standby.

## Settings

`~/.config/standby.env`: `BUCKET`, `ENDPOINT`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `UNIT`, and optionally `NAME` (hostname), `TTL` (60), `HOME_MACHINE`, `STABLE` (300), `UNHEALTHY` (120), `ON_CHANGE`, `BEFORE_HOLD`, `FOLLOW` (the unit that keeps the warm copy). The database's units read `DB` and `REPLICA` there too.

## Commands

`standby run` (the service) · `standby init [tenure]` (make the lease, once, or after a retire) · `standby retire` (take it out of use) · `standby status` · `standby move` (pass the lease to a waiter with a current copy) · `standby move --away` (pass it on now, as before sleep) · `standby drill [off]` (act cut off from the bucket, to rehearse an outage without one) · `standby fence` and `standby lapse` (for systemd).

## Install

Each machine builds a tagged release into a folder of that version's own, somewhere nothing syncs, and the units name the version:

```sh
git clone --depth 1 --branch v0.3.0 https://github.com/AVGVSTVS96/standby ~/.local/share/standby/v0.3.0
cd ~/.local/share/standby/v0.3.0 && bun install && bun test && bun run build
```

A half-saved edit can't go live, and moving to a new version is a change of the path in `standby.service` and a restart, which leaves what the holder runs running.

## Proof

`bun test` runs the simulation. `bun run rig` runs the outages for real: machines in podman containers with systemd, Litestream and a toy service, sharing one S3 store, each test on fresh machines, printing pass or fail and how long each move took (`bun run rig kill move` runs only those).

What the rig showed for v0.3.0, on a host so short on IO that its numbers are upper bounds:

- **Planned moves** (`far`: a 120 MB database, 200ms added to every request, a write every 0.2s): 1.1s, 2.7s, 2.4s and 1.9s from the last write on the old machine to the first on the new, each on the warm copy with every row. Of that, about 0.5s is Litestream's last sync, and the rest the lease passing and being seen across the added distance.
- **A torn copy** (`tear`): 6 moves with the follower killed at random through 2 MB transactions, half of them as the database arrived. Every database started whole and at the old machine's last row: 3 on the copy, 3 restored.
- **A stale copy** (`stale`): a follower that stops fetching as a move begins is never started on; the new machine restores instead, at the old one's last row.
- **standby killed** (`standby-9`), **hung** (`hung`) or **restarted** (`restart`) on the holder: what it held ran on, on the same tenure and processes, and the next run renewed in time.
- **standby gone for good** (`standby-gone`): what it held stopped 8.1s after its last renewal (`2/3 TTL` is 8s there), before the other machine took over.

## What it costs

Counted at the rig's store at `TTL` 60, per machine, and what that makes a month against R2's free tier (1M class A: writes and lists; 10M class B: reads):

- The lease: the holder renews it every `TTL/6` (260k writes a month) and each waiter reads it every `TTL/60` (2.6M reads a month).
- The holder's stream: a write for each second that has new transactions, so up to 2.6M a month for a database written every second, and 10 to 15 lists a minute (450k to 650k a month) for Litestream's compaction and retention.
- A waiter's copy: one list a minute while far (43k a month), four a second while near, and a read for each transaction file.

The bucket is a dependency: a holder that can't reach it for `2/3 TTL` stops its service, and nobody can take over while the bucket is down. A takeover after a crash takes `TTL` plus the restore, and loses at most Litestream's sync interval (1s) of writes; until a new holder's first snapshot is up, a second crash falls back to the previous tenure.
