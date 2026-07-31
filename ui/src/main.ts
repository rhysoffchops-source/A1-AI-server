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
type StudioKind = "image" | "image_edit" | "video" | "audio" | "audio_extract";
interface StudioHistoryEntry {
  readonly createdAt: string;
  readonly elapsed?: string;
  readonly id: string;
  readonly kind: StudioKind;
  readonly model?: string;
  readonly prompt: string;
  readonly referenceName?: string;
  readonly resultUrl?: string;
  readonly status: string;
  readonly title: string;
  readonly updatedAt: string;
}
interface PromptVariant {
  readonly explanation: string;
  readonly prompt: string;
  readonly technique: string;
}
interface TransformationStep {
  readonly name: string;
  readonly description: string;
  readonly applied: boolean;
}
interface PromptEngineResponse {
  readonly model: string;
  readonly originalIntent: string;
  readonly platform: string;
  readonly transformedIntent: string;
  readonly transformationSteps: readonly TransformationStep[];
  readonly variants: readonly PromptVariant[];
}
interface PromptLibraryEntry {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly model: string;
  readonly platform: string;
  readonly technique: string;
  readonly notes: string;
  readonly tags: readonly string[];
  readonly createdAt: string;
}
interface PromptThreadMessage {
  readonly id: string;
  readonly content: string;
  readonly createdAt: string;
  readonly role: "user" | "engine";
  readonly transformedIntent?: string;
  readonly transformationSteps?: readonly TransformationStep[];
  readonly variants?: readonly PromptVariant[];
}
interface PromptThread {
  readonly id: string;
  readonly title: string;
  readonly model: string;
  readonly platform: string;
  readonly messages: readonly PromptThreadMessage[];
  readonly updatedAt: string;
}
class ApiError extends Error {
  public constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const views = [
  "Chat",
  "Overview",
  "Prompt Engine",
  "Studios",
  "Memory",
  "Plugins",
  "Logs"
] as const;
type View = (typeof views)[number];
const CHAT_STORAGE_KEY = "a1-concierge-chat";
const MAX_CHAT_MESSAGES = 40;
let active: View = "Chat";
let snapshot: Dashboard | undefined;
const events: string[] = [];
let chatSending = false;
let chatMessages = loadChatMessages();
let studioHistory: readonly StudioHistoryEntry[] = [];
let studioHistoryLoading = false;
let promptVariants: readonly PromptVariant[] = [];
let promptOriginalIntent = "";
let promptTransformedIntent = "";
let promptTransformationSteps: readonly TransformationStep[] = [];
let promptThreads: readonly PromptThread[] = [];
let promptLibrary: readonly PromptLibraryEntry[] = [];
let promptThreadsLoading = false;
let promptLibraryLoading = false;
let activeThreadId: string | null = null;

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
  const response = await fetch(url, {
    ...init,
    headers
  });
  if (!response.ok) {
    if (response.status === 401) {
      window.location.href = "/";
      throw new ApiError(401, "Session required — redirecting to login.");
    }
    throw new ApiError(
      response.status,
      ((await response.json()) as { message?: string }).message ?? `HTTP ${String(response.status)}`
    );
  }
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
    ${card("Memory", `<div class="stat">${String(data.memory.length)}</div><div class="label">recent persistent records</div>`)}
    ${card("Host memory", `<div class="stat">${bytes(used)}</div><div class="label">of ${bytes(data.system.totalMemoryBytes)} used</div><div class="bar"><i style="width:${String(Math.round((used / data.system.totalMemoryBytes) * 100))}%"></i></div>`)}
    ${card("GPU", data.gpu.length === 0 ? `<div class="stat">—</div><div class="label">No NVIDIA GPU detected locally</div>` : `<div class="stat">${String(data.gpu.length)}</div><div class="label">${escape(data.gpu.map((gpu) => gpu.name).join(", "))}</div>`)}
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
function studioKindLabel(kind: StudioKind): string {
  return (
    {
      audio: "Voice",
      audio_extract: "Audio extract",
      image: "Image",
      image_edit: "Image edit",
      video: "Video"
    }[kind] ?? kind
  );
}
const VAST_COMFY_ORIGIN = "";
const VAST_VIDEO_ORIGIN = "";

function studioRendererLink(kind: StudioKind, resultUrl?: string, status?: string): string {
  if (resultUrl) {
    return `<a class="button-link" href="${resultUrl}" target="_blank" rel="noopener">View generated image</a>`;
  }
  if (kind === "image" || kind === "image_edit") {
    return `<a class="button-link" href="#" data-voice-howto="1" rel="noopener" style="display:none">Photo</a>`;
  }
  if (kind === "video") {
    return `<a class="button-link" href="https://runwayml.com" target="_blank" rel="noopener">Open Runway (free tier)</a>`;
  }
  if (kind === "audio") {
    return `<a class="button-link" href="#" data-voice-howto="1" rel="noopener">Bark TTS (local)</a>`;
  }
  return "";
}
function studioHistoryCards(): string {
  if (studioHistoryLoading) return `<div class="empty">Loading saved Studio work…</div>`;
  if (studioHistory.length === 0) {
    return `<div class="empty">Nothing saved yet. Your images, edits, videos, voice briefs, and prompt work will stay here after refreshes.</div>`;
  }
  return `<div class="studio-history">${studioHistory
    .slice(0, 30)
    .map(
      (entry) => `<article class="studio-history-item">
        <div><span class="studio-kind">${escape(studioKindLabel(entry.kind))}</span>${status(entry.status)}</div>
        <strong>${escape(entry.title)}</strong>
        <p>${escape(entry.prompt)}</p>
        <small>${new Date(entry.updatedAt).toLocaleString()}${entry.referenceName === undefined ? "" : ` · reference: ${escape(entry.referenceName)}`}</small>
        <div class="studio-history-actions"><button type="button" data-reuse-studio="${escape(entry.id)}">Reuse brief</button>${studioRendererLink(entry.kind, entry.resultUrl, entry.status)}</div>
      </article>`
    )
    .join("")}</div>`;
}
function promptCards(): string {
  if (promptVariants.length === 0) {
    return `<div class="empty prompt-empty">Choose a model and describe the outcome. A1 will make several model-ready versions without using the GPU.</div>`;
  }
  const hadTransformations = promptTransformationSteps.some((step) => step.applied);
  const transformationSection =
    hadTransformations && promptTransformedIntent !== promptOriginalIntent
      ? `<div class="prompt-transform-info"><details><summary>A1 applied ${String(promptTransformationSteps.filter((s) => s.applied).length)} transformation(s) for filtering compatibility</summary><div class="transform-detail"><strong>Original:</strong><pre class="small">${escape(promptOriginalIntent)}</pre><strong>Transformed:</strong><pre class="small">${escape(promptTransformedIntent)}</pre><ul>${promptTransformationSteps.map((step) => `<li>${step.applied ? "&#10003;" : "&#8212;"} ${escape(step.description)}</li>`).join("")}</ul></div></details></div>`
      : "";
  return `<div class="prompt-results">${transformationSection}${promptVariants
    .map(
      (variant, index) => `<article class="prompt-result">
        <div class="prompt-result-head"><h3>${escape(variant.technique)}</h3><button type="button" data-copy-prompt="${String(index)}">Copy</button><button type="button" data-save-lib="${String(index)}">Save</button></div>
        <p>${escape(variant.explanation)}</p>
        <pre>${escape(variant.prompt)}</pre>
      </article>`
    )
    .join("")}</div>`;
}
function promptEnginePage(): string {
  const modelOptions = `<optgroup label="OpenAI"><option>GPT-4.1</option><option>GPT-4o</option><option>GPT-4o-mini</option><option>o4-mini</option><option>o3</option><option>DALL-E 4</option></optgroup><optgroup label="Anthropic"><option>Claude Opus 4</option><option>Claude Sonnet 4</option><option>Claude Haiku 4</option></optgroup><optgroup label="Google"><option>Gemini 2.5 Pro</option><option>Gemini 2.5 Flash</option><option>Gemini 2.0 Flash Lite</option></optgroup><optgroup label="Meta"><option>Llama 4 Maverick</option><option>Llama 4 Scout</option></optgroup><optgroup label="xAI"><option>Grok 3</option><option>Grok 3 Mini</option></optgroup><optgroup label="Mistral"><option>Mistral Large 3</option><option>Mistral Small 3</option><option>Codestral</option></optgroup><optgroup label="DeepSeek"><option>DeepSeek-V3</option><option>DeepSeek-R1</option></optgroup><optgroup label="Image"><option>Midjourney v7</option><option>Stable Diffusion 3.5</option><option>FLUX.1 Pro</option><option>Ideogram 3.0</option><option>Z-Image Turbo</option></optgroup><optgroup label="Video"><option>LTX 2.3</option><option>Runway Gen-4</option><option>Sora 2</option><option>Kling 2.0</option></optgroup><optgroup label="Audio"><option>ElevenLabs v2</option><option>Suno v4</option><option>Udio v2</option></optgroup>`;

  const libHtml = promptLibrary.length === 0
    ? `<div class="prompt-panel-section"><h4>Library</h4><p class="muted small">Save prompts to reuse across sessions.</p></div>`
    : `<div class="prompt-panel-section"><h4>Library (${String(promptLibrary.length)})</h4><div class="prompt-library-list">${promptLibrary.slice(0, 30).map((e) => `<div class="lib-item"><strong>${escape(e.name)}</strong><span class="lib-model">${escape(e.model)} · ${escape(e.technique)}</span><pre class="lib-preview">${escape(e.prompt.slice(0, 200))}${e.prompt.length > 200 ? "…" : ""}</pre><div class="lib-actions"><button type="button" data-copy-lib="${escape(e.id)}">Copy</button><button type="button" data-delete-lib="${escape(e.id)}" class="danger small">×</button></div></div>`).join("")}</div></div>`;

  const threadHtml = promptThreads.length === 0
    ? `<div class="prompt-panel-section"><h4>Threads</h4><p class="muted small">Start a thread to iterate on prompts.</p></div>`
    : `<div class="prompt-panel-section"><h4>Threads (${String(promptThreads.length)})</h4><div class="prompt-thread-list">${promptThreads.slice(0, 20).map((t) => `<button class="thread-item" data-thread-id="${escape(t.id)}">${escape(t.title)}<span class="thread-meta">${escape(t.model)} · ${String(t.messages.length)} msg</span><button type="button" data-delete-thread="${escape(t.id)}" class="danger small">×</button></button>`).join("")}</div></div>`;

  return `<div class="prompt-engine-page">
    <div class="pe-main">
      <form id="prompt-engine-form">
        <select name="model" required aria-label="AI model"><option value="" disabled selected>Choose a model…</option>${modelOptions}</select>
        <select name="platform" required aria-label="Platform"><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="midjourney">Midjourney</option><option value="stable-diffusion">Stable Diffusion</option><option value="comfyui">ComfyUI</option><option value="ltx">LTX Video</option></select>
        <textarea name="intent" required placeholder="Describe what you want to make or achieve…"></textarea>
        <div class="pe-form-actions"><button class="primary" type="submit">Optimise prompts</button><button class="secondary" type="button" id="new-thread-btn" title="Start a new thread from this form">+ New Thread</button></div>
      </form>
      <div id="prompt-engine-results">${promptCards()}</div>
    </div>
    <div class="pe-panel">
      ${threadHtml}
      ${libHtml}
    </div>
  </div>`;
}

function studios(): string {
  return `<div class="studio-page">
    <section class="studio-hero">
      <div><p class="eyebrow">DAN'S DIGITAL STUDIOS</p><h2>Make, improve, remember.</h2><p>Creative briefs and previous edits are saved by A1 on the VPS. Images are generated via Replicate cloud GPUs — zero local RAM.</p></div>
      <div class="studio-destination"><span>Dashboard & history</span><strong>VPS</strong><span>Rendering</span><strong>Replicate Cloud GPU</strong></div>
    </section>
    <div class="grid studio-grid">
      ${card(
        "Image creator",
        `<p class="muted">Describe your image and generate it on Replicate cloud GPUs (FLUX, SDXL). Zero local resource usage.</p>
        <form class="studio-form" data-studio-kind="image"><input name="title" required placeholder="Name this image"><textarea name="prompt" required placeholder="Describe the image you want…"></textarea><div class="studio-form-actions"><button type="submit" class="primary">Generate</button><button type="button" data-save-studio="">Save brief only</button></div><div class="studio-result" data-studio-result="image"></div></form>`,
        "wide"
      )}
      ${card(
        "Image editing",
        `<p class="muted">Keep the original as the reference; say precisely what should change and what must stay untouched.</p>
        <form class="studio-form" data-studio-kind="image_edit"><input name="title" required placeholder="Name this edit"><textarea name="prompt" required placeholder="What should change? What must remain exactly the same?"></textarea><input name="reference" type="file" accept="image/png,image/jpeg,image/webp"><div class="studio-form-actions"><button type="submit" class="primary">Generate</button><button type="button" data-save-studio="">Save brief only</button></div><div class="studio-result" data-studio-result="image_edit"></div></form>`
      )}
      ${card(
        "Text / image to video",
        `<p class="muted">Write the action and camera movement, or choose a still to animate. LTX renders visual-only clips on Vast.</p>
        <form class="studio-form" data-studio-kind="video"><input name="title" required placeholder="Name this clip"><textarea name="prompt" required placeholder="Subject, action, camera movement, lighting, duration…"></textarea><input name="reference" type="file" accept="image/png,image/jpeg,image/webp"><button class="primary">Save video brief</button></form>
        ${studioRendererLink("video")}`,
        "wide"
      )}
      ${card(
        "Audio extractor",
        `<p class="muted">Extract audio track from a video file. Pick a format (mp3, wav, aac, ogg, flac) and save the brief.</p>
        <form class="studio-form" data-studio-kind="audio_extract"><input name="title" required placeholder="Name this job"><input name="videoPath" required placeholder="Full path to video file on M1 or VPS" value="/Users/dan/Documents/A1/"><input name="format" placeholder="mp3" value="mp3" style="width:8rem"><button class="primary">Extract audio</button></form>
        <div class="studio-result" data-studio-result="audio_extract"></div>`
      )}
      ${card(
        "Voice lab",
        `<p class="muted">Save an audio sample or record your own voice, then define the target voice. Voice conversion is kept separate from the visual GPU lane.</p>
        <form class="studio-form" data-studio-kind="audio"><input name="title" required placeholder="Name this voice job"><textarea name="prompt" required placeholder="Describe the desired voice: tone, accent, pace, emotion…"></textarea><input name="reference" type="file" accept="audio/*"><label class="consent"><input name="consent" type="checkbox" required> I have permission to use this voice sample and the target voice.</label><button class="primary">Save voice brief</button></form>
        <button type="button" id="record-voice">Record a sample</button><span id="voice-recording-status" class="muted"></span>`
      )}
      ${card("Studio history", `<p class="muted">Your previous prompts and edits are permanent A1 records. Reuse any one without starting from scratch.</p>${studioHistoryCards()}`, "full")}
    </div>
  </div>`;
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
  if (active === "Chat") content.innerHTML = chat(snapshot);
  else if (active === "Overview") content.innerHTML = overview(snapshot);
  else if (active === "Prompt Engine") content.innerHTML = promptEnginePage();
  else if (active === "Studios") content.innerHTML = studios();
  else if (active === "Memory") content.innerHTML = memory(snapshot);
  else if (active === "Plugins") content.innerHTML = plugins(snapshot);
  else if (active === "Logs") content.innerHTML = logs();
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
  document
    .querySelector<HTMLFormElement>("#prompt-engine-form")
    ?.addEventListener("submit", (event) => void submitPromptEngine(event));
  document
    .querySelectorAll<HTMLFormElement>(".studio-form")
    .forEach((form) => form.addEventListener("submit", (event) => void submitStudioBrief(event)));
  document
    .querySelectorAll<HTMLButtonElement>("[data-save-studio]")
    .forEach((btn) => btn.addEventListener("click", async () => {
      const form = btn.closest<HTMLFormElement>("form");
      if (!form) return;
      const kind = form.dataset.studioKind as StudioKind | undefined;
      const values = new FormData(form);
      try {
        await request("/api/v1/studios/history", {
          body: JSON.stringify({
            kind, prompt: values.get("prompt"), title: values.get("title"),
            referenceName: selectedReferenceName(values),
            status: "ready"
          }),
          method: "POST"
        });
        await loadStudioHistory();
        toast("Brief saved to history");
      } catch (error: unknown) {
        toast(error instanceof Error ? error.message : "Could not save brief");
      }
    }));
  document
    .querySelectorAll<HTMLButtonElement>("[data-copy-prompt]")
    .forEach((button) => button.addEventListener("click", () => void copyPrompt(button)));
  document
    .querySelectorAll<HTMLButtonElement>("[data-save-lib]")
    .forEach((button) => button.addEventListener("click", () => void saveToLibrary(button)));
  document
    .querySelectorAll<HTMLButtonElement>("[data-copy-lib]")
    .forEach((button) => button.addEventListener("click", () => copyLibPrompt(button.dataset.copyLib ?? "")));
  document
    .querySelectorAll<HTMLButtonElement>("[data-delete-lib]")
    .forEach((button) => button.addEventListener("click", () => deleteLibraryEntry(button.dataset.deleteLib ?? "")));
  document
    .querySelectorAll<HTMLButtonElement>("[data-delete-thread]")
    .forEach((button) => button.addEventListener("click", (e) => { e.stopPropagation(); deleteThread(button.dataset.deleteThread ?? ""); }));
  document
    .querySelectorAll<HTMLButtonElement>("[data-thread-id]")
    .forEach((button) => button.addEventListener("click", () => loadThread(button.dataset.threadId ?? "")));
  document.querySelector<HTMLButtonElement>("#new-thread-btn")?.addEventListener("click", () => void createThread());
  document
    .querySelectorAll<HTMLButtonElement>("[data-reuse-studio]")
    .forEach((button) => button.addEventListener("click", () => reuseStudioBrief(button.dataset.reuseStudio)));
  document.querySelector<HTMLButtonElement>("#record-voice")?.addEventListener("click", () => void recordVoice());
  document
    .querySelectorAll<HTMLAnchorElement>("[data-voice-howto]")
    .forEach((link) => link.addEventListener("click", (e) => {
      e.preventDefault();
      toast("Voice Lab: python3 scripts/voicelab.py \"your text\" --out output.wav");
    }));
}
async function loadStudioHistory(): Promise<void> {
  studioHistoryLoading = true;
  if (active === "Studios") render();
  try {
    const response = await request<{ entries: readonly StudioHistoryEntry[] }>("/api/v1/studios/history");
    studioHistory = response.entries;
  } catch (error: unknown) {
    toast(error instanceof Error ? error.message : "Could not load Studio history");
  } finally {
    studioHistoryLoading = false;
    if (active === "Studios") render();
  }
}
async function submitPromptEngine(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const values = new FormData(form);
  const intent = (values.get("intent") as string) ?? "";
  const model = (values.get("model") as string) ?? "";
  const platform = (values.get("platform") as string) ?? "";
  try {
    const response = await request<PromptEngineResponse>("/api/v1/prompt-engine/optimise", {
      body: JSON.stringify({ intent, model, platform }),
      method: "POST"
    });
    promptVariants = response.variants;
    promptOriginalIntent = response.originalIntent;
    promptTransformedIntent = response.transformedIntent;
    promptTransformationSteps = response.transformationSteps;
    const resultsEl = document.getElementById("prompt-engine-results");
    if (resultsEl) resultsEl.innerHTML = promptCards();
    document.querySelectorAll<HTMLButtonElement>("[data-copy-prompt]").forEach((b) => b.addEventListener("click", () => void copyPrompt(b)));
    document.querySelectorAll<HTMLButtonElement>("[data-save-lib]").forEach((b) => b.addEventListener("click", () => void saveToLibrary(b)));
    toast(`${String(response.variants.length)} optimised prompts ready`);
  } catch (error: unknown) {
    toast(error instanceof Error ? error.message : "Prompt Engine could not optimise that brief");
  }
}

async function saveToLibrary(button: HTMLButtonElement): Promise<void> {
  const index = Number(button.dataset.saveLib);
  const variant = promptVariants[index];
  if (!variant) return;
  const name = window.prompt("Name this prompt for your library:", variant.technique);
  if (!name?.trim()) return;
  const notes = window.prompt("Optional notes:", "") ?? "";
  try {
    await request("/api/v1/prompt-engine/library", {
      body: JSON.stringify({ name: name.trim(), prompt: variant.prompt, model: promptOriginalIntent ? "see-form" : "", platform: "openai", technique: variant.technique, notes: notes.trim(), tags: [] }),
      method: "POST"
    });
    await loadPromptLibrary();
    toast("Saved to library");
  } catch (error: unknown) {
    toast(error instanceof Error ? error.message : "Could not save to library");
  }
}

async function loadPromptLibrary(): Promise<void> {
  if (promptLibraryLoading) return;
  promptLibraryLoading = true;
  try {
    const resp = await request<{ entries: readonly PromptLibraryEntry[] }>("/api/v1/prompt-engine/library");
    promptLibrary = resp.entries;
  } catch {
    // silent
  } finally {
    promptLibraryLoading = false;
  }
}

async function loadPromptThreads(): Promise<void> {
  if (promptThreadsLoading) return;
  promptThreadsLoading = true;
  try {
    const resp = await request<{ threads: readonly PromptThread[] }>("/api/v1/prompt-engine/threads");
    promptThreads = resp.threads;
  } catch {
    // silent
  } finally {
    promptThreadsLoading = false;
  }
}

async function createThread(): Promise<void> {
  const form = document.querySelector<HTMLFormElement>("#prompt-engine-form");
  if (!form) return;
  const values = new FormData(form);
  const title = window.prompt("Thread name:", values.get("intent")?.toString().slice(0, 60) ?? "New thread");
  if (!title?.trim()) return;
  try {
    await request("/api/v1/prompt-engine/threads", {
      body: JSON.stringify({ title: title.trim(), model: values.get("model") ?? "", platform: values.get("platform") ?? "" }),
      method: "POST"
    });
    await loadPromptThreads();
    if (active === "Prompt Engine") render();
    toast("Thread created");
  } catch (error: unknown) {
    toast(error instanceof Error ? error.message : "Could not create thread");
  }
}

async function deleteThread(id: string): Promise<void> {
  try {
    await request(`/api/v1/prompt-engine/threads/${encodeURIComponent(id)}`, { method: "DELETE" });
    promptThreads = promptThreads.filter((t) => t.id !== id);
    if (active === "Prompt Engine") render();
    toast("Thread deleted");
  } catch {
    toast("Could not delete thread");
  }
}

async function loadThread(threadId: string): Promise<void> {
  try {
    const resp = await request<PromptThread>(`/api/v1/prompt-engine/threads/${encodeURIComponent(threadId)}`);
    activeThreadId = resp.id;
    promptVariants = [];
    const form = document.querySelector<HTMLFormElement>("#prompt-engine-form");
    if (form) {
      (form.querySelector("[name='model']") as HTMLInputElement).value = resp.model;
      (form.querySelector("[name='platform']") as HTMLSelectElement).value = resp.platform;
    }
    const resultsEl = document.getElementById("prompt-engine-results");
    if (resultsEl) {
      const messagesHtml = resp.messages.map((m) => {
        if (m.role === "user") return `<div class="thread-msg thread-user"><strong>You</strong><p>${escape(m.content)}</p></div>`;
        return `<div class="thread-msg thread-engine"><strong>Engine</strong><p>${escape(m.content)}</p>${m.variants ? m.variants.map((v, i) => `<div class="thread-variant"><h4>${escape(v.technique)}</h4><pre>${escape(v.prompt)}</pre></div>`).join("") : ""}</div>`;
      }).join("");
      resultsEl.innerHTML = `<div class="prompt-thread-view"><h3>${escape(resp.title)}</h3>${messagesHtml}<button class="secondary" data-close-thread>← Back to Prompt Engine</button></div>`;
      document.querySelector<HTMLButtonElement>("[data-close-thread]")?.addEventListener("click", () => { activeThreadId = undefined; render(); });
    }
  } catch {
    toast("Could not load thread");
  }
}

async function deleteLibraryEntry(id: string): Promise<void> {
  try {
    await request(`/api/v1/prompt-engine/library/${encodeURIComponent(id)}`, { method: "DELETE" });
    promptLibrary = promptLibrary.filter((e) => e.id !== id);
    if (active === "Prompt Engine") render();
    toast("Library entry removed");
  } catch {
    toast("Could not delete entry");
  }
}

async function copyLibPrompt(id: string): Promise<void> {
  const entry = promptLibrary.find((e) => e.id === id);
  if (!entry) return;
  try {
    await navigator.clipboard.writeText(entry.prompt);
    toast("Prompt copied from library");
  } catch {
    toast("Copy unavailable");
  }
}
function selectedReferenceName(values: FormData): string | undefined {
  const reference = values.get("reference");
  return reference instanceof File && reference.name !== "" ? reference.name : undefined;
}
async function submitStudioBrief(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const kind = form.dataset.studioKind as StudioKind | undefined;
  if (kind !== "image" && kind !== "image_edit" && kind !== "video" && kind !== "audio" && kind !== "audio_extract") return;
  const values = new FormData(form);
  const prompt = (values.get("prompt") as string) ?? "";
  const title = (values.get("title") as string) ?? "";
  const resultEl = form.querySelector<HTMLDivElement>("[data-studio-result]");

  // For image/image_edit: generate via Replicate
  if (kind === "image" || kind === "image_edit") {
    if (!prompt.trim()) return;
    if (resultEl) resultEl.innerHTML = `<div class="studio-generating"><div class="spinner"></div><span>Generating via Replicate cloud GPU…</span></div>`;
    const btn = form.querySelector<HTMLButtonElement>("button[type='submit']");
    if (btn) { btn.disabled = true; btn.textContent = "Generating…"; }
    try {
      const result = await request<{ url: string; model: string; elapsed: string; entry: StudioHistoryEntry }>(
        "/api/v1/studios/generate", {
          body: JSON.stringify({ kind, prompt, title, referenceName: selectedReferenceName(values) }),
          method: "POST"
        }
      );
      if (resultEl) resultEl.innerHTML = `<div class="studio-result-image"><img src="${result.url}" alt="${escape(prompt.slice(0,100))}" loading="lazy"><p class="muted small">${result.model} · ${result.elapsed}s · <a href="${result.url}" target="_blank">open full</a></p></div>`;
      await loadStudioHistory();
      render();
      bindForms();
    } catch (error: unknown) {
      if (resultEl) resultEl.innerHTML = `<p class="studio-error">${escape(error instanceof Error ? error.message : "Generation failed")}</p>`;
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "Generate"; }
    }
    return;
  }

