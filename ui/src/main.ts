type HealthStatus = "degraded" | "healthy" | "unhealthy";
interface Dashboard {
  readonly agents: readonly Agent[];
  readonly codeVerification: readonly CodeVerification[];
  readonly gpu: readonly Gpu[];
  readonly health: {
    readonly checks: Readonly<Record<string, { readonly status: HealthStatus }>>;
    readonly status: HealthStatus;
  };
  readonly memory: readonly MemoryResult[];
  readonly models: readonly Model[];
  readonly plugins: readonly Plugin[];
  readonly projects: readonly Project[];
  readonly system: System;
  readonly tasks: readonly Task[];
  readonly workers: readonly Worker[];
}
interface Agent {
  readonly id: string;
  readonly name: string;
  readonly maxSteps: number;
  readonly locationPreference: string;
}
interface Gpu {
  readonly index: number;
  readonly memoryTotalMb: number;
  readonly memoryUsedMb: number;
  readonly name: string;
  readonly temperatureCelsius: number;
  readonly utilizationPercent: number;
}
interface MemoryResult {
  readonly record: {
    readonly content: string;
    readonly key: string;
    readonly scope: string;
    readonly scopeId: string;
    readonly updatedAt: string;
  };
  readonly score: number;
}
interface Model {
  readonly capabilities: readonly string[];
  readonly id: string;
  readonly location: string;
  readonly priority: number;
  readonly providerId: string;
}
interface Plugin {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly version: string;
}
interface Project {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly status: string;
  readonly updatedAt: string;
}
interface System {
  readonly cpuCount: number;
  readonly freeMemoryBytes: number;
  readonly loadAverage: readonly number[];
  readonly platform: string;
  readonly systemUptimeSeconds: number;
  readonly totalMemoryBytes: number;
}
interface Task {
  readonly attempt: number;
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly updatedAt: string;
}
interface Worker {
  readonly allowedRoots: readonly string[];
  readonly id: string;
  readonly lastSeenAt?: string;
  readonly name: string;
  readonly platform: string;
  readonly status: string;
}
interface CodeVerification {
  readonly branch: string;
  readonly changedFiles: number;
  readonly fingerprint: string;
  readonly lastSeenAt: string;
  readonly lastVerifiedAt?: string;
  readonly lockStatus: string;
  readonly path: string;
  readonly reviewStatus: string;
  readonly reviewSummary?: string;
  readonly reviewedAt?: string;
  readonly verificationStatus: string;
  readonly workerId: string;
}
interface AgentTask {
  readonly failure?: { readonly message?: string };
  readonly id: string;
  readonly result?: { readonly output?: string };
  readonly status: string;
}
interface ChatMessage {
  readonly content: string;
  readonly id: string;
  readonly role: "assistant" | "user";
  readonly state?: "failed" | "queued" | "running";
  readonly taskId?: string;
}

const views = [
  "Chat",
  "Overview",
  "Projects",
  "Agents",
  "Workers",
  "Verification",
  "Tasks",
  "Models",
  "Memory",
  "Plugins",
  "Logs",
  "System"
] as const;
type View = (typeof views)[number];
const CHAT_STORAGE_KEY = "a1-concierge-chat";
const MAX_CHAT_MESSAGES = 40;
let active: View = "Chat";
let snapshot: Dashboard | undefined;
const events: string[] = [];
let chatSending = false;
let chatMessages = loadChatMessages();

