type Labels = Record<string, string>;

const counters = new Map<string, number>();
const latency = { count: 0, sumMs: 0, buckets: new Map<number, number>() };
const BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500];

function key(name: string, labels: Labels = {}): string {
  const l = Object.entries(labels)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}="${v}"`)
    .join(',');
  return l ? `${name}{${l}}` : name;
}

/** Contador em memória, por processo (o Prometheus soma entre instâncias). */
export function inc(name: string, labels: Labels = {}, by = 1): void {
  const k = key(name, labels);
  counters.set(k, (counters.get(k) ?? 0) + by);
}

export function observeLatency(ms: number): void {
  latency.count++;
  latency.sumMs += ms;
  for (const b of BUCKETS_MS) if (ms <= b) latency.buckets.set(b, (latency.buckets.get(b) ?? 0) + 1);
}

export function renderProcessMetrics(): string {
  const lines: string[] = [];
  for (const [k, v] of [...counters.entries()].sort()) lines.push(`${k} ${v}`);
  lines.push('# TYPE wager_processing_latency_ms histogram');
  for (const b of BUCKETS_MS) {
    lines.push(`wager_processing_latency_ms_bucket{le="${b}"} ${latency.buckets.get(b) ?? 0}`);
  }
  lines.push(`wager_processing_latency_ms_bucket{le="+Inf"} ${latency.count}`);
  lines.push(`wager_processing_latency_ms_sum ${latency.sumMs}`);
  lines.push(`wager_processing_latency_ms_count ${latency.count}`);
  return lines.join('\n');
}

/** Só para testes. */
export function resetMetrics(): void {
  counters.clear();
  latency.count = 0;
  latency.sumMs = 0;
  latency.buckets.clear();
}