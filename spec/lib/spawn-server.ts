// Spawns a real server/index.ts child process on a scratch port/DATA_DIR, for
// specs that need to restart the server mid-test (the APP_URL server from
// spec/global-setup.ts can't be restarted from inside a test). Each call is
// self-contained — start, use, stop — so no process outlives the test that
// started it (the lesson from issues/ANU-003.md).
import { spawn, type ChildProcess } from "node:child_process";

export interface SpawnedServer {
  baseUrl: string;
  stop(): Promise<void>;
}

export interface SpawnServerOptions {
  port: number;
  dataDir: string;
  /**
   * server/time.ts's GAME_TIME_SCALE — lets a spec exercise a multi-minute
   * design duration (capture time, production time, accrual) in real
   * seconds. Defaults to the server's own default (1) when omitted.
   */
  gameTimeScale?: number;
}

export function spawnServer({ port, dataDir, gameTimeScale }: SpawnServerOptions): Promise<SpawnedServer> {
  const baseUrl = `http://localhost:${port}`;
  const child: ChildProcess = spawn(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", "server/index.ts"],
    {
      env: {
        ...process.env,
        PORT: String(port),
        DATA_DIR: dataDir,
        ...(gameTimeScale !== undefined ? { GAME_TIME_SCALE: String(gameTimeScale) } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  function stop(): Promise<void> {
    return new Promise((resolve) => {
      if (child.exitCode !== null) {
        resolve();
        return;
      }
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
    });
  }

  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 10_000;
    child.once("exit", (code) => {
      reject(new Error(`server exited early (code ${code}): ${stderr}`));
    });
    (async () => {
      while (Date.now() < deadline) {
        try {
          await fetch(baseUrl);
          resolve({ baseUrl, stop });
          return;
        } catch {
          // not up yet
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      reject(new Error(`server on ${baseUrl} never came up: ${stderr}`));
    })();
  });
}