function element(id: string): HTMLElement {
  const value = document.getElementById(id);
  if (value === null) throw new Error(`Missing element "${id}".`);
  return value;
}
function escape(value: unknown): string {
  return String(value).replace(
    /[&<>"']/gu,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ??
      character
  );
}
function bytes(value: number): string {
  return `${(value / 1_073_741_824).toFixed(1)} GB`;
}
function age(seconds: number): string {
  const hours = Math.floor(seconds / 3_600);
  return hours < 24 ? `${String(hours)}h` : `${String(Math.floor(hours / 24))}d`;
}
function status(value: string): string {
  const style =
    value === "healthy" ||
    value === "active" ||
    value === "online" ||
    value === "passed" ||
    value === "approved" ||
    value === "unlocked" ||
    value === "succeeded"
      ? ""
      : value === "degraded" ||
          value === "paused" ||
          value === "queued" ||
          value === "running" ||
          value === "unverified" ||
          value === "lock_queued" ||
          value === "unlock_queued" ||
          value === "fix_required"
        ? " warn"
        : " bad";
  return `<span class="status${style}">${escape(value)}</span>`;
}
function rows(headers: readonly string[], values: readonly (readonly unknown[])[]): string {
  if (values.length === 0) return `<div class="empty">No records yet.</div>`;
  return `<div class="rows"><div class="row header">${headers.map((item) => `<span>${escape(item)}</span>`).join("")}</div>${values.map((row) => `<div class="row">${row.map((item, index) => (index === 0 ? `<strong>${String(item)}</strong>` : `<span>${String(item)}</span>`)).join("")}</div>`).join("")}</div>`;
}
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  const token = sessionStorage.getItem("a1-token");
  if (token !== null) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(url, {
    ...init,
    headers
  });
  if (!response.ok)
    throw new Error(
      ((await response.json()) as { message?: string }).message ?? `HTTP ${String(response.status)}`
    );
  return response.json() as Promise<T>;
}
function toast(message: string): void {
  const node = element("toast");
  node.textContent = message;
  node.classList.add("show");
  window.setTimeout(() => node.classList.remove("show"), 3_000);
}
function card(title: string, body: string, css = ""): string {
  return `<article class="card ${css}"><h2>${escape(title)}</h2>${body}</article>`;
}
function loadChatMessages(): ChatMessage[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(CHAT_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.flatMap((item): ChatMessage[] => {
      if (item === null || typeof item !== "object" || Array.isArray(item)) return [];
      const message = item as Record<string, unknown>;
      if (
        typeof message.id !== "string" ||
        typeof message.content !== "string" ||
        (message.role !== "assistant" && message.role !== "user")
      ) {
        return [];
      }
      return [
        {
          content: message.content,
          id: message.id,
          role: message.role,
          ...(message.state === "failed" ||
          message.state === "queued" ||
          message.state === "running"
            ? { state: message.state }
            : {}),
          ...(typeof message.taskId === "string" ? { taskId: message.taskId } : {})
        }
      ];
    });
  } catch {
    return [];
  }
}
function persistChatMessages(): void {
  try {
    localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(chatMessages.slice(-MAX_CHAT_MESSAGES)));
  } catch {
    // The chat remains available for the current browser session when storage is unavailable.
  }
}
function setChatMessages(messages: readonly ChatMessage[]): void {
  chatMessages = messages.slice(-MAX_CHAT_MESSAGES);
  persistChatMessages();
}
function replaceChatMessage(id: string, update: ChatMessage): void {
  setChatMessages(chatMessages.map((message) => (message.id === id ? update : message)));
}
function chatMessage(message: ChatMessage): string {
  const label = message.role === "user" ? "You" : "Concierge";
  const state =
    message.state === undefined
      ? ""
      : `<span class="chat-state ${message.state}">${escape(
          message.state === "failed" ? "Could not complete" : "Working"
        )}</span>`;
  const task =
    message.taskId === undefined
      ? ""
      : `<span class="chat-task">Task ${escape(message.taskId.slice(0, 8))}</span>`;
  return `<section class="chat-message ${message.role}${message.state === "failed" ? " failed" : ""}">
    <div class="chat-message-meta"><strong>${label}</strong>${state}${task}</div>
    <div class="chat-message-body">${escape(message.content).replaceAll("\n", "<br>")}</div>
  </section>`;
}
function chat(data: Dashboard): string {
  const concierge = data.agents.find((agent) => agent.id === "concierge");
  if (concierge === undefined) {
    return card(
      "Concierge chat",
      `<div class="empty">The Concierge agent is not configured. Add an agent with the ID <span class="mono">concierge</span> to enable chat.</div>`,
      "full"
    );
  }
  const messages =
    chatMessages.length === 0
      ? `<div class="chat-empty"><strong>Concierge is ready.</strong><span>Ask for a small task, a check, or help with your local A1 setup.</span></div>`
      : chatMessages.map(chatMessage).join("");
  const buttonLabel = chatSending ? "Working…" : "Send";
  return `<article class="chat-card">
    <div class="chat-head"><div><p class="eyebrow">LOCAL CONCIERGE</p><h2>Ask Concierge</h2><p>Small tasks run locally and appear here when they finish.</p></div><button id="clear-chat" class="danger" type="button"${chatSending ? " disabled" : ""}>Clear chat</button></div>
    <div class="chat-messages" id="chat-messages" aria-live="polite">${messages}</div>
    <form id="concierge-chat-form" class="chat-composer">
      <textarea name="input" rows="3" required placeholder="Ask Concierge to do something…"${chatSending ? " disabled" : ""}></textarea>
      <div class="chat-composer-actions"><span>Enter to send · Shift + Enter for a new line</span><button class="primary" type="submit"${chatSending ? " disabled" : ""}>${buttonLabel}</button></div>
    </form>
  </article>`;
}
function overview(data: Dashboard): string {
  const used = data.system.totalMemoryBytes - data.system.freeMemoryBytes;
  return `<div class="grid">
    ${card("System state", `<div class="stat">${escape(data.health.status)}</div><div class="label">${String(Object.keys(data.health.checks).length)} dependencies reporting</div>`)}
    ${card("Task queue", `<div class="stat">${String(data.tasks.filter((task) => task.status === "queued" || task.status === "running").length)}</div><div class="label">${String(data.tasks.length)} recent tasks</div>`)}
    ${card("Model catalog", `<div class="stat">${String(data.models.length)}</div><div class="label">${String(new Set(data.models.map((model) => model.providerId)).size)} configured providers</div>`)}
    ${card("Enrolled workers", `<div class="stat">${String(data.workers.filter((worker) => worker.status === "online").length)}</div><div class="label">${String(data.workers.length)} known machines</div>`)}
    ${card("Code gate", `<div class="stat">${String(data.codeVerification.filter((project) => project.verificationStatus === "passed" && project.reviewStatus === "approved" && project.lockStatus === "unlocked").length)} / ${String(data.codeVerification.length)}</div><div class="label">projects write-authorized</div>`)}
    ${card("Memory", `<div class="stat">${String(data.memory.length)}</div><div class="label">recent persistent records</div>`)}
    ${card("Host memory", `<div class="stat">${bytes(used)}</div><div class="label">of ${bytes(data.system.totalMemoryBytes)} used</div><div class="bar"><i style="width:${String(Math.round((used / data.system.totalMemoryBytes) * 100))}%"></i></div>`)}
    ${card("GPU", data.gpu.length === 0 ? `<div class="stat">—</div><div class="label">No NVIDIA GPU detected locally</div>` : `<div class="stat">${String(data.gpu.length)}</div><div class="label">${escape(data.gpu.map((gpu) => gpu.name).join(", "))}</div>`)}
    ${card(
      "Recent activity",
      rows(
        ["Task", "Kind", "Status", "Updated"],
        data.tasks
          .slice(0, 8)
          .map((task) => [
            escape(task.id.slice(0, 8)),
            escape(task.kind),
            status(task.status),
            new Date(task.updatedAt).toLocaleTimeString()
          ])
      ),
      "full"
    )}
  </div>`;
}
function projects(data: Dashboard): string {
  return card(
    "Register project",
    `<form id="project-form"><input name="name" required placeholder="Project name"><input name="path" required placeholder="/absolute/path"><button class="primary">Register</button></form>${rows(
      ["Project", "Path", "Status", "Updated"],
      data.projects.map((project) => [
        escape(project.name),
        `<span class="mono">${escape(project.path)}</span>`,
        status(project.status),
        new Date(project.updatedAt).toLocaleString()
      ])
    )}`,
    "full"
  );
}
function agents(data: Dashboard): string {
  const form =
    data.agents.length === 0
      ? ""
      : `<form id="agent-form"><select name="agentId">${data.agents.map((agent) => `<option value="${escape(agent.id)}">${escape(agent.name)}</option>`).join("")}</select><input name="input" required placeholder="Instruction"><button class="primary">Queue run</button></form>`;
  return card(
    "Agent monitor",
    `${form}${rows(
      ["Agent", "Location", "Step limit", "ID"],
      data.agents.map((agent) => [
        escape(agent.name),
        escape(agent.locationPreference),
        String(agent.maxSteps),
        `<span class="mono">${escape(agent.id)}</span>`
      ])
    )}`,
    "full"
  );
}
function workers(data: Dashboard): string {
  return card(
    "Machine control",
    `<p class="muted">Workers connect outward to this A1 hub. Concierge can inspect them and queue scoped code checks; changes remain inside their approved roots.</p>${rows(
      ["Worker", "Platform", "Last seen", "Approved roots"],
      data.workers.map((worker) => [
        `${escape(worker.name)}<br><span class="mono">${escape(worker.id)}</span>`,
        `${status(worker.status)} <span class="muted">${escape(worker.platform)}</span>`,
        worker.lastSeenAt === undefined ? "Never" : new Date(worker.lastSeenAt).toLocaleString(),
        `<span class="mono">${escape(worker.allowedRoots.join(", "))}</span>`
      ])
    )}`,
    "full"
  );
}
function verification(data: Dashboard): string {
  const workerNames = new Map(data.workers.map((worker) => [worker.id, worker.name]));
  return card(
    "Code verification gate",
    `<p class="muted">A project is write-authorized only when its exact source fingerprint has passed deterministic verification and an approved Code Watchdog review. A Watchdog block cancels queued A1 writes and requests a physical source-tree lock on that machine.</p>${rows(
      ["Project", "Worker", "Verifier", "Watchdog / lock", "Last review"],
      data.codeVerification.map((project) => [
        `<span class="mono">${escape(project.path)}</span><br><span class="muted">${escape(project.branch)} · ${String(project.changedFiles)} changed</span>`,
        escape(workerNames.get(project.workerId) ?? project.workerId),
        status(project.verificationStatus),
        `${status(project.reviewStatus)} ${status(project.lockStatus)}${project.reviewSummary === undefined ? "" : `<br><span class="muted">${escape(project.reviewSummary)}</span>`}`,
        project.reviewedAt === undefined ? "Not yet" : new Date(project.reviewedAt).toLocaleString()
      ])
    )}`,
    "full"
  );
}
function tasks(data: Dashboard): string {
  return card(
    "Task queue",
    rows(
      ["Task", "Kind", "Status", "Attempt"],
      data.tasks.map((task) => [
        `<span class="mono">${escape(task.id)}</span>`,
        escape(task.kind),
        status(task.status),
        String(task.attempt)
      ])
    ),
    "full"
  );
}
function models(data: Dashboard): string {
  return card(
    "Model selector",
    rows(
      ["Model", "Provider", "Location", "Capabilities"],
      data.models.map((model) => [
        escape(model.id),
        escape(model.providerId),
        escape(model.location),
        escape(model.capabilities.join(", "))
      ])
    ),
    "full"
  );
}
function memory(data: Dashboard): string {
  return card(
    "Memory viewer",
    `<form id="memory-form"><input name="query" required placeholder="Search persistent memory"><button>Search</button></form>${rows(
      ["Key", "Scope", "Content", "Score"],
      data.memory.map((item) => [
        escape(item.record.key),
        escape(`${item.record.scope}:${item.record.scopeId}`),
        escape(item.record.content.slice(0, 120)),
        item.score.toFixed(3)
      ])
    )}`,
    "full"
  );
}
function plugins(data: Dashboard): string {
  return card(
    "Plugin manager",
    rows(
      ["Plugin", "Version", "Status", "ID"],
      data.plugins.map((plugin) => [
        escape(plugin.name),
        escape(plugin.version),
        status(plugin.status),
        `<span class="mono">${escape(plugin.id)}</span>`
      ])
    ),
    "full"
  );
}
function logs(): string {
  return card(
    "Live event log",
    `<pre class="log">${events.length === 0 ? "Waiting for control-plane events…" : escape(events.join("\n"))}</pre>`,
    "full"
  );
}
function system(data: Dashboard): string {
  const healthRows = Object.entries(data.health.checks).map(([name, check]) => [
    escape(name),
    status(check.status),
    "",
    ""
  ]);
  const gpuRows = data.gpu.map((gpu) => [
    escape(gpu.name),
    `${String(gpu.utilizationPercent)}%`,
    `${String(gpu.memoryUsedMb)} / ${String(gpu.memoryTotalMb)} MB`,
    `${String(gpu.temperatureCelsius)}°C`
  ]);
  return `<div class="grid">${card("Host", `<div class="stat">${escape(data.system.platform)}</div><div class="label">${String(data.system.cpuCount)} CPUs · uptime ${age(data.system.systemUptimeSeconds)} · load ${data.system.loadAverage.map((item) => item.toFixed(2)).join(" / ")}</div>`, "full")}${card("Dependencies", rows(["Service", "State", "", ""], healthRows), "full")}${card("GPU telemetry", rows(["Device", "Utilization", "Memory", "Temperature"], gpuRows), "full")}</div>`;
}
function render(): void {
  if (snapshot === undefined) return;
  element("page-title").textContent = active;
  const content = element("content");
  content.innerHTML =
    active === "Chat"
      ? chat(snapshot)
      : active === "Overview"
        ? overview(snapshot)
        : active === "Projects"
          ? projects(snapshot)
          : active === "Agents"
            ? agents(snapshot)
            : active === "Workers"
              ? workers(snapshot)
              : active === "Verification"
                ? verification(snapshot)
                : active === "Tasks"
                  ? tasks(snapshot)
                  : active === "Models"
                    ? models(snapshot)
                    : active === "Memory"
                      ? memory(snapshot)
                      : active === "Plugins"
                        ? plugins(snapshot)
                        : active === "Logs"
                          ? logs()
                          : system(snapshot);
  bindForms();
  if (active === "Chat") {
    const messages = document.getElementById("chat-messages");
    if (messages !== null) messages.scrollTop = messages.scrollHeight;
  }
}
function bindForms(): void {
  document
    .querySelector<HTMLFormElement>("#project-form")
    ?.addEventListener("submit", (event) => void submitProject(event));
  document
    .querySelector<HTMLFormElement>("#concierge-chat-form")
    ?.addEventListener("submit", (event) => void submitConciergeChat(event));
  document
    .querySelector<HTMLTextAreaElement>("#concierge-chat-form textarea")
    ?.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        const textarea = event.currentTarget as HTMLTextAreaElement;
        const form = textarea.closest<HTMLFormElement>("form");
        form?.requestSubmit();
      }
    });
  document.querySelector<HTMLButtonElement>("#clear-chat")?.addEventListener("click", clearChat);
}
async function submitProject(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const values = new FormData(form);
  try {
    await request("/api/v1/projects", {
      body: JSON.stringify({ name: values.get("name"), path: values.get("path") }),
      method: "POST"
    });
    form.reset();
    await refresh();
    toast("Project registered");
  } catch (error: unknown) {
    toast(error instanceof Error ? error.message : "Project registration failed");
  }
}
async function submitAgent(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const values = new FormData(form);
  try {
    await request("/api/v1/agents/runs", {
      body: JSON.stringify({ agentId: values.get("agentId"), input: values.get("input") }),
      method: "POST"
    });
    form.reset();
    await refresh();
    toast("Agent run queued");
  } catch (error: unknown) {
    toast(error instanceof Error ? error.message : "Agent run failed");
  }
}
function chatPrompt(input: string): string {
  const history = chatMessages
    .filter((message) => message.state === undefined)
    .slice(-10)
    .map(
      (message) =>
        `${message.role === "user" ? "User" : "Concierge"}: ${message.content.slice(-1_200)}`
    );
  if (history.length === 0) return input;
  return `Continue this Concierge chat. Use the earlier messages only as context, then answer the final user request.\n\n${history.join("\n\n")}\n\nUser: ${input}`;
}
function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
async function waitForAgentTask(taskId: string): Promise<AgentTask> {
  for (let attempts = 0; attempts < 400; attempts += 1) {
    const task = await request<AgentTask>(`/api/v1/tasks/${encodeURIComponent(taskId)}`);
    if (task.status === "succeeded" || task.status === "failed" || task.status === "cancelled") {
      return task;
    }
    await wait(750);
  }
  throw new Error("Concierge took too long to respond. Check Tasks for the run status.");
}
async function submitConciergeChat(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (chatSending) return;
  const form = event.currentTarget as HTMLFormElement;
  const input = new FormData(form).get("input");
  if (typeof input !== "string" || input.trim() === "") return;
  const text = input.trim();
  const prompt = chatPrompt(text);
  const responseId = crypto.randomUUID();
  setChatMessages([
    ...chatMessages,
    { content: text, id: crypto.randomUUID(), role: "user" },
    { content: "Concierge is working…", id: responseId, role: "assistant", state: "queued" }
  ]);
  chatSending = true;
  render();
  try {
    const task = await request<AgentTask>("/api/v1/agents/runs", {
      body: JSON.stringify({ agentId: "concierge", input: prompt }),
      method: "POST"
    });
    replaceChatMessage(responseId, {
      content: "Concierge is working…",
      id: responseId,
      role: "assistant",
      state: "running",
      taskId: task.id
    });
    render();
    const completed = await waitForAgentTask(task.id);
    if (completed.status === "succeeded" && typeof completed.result?.output === "string") {
      replaceChatMessage(responseId, {
        content: completed.result.output,
        id: responseId,
        role: "assistant",
        taskId: task.id
      });
    } else {
      replaceChatMessage(responseId, {
        content:
          completed.failure?.message ??
          "Concierge could not complete that task. Check the Tasks view for details.",
        id: responseId,
        role: "assistant",
        state: "failed",
        taskId: task.id
      });
    }
    await refresh();
  } catch (error: unknown) {
    replaceChatMessage(responseId, {
      content: error instanceof Error ? error.message : "Concierge could not start that task.",
      id: responseId,
      role: "assistant",
      state: "failed"
    });
  } finally {
    chatSending = false;
    render();
  }
}
function clearChat(): void {
  setChatMessages([]);
  render();
}
async function submitMemory(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const values = new FormData(event.currentTarget as HTMLFormElement);
  try {
    const query = values.get("query");
    if (typeof query !== "string") throw new TypeError("Memory query is invalid.");
    const result = await request<{ results: Dashboard["memory"] }>(
      `/api/v1/memory/search?q=${encodeURIComponent(query)}`
    );
    if (snapshot !== undefined) snapshot = { ...snapshot, memory: result.results };
    render();
  } catch (error: unknown) {
    toast(error instanceof Error ? error.message : "Search failed");
  }
}
function bindDynamicForms(): void {
  document
    .querySelector<HTMLFormElement>("#agent-form")
    ?.addEventListener("submit", (event) => void submitAgent(event));
  document
    .querySelector<HTMLFormElement>("#memory-form")
    ?.addEventListener("submit", (event) => void submitMemory(event));
}
async function refresh(): Promise<void> {
  try {
    snapshot = await request<Dashboard>("/api/v1/dashboard");
    element("connection-dot").classList.add("online");
    element("connection-text").textContent = "Live";
    render();
    bindDynamicForms();
  } catch (error: unknown) {
    element("connection-dot").classList.remove("online");
    element("connection-text").textContent = "Offline";
    toast(error instanceof Error ? error.message : "Dashboard unavailable");
  }
}

