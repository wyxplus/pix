type RunGit = (cwd: string, args: string[]) => Promise<string>;

export async function validateBranch(run: RunGit, cwd: string, name: string): Promise<void> {
  if (!name || name.startsWith("-") || name.includes("@{")) throw new Error("Invalid branch name");
  await run(cwd, ["check-ref-format", "--branch", name]);
}

async function refExists(run: RunGit, cwd: string, ref: string): Promise<boolean> {
  try {
    await run(cwd, ["show-ref", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

export async function switchGitBranch(run: RunGit, cwd: string, raw: string): Promise<void> {
  const name = raw.trim();
  await validateBranch(run, cwd, name);
  if (await refExists(run, cwd, `refs/heads/${name}`)) {
    await run(cwd, ["switch", "--no-guess", name]);
    return;
  }
  if (!(await refExists(run, cwd, `refs/remotes/${name}`)))
    throw new Error("Branch does not exist");
  const short = name.slice(name.indexOf("/") + 1);
  await validateBranch(run, cwd, short);
  if (await refExists(run, cwd, `refs/heads/${short}`)) {
    await run(cwd, ["switch", "--no-guess", short]);
  } else {
    await run(cwd, ["switch", "--create", short, "--track", `refs/remotes/${name}`]);
  }
}
