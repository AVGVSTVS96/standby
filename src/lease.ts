export type Lease = {
  holder: string
  tenure: number
  from?: number
  free?: true
  claim?: string
  /** The holder was asked to pass the lease on: a waiter claims it once its copy of the database is current. */
  moving?: true
  /** What the units of the tenure before left for this one as they stopped: the last transaction they streamed. */
  handoff?: string
  /** A machine this tenure's holder took over from that died or was going down: what ran there needs carrying on. */
  left?: string
  /** Out of use (`standby retire`): no machine takes it until `standby init` makes the next tenure. */
  retired?: true
  beat: string
}

export type Seen = { lease: Lease; etag: string }
type Won = Seen & { sent: number }
export type Lost = "fenced" | "left" | "passed"

export interface Store {
  read(): Promise<Seen | null>
  /** Writes only if the lease still has this etag (null: only if there is none). Returns the new etag, or null when it lost. */
  write(lease: Lease, etag: string | null): Promise<string | null>
}

export interface Service {
  start(held: Lease): Promise<void>
  /** Resolves with what the stopped units left for the next holder. */
  stop(): Promise<string | undefined>
  kill(why: string): Promise<void>
  healthy(): Promise<boolean>
  /** The holder renewed the lease with a write sent `ago` ms before: what it runs may keep running until 2/3 TTL after that write. */
  renewed(ago: number): void
}

export type Config = {
  name: string
  ttl: number
  home: boolean
  stable: number
  unhealthy: number
  /** What the run before this one held is still running (standby restarted, as for an update): its tenure, and how long until its fence deadline. */
  inherited?: { tenure: number; within: number }
}

export type Deps = {
  store: Store
  service: Service
  now(): number
  sleep(ms: number): Promise<void>
  beat(): string
  beforeHold(): Promise<void>
  /** While another machine holds `tenure`, keeps a copy of its database: current within moments when `near`. */
  follow(tenure: number, near: boolean): Promise<void>
  /** Whether this machine may claim the lease from `holder` now: its copy is current, and so is what READY looks at. */
  ready(holder: string): Promise<boolean>
  onChange(lease: Lease, mine: boolean, lost?: Lost): void
  /** The machine is going down. */
  stopping(): boolean
  /** Asked to pass the lease on: "away" when this machine is about to sleep. */
  moveAsked(): false | "move" | "away"
  /** Resolves at the next ask, so a holder between renewals acts on it at once. */
  moveSignaled(): Promise<void>
}

/** Reads are cheap, and a waiter that looks often takes a passed lease within a second. */
const poll = (ttl: number) => ttl / 60

