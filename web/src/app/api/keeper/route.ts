import { exec } from "child_process";
import { NextResponse } from "next/server";
import path from "path";

export async function POST(req: Request): Promise<Response> {
  try {
    const { address } = (await req.json()) as { address?: string };
    if (!address)
      return NextResponse.json({ success: false, error: "Missing address" }, { status: 400 });

    const contractDir = path.resolve(process.cwd(), "../contracts");
    const cmd = `pnpm exec hardhat run scripts/keeper.ts --network gensynTestnet`;

    return new Promise<Response>((resolve) => {
      exec(
        cmd,
        {
          cwd: contractDir,
          // keeper.ts needs: COALITION_ADDRESS, PRIVATE_KEY / KEEPER_PRIVATE_KEY, GENSYN_TESTNET_RPC
          env: { ...process.env, COALITION_ADDRESS: address, STOP_ON_TERMINAL: "true" },
        },
        (error, stdout, stderr) => {
          resolve(NextResponse.json({ success: !error, stdout, stderr }));
        },
      );
    });
  } catch (e) {
    return NextResponse.json({ success: false, error: (e as Error).toString() }, { status: 500 });
  }
}
