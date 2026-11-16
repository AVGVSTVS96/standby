// The container proof: machines running real systemd, standby, Litestream and a toy service, sharing one S3 store.
// bun test/rig.ts [test…] runs every test, or the ones named, each on fresh machines; --keep keeps the last rig's files
// and machines.
// LITESTREAM names another Litestream binary to run in the machines.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { $ } from "bun"
import { s3 } from "../src/s3"

const repo = join(import.meta.dir, "..")
const litestream = process.env.LITESTREAM ?? join(process.env.HOME!, ".local/bin/litestream")
const port = 17070
const store = s3({ endpoint: `http://127.0.0.1:${port}`, bucket: "rig", accessKeyId: "rig", secretAccessKey: "rigsecret" }, () => false)
const TTL = 12_000
const STABLE = 30_000
const UNHEALTHY = 10_000
/** Litestream syncs every second; a row the toy logged within this long before a crash may not have reached the bucket. */
const SYNC = 2_000

type Row = { n: number; machine: string; tenure: number; at: number }
/**
 * far: ms added to every request a machine sends, as the real link adds (R2 answers the twin in about 200ms); pad: the
 * database's size in MB; churn: MB rewritten in every transaction; check: check the whole file as it arrives; every:
 * seconds between the toy's writes; ttl: the lease's, in ms, where a test needs the real one.
 */
type Options = { home?: string; stubborn?: boolean; far?: number; pad?: number; churn?: number; check?: boolean; every?: number; ttl?: number }

let state = ""
const keep = process.argv.includes("--keep")
const containers = new Set<string>()
const podman = (...args: string[]) => $`podman ${args}`.quiet()
const as = (machine: string, script: string) =>
  $`podman exec --user hex -e XDG_RUNTIME_DIR=/run/user/1000 ${`rig-${machine}`} sh -c ${script}`.nothrow().quiet()
const root = (machine: string, script: string) => $`podman exec ${`rig-${machine}`} sh -c ${script}`.nothrow().quiet()
const sleep = (ms: number) => Bun.sleep(ms)
const now = () => Date.now()

/** How much longer than the rig's own the timings are in a test that runs at the real TTL. */
const scale = (options: Options) => (options.ttl ?? TTL) / TTL

function settings(name: string, options: Options) {
  return `BUCKET=rig
ENDPOINT=http://store:7070
AWS_ACCESS_KEY_ID=rig
AWS_SECRET_ACCESS_KEY=rigsecret
UNIT=held.target
FOLLOW=db-follow.service
TTL=${(options.ttl ?? TTL) / 1000}
STABLE=${(STABLE * scale(options)) / 1000}
UNHEALTHY=${(UNHEALTHY * scale(options)) / 1000}
PATIENCE=${Math.round((UNHEALTHY * scale(options)) / 4000)}
HOME_MACHINE=${options.home === name ? 1 : 0}
DB=/home/hex/db/toy.db
REPLICA=s3://rig/db
PAD_MB=${options.pad ?? 16}
CHURN_MB=${options.churn ?? 0}
CHECK=${options.check ? 1 : ""}
WRITE_EVERY=${options.every ?? 1}
ON_CHANGE=echo "$(date +%s%3N) $HOLDER $TENURE $MINE $LOST" >> /rig/log/${name}.lease
`
}

function config(name: string, options: Options) {
  const dir = join(state, name, "config")
  const units = join(dir, "systemd/user")
  mkdirSync(join(units, "default.target.wants"), { recursive: true })
  for (const unit of ["standby.service", "held.target", "db-arrive.service", "db.service", "db-follow.service"]) cpSync(join(repo, "units", unit), join(units, unit))
  cpSync(join(repo, "test/rig/units"), units, { recursive: true })
  for (const unit of ["db-arrive.service", "db.service"]) {
    mkdirSync(join(units, `${unit}.d`))
    cpSync(join(repo, "test/rig/held.conf"), join(units, `${unit}.d/held.conf`))
  }
  if (options.stubborn) {
    cpSync(join(repo, "test/rig/stubborn.service"), join(units, "stubborn.service"))
    writeFileSync(join(units, "held.target.d/stubborn.conf"), "[Unit]\nWants=stubborn.service\n")
  }
  // The watchdog and the restart scaled to the rig's TTL, as the unit's are to the real one's.
  mkdirSync(join(units, "standby.service.d"))
  writeFileSync(join(units, "standby.service.d/rig.conf"), `[Service]\nWatchdogSec=${(options.ttl ?? TTL) / 3000}\nRestartSec=${(options.ttl ?? TTL) / 30_000}\n`)
  symlinkSync("../standby.service", join(units, "default.target.wants/standby.service"))
  writeFileSync(join(dir, "standby.env"), settings(name, options))
}

