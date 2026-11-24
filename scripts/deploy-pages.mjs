// Builds the site and publishes dist/ to the gh-pages branch, which GitHub
// Pages serves at the custom domain in public/CNAME.
//
//   pnpm deploy:pages
//
// The repository credential helper must already be able to push to origin.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });

console.log("building …");
run("pnpm", ["build"], process.cwd());

const remote = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim();
const dir = mkdtempSync(join(tmpdir(), "rjaa-pages-"));
cpSync("dist", dir, { recursive: true });
writeFileSync(join(dir, ".nojekyll"), "");

const git = (...args) => run("git", args, dir);
git("init", "-b", "gh-pages");
git("config", "user.name", "xiaotian7196");
git("config", "user.email", "157281571+xiaotian7196@users.noreply.github.com");
git("add", "-A");
git("commit", "-m", `Deploy ${new Date().toISOString()}`);
git("push", "--force", remote, "gh-pages");
console.log(`published ${dir} -> gh-pages`);
