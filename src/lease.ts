export type Lease = {
  holder: string
  tenure: number
  from?: number
  free?: true
  claim?: string
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
  stop(): Promise<void>
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
  onChange(lease: Lease, mine: boolean, lost?: Lost): void
  /** The machine is going down. */
  stopping(): boolean
  /** Asked to pass the lease on: "away" when this machine is about to sleep. */
  moveAsked(): false | "move" | "away"
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
    while (!deps.stopping()) {
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
        await sleep(poll(ttl))
        continue
      }
      const { lease, etag } = seen
      changed(lease, false)
      const resting = now() < sitOutUntil
      if (stale.etag !== etag) stale = { etag, since: now() }

      if (lease.holder === name) {
        if (!resting) return take({ ...lease, free: undefined, claim: undefined, left: lease.left === name ? undefined : lease.left }, etag)
      } else if (lease.free && !resting) {
        return take({ ...succeed(lease), left: lease.left }, etag)
      } else if (now() - stale.since >= ttl && !resting) {
        await deps.beforeHold()
        return take({ ...succeed(lease), left: lease.holder }, etag)
      } else if (config.home && !resting && !lease.claim && !lease.free && now() - healthySince >= config.stable) {
        await take({ ...lease, claim: name }, etag)
      }
      await sleep(poll(ttl))
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
    const fence = async (why: string) => {
      if (over) return
      over = true
      await service.kill(why)
      changed(lease, false, "fenced")
    }
    const pass = () => {
      stopped ??= service.stop().then(() => void (done = true))
    }
    if (expired()) return
    changed(lease, true)
    await service.start(lease)
    // Its own loop, so a renewal still in flight when a frozen machine wakes can't delay the fence.
    void (async () => {
      while (!over && !expired()) await sleep(1000)
      await fence(`no renewal for ${Math.round((now() - renewed) / 1000)}s`)
    })()

    while (!over) {
      const asked = deps.stopping() ? "away" : deps.moveAsked()
      away ||= asked === "away"
      if (asked || lease.claim) pass()
      else if (await service.healthy()) unhealthySince = null
      else if (now() - (unhealthySince ??= now()) >= config.unhealthy) {
        gaveUp = true
        pass()
      }

      const handing = done
      const next = !handing
        ? lease
        : lease.claim
          ? { holder: lease.claim, tenure: lease.tenure + 1, from: lease.tenure, left: away ? name : undefined }
          : { ...lease, free: true as const, left: away ? name : undefined }
      const written = await write(next, etag).catch(() => undefined)
      if (over) return

      if (written && handing) {
        over = true
        failures = gaveUp ? Math.min(failures + 1, 4) : 0
        if (gaveUp || !lease.claim) sitOutUntil = now() + config.stable * 2 ** failures
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
      const rest = sleep(written ? ttl / 6 : 1000)
      await (stopped && !done ? Promise.race([rest, stopped]) : rest)
    }
  }
}
