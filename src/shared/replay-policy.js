/**
 * How a recorded request is replayed to measure the app as it runs now. A just-restarted app is
 * slow for its first requests (cold code, new database connections), so reads are sent in warm-up
 * windows until they stop getting faster, then measured several times and the median kept.
 */
export const REPLAY = {
  /** Requests per warm-up window. */
  warmups: 3,
  /** At most this many warm-up requests in all. */
  maxWarmups: 30,
  /** Warm once a window's median is at least this share of the previous window's (under 10% faster). */
  settled: 0.9,
  samples: 5,
  maxSamples: 20,
  /** A replayed request that has not reported back by then counts as lost. */
  timeoutMs: 20000,
};

/** Methods backlens replays freely: they only read. */
export const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];