async function create(name: string, options: Options) {
  config(name, options)
  mkdirSync(join(state, name, "journal"))
  const mount = (from: string, to: string, mode = "ro") => ["-v", `${from}:${to}:${mode}`]
  containers.add(`rig-${name}`)
  await podman("run", "-d", "--name", `rig-${name}`, "--hostname", name, "--network", "standby-rig", "--systemd=always",
    "--userns=keep-id", "--user", "root", "--cap-add", "NET_ADMIN", "--memory", "1g", "--cpus", "1",
    ...mount(repo, "/standby"),
    ...mount(join(state, name, "config"), "/home/hex/.config", "rw"),
    ...mount(join(state, "log"), "/rig/log", "rw"),
    ...mount(join(state, name, "journal"), "/var/log/journal", "rw"),
    ...mount(join(repo, "dist/standby"), "/home/hex/.local/share/standby/standby"),
    ...["db-arrive", "db-follow", "db-handoff"].flatMap((script) => mount(join(repo, "bin", script), `/home/hex/.local/share/standby/${script}`)),
    ...mount(join(repo, "units/litestream.yml"), "/home/hex/.local/share/standby/litestream.yml"),
    ...mount(litestream, "/usr/local/bin/litestream"),
    "standby-rig")
  // Only packets that end a request (PSH) wait, so each request takes `far` longer, as R2's are slow to answer, while
  // ACKs go at once and a download keeps its speed.
  if (options.far)
    check((await root(name, `tc qdisc add dev eth0 root handle 1: prio && tc qdisc add dev eth0 parent 1:3 netem delay ${options.far}ms &&
      tc filter add dev eth0 parent 1: protocol ip u32 match ip protocol 6 0xff match u8 0x08 0x08 at 33 flowid 1:3`)).exitCode === 0, `${name}'s delay couldn't be set`)
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
    "-e", "ROOT_ACCESS_KEY=rig", "-e", "ROOT_SECRET_KEY=rigsecret", "-e", "VGW_REGION=auto", "--memory", "256m", "--cpus", "1",
    "-v", `${join(state, "store")}:/data`, "docker.io/versity/versitygw:latest", "--access-log", "/data/access.log", "posix", "/data")
  await until("the store to answer", async () => (await store.read().catch(() => undefined)) !== undefined, 15_000)
  await store.write({ holder: names[0]!, tenure: 1, beat: "init" }, null)
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
/** What the database held each time the toy started on it, before it wrote (test/rig/arrived). */
const arrivals = (machine: string) =>
  logged(`${machine}.arrived`).trim().split("\n").filter(Boolean).map((line) => {
    const [at, tenure, last, churn, distinct, churnLast, ...check] = line.split(" ")
    return { at: Number(at), tenure: Number(tenure), last: Number(last), churn: Number(churn), distinct: Number(distinct), churnLast: Number(churnLast), check: check.join(" ").trim() }
  })
/** How db-arrive brought the database on its last run: the warm copy or a restore. */
const arrivedBy = async (machine: string) =>
  (await root(machine, "journalctl _SYSTEMD_USER_UNIT=db-arrive.service -o cat | grep 'db-arrive:' | tail -n 1").text()).includes("the copy that followed") ? "copy" : "restore"
const writing = (machine: string) => (rows(machine).at(-1)?.at ?? 0) > now() - 2500
const firstAfter = (machine: string, at: number) => rows(machine).find((row) => row.at > at)
const holderWriting = (names: string[]) => names.find(writing)
/** Requests each machine sent the store between `after` and `before`, by operation, from the store's access log. */
async function requests(names: string[], after: number, before: number) {
  const ips = new Map<string, string>()
  for (const name of names) ips.set((await podman("inspect", "-f", "{{(index .NetworkSettings.Networks \"standby-rig\").IPAddress}}", `rig-${name}`).text()).trim(), name)
  const counts = Object.fromEntries(names.map((name) => [name, {} as Record<string, number>]))
  for (const line of readFileSync(join(state, "store/access.log"), "utf8").split("\n")) {
    const fields = line.split(" ")
    const time = Date.parse(`${(fields[2] ?? "").slice(1).replace(/\//g, " ").replace(":", " ")} UTC`)
    const machine = ips.get(fields[4] ?? "")
    if (!machine || !(time >= after && time < before)) continue
    const op = (fields[7] ?? "").replace(/^s3_/, "")
    counts[machine]![op] = (counts[machine]![op] ?? 0) + 1
  }
  return counts
}

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
  const wrote = rows(from)
  const db = await database(to)
  const have = new Set(db.map((row) => `${row.n} ${row.machine} ${row.tenure} ${row.at}`))
  const ordered = db.every((row, i) => i === 0 || row.tenure >= db[i - 1]!.tenure)
  const missing = wrote.filter((row) => !have.has(`${row.n} ${row.machine} ${row.tenure} ${row.at}`))
  return { missing, ordered }
}

