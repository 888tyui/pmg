import { Command } from "commander";
import chalk from "chalk";
import { readUserConfig } from "../utils/config.js";

export default function registerWhoamiCommand(program: Command) {
  program
    .command("whoami")
    .description("Show the public key of the currently logged-in wallet.")
    .action(() => {
      const cfg = readUserConfig();
      if (!cfg.publicKey) {
        console.log(chalk.yellow("Not logged in. Run `permagit login` first."));
        return;
      }
      console.log("You are logged in as:");
      console.log(chalk.cyan(cfg.publicKey));
    });
}
