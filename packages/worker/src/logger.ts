import { mkdirSync, appendFileSync } from "fs";
import { dirname } from "path";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class Logger {
  private level: number;
  private filePath: string | undefined;
  private module: string;
  private context: Record<string, unknown>;

  constructor(opts: {
    level?: LogLevel;
    filePath?: string;
    module?: string;
    context?: Record<string, unknown>;
  } = {}) {
    this.level = LEVEL_ORDER[opts.level ?? "info"];
    this.filePath = opts.filePath;
    this.module = opts.module ?? "app";
    this.context = opts.context ?? {};

    if (this.filePath) {
      try {
        mkdirSync(dirname(this.filePath), { recursive: true });
      } catch {
        // directory may already exist
      }
    }
  }

  child(fields: Record<string, unknown> & { module?: string; filePath?: string }): Logger {
    const { module, filePath, ...rest } = fields;
    const child = new Logger({
      level: Object.entries(LEVEL_ORDER).find(([, v]) => v === this.level)?.[0] as LogLevel,
      filePath: filePath ?? this.filePath,
      module: module ?? this.module,
      context: { ...this.context, ...rest },
    });
    return child;
  }

  debug(msg: string, ctx?: Record<string, unknown>): void {
    this.log("debug", msg, ctx);
  }

  info(msg: string, ctx?: Record<string, unknown>): void {
    this.log("info", msg, ctx);
  }

  warn(msg: string, ctx?: Record<string, unknown>): void {
    this.log("warn", msg, ctx);
  }

  error(msg: string, ctx?: Record<string, unknown>): void {
    this.log("error", msg, ctx);
  }

  private log(level: LogLevel, msg: string, ctx?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < this.level) return;

    const entry = {
      ts: new Date().toISOString(),
      level,
      module: this.module,
      msg,
      ...this.context,
      ...ctx,
    };

    const line = JSON.stringify(entry);
    process.stderr.write(line + "\n");

    if (this.filePath) {
      try {
        appendFileSync(this.filePath, line + "\n");
      } catch {
        // best-effort file logging
      }
    }
  }
}
