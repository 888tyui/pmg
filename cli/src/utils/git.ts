import { execSync } from "child_process";
import path from "path";

export function isGitRepo(cwd = process.cwd()) {
  try {
    execSync("git rev-parse --is-inside-work-tree", { stdio: "ignore", cwd });
    return true;
  } catch {
    return false;
  }
}

export function addOrUpdatePermagitRemote(
  remoteUrl = "permagit://arweave",
  cwd = process.cwd()
) {
  try {
    execSync("git remote get-url permagit", { stdio: "ignore", cwd });
    // If exists, skip URL update (extend later for actual URL update)
    return "exists";
  } catch {
    try {
      execSync(`git remote add permagit ${remoteUrl}`, {
        stdio: "ignore",
        cwd,
      });
      return "added";
    } catch {
      return "failed";
    }
  }
}

export function getCurrentBranch(cwd = process.cwd()): string {
  try {
    const out = execSync("git rev-parse --abbrev-ref HEAD", { cwd });
    return out.toString().trim();
  } catch {
    return "unknown";
  }
}

export function getRepoName(cwd = process.cwd()): string {
  return path.basename(cwd);
}
