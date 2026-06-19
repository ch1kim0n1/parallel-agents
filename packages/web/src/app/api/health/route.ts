import { NextResponse } from "next/server";

export async function GET() {
  const { version } = (await import("../../../../package.json", { with: { type: "json" } }))
    .default as { version: string };
  return NextResponse.json({ status: "ok", version });
}
