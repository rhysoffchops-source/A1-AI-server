import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

// --- Types ---

export interface McpToolDef {
  name: string;
  description: string;
  node: "vps" | "mac-studio" | "macbook";
  category: "filesystem" | "browser" | "fetch" | "maps" | "shell";
  requiresApproval: boolean; // HITL
  inputSchema: Record<string, unknown>;
}

export interface McpNodeDef {
  id: string;
  label: string;
  tailscaleIp: string;
  port: number;
  status: "online" | "offline" | "unknown";
  lastSeen: number;
}

export interface McpApprovalRequest {
  id: string;
  toolName: string;
  arguments: Record<string, unknown>;
  node: string;
  createdAt: number;
  status: "pending" | "approved" | "denied";
}

export interface McpExecutionLog {
  id: string;
  toolName: string;
  node: string;
  arguments: Record<string, unknown>;
  result: string;
  isError: boolean;
  durationMs: number;
  timestamp: number;
}

// --- Tool Registry ---

const TOOLS: McpToolDef[] = [
  // VPS filesystem — restricted to /sandbox
  {
    name: "filesystem_read",
    description: "Read a file on VPS (restricted to /sandbox)",
    node: "vps",
    category: "filesystem",
    requiresApproval: false,
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Path relative to /sandbox" } },
      required: ["path"]
    }
  },
  {
    name: "filesystem_write",
    description: "Write a file on VPS (restricted to /sandbox)",
    node: "vps",
    category: "filesystem",
    requiresApproval: true,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to /sandbox" },
        content: { type: "string", description: "File content" }
      },
      required: ["path", "content"]
    }
  },
  {
    name: "filesystem_list",
    description: "List directory on VPS (restricted to /sandbox)",
    node: "vps",
    category: "filesystem",
    requiresApproval: false,
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Path relative to /sandbox" } },
      required: ["path"]
    }
  },
  // Mac Studio filesystem — full access to /projects
  {
    name: "filesystem_read_studio",
    description: "Read a file on Mac Studio (full access to /projects)",
    node: "mac-studio",
    category: "filesystem",
    requiresApproval: false,
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute path under /projects" } },
      required: ["path"]
    }
  },
  {
    name: "filesystem_write_studio",
    description: "Write a file on Mac Studio (full access to /projects)",
    node: "mac-studio",
    category: "filesystem",
    requiresApproval: true,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" }
      },
      required: ["path", "content"]
    }
  },
  {
    name: "filesystem_list_studio",
    description: "List directory on Mac Studio",
    node: "mac-studio",
    category: "filesystem",
    requiresApproval: false,
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"]
    }
  },
  // Puppeteer — Mac Studio (real browser, no headless detection)
  {
    name: "browser_screenshot",
    description: "Take a screenshot of a URL using Mac Studio's real browser",
    node: "mac-studio",
    category: "browser",
    requiresApproval: false,
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to capture" },
        fullPage: { type: "boolean", description: "Capture full page", default: false }
      },
      required: ["url"]
    }
  },
  {
    name: "browser_scrape",
    description: "Extract text content from a URL using Mac Studio's browser",
    node: "mac-studio",
    category: "browser",
    requiresApproval: false,
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        selector: { type: "string", description: "CSS selector to extract (optional)" }
      },
      required: ["url"]
    }
  },
  {
    name: "browser_click",
    description: "Click an element and return result (Mac Studio)",
    node: "mac-studio",
    category: "browser",
    requiresApproval: true,
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        selector: { type: "string" },
        waitMs: { type: "number", default: 2000 }
      },
      required: ["url", "selector"]
    }
  },
  // Fetch — VPS (lightweight HTTP)
  {
    name: "fetch_get",
    description: "HTTP GET request for real-time data gathering",
    node: "vps",
    category: "fetch",
    requiresApproval: false,
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        headers: { type: "object", description: "Optional headers" }
      },
      required: ["url"]
    }
  },
  {
    name: "fetch_post",
    description: "HTTP POST request for real-time data gathering",
    node: "vps",
    category: "fetch",
    requiresApproval: false,
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        body: { type: "object" },
        headers: { type: "object" }
      },
      required: ["url"]
    }
  },
  // Google Maps — VPS (fetch proxy)
  {
    name: "maps_geocode",
    description: "Geocode an address using Google Maps API",
    node: "vps",
    category: "maps",
    requiresApproval: false,
    inputSchema: {
      type: "object",
      properties: { address: { type: "string" } },
      required: ["address"]
    }
  },
  {
    name: "maps_search",
    description: "Search places using Google Maps API",
    node: "vps",
    category: "maps",
    requiresApproval: false,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        location: { type: "string", description: "lat,lng (optional)" },
        radius: { type: "number", description: "meters (optional)", default: 5000 }
      },
      required: ["query"]
    }
  },
];

