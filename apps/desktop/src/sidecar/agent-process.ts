import { fork, type ChildProcess } from "node:child_process";

const children = new Set<ChildProcess>();
export function forkAgent(modulePath: string, env: Record<string, string>): ChildProcess {
  const child = fork(modulePath, [], {
    env,
    execPath: process.execPath,
    execArgv: [],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    serialization: "json",
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}
process.on("exit", () => {
  for (const child of children) child.kill();
});
