#!/usr/bin/env bun
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"
import { $ } from "bun"
import { run, type Service } from "./lease"
import { enforcesConditions, s3 } from "./s3"

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
const bucket = {
  endpoint: need("ENDPOINT"),
  bucket: need("BUCKET"),
  accessKeyId: need("AWS_ACCESS_KEY_ID"),
  secretAccessKey: need("AWS_SECRET_ACCESS_KEY"),
}
const runtime = join(process.env.XDG_RUNTIME_DIR ?? "/tmp", "standby")
const held = join(runtime, "held")
const drill = join(runtime, "drill")
const store = s3(bucket, () => existsSync(drill))
const systemctl = (...args: string[]) => $`systemctl --user ${args}`.nothrow().quiet()
const hook = (command: string | undefined, env: Record<string, string> = {}) =>
  command ? Bun.spawn(["sh", "-c", command], { env: { ...process.env, ...env }, stdio: ["ignore", "inherit", "inherit"] }).exited : undefined

/** Everything bound to the target goes at once: a unit's own stop could outlast the lease. */
async function stopNow() {
  rmSync(held, { force: true })
  const bound = (await systemctl("show", "-p", "BoundBy", "--value", unit).text()).split(/\s+/).filter(Boolean)
  await systemctl("stop", "--no-block", unit)
  if (bound.length) await systemctl("kill", "--signal=KILL", ...bound)
}

const service: Service = {
  async start({ tenure, from, left }) {
    writeFileSync(held, `TENURE=${tenure}\nFROM=${from ?? ""}\nLEFT=${left ?? ""}\n`)
    console.log(`standby: ${name} holds the lease, tenure ${tenure}`)
    await systemctl("start", "--no-block", unit)
  },
  async stop() {
    rmSync(held, { force: true })
    await systemctl("stop", unit)
  },
  async kill(why) {
    console.error(`standby: ${name} lost the lease (${why})`)
    await stopNow()
  },
  async healthy() {
    const required = (await systemctl("show", "-p", "Requires", "--value", unit).text()).split(/\s+/).filter(Boolean)
    return required.length === 0 || (await systemctl("is-active", ...required)).exitCode === 0
  },
}

const commands: Record<string, () => Promise<void>> = {
  async run() {
    if (!(await enforcesConditions(bucket))) exit("standby: this bucket doesn't enforce conditional writes, so two machines could both win the lease")
    mkdirSync(runtime, { recursive: true })
    rmSync(held, { force: true })
    const started = { clock: performance.now(), wall: Date.now() }
    // systemd kills a standby that stops answering, and ExecStopPost takes down what it held.
    const watchdog = Number(process.env.WATCHDOG_USEC ?? 0) / 1000
    if (watchdog) setInterval(() => Bun.spawn(["systemd-notify", "WATCHDOG=1"]), watchdog / 4).unref()
    let stopping = false
    let move: false | "move" | "away" = false
    process.on("SIGUSR1", () => void (move = "move"))
    process.on("SIGUSR2", () => void (move = "away"))
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.on(signal, async () => {
        // A machine going down passes the lease on first; a plain restart keeps it and takes it straight back.
        const goingDown = (await $`systemctl is-system-running`.nothrow().text()).trim() === "stopping"
        if (!goingDown) process.exit(0)
        stopping = true
      })
    }
    await run(
      { name, ttl: seconds("TTL", 60), home: settings.HOME_MACHINE === "1", stable: seconds("STABLE", 300), unhealthy: seconds("UNHEALTHY", 120) },
      {
        store,
        service,
        // A suspended machine's monotonic clock stands still, so the wall clock counts too.
        now: () => Math.max(performance.now() - started.clock, Date.now() - started.wall),
        sleep: (ms) => Bun.sleep(ms),
        beat: () => crypto.randomUUID(),
        beforeHold: async () => void (await hook(settings.BEFORE_HOLD)),
        onChange: (lease, mine, lost) =>
          void hook(settings.ON_CHANGE, { HOLDER: lease.free ? "" : lease.holder, TENURE: String(lease.tenure), MINE: mine ? "1" : "", LEFT: lease.left ?? "", LOST: lost ?? "" }),
        stopping: () => stopping,
        moveAsked: () => {
          const asked = move
          move = false
          return asked
        },
      },
    )
  },
  /** Makes the lease, once, held by this machine: `standby init [tenure]`, the tenure only when replacing a lease that was lost. */
  async init() {
    const made = await store.write({ holder: name, tenure: Number(process.argv[3] ?? 1), beat: crypto.randomUUID() }, null)
    console.log(made ? `standby: ${name} holds the new lease` : "standby: there is a lease already")
  },
  async status() {
    const seen = await store.read()
    if (!seen) return console.log("no lease: `standby init` on the machine that should hold it makes one")
    const { holder, tenure, free, claim } = seen.lease
    console.log(`${free ? `free (last held by ${holder})` : holder} · tenure ${tenure}${claim ? ` · ${claim} asked for it` : ""}${existsSync(held) ? " · held here" : ""}`)
  },
  async move() {
    if (!existsSync(held)) exit(`standby: ${name} doesn't hold the lease`)
    await systemctl("kill", `--signal=${process.argv[3] === "--away" ? "USR2" : "USR1"}`, "standby.service")
  },
  /** After standby.service exits, however it went. */
  fence: stopNow,
  async drill() {
    if (process.argv[3] === "off") rmSync(drill, { force: true })
    else writeFileSync(drill, "")
  },
}

await (commands[process.argv[2] ?? ""] ?? (() => exit("usage: standby run | init [tenure] | status | move [--away] | drill [off]")))()