// --- Node Registry ---

const NODES: McpNodeDef[] = [
  {
    id: "vps",
    label: "A1 VPS",
    tailscaleIp: "127.0.0.1",
    port: 8787,
    status: "online",
    lastSeen: Date.now()
  },
  {
    id: "mac-studio",
    label: "Mac Studio M1",
    tailscaleIp: process.env["A1_MAC_STUDIO_IP"] ?? "100.73.87.122",
    port: 11434,
    status: "unknown",
    lastSeen: 0
  },
  {
    id: "macbook",
    label: "MacBook Intel",
    tailscaleIp: process.env["A1_MACBOOK_IP"] ?? "100.73.87.123",
    port: 11435,
    status: "unknown",
    lastSeen: 0
  }
];

// --- State ---

const approvalQueue = new Map<string, McpApprovalRequest>();
const executionLogs: McpExecutionLog[] = [];
const MAX_LOGS = 200;

// --- Helpers ---

function sandboxPath(relative: string): string {
  const sandbox = resolve("/opt/a1/data/runtime/sandbox");
  const target = resolve(sandbox, relative.replace(/^\/+/, ""));
  if (!target.startsWith(sandbox)) throw new Error("Path traversal denied.");
  return target;
}

function addLog(entry: McpExecutionLog): void {
  executionLogs.push(entry);
  if (executionLogs.length > MAX_LOGS) executionLogs.shift();
}

export function getTools(): McpToolDef[] {
  return [...TOOLS];
}

export function getNodes(): McpNodeDef[] {
  return NODES.map((n) => ({ ...n }));
}

export function getLogs(): McpExecutionLog[] {
  return [...executionLogs];
}

export function getPendingApprovals(): McpApprovalRequest[] {
  return [...approvalQueue.values()].filter((a) => a.status === "pending");
}

// --- Tool Execution ---

export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  hitlEnabled: boolean
): Promise<{ result: string; isError: boolean; approvalId?: string }> {
  const tool = TOOLS.find((t) => t.name === toolName);
  if (!tool) throw new Error(`Unknown tool: ${toolName}`);

  // Check HITL
  if (hitlEnabled && tool.requiresApproval) {
    const approvalId = randomUUID();
    approvalQueue.set(approvalId, {
      id: approvalId,
      toolName,
      arguments: args,
      node: tool.node,
      createdAt: Date.now(),
      status: "pending"
    });
    return { result: "HITL approval required", isError: false, approvalId };
  }

  const start = Date.now();
  let result = "";
  let isError = false;

  try {
    if (tool.node === "vps") {
      result = await executeVps(tool, args);
    } else {
      result = await executeRemote(tool, args);
    }
  } catch (err) {
    result = `Error: ${err instanceof Error ? err.message : String(err)}`;
    isError = true;
  }

  addLog({
    id: randomUUID(),
    toolName,
    node: tool.node,
    arguments: args,
    result,
    isError,
    durationMs: Date.now() - start,
    timestamp: Date.now()
  });

  return { result, isError };
}

export function approveExecution(approvalId: string): McpApprovalRequest | null {
  const req = approvalQueue.get(approvalId);
  if (!req || req.status !== "pending") return null;
  req.status = "approved";
  return req;
}

export function denyExecution(approvalId: string): McpApprovalRequest | null {
  const req = approvalQueue.get(approvalId);
  if (!req || req.status !== "pending") return null;
  req.status = "denied";
  return req;
}

// --- VPS Tool Executors ---

