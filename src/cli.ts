#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"
import { $ } from "bun"
import { dlopen, FFIType, ptr } from "bun:ffi"
import { run, type Service } from "./lease"
import { enforcesConditions, s3, type Bucket } from "./s3"

const home = process.env.HOME!
const file = process.env.STANDBY_ENV ?? join(home, ".config/standby.env")
const settings: Record<string, string | undefined> = { ...process.env }
if (existsSync(file)) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const [, key, value] = line.match(/^([A-Z_]+)=["']?(.*?)["']?$/) ?? []
    if (key) settings[key] ??= value
  }
}
const need = (key: string) => settings[key] ?? exit(`standby: ${key} isn't set in ${file}`)
const seconds = (key: string, fallback: number) => Number(settings[key] ?? fallback) * 1000
const exit = (why: string): never => {
  console.error(why)
  process.exit(2)
}

const name = settings.NAME ?? hostname()
const unit = need("UNIT")
const ttl = seconds("TTL", 60)
const runtime = join(process.env.XDG_RUNTIME_DIR ?? "/tmp", "standby")
const held = join(runtime, "held")
const handoff = join(runtime, "handoff")
const following = join(runtime, "following")
const follower = settings.FOLLOW
const drill = join(runtime, "drill")
// Only what talks to the bucket needs its settings: the fence must work without them.
let bucket: Bucket | undefined
const settingsOfBucket = () =>
  (bucket ??= { endpoint: need("ENDPOINT"), bucket: need("BUCKET"), accessKeyId: need("AWS_ACCESS_KEY_ID"), secretAccessKey: need("AWS_SECRET_ACCESS_KEY") })
let opened: ReturnType<typeof s3> | undefined
const store = () => (opened ??= s3(settingsOfBucket(), () => existsSync(drill)))
const systemctl = (...args: string[]) => $`systemctl --user ${args}`.nothrow().quiet()
const hook = (command: string | undefined, env: Record<string, string> = {}, timeout?: number) =>
  command ? Bun.spawn(["sh", "-c", command], { env: { ...process.env, ...env }, stdio: ["ignore", "inherit", "inherit"], timeout }).exited : undefined
const words = async (...args: string[]) => (await systemctl(...args).text()).split(/\s+/).filter(Boolean)

/**
 * Everything bound to the target goes at once: a unit's own stop could outlast the lease. The held file goes last, as
 * it's what tells the fence there's something to stop.
 */
async function stopNow() {
  const bound = await words("show", "-p", "BoundBy", "--value", unit)
  await systemctl("stop", "--no-block", unit)
  if (bound.length) await systemctl("kill", "--signal=KILL", ...bound)
  rmSync(held, { force: true })
}

/** What systemd is doing to this standby: "restart" (an update), "stop" (on purpose), or nothing (it died). */
async function job() {
  const self = readFileSync("/proc/self/cgroup", "utf8").trim().split("/").at(-1)!
  return (await words("list-jobs", "--no-legend", self))[2]
}

/** The last renewal no longer lets what this machine holds run. */
const lapsed = () => !existsSync(held) || statSync(held).mtimeMs + (ttl * 2) / 3 <= Date.now()
const self = process.argv[1]?.startsWith("/$bunfs/") ? [process.execPath] : [process.execPath, process.argv[1]!]

/** The tenure the run before this one held, if what it held still runs, and how long its last renewal lets it run on. */
async function inherited() {
  if (!existsSync(held) || (await systemctl("is-active", "-q", unit)).exitCode !== 0) return undefined
  const tenure = Number(readFileSync(held, "utf8").match(/^TENURE=(\d+)$/m)?.[1])
  return tenure ? { tenure, within: statSync(held).mtimeMs + (ttl * 2) / 3 - Date.now() } : undefined
}

