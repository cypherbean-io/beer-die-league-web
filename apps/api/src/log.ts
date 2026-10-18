// JSON-lines logger. Callers pass only safe fields: never emails, codes, tokens, display
// names, raw IPs, request bodies, or raw paths (see CLAUDE.md, Logging).
export type LogEntry = { level: 'info' | 'warn' | 'error'; msg: string; [field: string]: unknown };
export type Log = (entry: LogEntry) => void;

export const stdoutLog: Log = (entry) => {
  process.stdout.write(`${JSON.stringify(entry)}\n`);
};

// Error fields that are safe to log: the class name and a provider or SQLSTATE code. Never
// the message, which can carry user data (Postgres messages quote conflicting values).
export function safeErrorFields(err: unknown): { error: string; code?: string } {
  const name = err instanceof Error ? err.name : typeof err;
  const raw = (err as { code?: unknown } | null)?.code;
  const code = typeof raw === 'string' && /^[A-Z0-9_]{1,40}$/.test(raw) ? raw : undefined;
  return code ? { error: name, code } : { error: name };
}
