import { NextRequest, NextResponse } from "next/server";
import { controlProxyTarget } from "@/lib/control-proxy.mjs";

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const target = controlProxyTarget(`/${path.join("/")}`, new URL(request.url).search, request.method);
  if (!target) return NextResponse.json({ error: "不允许代理该 Control API 路径。" }, { status: 404 });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_500);
  try {
    const headers = new Headers();
    for (const name of ["content-type", "x-taskcenter-action"]) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const upstream = await fetch(target, { method: request.method, headers, body: request.method === "GET" ? undefined : await request.text(), cache: "no-store", signal: controller.signal });
    const body = await upstream.text();
    return new NextResponse(body, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  } catch {
    return NextResponse.json({ error: "本地 Control API 不可用。" }, { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}

export function GET(request: NextRequest, context: { params: Promise<{ path: string[] }> }) { return proxy(request, context); }
export function POST(request: NextRequest, context: { params: Promise<{ path: string[] }> }) { return proxy(request, context); }
