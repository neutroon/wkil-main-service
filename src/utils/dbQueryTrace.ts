import { AsyncLocalStorage } from "node:async_hooks";

export type DbQueryTraceSink = {
  addDbQuery(stage: string, durationMs: number): void;
};

type DbQueryTraceContext = {
  stage: string;
  sink: DbQueryTraceSink;
};

const dbQueryTraceStorage = new AsyncLocalStorage<DbQueryTraceContext>();

export function traceDbQueriesForStage<T>(
  stage: string,
  sink: DbQueryTraceSink,
  operation: () => Promise<T>,
): Promise<T> {
  return dbQueryTraceStorage.run({ stage, sink }, operation);
}

export function recordPrismaQuery(durationMs: number | undefined | null) {
  const context = dbQueryTraceStorage.getStore();
  if (!context || !Number.isFinite(durationMs)) return;
  context.sink.addDbQuery(context.stage, Number(durationMs));
}
