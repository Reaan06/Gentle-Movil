import { request } from "node:http";

export interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json: unknown;
}

/** Plain GET against loopback. Never follows redirects: the bridge must not emit them. */
export function httpGet(port: number, path: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: "GET", agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          let json: unknown = undefined;
          try {
            json = JSON.parse(body);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(5000, () => {
      req.destroy(new Error("http request timed out"));
    });
    req.end();
  });
}
