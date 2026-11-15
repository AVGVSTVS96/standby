// The container proof: machines running real systemd, standby, Litestream and a toy service, sharing one S3 store.
// bun test/rig.ts [test…] runs every test, or the ones named, each on fresh machines; --keep keeps the last rig's files.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { $ } from "bun"
import { s3 } from "../src/s3"

const repo = join(import.meta.dir, "..")
const litestream = join(process.env.HOME!, ".local/bin/litestream")
const port = 17070
const store = s3({ endpoint: `http://127.0.0.1:${port}`, bucket: "rig", accessKeyId: "rig", secretAccessKey: "rigsecret" }, () => false)
const TTL = 12_000
const STABLE = 30_000
const UNHEALTHY = 10_000
/** Litestream syncs every second; a row the toy logged within this long before a crash may not have reached the bucket. */
const SYNC = 2_000

type Row = { n: number; machine: string; tenure: number; at: number }
type Options = { home?: string; stubborn?: boolean }

let state = ""
const keep = process.argv.includes("--keep")
const containers = new Set<string>()
const podman = (...args: string[]) => $`podman ${args}`.quiet()
const as = (machine: string, script: string) =>
  $`podman exec --user hex -e XDG_RUNTIME_DIR=/run/user/1000 ${`rig-${machine}`} sh -c ${script}`.nothrow().quiet()
const root = (machine: string, script: string) => $`podman exec ${`rig-${machine}`} sh -c ${script}`.nothrow().quiet()
const sleep = (ms: number) => Bun.sleep(ms)
const now = () => Date.now()

function settings(name: string, options: Options) {
  return `BUCKET=rig
ENDPOINT=http://store:7070
AWS_ACCESS_KEY_ID=rig
AWS_SECRET_ACCESS_KEY=rigsecret
UNIT=held.target
TTL=${TTL / 1000}
STABLE=${STABLE / 1000}
UNHEALTHY=${UNHEALTHY / 1000}
HOME_MACHINE=${options.home === name ? 1 : 0}
DB=/home/hex/db/toy.db
REPLICA=s3://rig/db
ON_CHANGE=echo "$(date +%s%3N) $HOLDER $TENURE $MINE $LOST" >> /rig/log/${name}.lease
`
}

function config(name: string, options: Options) {
  const dir = join(state, name, "config")
  const units = join(dir, "systemd/user")
  mkdirSync(join(units, "default.target.wants"), { recursive: true })
  for (const unit of ["standby.service", "held.target", "db-arrive.service", "db.service"]) cpSync(join(repo, "units", unit), join(units, unit))
  cpSync(join(repo, "test/rig/units"), units, { recursive: true })
  for (const unit of ["db-arrive.service", "db.service"]) {
    mkdirSync(join(units, `${unit}.d`))
    cpSync(join(repo, "test/rig/held.conf"), join(units, `${unit}.d/held.conf`))
  }
  if (options.stubborn) {
    cpSync(join(repo, "test/rig/stubborn.service"), join(units, "stubborn.service"))
    writeFileSync(join(units, "held.target.d/stubborn.conf"), "[Unit]\nWants=stubborn.service\n")
  }
  symlinkSync("../standby.service", join(units, "default.target.wants/standby.service"))
  writeFileSync(join(dir, "standby.env"), settings(name, options))
}

