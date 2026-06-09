export type LatencyTraceFields = Record<string, number>;

export class LatencyTrace {
  private readonly startedAt = Date.now();
  private readonly fields: LatencyTraceFields = {};

  constructor(initialFields: LatencyTraceFields = {}) {
    for (const [field, value] of Object.entries(initialFields)) {
      this.set(field, value);
    }
  }

  set(field: string, valueMs: number | undefined | null) {
    if (!Number.isFinite(valueMs)) return;
    this.fields[field] = Math.max(0, Math.round(Number(valueMs)));
  }

  add(field: string, valueMs: number | undefined | null) {
    if (!Number.isFinite(valueMs)) return;
    this.fields[field] =
      (this.fields[field] ?? 0) + Math.max(0, Math.round(Number(valueMs)));
  }

  async measure<T>(field: string, operation: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    try {
      return await operation();
    } finally {
      this.add(field, Date.now() - startedAt);
    }
  }

  snapshot(): LatencyTraceFields & { totalMs: number } {
    return {
      ...this.fields,
      totalMs: Date.now() - this.startedAt,
    };
  }
}

export function createLatencyTrace(initialFields: LatencyTraceFields = {}) {
  return new LatencyTrace(initialFields);
}
