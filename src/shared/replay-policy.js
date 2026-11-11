/**
 * How a recorded request is replayed to measure the app as it runs now. A just-restarted app is
 * slow for its first requests (cold code, new database connections), so reads are sent a few times
 * to warm up, then measured several times and the median kept.
 */
export const REPLAY = {
  warmups: 3,
  samples: 5,
  maxSamples: 20,
  /** A replayed request that has not reported back by then counts as lost. */
  timeoutMs: 20000,
};

/** Methods backlens replays freely: they only read. */
export const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];
