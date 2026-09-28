import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";

export async function runCli(args: string[], options: { env?: Record<string, string>; input?: string; cwd?: string; timeoutMs?: number; nodeArgs?: string[] } = {}): Promise<{ stdout: string; stderr: string; code: number }> {
  const executable = resolve(import.meta.dirname, "../../dist/bin/jev-axi.js");
  const preload = resolve(import.meta.dirname, "deny-network.cjs");
  const env = { ...process.env, ...options.env, PATH: `${dirname(process.execPath)}:${options.env?.PATH ?? process.env.PATH ?? ""}`, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${preload}`.trim() };
  return new Promise((done) => {
    const child = execFile(process.execPath, [...(options.nodeArgs ?? []), executable, ...args], {
      env, cwd: options.cwd, timeout: options.timeoutMs ?? 10000, maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => done({ stdout, stderr, code: typeof error?.code === "number" ? error.code : error ? 1 : 0 }));
    if (options.input !== undefined) child.stdin?.end(options.input);
    else child.stdin?.end();
  });
}
