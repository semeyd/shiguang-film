import { createServer } from "vite";
import { spawn } from "node:child_process";
import electronPath from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = await createServer({ root, server: { host: "127.0.0.1", port: 5173, strictPort: true } });
await server.listen();
const environment = { ...process.env, PHOTOBOOK_DEV_URL: "http://127.0.0.1:5173" };
delete environment.ELECTRON_RUN_AS_NODE;
const child = spawn(electronPath, ["."], { cwd: root, env: environment, stdio: "inherit" });
let closing = false;
async function close(code = 0) {
  if (closing) return;
  closing = true;
  if (!child.killed) child.kill();
  await server.close();
  process.exitCode = code;
}
child.once("exit", (code) => close(code || 0));
child.once("error", (error) => { console.error(error.message); close(1); });
process.once("SIGINT", () => close());
process.once("SIGTERM", () => close());