  // Audio extract: save brief, show local ffmpeg command
  if (kind === "audio_extract") {
    const videoPath = (values.get("videoPath") as string) ?? "";
    const format = (values.get("format") as string) ?? "mp3";
    if (!videoPath.trim()) { toast("Video path is required"); return; }
    try {
      const result = await request<{ entry: StudioHistoryEntry; command: string }>(
        "/api/v1/studios/extract-audio", {
          body: JSON.stringify({ videoPath, format, title }),
          method: "POST"
        }
      );
      if (resultEl) {
        resultEl.innerHTML = `<div class="studio-generating"><p class="muted">Run this on your M1 terminal:</p><pre><code>${escape(result.command)}</code></pre></div>`;
      }
      await loadStudioHistory();
      render();
      bindForms();
    } catch (error: unknown) {
      if (resultEl) resultEl.innerHTML = `<p class="studio-error">${escape(error instanceof Error ? error.message : "Extraction failed")}</p>`;
    }
    return;
  }

  // Video, audio: save brief only
  try {
    await request("/api/v1/studios/history", {
      body: JSON.stringify({
        kind,
        prompt,
        referenceName: selectedReferenceName(values),
        status: kind === "audio" ? "needs_setup" : "ready",
        title
      }),
      method: "POST"
    });
    form.reset();
    await loadStudioHistory();
    toast(`${studioKindLabel(kind)} brief saved to Studio history`);
  } catch (error: unknown) {
    toast(error instanceof Error ? error.message : "Studio brief could not be saved");
  }
}
async function copyPrompt(button: HTMLButtonElement): Promise<void> {
  const index = Number(button.dataset.copyPrompt);
  const prompt = promptVariants[index]?.prompt;
  if (prompt === undefined) return;
  try {
    await navigator.clipboard.writeText(prompt);
    toast("Prompt copied");
  } catch {
    toast("Copy is unavailable in this browser");
  }
}
function reuseStudioBrief(id: string | undefined): void {
  const entry = studioHistory.find((candidate) => candidate.id === id);
  if (entry === undefined) return;
  const kind = entry.kind === "image_edit" ? "image_edit" : entry.kind;
  const form = document.querySelector<HTMLFormElement>(`.studio-form[data-studio-kind="${kind}"]`);
  if (form === null) return;
  const prompt = form.elements.namedItem("prompt");
  const title = form.elements.namedItem("title");
  if (prompt instanceof HTMLTextAreaElement) prompt.value = entry.prompt;
  if (title instanceof HTMLInputElement) title.value = `${entry.title} — revision`;
  form.scrollIntoView({ behavior: "smooth", block: "center" });
  toast("Previous brief loaded. Add a new reference image if needed.");
}
async function recordVoice(): Promise<void> {
  const statusNode = document.getElementById("voice-recording-status");
  if (statusNode === null) return;
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    statusNode.textContent = "Recording is not supported in this browser.";
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    recorder.addEventListener("dataavailable", (item) => chunks.push(item.data));
    recorder.addEventListener("start", () => {
      statusNode.textContent = "Recording… click again to finish.";
    });
    recorder.addEventListener("stop", () => {
      stream.getTracks().forEach((track) => track.stop());
      const seconds = Math.max(1, Math.round(chunks.reduce((total, chunk) => total + chunk.size, 0) / 16_000));
      statusNode.textContent = `Sample recorded locally (${String(seconds)} sec). Save a Voice Lab brief to keep its note in A1.`;
    });
    recorder.start();
    const button = document.querySelector<HTMLButtonElement>("#record-voice");
    if (button !== null) {
      button.textContent = "Stop recording";
      button.onclick = () => {
        recorder.stop();
        button.textContent = "Record a sample";
      };
    }
  } catch {
    statusNode.textContent = "Microphone access was not granted.";
  }
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
    if (active === "Chat" || active === "Studios" || active === "Prompt Engine") return;
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
  if (active === "Prompt Engine") {
    void loadPromptLibrary();
    void loadPromptThreads();
  }
});
// --- Sidebar collapse toggle ---
const shell = document.querySelector<HTMLDivElement>(".shell")!;
const sidebarToggle = element("sidebar-toggle");
const layoutPreference = localStorage.getItem("a1-sidebar") ?? "expanded";
if (layoutPreference === "collapsed") {
  shell.classList.add("collapsed");
  sidebarToggle.innerHTML = "&raquo;";
  sidebarToggle.title = "Expand sidebar";
}
sidebarToggle.addEventListener("click", () => {
  const isCollapsed = shell.classList.toggle("collapsed");
  sidebarToggle.innerHTML = isCollapsed ? "&raquo;" : "&laquo;";
  sidebarToggle.title = isCollapsed ? "Expand sidebar" : "Collapse sidebar";
  localStorage.setItem("a1-sidebar", isCollapsed ? "collapsed" : "expanded");
});
element("refresh").addEventListener("click", () => void refresh());
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