async function create(name: string, options: Options) {
  config(name, options)
  mkdirSync(join(state, name, "journal"))
  const mount = (from: string, to: string, mode = "ro") => ["-v", `${from}:${to}:${mode}`]
  containers.add(`rig-${name}`)
  await podman("run", "-d", "--name", `rig-${name}`, "--hostname", name, "--network", "standby-rig", "--systemd=always",
    "--userns=keep-id", "--user", "root", "--cap-add", "NET_ADMIN", "--memory", "384m", "--cpus", "1",
    ...mount(repo, "/standby"),
    ...mount(join(state, name, "config"), "/home/hex/.config", "rw"),
    ...mount(join(state, "log"), "/rig/log", "rw"),
    ...mount(join(state, name, "journal"), "/var/log/journal", "rw"),
    ...mount(join(repo, "dist/standby"), "/home/hex/.local/share/standby/standby"),
    ...mount(join(repo, "bin/db-arrive"), "/home/hex/.local/share/standby/db-arrive"),
    ...mount(join(repo, "units/litestream.yml"), "/home/hex/.local/share/standby/litestream.yml"),
    ...mount(litestream, "/usr/local/bin/litestream"),
    "standby-rig")
}

async function teardown() {
  if (containers.size) await podman("rm", "-f", "-t", "0", ...containers).nothrow()
  containers.clear()
  await podman("network", "rm", "standby-rig").nothrow()
  if (state && !keep) await podman("unshare", "rm", "-rf", state)
}

async function fresh(names: string[], options: Options = {}) {
  await teardown()
  state = mkdtempSync("/var/tmp/standby-rig-")
  mkdirSync(join(state, "log"))
  mkdirSync(join(state, "store/rig"), { recursive: true })
  await podman("network", "create", "standby-rig")
  containers.add("rig-store")
  await podman("run", "-d", "--name", "rig-store", "--hostname", "store", "--network", "standby-rig", "-p", `127.0.0.1:${port}:7070`,
    "-e", "ROOT_ACCESS_KEY=rig", "-e", "ROOT_SECRET_KEY=rigsecret", "-e", "VGW_REGION=auto", "--memory", "256m",
    "-v", `${join(state, "store")}:/data`, "docker.io/versity/versitygw:latest", "posix", "/data")
  await until("the store to answer", async () => (await store.read().catch(() => undefined)) !== undefined, 15_000)
  await Promise.all(names.map((name) => create(name, options)))
}

// What happened, read from outside the machines.

const parse = (text: string): Row[] =>
  text.trim().split("\n").filter(Boolean).map((line) => {
    const [n, machine, tenure, at] = line.split(" ")
    return { n: Number(n), machine: machine!, tenure: Number(tenure), at: Number(at) }
  })
const logged = (file: string) => (existsSync(join(state, "log", file)) ? readFileSync(join(state, "log", file), "utf8") : "")
const rows = (machine: string) => parse(logged(`${machine}.rows`))
const beats = (machine: string) => logged(`${machine}.stubborn`).trim().split("\n").filter(Boolean).map(Number)
const database = async (machine: string) =>
  parse(await as(machine, "sqlite3 -cmd '.timeout 5000' -separator ' ' $DB 'select n, machine, tenure, at from rows order by n'".replace("$DB", "/home/hex/db/toy.db")).text())
const writing = (machine: string) => (rows(machine).at(-1)?.at ?? 0) > now() - 2500
const firstAfter = (machine: string, at: number) => rows(machine).find((row) => row.at > at)
const holderWriting = (names: string[]) => names.find(writing)

async function until(what: string, done: () => boolean | Promise<boolean>, timeout: number) {
  const end = now() + timeout
  while (!(await done())) {
    if (now() > end) throw new Error(`timed out after ${timeout / 1000}s waiting for ${what}`)
    await sleep(250)
  }
}

/** Each machine's runs of activity, from the rows and stubborn beats it logged; two machines' runs must never overlap. */
function overlaps(names: string[], after = 0) {
  const runs = names.flatMap((machine) => {
    const times = [...rows(machine).map((row) => row.at), ...beats(machine)].sort((a, b) => a - b)
    const out: { machine: string; from: number; to: number }[] = []
    for (const at of times) {
      const run = out.at(-1)
      if (run && at - run.to < 3000) run.to = at
      else out.push({ machine, from: at, to: at })
    }
    return out.filter((run) => run.from >= after)
  })
  return runs.flatMap((a) => runs.filter((b) => a.machine < b.machine && a.from <= b.to && b.from <= a.to).map((b) => `${a.machine} and ${b.machine} both ran ${new Date(Math.max(a.from, b.from)).toISOString()}–${new Date(Math.min(a.to, b.to)).toISOString()}`))
}

