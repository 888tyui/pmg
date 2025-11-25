#!/usr/bin/env node
/**
 * Minimal git remote helper for 'permagit' to support `git push permagit <branch>`.
 * Protocol (simplified):
 * - Git sends 'capabilities' → we reply with 'push' and newline.
 * - Git sends lines like 'push <src>:<dst>' then 'done'.
 * - We trigger `permagit push` (opens browser flow), then respond 'ok <dst>' for each push.
 * - We do not implement fetch; clone should use `permagit clone`.
 */
import { spawn } from "child_process";

const stdin = process.stdin;
const stdout = process.stdout;

type PushSpec = { src: string; dst: string };
const pushSpecs: PushSpec[] = [];

async function runPermagitPush(): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("permagit", ["push"], {
      stdio: "inherit",
      shell: true,
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

function writeLine(line: string) {
  stdout.write(line + "\n");
}

async function main() {
  let buffer = "";
  stdin.setEncoding("utf8");
  stdin.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      // Git may send 'option <name> <value>' lines before anything else
      if (line.startsWith("option ")) {
        // Accept all options for simplicity
        writeLine("ok");
        continue;
      }
      if (line === "capabilities") {
        writeLine("push");
        // end of capabilities response
        writeLine("");
        continue;
      }
      // Git asks for refs before pushing
      if (line === "list") {
        // No refs to advertise; end the list with a blank line
        writeLine("");
        continue;
      }
      if (line.startsWith("push ")) {
        const spec = line.slice(5).trim(); // "<src>:<dst>"
        const [src, dst] = spec.split(":");
        pushSpecs.push({ src: src || "", dst: dst || "" });
        continue;
      }
      if (line === "done") {
        // execute push once for all refs
        (async () => {
          const code = await runPermagitPush();
          const ok = code === 0;
          for (const s of pushSpecs) {
            writeLine((ok ? "ok " : "error ") + (s.dst || "permagit"));
          }
          // end response
          writeLine("");
          process.exit(ok ? 0 : 1);
        })();
        return;
      }
      if (line === "quit") {
        process.exit(0);
      }
      // ignore unknown lines
    }
  });
  stdin.on("end", () => {
    // no commands; exit gracefully
    process.exit(0);
  });
}

main().catch(() => process.exit(1));