const nav = element("nav");
nav.innerHTML = views
  .map(
    (view) =>
      `<button class="nav-item${view === active ? " active" : ""}" data-view="${view}"><span>${view}</span></button>`
  )
  .join("");
nav.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-view]");
  if (target === null) return;
  active = target.dataset.view as View;
  nav
    .querySelectorAll(".nav-item")
    .forEach((item) => item.classList.toggle("active", item === target));
  render();
  bindDynamicForms();
});
element("refresh").addEventListener("click", () => void refresh());
element("access").addEventListener("click", () => {
  const current = sessionStorage.getItem("a1-token") ?? "";
  const token = window.prompt("A1 bearer token (leave empty to clear)", current);
  if (token === null) return;
  if (token.trim() === "") sessionStorage.removeItem("a1-token");
  else sessionStorage.setItem("a1-token", token.trim());
  streamController.abort();
  streamController = new AbortController();
  void streamEvents(streamController.signal);
  void refresh();
});
window.setInterval(() => {
  element("clock").textContent = new Date().toLocaleTimeString();
}, 1_000);

let streamController = new AbortController();
async function streamEvents(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  try {
    const headers = new Headers();
    const token = sessionStorage.getItem("a1-token");
    if (token !== null) headers.set("authorization", `Bearer ${token}`);
    const response = await fetch("/api/v1/events", { headers, signal });
    if (!response.ok || response.body === null) throw new Error("Event stream unavailable.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let done = false;
    while (!done) {
      const result = await reader.read();
      done = result.done;
      if (done) continue;
      buffer += decoder.decode(result.value, { stream: true }).replaceAll("\r\n", "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (data !== "") {
          events.unshift(`${new Date().toLocaleTimeString()}  ${data}`);
          events.splice(200);
          if (active === "Logs") render();
          window.setTimeout(() => void refresh(), 100);
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") return;
    element("connection-dot").classList.remove("online");
    element("connection-text").textContent = "Reconnecting";
    await new Promise((resolve) => window.setTimeout(resolve, 2_000));
  }
  await streamEvents(signal);
}
void streamEvents(streamController.signal);
void refresh();
window.setInterval(() => void refresh(), 15_000);