// The faults.

const standby = (machine: string, command: string) => as(machine, `$HOME/.local/share/standby/standby ${command}`)
const storeIp = async () => (await podman("inspect", "-f", "{{(index .NetworkSettings.Networks \"standby-rig\").IPAddress}}", "rig-store").text()).trim()
const cut = async (machine: string) =>
  root(machine, `nft add table inet rig && nft 'add chain inet rig out { type filter hook output priority 0; }' && nft add rule inet rig out ip daddr ${await storeIp()} drop`)
const uncut = (machine: string) => root(machine, "nft delete table inet rig")
const active = async (machine: string, unit: string) => (await as(machine, `systemctl --user is-active ${unit}`).text()).trim()

const held = async (machine: string) => (await as(machine, "systemctl --user show -p MainPID --value toy.service db.service stubborn.service").text()).trim()
const gapSince = (machine: string, since: number) =>
  Math.max(...rows(machine).filter((row) => row.at > since - 1500).map((row, i, all) => (i ? row.at - all[i - 1]!.at : 0)))
/** What `machine` held kept running through a fault at `since`: the same processes, the same tenure, nobody else. */
async function ranOn(machine: string, other: string, before: string) {
  const after = await held(machine)
  check(after === before, `${machine}'s units restarted: ${before.replace(/\n/g, " ")} → ${after.replace(/\n/g, " ")}`)
  check(rows(other).length === 0, `${other} took over`)
  check(new Set(rows(machine).map((row) => row.tenure)).size === 1, "the tenure changed")
}

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
  await until("the holder to write", () => !!holderWriting(names), 30_000)
  const holder = holderWriting(names)!
  return { holder, other: names.find((name) => name !== holder)! }
}