export async function run(config: Config, deps: Deps): Promise<void> {
  const { name, ttl } = config
  const { store, service, now, sleep } = deps
  let sitOutUntil = 0
  /** Tenures in a row this machine gave up because its service wouldn't stay up: each doubles how long it sits out. */
  let failures = 0
  let last = ""

  const key = (lease: Lease, mine: boolean) => `${lease.holder} ${lease.tenure} ${lease.free ?? ""} ${mine}`
  const changed = (lease: Lease, mine: boolean, lost?: Lost) => {
    if (key(lease, mine) !== last) deps.onChange(lease, mine, lost)
    last = key(lease, mine)
  }
  const ours = (lease: Lease, tenure: number) => lease.holder === name && lease.tenure === tenure && !lease.free && !lease.retired
  const write = (lease: Omit<Lease, "beat">, etag: string | null) => {
    const next = { ...lease, beat: deps.beat() }
    const sent = now()
    return store.write(next, etag).then((etag) => (etag ? { lease: next, etag, sent } : null))
  }
  const take = (lease: Omit<Lease, "beat">, etag: string | null) => write(lease, etag).catch(() => null)
  const succeed = ({ tenure }: Lease) => ({ holder: name, tenure: tenure + 1, from: tenure })

  if (config.inherited) await resume(config.inherited)
  while (!deps.stopping()) {
    const held = await wait()
    if (held) await hold(held)
  }

  /** Renews the tenure the run before held, leaving what runs untouched, or fences it by the deadline that run's last renewal set. */
  async function resume({ tenure, within }: { tenure: number; within: number }): Promise<void> {
    const deadline = now() + within
    let over = false
    const fence = async (why: string) => {
      if (over) return
      over = true
      await service.kill(why)
    }
    void (async () => {
      while (!over && now() < deadline) await sleep(1000)
      await fence("no renewal since standby restarted")
    })()
    while (!over) {
      const seen = await store.read().catch(() => undefined)
      if (over) return
      if (seen === undefined) {
        await sleep(poll(ttl))
        continue
      }
      if (!seen || !ours(seen.lease, tenure)) return fence(`the lease went to ${seen?.lease.holder ?? "nobody"} while standby restarted`)
      const won = await take(seen.lease, seen.etag)
      if (over) return
      if (!won) {
        await sleep(poll(ttl))
        continue
      }
      over = true
      last = key(won.lease, true)
      return hold(won)
    }
  }

  async function wait(): Promise<Won | null> {
    let stale = { etag: "", since: 0 }
    let healthySince = now()
    let reached = now()
    /** When this machine claimed the lease: the holder passes it as soon as its units stop, so it looks often a while. */
    let claimed = -Infinity
    /** The last lease read, and when that read was sent. */
    let before = { etag: "", sent: -Infinity }
    while (!deps.stopping()) {
      const sent = now()
      const seen = await store.read().catch(() => undefined)
      // A read that failed says nothing: the same ETag seen a TTL apart is what shows the holder is gone.
      if (seen === undefined) {
        if (now() - reached > ttl / 2) healthySince = now()
        await sleep(poll(ttl))
        continue
      }
      reached = now()
      // A lease is made once, by hand (`standby init`): one that went missing must not start again at tenure 1, and a
      // retired one waits for init too.
      if (!seen || seen.lease.retired) {
        before = { etag: seen?.etag ?? "", sent }
        await sleep(poll(ttl))
        continue
      }
      const { lease, etag } = seen
      changed(lease, false)
      const resting = now() < sitOutUntil
      if (stale.etag !== etag) stale = { etag, since: now() }
      const silent = now() - stale.since
      const home = config.home && now() - healthySince >= config.stable

      if (lease.holder === name) {
        // A lease passed to this machine since the last read was written after that read was sent: from then on it's
        // this machine's for 2/3 TTL, as after a renewal, so what it holds starts without waiting on a write.
        if (!resting && before.etag && before.etag !== etag && now() - before.sent < ttl / 6) return { lease, etag, sent: before.sent }
        if (!resting) return take({ ...lease, free: undefined, claim: undefined, moving: undefined, left: lease.left === name ? undefined : lease.left }, etag)
      } else {
        // The copy of the holder's database follows closely once this machine may take the lease: it's free, asked for
        // a move, wanted home, or its holder hasn't renewed it for half a TTL.
        const near = !resting && Boolean(lease.free || lease.moving || lease.claim === name || home || silent >= ttl / 2)
        await deps.follow(lease.tenure, near)
        // A lease nobody holds is taken at once: the copy catches up as the database arrives, or a restore stands in.
        if (!resting && lease.free) return take({ ...succeed(lease), handoff: lease.handoff, left: lease.left }, etag)
        else if (!resting && silent >= ttl) {
          await deps.beforeHold()
          return take({ ...succeed(lease), left: lease.holder }, etag)
        } else if (!resting && !lease.claim && (lease.moving || home) && (await deps.ready(lease.holder)) && (await take({ ...lease, claim: name }, etag))) claimed = now()
      }
      before = { etag, sent }
      await sleep(now() - claimed < ttl ? ttl / 600 : poll(ttl))
    }
    return null
  }

  async function hold(won: Won): Promise<void> {
    let { lease, etag, sent: renewed } = won
    let unhealthySince: number | null = null
    let stopped: Promise<void> | null = null
    let done = false
    let over = false
    const expired = () => now() - renewed > (ttl * 2) / 3
    let away = false
    let gaveUp = false
    /** When a move was asked: it waits for a waiter to claim the lease, which one does once its copy is current. */
    let moving: number | null = null
    let handoff: string | undefined
    const fence = async (why: string) => {
      if (over) return
      over = true
      await service.kill(why)
      changed(lease, false, "fenced")
    }
    const pass = () => {
      stopped ??= service.stop().then((left) => {
        handoff = left
        done = true
      })
    }
    if (expired()) return
    changed(lease, true)
    await service.start(lease)
    const renewal = () => ({ ...lease, moving: moving === null ? undefined : (true as const) })
    // Its own loop, so a renewal still in flight when a frozen machine wakes can't delay the fence. Nobody can take the
    // lease until a full TTL after the last renewal, so past 2/3 TTL it renews by itself until 5/6 TTL before it fences:
    // a machine that froze, or whose renewals were stuck behind a slow health check, keeps what it runs if nobody took over.
    void (async () => {
      while (!over) {
        if (!expired()) {
          await sleep(1000)
          continue
        }
        const left = renewed + (ttl * 5) / 6 - now()
        if (left <= 0 || stopped) return fence(`no renewal for ${Math.round((now() - renewed) / 1000)}s`)
        const won = await Promise.race([write(renewal(), etag).catch(() => null), sleep(left).then(() => null)])
        if (over) return
        if (won) {
          ;({ lease, etag, sent: renewed } = won)
          service.renewed(now() - renewed)
        } else await sleep(Math.max(0, Math.min(1000, renewed + (ttl * 5) / 6 - now())))
      }
    })()

    while (!over) {
      const asked = deps.stopping() ? "away" : deps.moveAsked()
      away ||= asked === "away"
      if (asked === "move") moving ??= now()
      // A machine going away passes the lease at once, and a move nobody claimed within TTL/2 passes it free.
      if (away || lease.claim || (moving !== null && now() - moving >= ttl / 2)) pass()
      else if (await service.healthy()) unhealthySince = null
      else if (now() - (unhealthySince ??= now()) >= config.unhealthy) {
        gaveUp = true
        pass()
      }

      const handing = done
      const awaitingClaim = moving !== null && !stopped
      if (awaitingClaim && lease.moving && now() - renewed < ttl / 6) {
        const seen = await store.read().catch(() => undefined)
        if (over) return
        if (seen && ours(seen.lease, lease.tenure)) ({ lease, etag } = seen)
        else if (seen !== undefined) return fence(`the lease went to ${seen?.lease.holder ?? "nobody"}`)
        await sleep(poll(ttl))
        continue
      }
      const next = !handing
        ? renewal()
        : lease.claim
          ? { holder: lease.claim, tenure: lease.tenure + 1, from: lease.tenure, handoff, left: away ? name : undefined }
          : { ...lease, free: true as const, moving: undefined, handoff, left: away ? name : undefined }
      const written = await write(next, etag).catch(() => undefined)
      if (over) return

      if (written && handing) {
        over = true
        failures = gaveUp ? Math.min(failures + 1, 4) : 0
        // One that passed a move nobody claimed holds back only until a waiter has had time to take it: sitting out
        // longer would leave the lease free if it's moved back meanwhile.
        if (gaveUp) sitOutUntil = now() + config.stable * 2 ** failures
        else if (!lease.claim) sitOutUntil = now() + ttl / 6
        return changed(written.lease, false, away ? "left" : "passed")
      }
      if (written) {
        ;({ lease, etag, sent: renewed } = written)
        service.renewed(now() - renewed)
      } else if (written === null) {
        const current = await store.read().catch(() => undefined)
        if (current && ours(current.lease, lease.tenure)) ({ lease, etag } = current)
        else if (current !== undefined) return fence(`the lease went to ${current?.lease.holder ?? "nobody"}`)
      }
      const rest = sleep(!written ? 1000 : awaitingClaim ? poll(ttl) : ttl / 6)
      await Promise.race([rest, deps.moveSignaled(), ...(stopped && !done ? [stopped] : [])])
    }
  }
}
