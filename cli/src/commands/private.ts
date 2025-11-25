import { Command } from "commander";
import chalk from "chalk";
import { readRepoConfig, writeRepoConfig } from "../utils/config.js";

export default function registerPrivateCommand(program: Command) {
  const privateCmd = new Command("private").description(
    "Manage repository private (encrypted) mode."
  );

  privateCmd
    .command("on")
    .description("Turn private (encrypted) mode on")
    .action(() => {
      const current = readRepoConfig();
      writeRepoConfig({ private: true });
      console.log(chalk.green("Private mode enabled."));
      if (!current.private) {
        console.log(
          chalk.gray(
            "Future pushes will encrypt before upload. (to be implemented)"
          )
        );
      }
    });

  privateCmd
    .command("off")
    .description("Turn public mode on")
    .action(() => {
      writeRepoConfig({ private: false });
      console.log(chalk.green("Switched to public mode."));
    });

  program.addCommand(privateCmd);
}
