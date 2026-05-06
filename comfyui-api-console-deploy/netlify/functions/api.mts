const DEFAULT_COMFY_BASE = "https://4di2u9iqjg-8188.cnb.run";

declare const Netlify: {
  env: {
    get(name: string): string | undefined;
  };
};

function envDefaultBase() {
  try {
    return Netlify.env.get("COMFY_BASE") || DEFAULT_COMFY_BASE;
  } catch {
    return DEFAULT_COMFY_BASE;
  }
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function comfyBase(req: Request) {
  const url = new URL(req.url);
  const raw = (url.searchParams.get("base") || req.headers.get("x-comfy-base") || envDefaultBase()).trim().replace(/\/+$/, "");
  try {
    const parsed = new URL(raw);
    if (!["http:", "https:"].includes(parsed.protocol)) return envDefaultBase();
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return envDefaultBase();
  }
}

function pathAfterApi(req: Request) {
  const pathname = new URL(req.url).pathname;
  return pathname.replace(/^\/api/, "") || "/";
}

function queryWithoutBase(req: Request) {
  const url = new URL(req.url);
  url.searchParams.delete("base");
  return url.searchParams.toString();
}

async function proxyFetch(req: Request, remotePath: string, init: RequestInit = {}) {
  const target = `${comfyBase(req)}${remotePath}`;
  try {
    const response = await fetch(target, init);
    const headers = new Headers();
    const contentType = response.headers.get("content-type");
    if (contentType) headers.set("content-type", contentType);
    headers.set("cache-control", "no-store");
    return new Response(response.body, { status: response.status, headers });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 502);
  }
}

async function handleUpload(req: Request) {
  const body = await req.arrayBuffer();
  const contentType = req.headers.get("content-type") || "multipart/form-data";
  return proxyFetch(req, "/upload/image", {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
}

async function handleQueue(req: Request) {
  let payload: any;
  try {
    payload = await req.json();
  } catch (error) {
    return json({ error: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}` }, 400);
  }

  if (!payload?.workflow || typeof payload.workflow !== "object" || Array.isArray(payload.workflow)) {
    return json({ error: "workflow must be an API-format object" }, 400);
  }

  return proxyFetch(req, "/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prompt: payload.workflow,
      client_id: payload.client_id || crypto.randomUUID(),
    }),
  });
}

export default async (req: Request) => {
  const route = pathAfterApi(req);

  if (req.method === "GET" && route === "/config") {
    return json({ default_base: envDefaultBase() });
  }

  if (req.method === "GET" && route === "/status") {
    return proxyFetch(req, "/system_stats");
  }

  if (req.method === "GET" && route.startsWith("/history/")) {
    const promptId = encodeURIComponent(route.replace("/history/", ""));
    return proxyFetch(req, `/history/${promptId}`);
  }

  if (req.method === "GET" && route === "/view") {
    const query = queryWithoutBase(req);
    return proxyFetch(req, `/view${query ? `?${query}` : ""}`);
  }

  if (req.method === "POST" && route === "/upload") {
    return handleUpload(req);
  }

  if (req.method === "POST" && route === "/queue") {
    return handleQueue(req);
  }

  return json({ error: "Unknown endpoint" }, 404);
};

export const config = {
  path: "/api/*",
};