const service: Service = {
  async start({ tenure, from, left, handoff: last }) {
    rmSync(handoff, { force: true })
    writeFileSync(held, `TENURE=${tenure}\nFROM=${from ?? ""}\nLEFT=${left ?? ""}\nHANDOFF=${last ?? ""}\n`)
    console.log(`standby: ${name} holds the lease, tenure ${tenure}`)
    await systemctl("start", "--no-block", unit)
  },
  async stop() {
    await systemctl("stop", "--no-block", unit)
    rmSync(held, { force: true })
    await systemctl("stop", unit)
    return existsSync(handoff) ? readFileSync(handoff, "utf8").trim() || undefined : undefined
  },
  async kill(why) {
    console.error(`standby: ${name} lost the lease (${why})`)
    await stopNow()
  },
  async healthy() {
    const upheld = await words("show", "-p", "Upholds", "--value", unit)
    // is-active passes when any one unit is active, so each one's state is read. A unit stopping to restart, as for an
    // update, is on its way back within its own stop timeout, however long that stop takes.
    const states = await words("is-active", ...upheld)
    const jobs = (await systemctl("list-jobs", "--no-legend", ...upheld).text()).split("\n").map((line) => line.trim().split(/\s+/))
    const restarting = new Set(jobs.filter(([, , type]) => type === "restart").map(([, name]) => name))
    return states.every((state, i) => state === "active" || (state === "deactivating" && restarting.has(upheld[i]!)))
  },
  // The held file's time is the last renewal's, for a restarted standby to know its fence deadline.
  renewed(ago) {
    const at = new Date(Date.now() - ago)
    if (!existsSync(held)) return
    const gap = at.getTime() - statSync(held).mtimeMs
    if (gap > (ttl * 2) / 3) console.log(`standby: ${name} renewed the lease ${Math.round(gap / 1000)}s after the last renewal, before anyone could take it`)
    utimesSync(held, at, at)
  },
}

