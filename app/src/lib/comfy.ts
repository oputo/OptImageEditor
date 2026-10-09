// ComfyUI client (phase D, minimal): runs an API-format workflow on a local ComfyUI server and returns its images.
// The webview talks to ComfyUI directly (ComfyUI runs with --enable-cors-header; the app's CSP is off):
//   POST /upload/image (the input, always the same name so nothing piles up) -> POST /prompt -> WebSocket /ws
//   (progress, and the result images of SaveImageWebsocket as binary messages) -> fallback: /history + /view.
// Workflows are templates with placeholders: the string values "{{image}}", "{{prompt}}", "{{seed}}" are replaced
// ("{{seed}}" by a number). Built-ins below; a JSON file in the app's config folder (comfy/<kind>.json, exported from
// ComfyUI with "Export (API)") overrides one.
import { appConfigDir, join } from "@tauri-apps/api/path";
import { TauriFileSource, isTauri } from "./source";

export type WorkflowKind = "bg_remove" | "edit";
export type Workflow = Record<string, { class_type: string; inputs: Record<string, unknown>; _meta?: unknown }>;

/** Background removal: BiRefNet (ComfyUI core nodes). Output: the mask as a grey image. */
const BG_REMOVE: Workflow = {
  "1": { class_type: "LoadImage", inputs: { image: "{{image}}" } },
  "2": { class_type: "LoadBackgroundRemovalModel", inputs: { bg_removal_name: "birefnet.safetensors" } },
  "3": { class_type: "RemoveBackground", inputs: { bg_removal_model: ["2", 0], image: ["1", 0] } },
  "4": { class_type: "MaskToImage", inputs: { mask: ["3", 0] } },
  "9": { class_type: "SaveImageWebsocket", inputs: { images: ["4", 0] } },
};

/** Edit by instruction: Qwen-Image-Edit-2511 (weights cast to fp8 to fit 16 GB) + Lightning 4 steps. The output has
 *  the size of the input (the app sends ~1 MP). */
const EDIT: Workflow = {
  "1": { class_type: "LoadImage", inputs: { image: "{{image}}" } },
  "10": { class_type: "UNETLoader", inputs: { unet_name: "qwen_image_edit_2511_bf16.safetensors", weight_dtype: "fp8_e4m3fn" } },
  "11": { class_type: "LoraLoaderModelOnly", inputs: { model: ["10", 0], lora_name: "Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors", strength_model: 1 } },
  "12": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["11", 0], shift: 3.1 } },
  "13": { class_type: "CFGNorm", inputs: { model: ["12", 0], strength: 1 } },
  "20": { class_type: "CLIPLoader", inputs: { clip_name: "qwen_2.5_vl_7b_fp8_scaled.safetensors", type: "qwen_image", device: "default" } },
  "21": { class_type: "VAELoader", inputs: { vae_name: "qwen_image_vae.safetensors" } },
  "30": { class_type: "TextEncodeQwenImageEditPlus", inputs: { clip: ["20", 0], vae: ["21", 0], image1: ["1", 0], prompt: "{{prompt}}" } },
  "31": { class_type: "TextEncodeQwenImageEditPlus", inputs: { clip: ["20", 0], vae: ["21", 0], image1: ["1", 0], prompt: "" } },
  "32": { class_type: "FluxKontextMultiReferenceLatentMethod", inputs: { conditioning: ["30", 0], reference_latents_method: "index_timestep_zero" } },
  "33": { class_type: "FluxKontextMultiReferenceLatentMethod", inputs: { conditioning: ["31", 0], reference_latents_method: "index_timestep_zero" } },
  "40": { class_type: "VAEEncode", inputs: { pixels: ["1", 0], vae: ["21", 0] } },
  "41": { class_type: "KSampler", inputs: { model: ["13", 0], positive: ["32", 0], negative: ["33", 0], latent_image: ["40", 0], seed: "{{seed}}", steps: 4, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1 } },
  "42": { class_type: "VAEDecode", inputs: { samples: ["41", 0], vae: ["21", 0] } },
  "9": { class_type: "SaveImageWebsocket", inputs: { images: ["42", 0] } },
};

export const BUILTIN: Record<WorkflowKind, Workflow> = { bg_remove: BG_REMOVE, edit: EDIT };
export const KIND_LABEL: Record<WorkflowKind, string> = { bg_remove: "背景除去", edit: "指示で編集" };

/** where an override of `kind` is looked for (desktop only) */
export async function overridePath(kind: WorkflowKind): Promise<string | null> {
  if (!isTauri()) return null;
  try { return await join(await appConfigDir(), "comfy", `${kind}.json`); } catch { return null; }
}

