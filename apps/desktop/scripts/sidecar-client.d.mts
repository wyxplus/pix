import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
export class SidecarClient extends EventEmitter {
  constructor(
    root: string,
    env: NodeJS.ProcessEnv,
    native?: (method: string, params: any) => Promise<any>,
  );
  readonly child: ChildProcess;
  readonly ready: Promise<void>;
  readonly stderr: string;
  invoke(channel: string, ...args: unknown[]): Promise<any>;
  close(): Promise<void>;
}