const commands: Record<string, () => Promise<void>> = {
  async run() {
    if (!(await enforcesConditions(settingsOfBucket()))) exit("standby: this bucket doesn't enforce conditional writes, so two machines could both win the lease")
    mkdirSync(runtime, { recursive: true })
    const before = await inherited()
    if (before) console.log(`standby: ${name} restarted holding tenure ${before.tenure}, which keeps running while it renews the lease`)
    else rmSync(held, { force: true })
    const started = { clock: performance.now(), wall: Date.now() }
    const watchdog = Number(process.env.WATCHDOG_USEC ?? 0) / 1000
    // A standby that hangs is replaced at the watchdog, and the next run must renew before the last renewal runs out.
    if (watchdog > ttl / 3) exit(`standby: WatchdogSec is ${watchdog / 1000}s, more than TTL/3 (${ttl / 3000}s), so a hung standby could outlast its lease`)
    if (watchdog) {
      // From this process itself: a systemd-notify per ping is a new process to load, which waits on systemd, and a
      // machine short on IO can hold either up past the watchdog.
      const { symbols } = dlopen("libsystemd.so.0", { sd_notify: { args: [FFIType.i32, FFIType.ptr], returns: FFIType.i32 } })
      const ping = Buffer.from("WATCHDOG=1\0")
      setInterval(() => symbols.sd_notify(0, ptr(ping)), watchdog / 4).unref()
    }
    let stopping = false
    let move: false | "move" | "away" = false
    let signaled = Promise.withResolvers<void>()
    const ask = (kind: "move" | "away") => {
      move = kind
      signaled.resolve()
      signaled = Promise.withResolvers<void>()
    }
    process.on("SIGUSR1", () => ask("move"))
    process.on("SIGUSR2", () => ask("away"))
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.on(signal, async () => {
        // A restart leaves what it holds running, for the next run to renew; a machine going down passes the lease on
        // first; a plain stop stops what it holds and lets the lease run out. A waiter holds nothing to stop.
        if ((await job()) === "restart") process.exit(0)
        if ((await $`systemctl is-system-running`.nothrow().text()).trim() === "stopping") return void (stopping = true)
        if (existsSync(held)) await service.stop()
        process.exit(0)
      })
    }
    await run(
      { name, ttl, home: settings.HOME_MACHINE === "1", stable: seconds("STABLE", 300), unhealthy: seconds("UNHEALTHY", 120), inherited: before },
      {
        store: store(),
        service,
        // A suspended machine's monotonic clock stands still, so the wall clock counts too.
        now: () => Math.max(performance.now() - started.clock, Date.now() - started.wall),
        sleep: (ms) => Bun.sleep(ms),
        beat: () => crypto.randomUUID(),
        beforeHold: async () => void (await hook(settings.BEFORE_HOLD)),
        // FOLLOW restarts with what it should follow.
        async follow(tenure, near) {
          if (!follower) return
          const want = `TENURE=${tenure}\nNEAR=${near ? 1 : ""}\n`
          if (existsSync(following) && readFileSync(following, "utf8") === want) return
          writeFileSync(following, want)
          await systemctl("restart", "--no-block", follower)
        },
        // Active is ready (Type=notify), once no restart is queued that would make it follow anew.
        ready: async (holder) =>
          (!follower || ((await systemctl("is-active", "-q", follower)).exitCode === 0 && !(await words("list-jobs", "--no-legend", follower)).length)) &&
          (await (hook(settings.READY, { HOLDER: holder }, ttl / 6) ?? 0)) === 0,
        onChange: (lease, mine, lost) =>
          void hook(settings.ON_CHANGE, { HOLDER: lease.free ? "" : lease.holder, TENURE: String(lease.tenure), MINE: mine ? "1" : "", LEFT: lease.left ?? "", LOST: lost ?? "" }),
        stopping: () => stopping,
        moveAsked: () => {
          const asked = move
          move = false
          return asked
        },
        moveSignaled: () => signaled.promise,
      },
    )
  },
  /**
   * Makes the lease, held by this machine, whose database is the one kept: once, or after `standby retire`, at the tenure
   * after the retired one. `standby init [tenure]` sets the tenure when replacing a lease that was lost.
   */
  async init() {
    const seen = await store().read()
    if (seen && !seen.lease.retired) return console.log("standby: there is a lease already")
    const tenure = seen ? seen.lease.tenure + 1 : Number(process.argv[3] ?? 1)
    const made = await store().write({ holder: name, tenure, beat: crypto.randomUUID() }, seen?.etag ?? null)
    if (!made) exit("standby: the lease changed meanwhile, so none was made")
    console.log(`standby: ${name} holds the new lease, tenure ${tenure}`)
  },
  /** Takes the lease out of use: its holder stops at its next renewal, and no machine takes it until `standby init`. */
  async retire() {
    const seen = await store().read()
    if (!seen || seen.lease.retired) return console.log("standby: no lease is in use")
    const { claim: _, ...lease } = seen.lease
    if (!(await store().write({ ...lease, retired: true, beat: crypto.randomUUID() }, seen.etag))) exit("standby: the lease changed meanwhile, so it wasn't retired")
    console.log(`standby: retired the lease at tenure ${lease.tenure}`)
  },
  async status() {
    const seen = await store().read()
    if (!seen) return console.log("no lease: `standby init` on the machine that should hold it makes one")
    const { holder, tenure, free, claim, retired } = seen.lease
    if (retired) return console.log(`retired at tenure ${tenure}: \`standby init\` makes the next`)
    console.log(`${free ? `free (last held by ${holder})` : holder} · tenure ${tenure}${claim ? ` · ${claim} asked for it` : ""}${existsSync(held) ? " · held here" : ""}`)
  },
  async move() {
    if (!existsSync(held)) exit(`standby: ${name} doesn't hold the lease`)
    await systemctl("kill", `--signal=${process.argv[3] === "--away" ? "USR2" : "USR1"}`, "standby.service")
  },
  /**
   * After standby.service exits, however it went. Stopped on purpose, it stops what it held. Restarted, crashed, killed
   * by the watchdog or failing to start, what it held runs on while the last renewal covers it: the next run renews
   * it, and `standby lapse` stops it once that runs out, whether or not standby came back. A standby that never held,
   * or already stopped what it held, leaves the units alone: they may be another setup's.
   */
  async fence() {
    if (!existsSync(held)) return
    if ((await job()) === "stop" || lapsed()) return stopNow()
    const left = Math.ceil(statSync(held).mtimeMs + (ttl * 2) / 3 - Date.now())
    const env = [`UNIT=${unit}`, `TTL=${ttl / 1000}`, ...(process.env.STANDBY_ENV ? [`STANDBY_ENV=${process.env.STANDBY_ENV}`] : [])]
    await systemctl("stop", "standby-lapse.timer")
    const timer = await $`systemd-run --user --quiet --collect --unit=standby-lapse --on-active=${left}ms --timer-property=AccuracySec=100ms ${env.map((pair) => `--setenv=${pair}`)} ${self} lapse`.nothrow().quiet()
    if (timer.exitCode !== 0) await stopNow()
  },
  /** Stops what this machine holds if its last renewal has run out. */
  async lapse() {
    if (lapsed()) await stopNow()
  },
  async drill() {
    if (process.argv[3] === "off") rmSync(drill, { force: true })
    else writeFileSync(drill, "")
  },
}

await (commands[process.argv[2] ?? ""] ?? (() => exit("usage: standby run | init [tenure] | retire | status | move [--away] | drill [off] | fence | lapse")))()