/** the workflow of `kind`: the override file when it exists, else the built-in one */
export async function loadWorkflow(kind: WorkflowKind): Promise<{ wf: Workflow; source: string | null }> {
  const p = await overridePath(kind);
  if (p) {
    let src: TauriFileSource | null = null;
    try { src = await TauriFileSource.open(p); } catch { /* no override */ }
    if (src) {
      const text = new TextDecoder().decode(await src.read(0, src.size));
      let wf: Workflow;
      try { wf = JSON.parse(text); } catch (e) { throw new Error(`${p} が JSON として読めません: ${e instanceof Error ? e.message : e}`); }
      if (!wf || typeof wf !== "object" || !Object.values(wf).every((n) => n && typeof n === "object" && "class_type" in n)) {
        throw new Error(`${p} は API 形式のワークフローではありません（ComfyUI の「Export (API)」で書き出してください）`);
      }
      return { wf, source: p };
    }
  }
  return { wf: structuredClone(BUILTIN[kind]), source: null };
}

/** replaces the placeholders (string values only) */
export function fill(wf: Workflow, values: { image: string; prompt?: string; seed?: number }): Workflow {
  const out = structuredClone(wf);
  for (const node of Object.values(out)) {
    for (const [k, v] of Object.entries(node.inputs)) {
      if (v === "{{image}}") node.inputs[k] = values.image;
      else if (v === "{{prompt}}") node.inputs[k] = values.prompt ?? "";
      else if (v === "{{seed}}") node.inputs[k] = values.seed ?? 0;
    }
  }
  return out;
}

const SETTINGS_KEY = "oie.comfy";
export const DEFAULT_URL = "http://127.0.0.1:18188";

export type Progress = { phase: string; node: string | null; value: number; max: number; elapsedMs: number };
export type ServerInfo = { version: string; device: string; vramFreeMb: number; vramTotalMb: number };

const PHASE: Record<string, string> = {
  LoadImage: "画像の読み込み", UNETLoader: "モデルの読み込み", CLIPLoader: "モデルの読み込み", VAELoader: "モデルの読み込み",
  LoraLoaderModelOnly: "モデルの読み込み", LoadBackgroundRemovalModel: "モデルの読み込み", CheckpointLoaderSimple: "モデルの読み込み",
  TextEncodeQwenImageEditPlus: "プロンプトの処理", VAEEncode: "エンコード", KSampler: "生成", SamplerCustomAdvanced: "生成",
  VAEDecode: "デコード", RemoveBackground: "背景除去", SaveImageWebsocket: "受け取り", SaveImage: "受け取り",
};

export class AbortedError extends Error { constructor() { super("中止しました"); this.name = "AbortedError"; } }

/** One ComfyUI server (URL kept in localStorage). */
export class ComfyClient {
  url: string;
  private clientId = `oie-${Math.random().toString(36).slice(2, 10)}`;

  constructor() {
    let u = DEFAULT_URL;
    try { u = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}").url || DEFAULT_URL; } catch { /* storage unavailable */ }
    this.url = u;
  }

