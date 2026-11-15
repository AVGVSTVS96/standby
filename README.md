# standby

Runs a service on exactly one of several machines, and moves it when that machine goes away.

One rule: **the service runs only on the machine that holds the lease.**

The lease is one small object in S3-compatible storage. Only one machine can win it (a conditional write), and it runs out unless the holder keeps renewing it. Machines never ask each other anything: each one wins the lease or waits. A SQLite database follows the lease through [Litestream](https://litestream.io) and the same bucket.

```
            bucket
   lease.json      db/<tenure>/…
      │  ▲              ▲  │
 renew│  │watch   stream│  │restore
      ▼  │              │  ▼
  ┌─────────┐       ┌─────────┐
  │ holder  │       │ waiter  │
  │ standby │       │ standby │
  │ target ↑│       │ target ↓│
  └─────────┘       └─────────┘
```

## The lease

`lease.json`: `{ holder, tenure, claim?, beat }`. Every write is a compare-and-swap on the object's ETag (`If-Match`), and carries a random `beat`, since a store may give identical bodies identical ETags. The lease is made once, by `standby init` on the machine that should hold it: a lease that went missing is never started again at tenure 1 by itself.

- **Holding.** The holder rewrites the lease every `TTL/6`. If no write has succeeded for `2/3 TTL`, or a write comes back 412 and the lease now names someone else, it stops being the holder at once. Both the monotonic and the wall clock count, so a machine that slept or froze knows.
- **Waiting.** A waiter reads the lease every `TTL/60` (reads are cheap, and it takes a passed lease within a second). Once it has seen the same ETag for a full `TTL` on its own clock, the holder is gone and the waiter writes itself in. No clocks are compared between machines.
- **Tenure** goes up by one each time the holder changes. It names the database's replica path, `db/<tenure>`, so a machine that froze and woke after losing the lease can only write where nobody reads.
- **Passing it on.** A holder that is shutting down, was told to move (`standby move`), or can't keep its service up for `UNHEALTHY` seconds, stops the service and writes the next holder in: the machine in `claim`, or nobody. One that gave up on its service then sits out `STABLE`, doubled for each tenure in a row it gave up (up to 16 times), so a machine that can't run the service doesn't keep taking it back.
- **Home.** A machine with `HOME_MACHINE=1` that has waited healthily for `STABLE` seconds writes its name into `claim`. The holder sees it at its next renewal and passes the lease on.

## systemd is the state

`standby.service` runs on every machine. While it holds the lease, `$XDG_RUNTIME_DIR/standby/held` exists (an env file: `TENURE`, `FROM`, the tenure before, and `LEFT`, a machine that went away) and standby starts `UNIT`, a target you define:

```ini
# your.target
[Unit]
BindsTo=standby.service
After=standby.service
ConditionPathExists=%t/standby/held
```

Everything that must run on one machine binds to that target, in a drop-in:

```ini
[Unit]
BindsTo=your.target
After=your.target
```

So nothing starts it without the lease, it stops before standby passes the lease on (and before standby itself, when the machine goes down), and when the lease is lost standby kills it outright, whatever its own stop would take. When standby itself dies or hangs (`WatchdogSec`), `ExecStopPost` does the same. There is no holder file and no start-up check to pass or skip: a unit is up because the lease is held.

The database is three units in that target, ordered before the service: restore (`db/<FROM>`, skipped when this disk ran that tenure or this one; what a disk wrote that never reached the bucket is kept beside it as `<db>.ran-<tenure>`), `litestream replicate` to `db/<TENURE>`, then the service, which stops first so its last writes are streamed.

## One hook

`ON_CHANGE` runs whenever the lease this machine sees changes, with `HOLDER`, `TENURE` and `MINE` in its environment. Notifications, DNS names, resizing a cloud machine before it takes over (`BEFORE_HOLD`) live there, outside standby.

## Settings

`~/.config/standby.env`: `BUCKET`, `ENDPOINT`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `UNIT`, and optionally `NAME` (hostname), `TTL` (60), `HOME_MACHINE`, `STABLE` (300), `UNHEALTHY` (120), `ON_CHANGE`, `BEFORE_HOLD`.

## Commands

`standby run` (the service) · `standby init [tenure]` (make the lease, once) · `standby status` · `standby move` (pass the lease on now) · `standby drill [off]` (act cut off from the bucket, to rehearse an outage without one).

## Install

Each machine builds a tagged release into a folder of that version's own, somewhere nothing syncs, and the units name the version:

```sh
git clone --depth 1 --branch v0.1.1 https://github.com/AVGVSTVS96/standby ~/.local/share/standby/v0.1.1
cd ~/.local/share/standby/v0.1.1 && bun install && bun test && bun run build
```

A half-saved edit can't go live, and moving to a new version is a change of the path in `standby.service`. Restarting standby on the holder restarts what it holds, on the same lease and tenure.

## Proof

`bun test` runs the simulation. `bun run rig` runs the outages for real: machines in podman containers with systemd, Litestream and a toy service, sharing one S3 store, each test on fresh machines, printing pass or fail and how long each move took (`bun run rig kill move` runs only those).

## What it costs

The bucket is a dependency: a holder that can't reach it for `2/3 TTL` stops its service, and nobody can take over while the bucket is down. A takeover after a crash takes `TTL` plus the restore, and loses at most Litestream's sync interval (1s) of writes; until a new holder's first snapshot is up, a second crash falls back to the previous tenure.
