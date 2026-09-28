import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it.each([["example.com", 443], ["443", "example.com"]])("denies string host/port socket arguments %s, %s in the test subprocess", (...args) => {
  const preload = resolve(import.meta.dirname, "helpers/deny-network.cjs");
  for (const method of ["connect", "createConnection"]) {
    const script = `const net = require('node:net');
try {
  const socket = net[${JSON.stringify(method)}](...${JSON.stringify(args)});
  socket.destroy();
  process.exitCode = 2;
} catch (error) {
  if (error.message !== 'Unexpected network request in test subprocess') throw error;
}`;
    const result = spawnSync(process.execPath, ["--require", preload, "--eval", script], {
      encoding: "utf8", timeout: 5000,
    });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
  }
});
