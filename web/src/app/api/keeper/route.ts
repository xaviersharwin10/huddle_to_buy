import { exec } from "child_process";
import { NextResponse } from "next/server";
import path from "path";

const KEEPERHUB_API_URL = "https://app.keeperhub.com";
const COMMIT_WORKFLOW_ID = "agfndtbs9xl7wlj9qa3ud";
const REFUND_WORKFLOW_ID = "kt470bvmvs0aqyrtgi5ax";

async function fetchKeeperHubWorkflow(id: string, apiKey: string) {
  const res = await fetch(`${KEEPERHUB_API_URL}/api/workflows/${id}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { address } = (await req.json()) as { address?: string };
    if (!address)
      return NextResponse.json({ success: false, error: "Missing address" }, { status: 400 });

    const apiKey = process.env.KEEPERHUB_API_KEY ?? "";

    // Fetch live KeeperHub workflow statuses and run the local keeper in parallel.
    const contractDir = path.resolve(process.cwd(), "../contracts");
    const cmd = `pnpm exec hardhat run scripts/keeper.ts --network gensynTestnet`;

    const [commitWf, refundWf, keeperResult] = await Promise.all([
      apiKey ? fetchKeeperHubWorkflow(COMMIT_WORKFLOW_ID, apiKey) : Promise.resolve(null),
      apiKey ? fetchKeeperHubWorkflow(REFUND_WORKFLOW_ID, apiKey) : Promise.resolve(null),
      new Promise<{ success: boolean; stdout: string; stderr: string }>((resolve) => {
        exec(
          cmd,
          {
            cwd: contractDir,
            env: { ...process.env, COALITION_ADDRESS: address, STOP_ON_TERMINAL: "true" },
          },
          (error, stdout, stderr) => {
            resolve({ success: !error, stdout, stderr });
          },
        );
      }),
    ]);

    return NextResponse.json({
      ...keeperResult,
      keeperHub: {
        commitWorkflow: {
          id: COMMIT_WORKFLOW_ID,
          url: `${KEEPERHUB_API_URL}/workflows/${COMMIT_WORKFLOW_ID}`,
          ...(commitWf ?? {}),
        },
        refundWorkflow: {
          id: REFUND_WORKFLOW_ID,
          url: `${KEEPERHUB_API_URL}/workflows/${REFUND_WORKFLOW_ID}`,
          ...(refundWf ?? {}),
        },
      },
    });
  } catch (e) {
    return NextResponse.json({ success: false, error: (e as Error).toString() }, { status: 500 });
  }
}
