import * as http from "http";
import * as https from "https";
import type { IncomingMessage } from "http";

export interface HttpJsonOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  /** When true, skip TLS certificate verification (self-signed / corporate proxies). */
  tlsInsecure?: boolean;
  timeoutMs?: number;
}

function readBody(res: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    res.on("error", reject);
  });
}

export async function httpJson(
  url: string,
  opts: HttpJsonOptions = {}
): Promise<{ status: number; body: any; raw: string }> {
  const method = opts.method ?? "POST";
  const payload =
    opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body), "utf8");
  const headers: Record<string, string> = {
    Accept: "application/json",
    ...(opts.headers ?? {}),
  };
  if (payload) {
    headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
    headers["Content-Length"] = String(payload.length);
  }

  const attempt = (): Promise<{ status: number; body: any; raw: string }> =>
    new Promise((resolve, reject) => {
      const u = new URL(url);
      const isHttps = u.protocol === "https:";
      const lib = isHttps ? https : http;
      const req = lib.request(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || (isHttps ? 443 : 80),
          path: `${u.pathname}${u.search}`,
          method,
          headers,
          ...(isHttps ? { rejectUnauthorized: !opts.tlsInsecure } : {}),
        },
        async (res) => {
          try {
            const raw = await readBody(res);
            let body: any = {};
            if (raw) {
              try {
                body = JSON.parse(raw);
              } catch {
                body = { message: raw };
              }
            }
            resolve({ status: res.statusCode ?? 0, body, raw });
          } catch (e) {
            reject(e);
          }
        }
      );

      const timeoutMs = opts.timeoutMs ?? 120_000;
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`Timeout após ${timeoutMs}ms`));
      });

      const onAbort = () => {
        req.destroy(new Error("Aborted"));
      };
      if (opts.signal) {
        if (opts.signal.aborted) {
          onAbort();
          return;
        }
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }

      req.on("error", (err) => {
        opts.signal?.removeEventListener("abort", onAbort);
        reject(err);
      });

      req.on("close", () => {
        opts.signal?.removeEventListener("abort", onAbort);
      });

      if (payload) {
        req.write(payload);
      }
      req.end();
    });

  let lastErr: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      const result = await attempt();
      if ((result.status === 429 || result.status >= 500) && i < 2) {
        await new Promise((r) => setTimeout(r, 400 * (i + 1)));
        continue;
      }
      return result;
    } catch (e) {
      lastErr = e;
      if (opts.signal?.aborted) {
        throw e;
      }
      if (i < 2) {
        await new Promise((r) => setTimeout(r, 400 * (i + 1)));
        continue;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
