import { Command } from "commander";
import chalk from "chalk";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import registerLoginCommand from "./commands/login.js";
import registerWhoamiCommand from "./commands/whoami.js";
import registerInitCommand from "./commands/init.js";
import registerPrivateCommand from "./commands/private.js";
import registerIrysCommand from "./commands/irys.js";
import registerPushCommand from "./commands/push.js";
import registerCloneCommand from "./commands/clone.js";
import registerLogsCommand from "./commands/logs.js";
import registerFundCommand from "./commands/fund.js";
import registerRepoCommand from "./commands/repo.js";
import registerOtpCommand from "./commands/otp.js";
import registerApproveCommand from "./commands/approve.js";

const program = new Command();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8")
);

program
  .name("permagit")
  .description("Permagit CLI - Decentralized Git on Arweave with Solana wallet")
  .version(pkg.version);

registerLoginCommand(program);
registerWhoamiCommand(program);
registerInitCommand(program);
registerPrivateCommand(program);
registerIrysCommand(program);
registerPushCommand(program);
registerCloneCommand(program);
registerLogsCommand(program);
registerFundCommand(program);
registerRepoCommand(program);
registerOtpCommand(program);
registerApproveCommand(program);

program.configureHelp({
  sortSubcommands: true,
});

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = (err as any)?.message || String(err);
  console.error(chalk.red(`Error: ${message}`));
  process.exit(1);
});
