import {
  traceDbQueriesForStage,
  type DbQueryTraceSink,
} from "./dbQueryTrace";

export type LatencyTraceFields = Record<string, number>;

export class LatencyTrace implements DbQueryTraceSink {
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

  max(field: string, valueMs: number | undefined | null) {
    if (!Number.isFinite(valueMs)) return;
    const value = Math.max(0, Math.round(Number(valueMs)));
    this.fields[field] = Math.max(this.fields[field] ?? 0, value);
  }

  addDbQuery(field: string, durationMs: number) {
    const prefix = field.endsWith("Ms") ? field.slice(0, -2) : field;
    this.add(`${prefix}DbQueries`, 1);
    this.add(`${prefix}DbMs`, durationMs);
    this.max(`${prefix}DbMaxMs`, durationMs);
  }

  async measure<T>(field: string, operation: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    try {
      return await operation();
    } finally {
      this.add(field, Date.now() - startedAt);
    }
  }

  async measureDb<T>(field: string, operation: () => Promise<T>): Promise<T> {
    return this.measure(field, () =>
      traceDbQueriesForStage(field, this, operation),
    );
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