/** Rows the old holder logged that the new holder's database lacks, and whether its tenures only ever go up. */
async function carried(from: string, to: string) {
  const db = await database(to)
  const have = new Set(db.map((row) => `${row.n} ${row.machine} ${row.tenure} ${row.at}`))
  const ordered = db.every((row, i) => i === 0 || row.tenure >= db[i - 1]!.tenure)
  const missing = rows(from).filter((row) => !have.has(`${row.n} ${row.machine} ${row.tenure} ${row.at}`))
  return { missing, ordered }
}

// The faults.

const standby = (machine: string, command: string) => as(machine, `$HOME/.local/share/standby/standby ${command}`)
const storeIp = async () => (await podman("inspect", "-f", "{{(index .NetworkSettings.Networks \"standby-rig\").IPAddress}}", "rig-store").text()).trim()
const cut = async (machine: string) =>
  root(machine, `nft add table inet rig && nft 'add chain inet rig out { type filter hook output priority 0; }' && nft add rule inet rig out ip daddr ${await storeIp()} drop`)
const uncut = (machine: string) => root(machine, "nft delete table inet rig")
const active = async (machine: string, unit: string) => (await as(machine, `systemctl --user is-active ${unit}`).text()).trim()

// The tests: each returns what it measured and throws on what it must never see.

type Result = { detail: string; ms?: Record<string, number> }
const check = (ok: boolean, why: string) => {
  if (!ok) throw new Error(why)
}
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`

async function started(names: string[], options: Options = {}) {
  await fresh(names, options)
  await until("a holder", () => !!holderWriting(names), 60_000)
  await sleep(3000)
  const holder = holderWriting(names)!
  return { holder, other: names.find((name) => name !== holder)! }
}

/** Waits for `to` to take over from `from` after a fault at `since`, and checks it carried `from`'s rows and nothing ran twice. */
async function handover(from: string, to: string, since: number, kind: "crash" | "planned", timeout = TTL * 4) {
  await until(`${to} to write`, () => !!firstAfter(to, since), timeout)
  await sleep(3000)
  const first = firstAfter(to, since)!
  const lastOld = rows(from).filter((row) => row.at < first.at).at(-1)!
  const { missing, ordered } = await carried(from, to)
  check(ordered, `${to}'s database has rows of an older tenure after a newer one`)
  const early = missing.filter((row) => kind === "planned" || row.at < since - SYNC)
  check(early.length === 0, `${to}'s database lacks ${missing.length} of ${from}'s rows (n ${missing.map((row) => row.n).join(" ")}), the first ${seconds(since - (missing[0]?.at ?? since))} before the fault`)
  const two = overlaps([from, to])
  check(two.length === 0, two.join("; "))
  return { move: first.at - lastOld.at, missing: missing.length }
}

