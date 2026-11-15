export type Lease = {
  holder: string
  tenure: number
  from?: number
  free?: true
  claim?: string
  beat: string
}

export type Seen = { lease: Lease; etag: string }
type Won = Seen & { sent: number }

export interface Store {
  read(): Promise<Seen | null>
  /** Writes only if the lease still has this etag (null: only if there is none). Returns the new etag, or null when it lost. */
  write(lease: Lease, etag: string | null): Promise<string | null>
}

export interface Service {
  start(held: { tenure: number; from?: number }): Promise<void>
  stop(): Promise<void>
  kill(why: string): Promise<void>
  healthy(): Promise<boolean>
}

export type Config = {
  name: string
  ttl: number
  home: boolean
  stable: number
  unhealthy: number
}

export type Deps = {
  store: Store
  service: Service
  now(): number
  sleep(ms: number): Promise<void>
  beat(): string
  beforeHold(): Promise<void>
  onChange(lease: Lease, mine: boolean): void
  stopping(): boolean
  moveAsked(): boolean
}

const poll = (ttl: number) => ttl / 12

export async function run(config: Config, deps: Deps): Promise<void> {
  const { name, ttl } = config
  const { store, service, now, sleep } = deps
  let sitOutUntil = 0
  let last = ""

  const changed = (lease: Lease, mine: boolean) => {
    const key = `${lease.holder} ${lease.tenure} ${lease.free ?? ""} ${mine}`
    if (key !== last) deps.onChange(lease, mine)
    last = key
  }
  const write = (lease: Omit<Lease, "beat">, etag: string | null) => {
    const next = { ...lease, beat: deps.beat() }
    const sent = now()
    return store.write(next, etag).then((etag) => (etag ? { lease: next, etag, sent } : null))
  }
  const take = (lease: Omit<Lease, "beat">, etag: string | null) => write(lease, etag).catch(() => null)
  const succeed = ({ tenure }: Lease) => ({ holder: name, tenure: tenure + 1, from: tenure })

  while (!deps.stopping()) {
    const held = await wait()
    if (held) await hold(held)
  }

  async function wait(): Promise<Won | null> {
    let stale = { etag: "", since: 0 }
    let healthySince = now()
    let reached = now()
    while (!deps.stopping()) {
      const seen = await store.read().catch(() => undefined)
      if (seen === undefined) {
        stale = { etag: "", since: 0 }
        if (now() - reached > ttl / 2) healthySince = now()
        await sleep(poll(ttl))
        continue
      }
      reached = now()
      if (!seen) return take({ holder: name, tenure: 1 }, null)
      const { lease, etag } = seen
      changed(lease, false)
      const resting = now() < sitOutUntil
      if (stale.etag !== etag) stale = { etag, since: now() }

      if (lease.holder === name) {
        if (!resting) return take({ ...lease, free: undefined, claim: undefined }, etag)
      } else if (lease.free && !resting) {
        return take(succeed(lease), etag)
      } else if (now() - stale.since >= ttl && !resting) {
        await deps.beforeHold()
        return take(succeed(lease), etag)
      } else if (config.home && !lease.claim && !lease.free && now() - healthySince >= config.stable) {
        await take({ ...lease, claim: name }, etag)
      }
      await sleep(lease.claim === name ? poll(ttl) / 5 : poll(ttl))
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
    const fence = async (why: string) => {
      if (over) return
      over = true
      await service.kill(why)
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
      if (deps.stopping() || deps.moveAsked() || lease.claim) pass()
      else if (await service.healthy()) unhealthySince = null
      else if (now() - (unhealthySince ??= now()) >= config.unhealthy) pass()

      const handing = done
      const next = !handing
        ? lease
        : lease.claim
          ? { holder: lease.claim, tenure: lease.tenure + 1, from: lease.tenure }
          : { ...lease, free: true as const }
      const written = await write(next, etag).catch(() => undefined)
      if (over) return

      if (written && handing) {
        over = true
        if (!lease.claim) sitOutUntil = now() + config.stable
        return changed(written.lease, false)
      }
      if (written) {
        ;({ lease, etag, sent: renewed } = written)
      } else if (written === null) {
        const current = await store.read().catch(() => undefined)
        const mine = current && current.lease.holder === name && current.lease.tenure === lease.tenure && !current.lease.free
        if (mine) ({ lease, etag } = current)
        else if (current !== undefined) return fence(`the lease went to ${current?.lease.holder ?? "nobody"}`)
      }
      const rest = sleep(written ? ttl / 6 : 1000)
      await (stopped && !done ? Promise.race([rest, stopped]) : rest)
    }
  }
}
