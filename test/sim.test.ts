import { expect, test } from "bun:test"
import { run, type Config, type Lease, type Seen, type Store } from "../src/lease"

const TTL = 60_000

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 2 ** 32
  }
}

/** A world of machines on one virtual clock, sharing one lease, where machines freeze, lose the store and restart. */
function world(seed: number, names: string[]) {
  const random = rng(seed)
  let time = 0
  let order = 0
  const timers: { at: number; order: number; machine: Machine; generation?: number; fire: () => void }[] = []
  let writes = 1
  let stored: (Seen & { n: number }) | null = { lease: { holder: names[0]!, tenure: 1, beat: "init" }, etag: "e1", n: 1 }

  type Machine = {
    name: string
    frozenUntil: number
    cutUntil: number
    running: boolean
    generation: number
    tenure?: number
    tenureRuns: number
    move: boolean
    broken: boolean
  }
  const machines = names.map<Machine>((name) => ({ name, frozenUntil: 0, cutUntil: 0, running: false, generation: 0, move: false, broken: false, tenureRuns: 0 }))
  const log: string[] = []
  const say = (text: string) => log.push(`${(time / 1000).toFixed(1).padStart(8)}s ${text}`)

  /** A process that died never wakes: its timers are dropped. */
  const at = (machine: Machine, ms: number) =>
    new Promise<void>((fire) => timers.push({ at: time + ms, order: order++, machine, generation: machine.generation, fire }))

  const store = (machine: Machine): Store => {
    const trip = async () => {
      await at(machine, 20 + random() * 1500)
      if (time < machine.cutUntil || random() < 0.03) {
        await at(machine, random() * 4000)
        throw new Error("unreachable")
      }
    }
    return {
      async read() {
        await trip()
        const now = stored && { lease: stored.lease, etag: stored.etag }
        await at(machine, random() * 300)
        return now
      },
      async write(lease: Lease, etag: string | null) {
        await trip()
        const won = (stored?.etag ?? null) === etag
        if (won) stored = { lease, etag: `e${++writes}`, n: writes }
        const mine = stored!.etag
        await at(machine, random() * 300)
        if (random() < 0.02) throw new Error("answer lost")
        return won ? mine : null
      },
    }
  }

  function boot(machine: Machine, config: Partial<Config> = {}) {
    const generation = ++machine.generation
    const alive = () => machine.generation === generation
    void run(
      { name: machine.name, ttl: TTL, home: machine.name === names[0], stable: 300_000, unhealthy: 120_000, ...config },
      {
        store: store(machine),
        now: () => time,
        sleep: (ms) => at(machine, ms),
        beat: () => `${machine.name}-${order++}`,
        beforeHold: () => at(machine, random() < 0.2 ? 40_000 : 0),
        onChange: () => {},
        stopping: () => !alive(),
        moveAsked: () => (machine.move ? ((machine.move = false), random() < 0.5 ? "move" : "away") : false),
        service: {
          async start(held) {
            if (!alive()) return
            machine.running = true
            machine.tenureRuns++
            machine.tenure = held.tenure
            say(`${machine.name} runs tenure ${held.tenure}`)
          },
          // systemd runs jobs in order: a stop asked before the latest start doesn't undo it.
          async stop() {
            const run = machine.tenureRuns
            await at(machine, random() * 8000)
            if (alive() && run === machine.tenureRuns) machine.running = false
            say(`${machine.name} stopped`)
          },
          async kill(why) {
            if (alive()) machine.running = false
            say(`${machine.name} fenced: ${why}`)
          },
          healthy: async () => !machine.broken,
        },
      },
    ).catch((error) => say(`${machine.name} crashed: ${error}`))
  }

  /** What systemd does when standby dies: the bound target stops, and standby starts again. */
  function restart(machine: Machine) {
    machine.generation++
    machine.running = false
    say(`${machine.name} restarts`)
    timers.push({ at: time + 1000 + random() * 20_000, order: order++, machine, fire: () => boot(machine) })
  }

  const active = () => machines.filter((m) => m.running && time >= m.frozenUntil)

  async function until(end: number, chaos: boolean) {
    let nextChaos = 0
    while (true) {
      const due = (timer: (typeof timers)[number]) => Math.max(timer.at, timer.machine.frozenUntil)
      // Not a subtraction: two timers of a machine frozen for good are both at Infinity.
      timers.sort((a, b) => (due(a) < due(b) ? -1 : due(a) > due(b) ? 1 : a.order - b.order))
      const next = timers[0]
      const at = next ? due(next) : Infinity
      if (at > end) break
      if (at > time) {
        const up = active()
        if (up.length > 1) throw new Error(`two holders at ${time}ms: ${up.map((m) => m.name)}\n${log.slice(-30).join("\n")}`)
      }
      time = at
      timers.shift()
      if (next!.generation !== undefined && next!.generation !== next!.machine.generation) continue
      next!.fire()
      await new Promise((settle) => setImmediate(settle))
      if (chaos && time >= nextChaos) {
        nextChaos = time + random() * 120_000
        const machine = machines[Math.floor(random() * machines.length)]!
        const kind = random()
        if (kind < 0.3) {
          machine.frozenUntil = time + random() * 200_000
          say(`${machine.name} freezes`)
        } else if (kind < 0.6) {
          machine.cutUntil = time + random() * 200_000
          say(`${machine.name} is cut off`)
        } else if (kind < 0.8) restart(machine)
        else if (kind < 0.9) machine.move = machine.running
        else machine.broken = !machine.broken
      }
    }
    time = end
  }

  for (const machine of machines) boot(machine)
  return { until, active, machines, log, time: () => time, lease: () => stored?.lease, restart }
}

test("never two holders, through freezes, cut connections, restarts and moves", async () => {
  for (let seed = 1; seed <= 300; seed++) {
    const w = world(seed, seed % 3 ? ["server", "twin"] : ["server", "twin", "third"])
    await w.until(3_600_000, true)
  }
}, 600_000)

test("once the trouble ends, exactly one machine holds, and home gets it back", async () => {
  for (let seed = 1; seed <= 100; seed++) {
    const w = world(seed, ["server", "twin"])
    await w.until(1_800_000, true)
    for (const machine of w.machines) machine.broken = false
    await w.until(w.time() + 6_000_000, false)
    const up = w.active().map((m) => m.name)
    if (up.join() !== "server") throw new Error(`seed ${seed}: ${up} holds, lease ${JSON.stringify(w.lease())}, ${JSON.stringify(w.machines)}\n${w.log.slice(-12).join("\n")}`)
  }
}, 600_000)

test("a holder that goes silent is replaced after one ttl, on the next tenure", async () => {
  const w = world(7, ["server", "twin"])
  await w.until(120_000, false)
  const [server, twin] = w.machines
  const first = w.active()[0]!
  const other = first === server ? twin! : server!
  first.frozenUntil = Infinity
  const tenure = w.lease()!.tenure
  await w.until(w.time() + TTL + 60_000, false)
  expect(w.active().map((m) => m.name)).toEqual([other.name])
  expect(w.lease()).toMatchObject({ holder: other.name, tenure: tenure + 1, from: tenure })
})

test("a holder that restarts keeps its tenure, so it keeps its database", async () => {
  const w = world(11, ["server"])
  await w.until(60_000, false)
  const tenure = w.lease()!.tenure
  w.restart(w.machines[0]!)
  await w.until(w.time() + 60_000, false)
  expect(w.active()).toHaveLength(1)
  expect(w.lease()!.tenure).toBe(tenure)
})
