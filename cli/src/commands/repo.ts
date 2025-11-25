import { Command } from "commander";
import chalk from "chalk";
import {
  readRepoConfig,
  readUserConfig,
  writeRepoConfig,
} from "../utils/config.js";
import { getRepoName, isGitRepo } from "../utils/git.js";
import { backendJson } from "../utils/http.js";

function parseSigners(input?: string | string[]): string[] {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input
      .flatMap((val) =>
        typeof val === "string" ? val.split(",") : (val as any)
      )
      .map((v) => (typeof v === "string" ? v.trim() : ""))
      .filter((v) => v.length > 0);
  }
  return input
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

export default function registerRepoCommand(program: Command) {
  const repoCmd = new Command("repo").description(
    "Manage repository metadata with the Permagit backend."
  );

  repoCmd
    .command("register")
    .description(
      "Register the current repo with the backend after submitting the payment."
    )
    .requiredOption("--payment <txSig>", "Token transfer signature for payment")
    .option("--name <name>", "Repository name (defaults to current directory)")
    .option("--owner <pubkey>", "Repository owner public key (defaults to login)")
    .option("--private", "Mark repo as private (encrypted pushes)", false)
    .option("--signers <pubkeys>", "Comma-separated list of multisig signers")
    .option(
      "--threshold <n>",
      "Multisig approval threshold (defaults to ceil(len/2))"
    )
    .action(async (opts: {
      payment: string;
      name?: string;
      owner?: string;
      private?: boolean;
      signers?: string;
      threshold?: string;
    }) => {
      if (!isGitRepo()) {
        console.error(chalk.red("Not inside a git repository."));
        process.exit(1);
      }
      const repoCfg = readRepoConfig();
      const userCfg = readUserConfig();
      const repoName = (opts.name || getRepoName()).trim();
      const owner = (opts.owner || userCfg.publicKey || "").trim();
      if (!owner) {
        console.error(
          chalk.red(
            "Owner public key is required. Login first or pass --owner <pubkey>."
          )
        );
        process.exit(1);
      }
      const signers = parseSigners(opts.signers);
      if (signers.length && !signers.includes(owner)) {
        signers.push(owner);
      }
      const threshold =
        typeof opts.threshold === "string" ? Number(opts.threshold) : undefined;
      try {
        console.log(chalk.gray("Verifying payment..."));
        await backendJson("/payments/verify", {
          body: {
            txSig: opts.payment,
            payer: owner,
            purpose: "repo_init",
            repoName,
          },
        });
        console.log(chalk.gray("Creating repo metadata..."));
        const result = await backendJson<{
          repo: {
            id: string;
            isPrivate: boolean;
            isMultisig: boolean;
            threshold: number | null;
            signers: string[];
          };
        }>("/repos", {
          body: {
            name: repoName,
            owner,
            isPrivate:
              typeof opts.private === "boolean" ? opts.private : repoCfg.private,
            signers,
            threshold: Number.isFinite(threshold) ? threshold : undefined,
            paymentTxSig: opts.payment,
          },
        });
        const repoId = result?.repo?.id;
        if (repoId) {
          writeRepoConfig(
            {
              repoId,
              private:
                typeof opts.private === "boolean"
                  ? opts.private
                  : repoCfg.private,
            },
            process.cwd()
          );
        }
        console.log(
          chalk.green(
            `Repo ${repoName} registered. Multisig: ${
              result.repo.isMultisig ? "enabled" : "disabled"
            }`
          )
        );
        if (result.repo.isMultisig) {
          console.log(
            `Signers (${result.repo.signers.length}): ${result.repo.signers.join(
              ", "
            )}`
          );
          console.log(
            `Threshold: ${result.repo.threshold ?? Math.ceil(result.repo.signers.length / 2)}`
          );
        }
      } catch (err: any) {
        console.error(chalk.red("Repo registration failed."));
        console.error(chalk.red(err?.message || String(err)));
        process.exit(1);
      }
    });

  program.addCommand(repoCmd);
}