async function executeVps(tool: McpToolDef, args: Record<string, unknown>): Promise<string> {
  switch (tool.name) {
    case "filesystem_read": {
      const path = sandboxPath(String(args["path"] ?? "."));
      await ensureSandbox();
      return await readFile(path, "utf-8");
    }
    case "filesystem_write": {
      const path = sandboxPath(String(args["path"] ?? ""));
      const content = String(args["content"] ?? "");
      await ensureSandbox();
      await writeFile(path, content, "utf-8");
      return `Written ${content.length} bytes to ${path}`;
    }
    case "filesystem_list": {
      const path = sandboxPath(String(args["path"] ?? "."));
      await ensureSandbox();
      const entries = await readdir(path, { withFileTypes: true });
      return entries.map((e) => `${e.isDirectory() ? "d" : "f"} ${e.name}`).join("\n");
    }
    case "fetch_get": {
      const url = String(args["url"] ?? "");
      const hdrs = (args["headers"] as Record<string, string>) ?? {};
      const resp = await fetch(url, { headers: hdrs, signal: AbortSignal.timeout(15000) });
      const text = await resp.text();
      return `HTTP ${resp.status}\n${text.slice(0, 5000)}`;
    }
    case "fetch_post": {
      const url = String(args["url"] ?? "");
      const body = (args["body"] ?? {}) as Record<string, unknown>;
      const hdrs = (args["headers"] as Record<string, string>) ?? {};
      const resp = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...hdrs },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000)
      });
      const text = await resp.text();
      return `HTTP ${resp.status}\n${text.slice(0, 5000)}`;
    }
    case "maps_geocode": {
      const address = String(args["address"] ?? "");
      const key = process.env["GOOGLE_MAPS_API_KEY"] ?? process.env["GEMINI_API_KEY"] ?? "";
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${key}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const data = (await resp.json()) as Record<string, unknown>;
      const results = data["results"] as Array<Record<string, unknown>> | undefined;
      if (!results || results.length === 0) return "No results found.";
      const loc = results[0]!;
      const geo = (loc["geometry"] as Record<string, unknown>) ?? {};
      const coords = (geo["location"] as Record<string, unknown>) ?? {};
      return `${loc["formatted_address"] ?? address}\nlat: ${coords["lat"]}, lng: ${coords["lng"]}`;
    }
    case "maps_search": {
      const query = String(args["query"] ?? "");
      const location = String(args["location"] ?? "");
      const radius = Number(args["radius"] ?? 5000);
      const key = process.env["GOOGLE_MAPS_API_KEY"] ?? process.env["GEMINI_API_KEY"] ?? "";
      let url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${key}&radius=${radius}`;
      if (location) url += `&location=${encodeURIComponent(location)}`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
      const data = (await resp.json()) as Record<string, unknown>;
      const results = data["results"] as Array<Record<string, unknown>> | undefined;
      if (!results || results.length === 0) return "No places found.";
      return results.slice(0, 10).map((p) => `${p["name"]} — ${p["formatted_address"] ?? ""} (rating: ${p["rating"] ?? "N/A"})`).join("\n");
    }
    default:
      throw new Error(`VPS tool not implemented: ${tool.name}`);
  }
}

// --- Remote Tool Execution (via worker command) ---

async function executeRemote(tool: McpToolDef, args: Record<string, unknown>): Promise<string> {
  const node = NODES.find((n) => n.id === tool.node);
  if (!node || node.status !== "online") {
    return `Node ${tool.node} is offline. Tool cannot execute.`;
  }

  // Build a shell command that the remote worker can execute
  // In production, this would queue a worker command via the worker-registry
  // For now, we use a direct fetch to the worker's HTTP endpoint

  const baseUrl = `http://${node.tailscaleIp}:${node.port}`;

  switch (tool.category) {
    case "filesystem": {
      const path = String(args["path"] ?? ".");
      try {
        const resp = await fetch(`${baseUrl}/fs/read?path=${encodeURIComponent(path)}`, {
          signal: AbortSignal.timeout(10000)
        });
        return resp.ok ? await resp.text() : `FS error: HTTP ${resp.status}`;
      } catch {
        return `Cannot reach ${node.label} at ${node.tailscaleIp}:${node.port}`;
      }
    }
    case "browser": {
      const url = String(args["url"] ?? "");
      try {
        const resp = await fetch(`${baseUrl}/browser/${tool.name.replace("browser_", "")}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(args),
          signal: AbortSignal.timeout(30000)
        });
        return resp.ok ? await resp.text() : `Browser error: HTTP ${resp.status}`;
      } catch {
        return `Cannot reach ${node.label} browser at ${node.tailscaleIp}:${node.port}`;
      }
    }
    default:
      return `Remote tool category ${tool.category} not yet implemented on worker.`;
  }
}

// --- Sandbox init ---

let sandboxReady = false;
async function ensureSandbox(): Promise<void> {
  if (sandboxReady) return;
  await mkdir("/opt/a1/data/runtime/sandbox", { recursive: true }).catch(() => {});
  sandboxReady = true;
}

// --- Node Health Check ---

export async function refreshNodeStatus(): Promise<McpNodeDef[]> {
  for (const node of NODES) {
    if (node.id === "vps") {
      node.status = "online";
      node.lastSeen = Date.now();
      continue;
    }
    try {
      const resp = await fetch(`http://${node.tailscaleIp}:${node.port}/health`, {
        signal: AbortSignal.timeout(5000)
      });
      if (resp.ok) {
        node.status = "online";
        node.lastSeen = Date.now();
      } else {
        node.status = "offline";
      }
    } catch {
      node.status = "offline";
    }
  }
  return NODES.map((n) => ({ ...n }));
}
