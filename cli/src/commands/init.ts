import { Command } from "commander";
import chalk from "chalk";
import { isGitRepo, addOrUpdatePermagitRemote } from "../utils/git.js";
import { readRepoConfig, writeRepoConfig } from "../utils/config.js";

export default function registerInitCommand(program: Command) {
  program
    .command("init")
    .description(
      "Set up Permagit remote for current Git repo. (--private for encrypted mode)"
    )
    .option("--private", "Initialize in private (encrypted) mode")
    .action((opts: { private?: boolean }) => {
      if (!isGitRepo()) {
        console.error(
          chalk.red(
            "This directory is not a Git repository. Run `git init` first."
          )
        );
        process.exit(1);
      }
      const remoteResult = addOrUpdatePermagitRemote(
        "permagit://arweave",
        process.cwd()
      );
      const repoCfg = readRepoConfig();
      const next = writeRepoConfig(
        {
          private: Boolean(opts.private ?? repoCfg.private ?? false),
        },
        process.cwd()
      );
      if (remoteResult === "added") {
        console.log(chalk.green("Git remote 'permagit' has been added."));
      } else if (remoteResult === "exists") {
        console.log(chalk.gray("Git remote 'permagit' already exists."));
      } else {
        console.log(
          chalk.yellow(
            "Failed to add 'permagit' remote. Please configure it manually."
          )
        );
      }
      console.log("");
      console.log(chalk.green("Permagit initialization complete"));
      console.log(
        `Private mode: ${next.private ? chalk.cyan("on") : chalk.gray("off")}`
      );
      console.log("");
      console.log(
        chalk.gray(
          "Note: `git push permagit <branch>` will work after backend/upload integration."
        )
      );
    });
}