  setUrl(url: string) {
    this.url = url.trim().replace(/\/+$/, "") || DEFAULT_URL;
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ url: this.url })); } catch { /* storage unavailable */ }
  }

  private async json<T>(path: string, init?: RequestInit, timeoutMs = 10000): Promise<T> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(this.url + path, { ...init, signal: ctl.signal });
      const text = await r.text();
      if (!r.ok) {
        let msg = text;
        try { const j = JSON.parse(text); msg = j.error?.message ?? j.message ?? text; if (j.node_errors && Object.keys(j.node_errors).length) msg += ": " + describeNodeErrors(j.node_errors); } catch { /* plain text */ }
        throw new Error(`ComfyUI ${r.status}: ${msg.slice(0, 400)}`);
      }
      return (text ? JSON.parse(text) : null) as T;
    } catch (e) {
      if ((e as Error).name === "AbortError") throw new Error(`ComfyUI（${this.url}）が応答しません`);
      if (e instanceof TypeError) throw new Error(`ComfyUI（${this.url}）に接続できません。起動しているか確認してください`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async info(): Promise<ServerInfo> {
    const s = await this.json<{ system: { comfyui_version: string }; devices: { name: string; vram_free: number; vram_total: number }[] }>("/system_stats", undefined, 4000);
    const d = s.devices[0];
    return {
      version: s.system.comfyui_version,
      device: d ? d.name.replace(/^cuda:\d+\s*/, "").replace(/\s*:.*$/, "") : "?",
      vramFreeMb: d ? d.vram_free / 2 ** 20 : 0, vramTotalMb: d ? d.vram_total / 2 ** 20 : 0,
    };
  }

  /** frees the models from VRAM / RAM */
  async free() {
    await this.json("/free", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ unload_models: true, free_memory: true }) });
  }

  private async upload(png: Blob, name: string): Promise<string> {
    const fd = new FormData();
    fd.append("image", png, name);
    fd.append("subfolder", "oie");
    fd.append("type", "input");
    fd.append("overwrite", "true");
    const r = await this.json<{ name: string; subfolder: string }>("/upload/image", { method: "POST", body: fd }, 120000);
    return r.subfolder ? `${r.subfolder}/${r.name}` : r.name;
  }

  /** Runs `wf` (placeholders filled with the uploaded `input`) and returns the PNG images of its output nodes. */
  async run(
    wf: Workflow, input: Blob, values: { prompt?: string; seed?: number }, inputName: string,
    onProgress: (p: Progress) => void, signal: AbortSignal,
  ): Promise<Blob[]> {
    if (signal.aborted) throw new AbortedError();
    const t0 = performance.now();
    const report = (phase: string, node: string | null, value = 0, max = 0) => onProgress({ phase, node, value, max, elapsedMs: performance.now() - t0 });
    report("送信", null);
    const image = await this.upload(input, inputName);
    const prompt = fill(wf, { image, ...values });

    // websocket first, so no message of the run is missed
    const ws = new WebSocket(`${this.url.replace(/^http/, "ws")}/ws?clientId=${this.clientId}`);
    ws.binaryType = "arraybuffer";
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error(`ComfyUI（${this.url}）の WebSocket に接続できません`));
    });

    let promptId: string | null = null;
    try {
      const r = await this.json<{ prompt_id: string; node_errors?: Record<string, unknown> }>("/prompt", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt, client_id: this.clientId }),
      });
      promptId = r.prompt_id;
      report("順番待ち", null);
      const outputs = new Set(Object.entries(prompt).filter(([, n]) => n.class_type === "SaveImageWebsocket").map(([id]) => id));
      const images: Blob[] = [];
      await new Promise<void>((res, rej) => {
        let current: string | null = null;
        const onAbort = () => {
          const body = JSON.stringify({ prompt_id: promptId });
          fetch(this.url + "/queue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delete: [promptId] }) }).catch(() => {});
          fetch(this.url + "/interrupt", { method: "POST", headers: { "Content-Type": "application/json" }, body }).catch(() => {});
          rej(new AbortedError());
        };
        signal.addEventListener("abort", onAbort, { once: true });
        ws.onclose = () => rej(new Error("ComfyUI との接続が切れました"));
        ws.onmessage = (ev) => {
          if (typeof ev.data !== "string") {
            // binary: [u32 event][u32 format][image]; only images sent while one of our output nodes runs
            const v = new DataView(ev.data as ArrayBuffer);
            if (current && outputs.has(current) && v.getUint32(0) === 1 && v.getUint32(4) === 2) {
              images.push(new Blob([(ev.data as ArrayBuffer).slice(8)], { type: "image/png" }));
            }
            return;
          }
          let m: { type: string; data: Record<string, unknown> };
          try { m = JSON.parse(ev.data); } catch { return; }
          const d = m.data ?? {};
          if (d.prompt_id !== undefined && d.prompt_id !== promptId) return;
          if (m.type === "executing") {
            current = (d.node as string | null) ?? null;
            if (current) { const ct = prompt[current]?.class_type ?? current; report(PHASE[ct] ?? ct, current); }
          } else if (m.type === "progress") {
            const ct = prompt[d.node as string]?.class_type ?? "";
            report(PHASE[ct] ?? "処理中", d.node as string, d.value as number, d.max as number);
          } else if (m.type === "execution_success") {
            signal.removeEventListener("abort", onAbort);
            res();
          } else if (m.type === "execution_error") {
            signal.removeEventListener("abort", onAbort);
            rej(new Error(`ComfyUI の実行エラー（${d.node_type ?? d.node_id}）: ${String(d.exception_message ?? "").trim().slice(0, 400)}`));
          } else if (m.type === "execution_interrupted") {
            signal.removeEventListener("abort", onAbort);
            rej(new AbortedError());
          }
        };
      });
      if (images.length) return images;
      // the workflow saved its images instead (SaveImage / PreviewImage): read them from the history
      const h = await this.json<Record<string, { outputs: Record<string, { images?: { filename: string; subfolder: string; type: string }[] }> }>>(`/history/${promptId}`);
      const out = h[promptId]?.outputs ?? {};
      for (const o of Object.values(out)) {
        for (const im of o.images ?? []) {
          const q = new URLSearchParams({ filename: im.filename, subfolder: im.subfolder, type: im.type });
          const r = await fetch(`${this.url}/view?${q}`);
          if (r.ok) images.push(await r.blob());
        }
      }
      if (!images.length) throw new Error("ワークフローが画像を出力しませんでした（SaveImageWebsocket か SaveImage が必要です）");
      return images;
    } finally {
      ws.onclose = null;
      ws.close();
    }
  }
}

function describeNodeErrors(ne: Record<string, unknown>): string {
  return Object.entries(ne).map(([id, e]) => {
    const x = e as { class_type?: string; errors?: { message?: string; details?: string }[] };
    return `${x.class_type ?? id}: ${(x.errors ?? []).map((er) => `${er.message ?? ""} ${er.details ?? ""}`.trim()).join(", ")}`;
  }).join(" / ");
}

export const comfy = new ComfyClient();
