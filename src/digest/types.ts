export type DigestStatus = 'ok' | 'retry' | 'fail';

/** One job across every valid event in a single night's log. */
export type DigestRow = {
  job: string;
  /** Owner of the chronologically last event; null remains visible as missing. */
  owner: string | null;
  /** Number of valid events for this job, including retries and failures. */
  runs: number;
  /** Number of this job's events whose status is retry. */
  retries: number;
  lastStatus: DigestStatus;
  /** Most recent error present, retained after recovery; null if none occurred. */
  lastError: string | null;
  /** Earliest/latest event by instant; retain the original timestamp and offset. */
  firstAt: string;
  lastAt: string;
  /** True if any event failed, even if a later event recovered. */
  hasFailure: boolean;
};

export type NightDigest = {
  night: string;
  /** One row per job, sorted ascending by job using string comparison. */
  rows: DigestRow[];
  /** Nonblank lines rejected for invalid JSON or an invalid event schema. */
  badLines: number;
  /** Counts of valid events, not counts of jobs or their final statuses. */
  counts: Record<DigestStatus, number>;
};

/**
 * Contract for readNight, implemented in ./reader.ts.
 *
 * Read runsDir/<night>.jsonl synchronously. Accept only a YYYY-MM-DD basename
 * (no separators or traversal); return null for an invalid night or missing file.
 * Other filesystem errors propagate. An empty file returns an empty digest with
 * zero counts. Ignore blank lines, including the trailing newline.
 *
 * Each valid line is a JSON object with a nonempty string job, an ISO 8601 at
 * timestamp with an explicit offset (or Z) identifying a valid instant, a status
 * from DigestStatus, owner as string or null, and optional string error. Missing
 * owner is invalid; extra properties are ignored. Invalid lines increment
 * badLines and do not affect rows or counts.
 *
 * Order events by timestamp instant, not file position or timestamp text. For
 * equal instants, original file order breaks ties (the later line wins for the
 * last event). firstAt/lastAt keep the original strings. owner and lastStatus
 * describe the last event. lastError is the error from the chronologically last
 * event containing an error, even if a later event recovers; null means no event
 * contained an error. An explicitly present empty string still counts as an error.
 *
 * Consumers can import this type before the reader exists; implementations
 * export `const readNight: ReadNight = ...` from ./reader.ts.
 */
export type ReadNight = (runsDir: string, night: string) => NightDigest | null;
