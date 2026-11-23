// What the two classic scripts in stats.html put on window: qb.js (the
// query builder, state in and SQL out; it has node tests, so it stays
// as it is) and vendor/httpvfs/index.js (sql.js-httpvfs 0.8.12, UMD).
type QbFilter = { field: string; values?: string[]; text?: string; from?: string; to?: string };
type QbState = {
  status: string; filters: QbFilter[]; group: string; metric: string; limit: number;
  event: string; range: number; compare: string;
};
declare const QB: {
  FIELDS: Record<string, { label: string; kind: "pick" | "text" | "date"; col: string | null; searchable?: boolean }>;
  GROUPS: Record<string, { label: string; expr?: string; join?: string; skill?: boolean; time?: "day" | "week" | "month" }>;
  METRICS: Record<string, { label: string; col: string }>;
  STATUS: Record<string, { label: string; where: string | null }>;
  EVENTS: Record<string, { label: string; col: string }>;
  RANGES: Record<string, string>;
  defaultState(): QbState;
  canCompare(st: QbState): boolean;
  buildSql(st: QbState): string;
  encodeState(st: QbState): string;
  decodeState(s: string): Partial<QbState> | null;
};

type SqlResult = { columns: string[]; values: (string | number | null)[][] };
// The worker is a Comlink proxy: every property read is a promise.
type DbWorker = { db: { exec(sql: string): Promise<SqlResult[]> }; worker: { bytesRead: Promise<number> }; raw?: Worker };
declare function createDbWorker(configs: unknown[], workerUrl: string, wasmUrl: string, maxBytes?: number): Promise<DbWorker>;
