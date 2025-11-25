import { Command } from "commander";
import chalk from "chalk";
import { backendJson } from "../utils/http.js";
import { readRepoConfig, readUserConfig } from "../utils/config.js";
import { getRepoName, isGitRepo } from "../utils/git.js";

export default function registerOtpCommand(program: Command) {
  const otpCmd = new Command("otp").description("Manage OTP shares for private bundles.");

  otpCmd
    .command("request")
    .description("Request a one-time password for a private bundle (requires payment).")
    .requiredOption("--payment <txSig>", "Payment transaction signature for OTP issuance")
    .requiredOption("--bundle <txId>", "Arweave/Irys transaction id of the encrypted bundle")
    .option("--repo <name>", "Repository name (defaults to current repo config)")
    .option("--owner <pubkey>", "Owner public key (defaults to login)")
    .option("--key <base64>", "Custom decrypt key (base64). Generated if omitted.")
    .option("--expires <minutes>", "OTP expiry window in minutes (default 1440)")
    .action(async (opts: {
      payment: string;
      bundle: string;
      repo?: string;
      owner?: string;
      key?: string;
      expires?: string;
    }) => {
      try {
        const repoCfg = readRepoConfig();
        const userCfg = readUserConfig();
        const repoId = repoCfg.repoId || undefined;
        let repoName = opts.repo;
        if (!repoId && !repoName) {
          if (isGitRepo()) {
            repoName = getRepoName();
          } else {
            console.error(
              chalk.red(
                "Repo identifier required. Pass --repo <name> or run inside the repo directory."
              )
            );
            process.exit(1);
          }
        }
        const owner = opts.owner || userCfg.publicKey || null;
        const expiresInMinutes =
          typeof opts.expires === "string" ? Number(opts.expires) : undefined;
        const body: any = {
          repoId,
          owner: owner || undefined,
          name: repoName || undefined,
          bundleTx: opts.bundle,
          paymentTxSig: opts.payment,
          decryptKey: opts.key,
          expiresInMinutes: Number.isFinite(expiresInMinutes)
            ? expiresInMinutes
            : undefined,
        };
        console.log(chalk.gray("Requesting OTP..."));
        const resp = await backendJson<{
          otp: string;
          decryptKey: string;
          bundleTx: string;
          expiresAt: string;
        }>("/otp/request", { body });
        console.log(chalk.green("OTP issued"));
        console.log(`OTP: ${chalk.cyan(resp.otp)}`);
        console.log(`Decrypt key (base64): ${resp.decryptKey}`);
        console.log(`Bundle: ${resp.bundleTx}`);
        console.log(`Expires at: ${resp.expiresAt}`);
      } catch (err: any) {
        console.error(chalk.red("OTP request failed."));
        console.error(chalk.red(err?.message || String(err)));
        process.exit(1);
      }
    });

  otpCmd
    .command("redeem")
    .description("Redeem an OTP to inspect bundle metadata.")
    .requiredOption("--otp <token>", "OTP token to redeem")
    .action(async (opts: { otp: string }) => {
      try {
        const resp = await backendJson<{
          repoId: string;
          bundleTx: string;
          decryptKey: string;
        }>("/otp/redeem", { body: { otp: opts.otp } });
        console.log(chalk.green("OTP is valid."));
        console.log(`Repo ID: ${resp.repoId}`);
        console.log(`Bundle: ${resp.bundleTx}`);
        console.log(`Decrypt key (base64): ${resp.decryptKey}`);
      } catch (err: any) {
        console.error(chalk.red("OTP redeem failed."));
        console.error(chalk.red(err?.message || String(err)));
        process.exit(1);
      }
    });

  program.addCommand(otpCmd);
}

