import { AwsClient } from "aws4fetch"
import type { Lease, Seen, Store } from "./lease"

export type Bucket = { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; key?: string }

export function s3({ endpoint, bucket, accessKeyId, secretAccessKey, key = "lease.json" }: Bucket, cutOff: () => boolean): Store & { remove(): Promise<void> } {
  const client = new AwsClient({ accessKeyId, secretAccessKey, service: "s3", region: "auto" })
  const url = `${endpoint.replace(/\/$/, "")}/${bucket}/${key}`
  const request = (init: RequestInit) => {
    if (cutOff()) throw new Error("drill: acting cut off from the bucket")
    return client.fetch(url, { ...init, signal: AbortSignal.timeout(5000) })
  }

  return {
    async read(): Promise<Seen | null> {
      const response = await request({ headers: { "cache-control": "no-cache" } })
      if (response.status === 404) return null
      if (!response.ok) throw new Error(`reading the lease: ${response.status}`)
      return { lease: (await response.json()) as Lease, etag: response.headers.get("etag")! }
    },
    async write(lease, etag) {
      const response = await request({
        method: "PUT",
        body: JSON.stringify(lease),
        headers: { "content-type": "application/json", ...(etag ? { "if-match": etag } : { "if-none-match": "*" }) },
      })
      if (response.status === 412 || response.status === 409) return null
      if (!response.ok) throw new Error(`writing the lease: ${response.status}`)
      return response.headers.get("etag")!
    },
    async remove() {
      await request({ method: "DELETE" })
    },
  }
}

/** Refuses a bucket that doesn't enforce conditional writes, where two machines could both win. */
export async function enforcesConditions(bucket: Bucket): Promise<boolean> {
  const probe = s3({ ...bucket, key: `probe-${crypto.randomUUID()}.json` }, () => false)
  const lease: Lease = { holder: "probe", tenure: 0, beat: "" }
  const first = await probe.write(lease, null)
  const again = await probe.write(lease, null)
  const stale = await probe.write({ ...lease, beat: "2" }, '"0"')
  await probe.remove()
  return first !== null && again === null && stale === null
}
