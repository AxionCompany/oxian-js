import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { kill } from "node:process";
// @deno-types="npm:@types/ws@8.18.2"
import { WebSocket } from "ws";

const root = fileURLToPath(new URL("../../", import.meta.url));
const appModule = new URL("../../src/app/index.ts", import.meta.url).href;
const httpModule = new URL("../../src/http/index.ts", import.meta.url).href;

async function bounded<T>(
  promise: Promise<T>,
  ms: number,
  detail: () => string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Shutdown subprocess timeout: ${detail()}`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

for (const adapter of ["cli-portable", "cli-native", "node"] as const) {
  for (const mode of adapter === "node" ? ["start"] : ["start", "dev"]) {
    for (const transport of ["in-process", "websocket"]) {
      for (const peer of ["abrupt", "unresponsive"] as const) {
        test(`${adapter}/${mode}/${transport}: SIGTERM exits after ${peer} peer`, async () => {
          const dir = await mkdtemp(join(tmpdir(), "oxian-shutdown-"));
          const clients: WebSocket[] = [];
          await mkdir(join(dir, "routes"));
          await writeFile(
            join(dir, "routes/index.ts"),
            `export function GET(request, context) { return context.state.fetch(request); }`,
          );
          await writeFile(
            join(dir, "app.ts"),
            `
import {createApplication} from ${JSON.stringify(appModule)};
import {upgradeWebSocket} from ${JSON.stringify(httpModule)};
export default ({router, basePath}) => createApplication({router, basePath,
  state: {fetch(request) {
    if (new URL(request.url).searchParams.has('pending')) {
      console.log('PENDING');
      return new Promise(resolve => {
        const done = () => resolve(new Response(null, {status:503}));
        request.signal.addEventListener('abort', done, {once:true});
        if (request.signal.aborted) done();
      });
    }
    const {socket,response} = ${adapter === "cli-native" ? "Deno.upgradeWebSocket" : "upgradeWebSocket"}(request);
    socket.binaryType = 'arraybuffer';
    socket.onmessage = event => socket.send(event.data);
    return response;
  }}, dispose() { console.log('DISPOSED'); }
});`,
          );
          await writeFile(
            join(dir, "oxian.config.ts"),
            `export default {application:{routesRoot:'./routes',factory:'./app.ts'},gateway:{workerTransport:'${transport}',listener:{hostname:'127.0.0.1',port:0},hypervisor:{shutdownTimeoutMs:100,cancellationAckTimeoutMs:100}}};`,
          );
          const child =
            adapter === "node"
              ? spawn(
                  "node",
                  [join(root, "tests/fixtures/shutdown/node.ts"), transport],
                  { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
                )
              : spawn(
                  "deno",
                  [
                    "run",
                    "-A",
                    "--config",
                    join(root, "deno.json"),
                    join(root, "cli.ts"),
                    mode,
                    "--config",
                    join(dir, "oxian.config.ts"),
                  ],
                  { cwd: dir, stdio: ["ignore", "pipe", "pipe"] },
                );
          const exited = once(child, "close");
          let log = "";
          const ready = Promise.withResolvers<string>();
          const pending = Promise.withResolvers<void>();
          const collect = (data: Buffer) => {
            log += data.toString();
            const url = /listening at (http:\/\/[^\s]+)/.exec(log)?.[1];
            if (url) ready.resolve(url);
            if (log.includes("PENDING")) pending.resolve();
          };
          child.stdout!.on("data", collect);
          child.stderr!.on("data", collect);
          try {
            const url = await bounded(
              Promise.race([
                ready.promise,
                exited.then(() => {
                  throw new Error(log);
                }),
              ]),
              15_000,
              () => log,
            );
            const client = new WebSocket(url.replace("http:", "ws:"));
            clients.push(client);
            client.on("error", () => undefined);
            let status: number | undefined;
            client.on("upgrade", (response) => {
              status = response.statusCode;
            });
            await bounded(once(client, "open"), 5_000, () => log);
            assert.equal(status, 101);
            for (const data of ["echo", Buffer.from([0, 255, 12])]) {
              const received = once(client, "message");
              client.send(data);
              const [echo, binary] = await bounded(received, 5_000, () => log);
              assert.equal(binary, typeof data !== "string");
              assert.deepEqual(Buffer.from(echo), Buffer.from(data));
            }
            if (peer === "abrupt") {
              const closed = once(client, "close");
              client.terminate();
              await closed;
            } else {
              // Pause the client's native reader: it cannot acknowledge Close.
              client.pause();
              const waiting = new WebSocket(
                url.replace("http:", "ws:") + "?pending",
              );
              clients.push(waiting);
              waiting.on("error", () => undefined);
              await bounded(pending.promise, 5_000, () => log);
            }
            const start = Date.now();
            // Deno's ChildProcess.kill caches the sent signal as exit status,
            // even when the child handles it. Observe the actual OS exit here.
            kill(child.pid!, "SIGTERM");
            const [code, signal] = await bounded(exited, 3_000, () => log);
            assert.equal(signal, null, log);
            assert.equal(code, 0, log);
            assert.match(log, /DISPOSED/);
            console.log(
              `${adapter}/${mode}/${transport}/${peer}: 101, text/binary echo, disposal, exit=0 in ${Date.now() - start}ms`,
            );
          } finally {
            for (const client of clients) client.terminate();
            if (child.exitCode === null && child.signalCode === null)
              child.kill("SIGKILL");
            await exited;
            await rm(dir, { recursive: true, force: true });
          }
        });
      }
    }
  }
}
