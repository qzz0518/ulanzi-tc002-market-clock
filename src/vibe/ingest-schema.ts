/**
 * The wire contract between `src/vibe-agent.ts` and `POST /v1/push`.
 *
 * Its own module so the agent binary can name the schema without pulling in the
 * store (and the store without pulling in the agent). The envelope deliberately
 * mirrors openusage's hub shape — `{machine, sent_at, snapshots}` on
 * `/v1/push`, optional `Authorization: Bearer` — so that swapping our collector
 * for a third-party exporter later is a mapping of the array elements, not a
 * new endpoint. `schema` is what tells the two apart.
 */

export const VIBE_INGEST_SCHEMA = "vibe.usage.v1";

/** The path the agent posts to. Matches openusage's hub for the reason above. */
export const VIBE_INGEST_PATH = "/v1/push";
