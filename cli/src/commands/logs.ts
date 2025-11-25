import { Command } from "commander";
import chalk from "chalk";
import http from "http";
import https from "https";
import { getBackendUrl, readUserConfig } from "../utils/config.js";

function getJson(url: URL): Promise<any> {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === "https:";
    const client = isHttps ? https : http;
    const req = client.request(
      {
        method: "GET",
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + (url.search || ""),
        headers: { Accept: "application/json" },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) =>
          chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
        );
        res.on("end", () => {
          try {
            const text = Buffer.concat(chunks).toString("utf-8");
            if (
              res.statusCode &&
              res.statusCode >= 200 &&
              res.statusCode < 300
            ) {
              resolve(JSON.parse(text || "null"));
            } else {
              reject(
                new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`)
              );
            }
          } catch (e) {
            reject(e);
          }
        });
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.end();
  });
}

export default function registerLogsCommand(program: Command) {
  program
    .command("logs")
    .description("List recent permagit push logs (newest first)")
    .option("--repo <name>", "Filter by repo name")
    .option(
      "--owner <pubkey>",
      "Filter by owner public key (defaults to your login)"
    )
    .option("--limit <n>", "Max items to show (default 20)", "20")
    .action(async (opts: { repo?: string; owner?: string; limit?: string }) => {
      try {
        const backendBase = getBackendUrl();
        const url = new URL("/logs", backendBase);
        const userCfg = readUserConfig();
        const owner = opts.owner || userCfg.publicKey || "";
        if (owner) url.searchParams.set("owner", owner);
        if (opts.repo) url.searchParams.set("repo", opts.repo);
        const limit = Math.max(
          1,
          Math.min(1000, parseInt(opts.limit || "20", 10) || 20)
        );
        const rows: any[] = await getJson(url);
        const items = Array.isArray(rows) ? rows.slice(0, limit) : [];
        if (!items.length) {
          console.log(chalk.gray("No logs found."));
          return;
        }
        // Header
        console.log(chalk.bold("Recent push logs (newest first):"));
        for (const r of items) {
          const created = r.createdAt || r.created_at || "";
          const repo = r.repo || "";
          const branch = r.branch || "";
          const tx = r.txId || r.txid || r.tx_id || "";
          const enc = r.encrypted ? "yes" : "no";
          console.log(
            `- ${created}  repo=${repo}  branch=${branch}  enc=${enc}  tx=${tx}`
          );
        }
      } catch (e: any) {
        console.error(chalk.red("Failed to fetch logs."));
        console.error(String(e?.message || e));
        process.exit(1);
      }
    });
}