/**
 * Waits for `to` to take over from `from` after a fault at `since`, and checks it carried `from`'s rows, nothing ran
 * twice, and the database it started on was whole and not stale: after a planned move, at `from`'s very last row.
 */
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
  const arrived = arrivals(to).find((row) => row.at > since && row.tenure === first.tenure)
  check(!!arrived, `${to} logged no arrival for tenure ${first.tenure}`)
  // After a planned move it starts on the old holder's last row: the last it logged, or one it was stopped in the middle
  // of committing, which its own database has, or may not have where SQLite dropped it after Litestream sent it.
  const ran = (await database(from)).at(-1)?.n ?? 0
  const synced = rows(from).filter((row) => row.at < since - SYNC).at(-1)?.n ?? 0
  const current = arrived!.last >= Math.max(ran, lastOld.n) && arrived!.last <= lastOld.n + 1
  check(kind === "planned" ? current : arrived!.last >= synced, `${to} started tenure ${first.tenure} on row ${arrived!.last}, but ${from}'s last was ${ran} (${lastOld.n} logged)`)
  check(arrived!.churn === 0 || (arrived!.distinct === 1 && arrived!.churnLast === arrived!.last), `${to} started on a torn copy: churn rows from ${arrived!.distinct} transactions, the last ${arrived!.churnLast}, rows up to ${arrived!.last}`)
  check(arrived!.check === "-" || arrived!.check === "ok", `${to} started on a damaged copy: ${arrived!.check}`)
  return { move: first.at - lastOld.at, missing: missing.length, by: await arrivedBy(to) }
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
    const before = await held(holder)
    const since = now()
    await as(holder, "systemctl --user kill --kill-whom=main --signal=KILL standby.service")
    await sleep(TTL * 2)
    await ranOn(holder, other, before)
    return { detail: `${holder}'s standby was killed and came back: the toy, its stream and the stubborn unit ran on, on the same tenure`, ms: { "longest gap between rows": gapSince(holder, since) } }
  },

  async "standby-gone"() {
    const { holder, other } = await started(["a", "b"], { stubborn: true })
    // standby can't start again: whatever it held must stop once its last renewal runs out, before anyone takes over.
    await as(holder, `mkdir -p $HOME/.config/systemd/user/standby.service.d && printf '[Service]\nExecStart=\nExecStart=/bin/false\n' > $HOME/.config/systemd/user/standby.service.d/gone.conf && systemctl --user daemon-reload`)
    await as(holder, "systemctl --user kill --kill-whom=main --signal=KILL standby.service")
    const since = now()
    // Read after the kill, so no renewal can come after it.
    const renewed = Number((await as(holder, "date -r $XDG_RUNTIME_DIR/standby/held +%s%3N").text()).trim())
    const { move } = await handover(holder, other, since, "crash")
    const last = Math.max(rows(holder).at(-1)!.at, beats(holder).at(-1) ?? 0)
    check(last - renewed < (TTL * 2) / 3 + 1500, `${holder} ran ${seconds(last - renewed)} past its last renewal`)
    return { detail: `${holder}'s standby died for good: its units stopped ${seconds(last - renewed)} after the last renewal, and ${other} took over`, ms: { crash: move } }
  },

  async "stray-start"() {
    const { holder, other } = await started(["a", "b"])
    const started_ = now()
    const result = await as(other, "systemctl --user start toy.service db.service")
    await sleep(3000)
    check(now() - started_ < 8000, `starting a bound unit on the waiter took ${seconds(now() - started_)}`)
    check((await active(other, "toy.service")) !== "active" && (await active(other, "db.service")) !== "active", `${other} runs its units without the lease`)
    check(rows(other).length === 0 && writing(holder), `the lease moved`)
    return { detail: `starting the units by hand on the waiter ${other} ${result.exitCode ? "fails" : "returns"} at once and runs nothing` }
  },

  async restart() {
    const { holder, other } = await started(["a", "b"], { stubborn: true })
    const pids = async () => (await as(holder, "systemctl --user show -p MainPID --value toy.service db.service stubborn.service").text()).trim()
    const before = await pids()
    const since = now()
    // An update: the unit names the next version's folder, and standby restarts on it.
    await as(holder, `mkdir -p $HOME/.local/share/standby/next && cp $HOME/.local/share/standby/standby $HOME/.local/share/standby/next/standby &&
      sed -i 's|/standby/standby |/standby/next/standby |' $HOME/.config/systemd/user/standby.service && systemctl --user daemon-reload && systemctl --user restart standby.service`)
    await sleep(TTL)
    const after = await pids()
    const gap = Math.max(...rows(holder).filter((row) => row.at > since - 1500).map((row, i, all) => (i ? row.at - all[i - 1]!.at : 0)))
    check((await as(holder, "ps -o args= -p $(systemctl --user show -p MainPID --value standby.service)").text()).includes("next/standby"), "standby didn't restart on the next version")
    check(after === before, `the units restarted with standby: ${before.replace(/\n/g, " ")} → ${after.replace(/\n/g, " ")}`)
    check(rows(other).length === 0, `${other} took over`)
    check(new Set(rows(holder).map((row) => row.tenure)).size === 1, "the tenure changed")
    return { detail: `updating standby on ${holder} restarts standby alone: the toy, its database's stream and the stubborn unit run on, on the same tenure`, ms: { "longest gap between rows": gap } }
  },

  async "toy-restart"() {
    const { holder } = await started(["a", "b"], { stubborn: true })
    const others = async () => (await as(holder, "systemctl --user show -p MainPID --value db.service stubborn.service standby.service").text()).trim()
    const before = await others()
    await as(holder, "systemctl --user restart toy.service")
    await sleep(3000)
    check((await others()) === before, `restarting the toy restarted others: ${before} → ${await others()}`)
    check(writing(holder), `${holder}'s toy didn't come back`)
    return { detail: "restarting the held service (an update of it) restarts it alone" }
  },

  async stop() {
    const { holder, other } = await started(["a", "b"])
    const since = now()
    await as(holder, "systemctl --user stop standby.service")
    const stopped = now()
    check((await active(holder, "held.target")) !== "active" && (await active(holder, "toy.service")) !== "active", `${holder}'s units still run after standby stopped`)
    const { move } = await handover(holder, other, since, "planned", TTL * 4)
    return { detail: `stopping standby on ${holder} stops its units, and ${other} takes the lease once it runs out`, ms: { "stop took": stopped - since, "last row to first on the new": move } }
  },

  async retire() {
    const { holder, other } = await started(["a", "b"])
    const since = now()
    check((await standby(other, "retire")).exitCode === 0, "standby retire failed")
    await sleep(TTL * 3)
    const last = rows(holder).at(-1)!
    check(last.at - since < TTL, `${holder} ran ${seconds(last.at - since)} after the lease was retired`)
    check(rows(other).length === 0, `${other} took a retired lease`)
    const { tenure } = last
    const init = await standby(holder, "init")
    check(init.exitCode === 0, `init after retire failed: ${init.stderr}`)
    await until(`${holder} to write again`, () => rows(holder).some((row) => row.at > now() - 1000 && row.tenure === tenure + 1), TTL * 2)
    const { missing } = await carried(holder, holder)
    check(missing.length === 0, `${holder} lost ${missing.length} rows across retire and init`)
    return { detail: `${holder} stopped ${seconds(last.at - since)} after the lease was retired, nobody took it for ${seconds(TTL * 3)}, and init on ${holder} made tenure ${tenure + 1} with its database kept` }
  },

  async hung() {
    const ttl = 60_000
    const { holder, other } = await started(["a", "b"], { stubborn: true, ttl })
    const before = await held(holder)
    const since = now()
    await as(holder, "systemctl --user kill --kill-whom=main --signal=STOP standby.service")
    await sleep(ttl)
    await ranOn(holder, other, before)
    return { detail: `${holder}'s standby hung, the watchdog replaced it, and the next run renewed in time: the toy, its stream and the stubborn unit ran on, on the same tenure`, ms: { "longest gap between rows": gapSince(holder, since) } }
  },

  async broken() {
    const { holder, other } = await started(["a", "b"])
    const since = now()
    await as(holder, "touch $HOME/broken && systemctl --user kill toy.service")
    const { move } = await handover(holder, other, since, "planned", UNHEALTHY + TTL * 4)
    return { detail: `${holder} couldn't run the toy for UNHEALTHY (${seconds(UNHEALTHY)}) and passed the lease to ${other}`, ms: { "fault to first row on the new": move } }
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
    await as(holder, "systemctl --user kill --signal=KILL stubborn.service")
    const { move } = await handover(holder, other, since, "planned")
    return { detail: `a unit that won't stop holds a planned move on ${holder}, renewing; once it's gone the move completes`, ms: { "planned move": move } }
  },

  async far() {
    const options = { far: 200, pad: 120, every: 0.2, ttl: 60_000 }
    let { holder, other } = await started(["a", "b"], options)
    const ms: Record<string, number> = {}
    for (let i = 1; i <= 4; i++) {
      await until(`${other} to follow ${holder}`, async () => (await active(other, "db-follow.service")) === "active", 120_000)
      await sleep(5000)
      const since = now()
      check((await standby(holder, "move")).exitCode === 0, "standby move failed")
      const { move, by } = await handover(holder, other, since, "planned")
      check(by === "copy", `move ${i} restored from the bucket instead of starting on the copy`)
      ms[`${holder}→${other}`] = Math.max(ms[`${holder}→${other}`] ?? 0, move)
      console.log(`      move ${i} ${holder} → ${other}: ${seconds(move)}`)
      ;[holder, other] = [other, holder]
    }
    return { detail: `4 moves of a ${options.pad} MB database with ${options.far}ms added to every request, each on the warm copy, every row carried`, ms }
  },

  async tear() {
    let { holder, other } = await started(["a", "b"], { churn: 2, check: true, every: 1, ttl: 60_000 })
    const by = { copy: 0, restore: 0 }
    const kill = (machine: string) => as(machine, "systemctl --user kill --signal=KILL db-follow.service")
    for (let i = 1; i <= 6; i++) {
      await sleep(5000)
      // Each transaction rewrites 2 MB, so a follower killed at a random moment is often in the middle of one.
      for (const end = now() + 5000 + Math.random() * 10_000; now() < end; await sleep(Math.random() * 3000)) await kill(other)
      await sleep(Math.random() * 6000)
      const since = now()
      check((await standby(holder, "move")).exitCode === 0, "standby move failed")
      // Half the moves keep killing it as the database arrives.
      let moving = i % 2 === 0
      const killing = (async () => {
        while (moving) {
          await sleep(Math.random() * 1500)
          if (moving) await kill(other)
        }
      })()
      const result = await handover(holder, other, since, "planned", 120_000).finally(() => (moving = false))
      await killing
      by[result.by as "copy" | "restore"]++
      ;[holder, other] = [other, holder]
    }
    return { detail: `6 moves with the follower killed at random through 2 MB transactions: every database started whole and at the last row (${by.copy} on the copy, ${by.restore} restored)` }
  },

  async stale() {
    const { holder, other } = await started(["a", "b"], { every: 0.2, ttl: 60_000 })
    await until(`${other} to follow`, async () => (await active(other, "db-follow.service")) === "active", 60_000)
    const since = now()
    check((await standby(holder, "move")).exitCode === 0, "standby move failed")
    // The follower goes near and is ready, then stops fetching, as one stuck on a dead connection would.
    await until(`${other}'s follower to look often`, async () => (await as(other, "cat $XDG_RUNTIME_DIR/standby/following").text()).includes("NEAR=1") && (await active(other, "db-follow.service")) === "active", 30_000)
    await as(other, "systemctl --user kill --signal=STOP db-follow.service")
    const { move, by } = await handover(holder, other, since, "planned")
    return { detail: `${other}'s follower stopped as the move began; ${other} started at ${holder}'s last row on ${by === "copy" ? "the copy, current before it stopped" : "a restore"}`, ms: { "planned move": move } }
  },

  async cost() {
    const names = ["a", "b"]
    // hex writes about 10 transactions a minute.
    const { holder, other } = await started(names, { ttl: 60_000, every: 6, pad: 120 })
    await until(`${other} to follow`, async () => (await active(other, "db-follow.service")) === "active", 120_000)
    await sleep(20_000)
    const window = 180_000
    const busyFrom = now()
    await sleep(window)
    const busy = await requests(names, busyFrom, now())
    await as(holder, "systemctl --user kill --signal=STOP toy.service")
    const idleFrom = now()
    await sleep(window)
    const idle = await requests(names, idleFrom, now())
    await as(holder, "systemctl --user kill --signal=CONT toy.service")
    const month = (counts: Record<string, number>, ops: string[]) => Math.round((ops.reduce((sum, op) => sum + (counts[op] ?? 0), 0) * 30 * 24 * 3600_000) / window)
    const classA = ["ListObjectsV2", "PutObject", "CopyObject", "CreateMultipartUpload", "UploadPart", "CompleteMultipartUpload"]
    const classB = ["GetObject", "HeadObject"]
    const line = (what: string, counts: Record<string, number>) =>
      `${what}: ${Object.entries(counts).map(([op, n]) => `${op} ${n}`).join(", ")} in ${window / 1000}s; a month: ${month(counts, classA)} class A, ${month(counts, classB)} class B`
    for (const [what, counts] of [[`holder ${holder}, writing`, busy[holder]!], [`waiter ${other}, writing`, busy[other]!], [`holder ${holder}, idle`, idle[holder]!], [`waiter ${other}, idle`, idle[other]!]] as const)
      console.log(`      ${line(what, counts)}`)
    return { detail: "requests counted at the store, at the real TTL" }
  },

  async home() {
    await started(["b"], { home: "a" })
    const back = now()
    await create("a", { home: "a" })
    const { move } = await handover("b", "a", back, "planned", STABLE * 2 + TTL * 2)
    return { detail: `home machine a came back and got the lease ${seconds(firstAfter("a", back)!.at - back)} after it booted`, ms: { "planned move": move } }
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
      const deadline = sleep(600_000).then(() => Promise.reject(new Error("took over 10 minutes")))
      const { detail, ms = {} } = await Promise.race([tests[name]!(), deadline])
      const times = Object.entries(ms).map(([what, value]) => `${what} ${seconds(value)}`).join(", ")
      console.log(`pass  ${name}: ${detail}${times ? ` (${times})` : ""}  [${seconds(now() - began)}]`)
    } catch (error) {
      failed++
      console.log(`FAIL  ${name}: ${(error as Error).message}  [${seconds(now() - began)}]${keep ? ` ${state}` : ""}`)
    }
    if (keep) console.log(`      ${state}`)
  }
} finally {
  // --keep leaves the last test's machines running too, to look into.
  if (!keep) await teardown()
}
process.exit(failed ? 1 : 0)
