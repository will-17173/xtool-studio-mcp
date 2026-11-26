import { createHash } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const profile = process.platform === "win32" ? homedir().toLowerCase() : homedir();
const ownerKey = createHash("sha256").update(profile).digest("hex").slice(0, 16);
const lockPath = join(homedir(), `.xtool-studio-desktop-${ownerKey}.lock`);

export async function withDesktopLock<T>(operation: () => Promise<T>): Promise<T> {
  const deadline = performance.now() + 20000;
  async function acquire() {
    while (true) {
      try {
        return await open(lockPath, "wx", 0o600);
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
      }
      if (performance.now() >= deadline) {
        throw new Error(`Another Studio desktop action holds the lock at ${lockPath}. If the owning MCP server has exited, remove its abandoned lock before retrying.`);
      }
      await delay(125);
    }
  }

  const lock = await acquire();
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    return await operation();
  } finally {
    try {
      await lock.close();
    } finally {
      await unlink(lockPath);
    }
  }
}
