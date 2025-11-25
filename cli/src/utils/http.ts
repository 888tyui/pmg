import http from "http";
import https from "https";
import { URL } from "url";
import { getBackendUrl } from "./config.js";

export interface BackendRequestOptions {
  method?: string;
  body?: any;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export async function backendJson<T = any>(
  path: string,
  options: BackendRequestOptions = {}
): Promise<T> {
  const base = getBackendUrl();
  const url = new URL(path, base);
  const method = (options.method || (options.body ? "POST" : "GET")).toUpperCase();
  const payload =
    options.body === undefined
      ? undefined
      : typeof options.body === "string"
      ? options.body
      : JSON.stringify(options.body);
  const headers: Record<string, string> = {
    ...(options.headers || {}),
  };
  if (payload && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const isHttps = url.protocol === "https:";
  const client = isHttps ? https : http;
  const timeoutMs = options.timeoutMs ?? 10_000;

  return new Promise<T>((resolve, reject) => {
    const req = client.request(
      {
        method,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          const status = res.statusCode || 500;
          let parsed: any = null;
          if (data.length) {
            try {
              parsed = JSON.parse(data);
            } catch {
              parsed = { raw: data };
            }
          }
          if (status >= 400) {
            const errMsg =
              parsed?.message ||
              parsed?.error ||
              `Backend request failed with status ${status}`;
            const error = new Error(errMsg);
            (error as any).status = status;
            (error as any).response = parsed;
            reject(error);
          } else {
            resolve(parsed as T);
          }
        });
      }
    );
    req.on("error", reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}


