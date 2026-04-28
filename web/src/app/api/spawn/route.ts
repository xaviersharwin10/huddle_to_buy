import { spawn, ChildProcess } from "child_process";
import { NextResponse } from "next/server";
import path from "path";
import fs from "fs";

// Cross-platform agent spawn API.
// - On Linux/macOS: uses child_process.spawn directly with detached children
//   whose stdout/stderr go to logs/agent-<id>.log. The dashboard polls each
//   agent's /status endpoint for live state — no terminal window needed.
// - On Windows: same, child_process.spawn supports it natively.
// - SELLER_PEER_ID is discovered dynamically from nodeS /topology.
// - Buyer credentials come from agent/.env.buyer{1,2,3} (gitignored). Copy the
//   per-buyer templates at agent/.env.buyer{1,2,3}.example.

type SpawnRequest = {
  agentId: "buyer1" | "buyer2" | "buyer3" | "seller";
  port: number;
  type: "buyer" | "seller";
};

const childByPort: Map<number, ChildProcess> = new Map();

const SELLER_AXL_API = "http://127.0.0.1:9032";

const ENV_FILE_BY_BUYER: Record<string, string> = {
  buyer1: ".env.buyer1",
  buyer2: ".env.buyer2",
  buyer3: ".env.buyer3",
};

async function fetchSellerPeerId(): Promise<string | null> {
  try {
    const res = await fetch(`${SELLER_AXL_API}/topology`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { our_public_key?: string };
    return typeof data.our_public_key === "string" ? data.our_public_key : null;
  } catch {
    return null;
  }
}

function loadEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
    const idx = line.indexOf("=");
    if (idx < 1) continue;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

function repoRoot(): string {
  return path.resolve(process.cwd(), "..");
}

export async function POST(req: Request) {
  try {
    const { agentId, port, type } = (await req.json()) as SpawnRequest;
    if (!port || !agentId || !type) {
      return NextResponse.json({ success: false, error: "agentId, port, type required" }, { status: 400 });
    }

    const root = repoRoot();
    const agentDir = path.join(root, "agent");
    if (!fs.existsSync(path.join(agentDir, "package.json"))) {
      return NextResponse.json(
        { success: false, error: `agent/ not found relative to ${process.cwd()}` },
        { status: 500 },
      );
    }

    // Kill existing on this port if any.
    const existing = childByPort.get(port);
    if (existing && existing.pid && !existing.killed) {
      try {
        existing.kill("SIGTERM");
      } catch {
        // ignore
      }
      childByPort.delete(port);
      await new Promise((r) => setTimeout(r, 500));
    }

    // Build env vars.
    const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port) };

    if (type === "seller") {
      env.AXL_API = SELLER_AXL_API;
      // SELLER side optionally takes its own keys from process env (out of band).
      // We don't auto-inject anything sensitive here.
    } else {
      const envFile = ENV_FILE_BY_BUYER[agentId];
      if (envFile) {
        const buyerEnv = loadEnvFile(path.join(agentDir, envFile));
        Object.assign(env, buyerEnv);
      }
      // Discover seller peer id at spawn time so a buyer always points at the
      // currently-running nodeS, regardless of host machine.
      const sellerPeerId = await fetchSellerPeerId();
      if (sellerPeerId) {
        env.SELLER_PEER_ID = sellerPeerId;
      } else {
        return NextResponse.json(
          {
            success: false,
            error: `Cannot reach seller AXL node at ${SELLER_AXL_API}/topology — start AXL nodes (axl/scripts/run-node.sh nodeS) and the seller agent (port 3004) first.`,
          },
          { status: 503 },
        );
      }
    }

    // Set up log file.
    const logsDir = path.join(root, "logs");
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    const logPath = path.join(logsDir, `agent-${agentId}.log`);
    const logFd = fs.openSync(logPath, "a");
    fs.writeSync(
      logFd,
      `\n--- Agent ${agentId} starting at ${new Date().toISOString()} (port=${port}) ---\n`,
    );

    const args =
      type === "seller"
        ? ["exec", "tsx", "src/index.ts", "seller"]
        : ["exec", "tsx", "src/index.ts", "run", "daemon"];

    const child = spawn("pnpm", args, {
      cwd: agentDir,
      env,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });

    if (!child.pid) {
      fs.closeSync(logFd);
      return NextResponse.json({ success: false, error: "failed to spawn child process" }, { status: 500 });
    }

    child.unref();
    childByPort.set(port, child);

    // The fd is owned by the child after spawn; we can close our handle.
    try {
      fs.closeSync(logFd);
    } catch {
      // ignore
    }

    return NextResponse.json({ success: true, pid: child.pid, log: logPath });
  } catch (e) {
    return NextResponse.json({ success: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const { port } = (await req.json()) as { port: number };
    const child = childByPort.get(port);
    if (child && child.pid && !child.killed) {
      try {
        // Negative PID kills the whole process group (the detached child).
        process.kill(-child.pid, "SIGTERM");
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
      }
      // Force-kill after 2s if still alive.
      setTimeout(() => {
        if (child.pid && !child.killed) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            try {
              child.kill("SIGKILL");
            } catch {
              // ignore
            }
          }
        }
      }, 2000);
      childByPort.delete(port);
    }
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ success: false, error: (e as Error).message }, { status: 500 });
  }
}