const tests: Record<string, () => Promise<Result>> = {
  async together() {
    await fresh(["a", "b"])
    await until("a holder", () => !!holderWriting(["a", "b"]), 60_000)
    await sleep(15_000)
    const two = overlaps(["a", "b"])
    check(two.length === 0, two.join("; "))
    check(rows("a").length === 0 || rows("b").length === 0, "both machines wrote rows")
    return { detail: `${holderWriting(["a", "b"])} alone holds` }
  },

  async move() {
    const { holder, other } = await started(["a", "b"])
    const since = now()
    check((await standby(holder, "move")).exitCode === 0, "standby move failed")
    const { move } = await handover(holder, other, since, "planned")
    return { detail: `${holder} → ${other}, every row carried`, ms: { "planned move": move } }
  },

  async shutdown() {
    const { holder, other } = await started(["a", "b"])
    const since = now()
    await podman("stop", "-t", "120", `rig-${holder}`)
    const { move } = await handover(holder, other, since, "planned")
    check(move < TTL, `${other} only took over after ${seconds(move)}: the lease wasn't passed on`)
    return { detail: `${holder} went down and passed the lease on first, every row carried`, ms: { "planned move": move } }
  },

  async kill() {
    const { holder, other } = await started(["a", "b"])
    const since = now()
    await podman("kill", `rig-${holder}`)
    const { move, missing } = await handover(holder, other, since, "crash")
    return { detail: `${other} took over; ${missing} row(s) from the last ${seconds(SYNC)} lost`, ms: { crash: move } }
  },

  async freeze() {
    const { holder, other } = await started(["a", "b"])
    const since = now()
    await podman("pause", `rig-${holder}`)
    await until(`${other} to write`, () => !!firstAfter(other, since), TTL * 4)
    await sleep(3000)
    const thawed = now()
    await podman("unpause", `rig-${holder}`)
    await sleep(5000)
    const stale = rows(holder).filter((row) => row.at >= thawed)
    const db = await database(other)
    check(!stale.some((row) => db.some((mine) => mine.at === row.at && mine.machine === holder)), `${holder}'s rows from after the thaw reached ${other}`)
    check((await active(holder, "toy.service")) !== "active", `${holder}'s toy still runs after the thaw`)
    const { missing } = await carried(holder, other)
    check(missing.every((row) => row.at >= since - SYNC || row.at >= thawed), `${other} lacks rows from before the freeze`)
    const two = overlaps([holder, other]).filter(() => stale.length === 0)
    check(two.length === 0, two.join("; "))
    return { detail: `${other} took over; ${holder} wrote ${stale.length} row(s) in the moment after its thaw, kept off ${other}` }
  },

  async cutoff() {
    const { holder, other } = await started(["a", "b"], { stubborn: true })
    const since = now()
    await cut(holder)
    await until(`${other} to write`, () => !!firstAfter(other, since), TTL * 4)
    await sleep(3000)
    const fenced = Math.max(rows(holder).at(-1)!.at, beats(holder).at(-1) ?? 0)
    const took = firstAfter(other, since)!.at
    const two = overlaps([holder, other])
    check(two.length === 0, two.join("; "))
    const unsynced = rows(holder).filter((row) => row.at > since).length
    await uncut(holder)
    await sleep(TTL / 2)
    check(!writing(holder), `${holder} took the lease back`)
    return { detail: `${holder} stopped everything, stubborn unit included, before ${other} took over; its ${unsynced} rows after the cut never reached the bucket`, ms: { "last on old to first on new": took - fenced } }
  },

  async "standby-9"() {
    const { holder, other } = await started(["a", "b"], { stubborn: true })
    const since = now()
    await root(holder, "pkill -KILL -f 'standby run'")
    await until(`${holder} to write again`, () => rows(holder).some((row) => row.at > since + 1500), TTL * 2)
    await sleep(3000)
    const before = rows(holder).filter((row) => row.at <= since).at(-1)!
    const after = rows(holder).find((row) => row.at > since + 1500)!
    check(rows(other).length === 0, `${other} took over`)
    check(after.tenure === before.tenure, `the tenure went from ${before.tenure} to ${after.tenure}`)
    return { detail: `${holder} kept the lease and its tenure; its units went down with standby and came back`, ms: { gap: after.at - before.at } }
  },

  async hung() {
    const { holder, other } = await started(["a", "b"], { stubborn: true })
    const since = now()
    await root(holder, "pkill -STOP -f 'standby run'")
    await sleep(TTL * 2)
    const two = overlaps([holder, other])
    check(two.length === 0, two.join("; "))
    const quiet = rows(holder).filter((row) => row.at > since).findIndex((row, i, all) => (all[i + 1]?.at ?? now()) - row.at > 3000)
    const stopped = rows(holder).filter((row) => row.at > since)[quiet]?.at ?? since
    return { detail: `${holder}'s units went down ${seconds(stopped - since)} after its standby hung; ${writing(other) ? other : writing(holder) ? holder : "nobody"} holds now` }
  },

  async broken() {
    const { holder, other } = await started(["a", "b"])
    const since = now()
    await as(holder, "touch $HOME/broken && systemctl --user kill toy.service")
    const { move } = await handover(holder, other, since, "planned", UNHEALTHY + TTL * 4)
    return { detail: `${holder} couldn't run the toy and passed the lease to ${other}`, ms: { "fault to first row": firstAfter(other, since)!.at - since, "planned move": move } }
  },

  async "reboot-taking"() {
    const { holder, other } = await started(["a", "b"])
    const since = now()
    await podman("kill", `rig-${holder}`)
    await until(`${other} to win the lease`, async () => (await store.read())?.lease.holder === other, TTL * 3)
    await podman("restart", "-t", "0", `rig-${other}`)
    const { move, missing } = await handover(holder, other, since, "crash")
    return { detail: `${other} was rebooted as it took over and still came up with ${holder}'s rows (${missing} lost to the crash)`, ms: { crash: move } }
  },

  async "reboot-holder"() {
    const { holder, other } = await started(["a", "b"])
    const since = now()
    await podman("kill", `rig-${holder}`)
    await until(`${other} to win the lease`, async () => (await store.read())?.lease.holder === other, TTL * 3)
    await podman("start", `rig-${holder}`)
    await handover(holder, other, since, "crash")
    await sleep(TTL)
    const two = overlaps([holder, other])
    check(two.length === 0, two.join("; "))
    check(!writing(holder), `${holder} took the lease back`)
    return { detail: `${holder} came back up while ${other} was taking over, and waited` }
  },

  async "stuck-stop"() {
    const { holder, other } = await started(["a", "b"], { stubborn: true })
    await standby(holder, "move")
    await sleep(TTL * 3)
    check(rows(other).length === 0, `${other} took over while ${holder}'s stubborn unit was still stopping`)
    const since = now()
    await root(holder, "pkill -KILL -f stubborn")
    const { move } = await handover(holder, other, since, "planned")
    return { detail: `a unit that won't stop holds a planned move on ${holder}, renewing; once it's gone the move completes`, ms: { "planned move": move } }
  },

  async home() {
    const { holder } = await started(["a", "b"], { home: "a" })
    if (holder !== "a") return { detail: "b won the start, so there was nothing to bring home; run it again" }
    const since = now()
    await standby("a", "move")
    await handover("a", "b", since, "planned")
    const away = now()
    await until("a to take the lease back", () => !!firstAfter("a", away), STABLE * 3 + TTL * 2)
    const { move } = await handover("b", "a", away, "planned")
    return { detail: `a got the lease back ${seconds(firstAfter("a", away)!.at - away)} after b took it`, ms: { "planned move": move } }
  },
}

const chosen = process.argv.slice(2).filter((arg) => !arg.startsWith("--"))
let failed = 0
await $`bun run build`.cwd(repo).quiet()
await podman("build", "-q", "-t", "standby-rig", join(repo, "test/rig"))
try {
  for (const name of chosen.length ? chosen : Object.keys(tests)) {
    const began = now()
    try {
      const { detail, ms = {} } = await tests[name]!()
      const times = Object.entries(ms).map(([what, value]) => `${what} ${seconds(value)}`).join(", ")
      console.log(`pass  ${name}: ${detail}${times ? ` (${times})` : ""}  [${seconds(now() - began)}]`)
    } catch (error) {
      failed++
      console.log(`FAIL  ${name}: ${(error as Error).message}  [${seconds(now() - began)}]${keep ? ` ${state}` : ""}`)
    }
    if (keep) console.log(`      ${state}`)
  }
} finally {
  await teardown()
}
process.exit(failed ? 1 : 0)
