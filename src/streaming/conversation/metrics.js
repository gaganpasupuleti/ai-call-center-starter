/**
 * Aggregate safe speech metrics (no transcripts, no audio).
 */
export class SpeechMetrics {
  constructor() {
    this.counters = {
      sttConnectionFailures: 0,
      sttTranscriptionFailures: 0,
      kokoroFailures: 0,
      piperFailures: 0,
      ttsQueueFull: 0,
      activeConversations: 0,
      completionReasons: {},
    };
    this.latencies = {
      sttMs: [],
      ttsMs: [],
      turnMs: [],
    };
  }

  inc(name, by = 1) {
    if (typeof this.counters[name] === 'number') {
      this.counters[name] += by;
    }
  }

  recordCompletion(reason) {
    const key = String(reason || 'unknown');
    this.counters.completionReasons[key] =
      (this.counters.completionReasons[key] || 0) + 1;
  }

  recordLatency(bucket, ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n < 0) return;
    const list = this.latencies[bucket];
    if (!list) return;
    list.push(n);
    if (list.length > 200) list.shift();
  }

  snapshot() {
    return {
      ...this.counters,
      latency: {
        sttMs: summarize(this.latencies.sttMs),
        ttsMs: summarize(this.latencies.ttsMs),
        turnMs: summarize(this.latencies.turnMs),
      },
    };
  }
}

function summarize(values) {
  if (!values.length) {
    return { count: 0, min: null, median: null, p95: null, max: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const pct = (p) =>
    sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
  return {
    count: sorted.length,
    min: sorted[0],
    median: pct(50),
    p95: pct(95),
    max: sorted[sorted.length - 1],
  };
}

export const globalSpeechMetrics = new SpeechMetrics();
