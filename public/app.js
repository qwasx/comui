const WORKFLOW_URL = "/workflows/wan22-remix-video.json";

const state = {
  workflow: null,
  uploads: [],
  comfyBase: localStorage.getItem("comfyBase") || "",
  clientId: `codex-ui-${crypto.randomUUID()}`,
  polling: null,
};

const els = {
  statusText: document.querySelector("#statusText"),
  statusButton: document.querySelector("#statusButton"),
  comfyUrl: document.querySelector("#comfyUrl"),
  saveComfyUrl: document.querySelector("#saveComfyUrl"),
  promptBadge: document.querySelector("#promptBadge"),
  mediaFiles: document.querySelector("#mediaFiles"),
  uploads: document.querySelector("#uploads"),
  runButton: document.querySelector("#runButton"),
  log: document.querySelector("#log"),
  outputs: document.querySelector("#outputs"),
  outputBadge: document.querySelector("#outputBadge"),
};

function log(line) {
  const time = new Date().toLocaleTimeString();
  els.log.textContent = `[${time}] ${line}\n${els.log.textContent}`.slice(0, 7000);
}

function apiUrl(path) {
  const url = new URL(path, window.location.origin);
  if (state.comfyBase) url.searchParams.set("base", state.comfyBase);
  return url;
}

function normalizeComfyUrl(value) {
  const trimmed = value.trim().replace(/\/+$/, "");
  const url = new URL(trimmed);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("地址必须以 http:// 或 https:// 开头");
  }
  return url.toString().replace(/\/+$/, "");
}

async function readJson(res) {
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(text || `HTTP ${res.status}`);
  }
  if (!res.ok) {
    throw new Error(data.error || data.message || data.errmsg || `HTTP ${res.status}`);
  }
  return data;
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value > 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

async function loadConfig() {
  const res = await fetch("/api/config");
  const data = await readJson(res);
  state.comfyBase = state.comfyBase || data.default_base;
  els.comfyUrl.value = state.comfyBase;
  localStorage.setItem("comfyBase", state.comfyBase);
  await checkStatus();
}

async function checkStatus() {
  els.statusText.textContent = "连接中...";
  try {
    const res = await fetch(apiUrl("/api/status"));
    const data = await readJson(res);
    const version = data?.system?.comfyui_version || "online";
    const ram = data?.system?.ram_free ? `，空闲内存 ${formatBytes(data.system.ram_free)}` : "";
    els.statusText.textContent = `已连接：${state.comfyBase}，ComfyUI ${version}${ram}`;
  } catch (error) {
    els.statusText.textContent = `连接失败：${error.message}`;
  }
}

async function loadWorkflow() {
  const res = await fetch(WORKFLOW_URL, { cache: "no-store" });
  state.workflow = await readJson(res);
  log("内置视频工作流已准备好");
}

function cloneWorkflowWithImage() {
  if (!state.workflow) throw new Error("工作流还没加载好");
  if (!state.uploads[0]) throw new Error("请先上传一张图片");

  const workflow = structuredClone(state.workflow);
  const image = state.uploads[0];
  let applied = false;

  for (const [nodeId, node] of Object.entries(workflow)) {
    const inputs = node?.inputs || {};
    const classType = String(node?.class_type || "").toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(inputs, "image")) continue;
    if (Array.isArray(inputs.image)) continue;
    if (!classType.includes("loadimage") && !classType.includes("base64")) continue;

    node.inputs.image = classType.includes("base64") ? image.base64 : image.name;
    applied = true;
  }

  if (!applied) throw new Error("工作流里没有找到图片输入节点");
  return workflow;
}

async function uploadFiles(files) {
  const file = files.find((item) => item.type.startsWith("image/"));
  if (!file) {
    log("请上传图片文件");
    return;
  }

  state.uploads = [];
  els.outputs.innerHTML = "";
  els.outputBadge.textContent = "0";
  els.mediaFiles.disabled = true;

  try {
    const base64 = await fileToBase64(file);
    const form = new FormData();
    form.append("image", file);
    form.append("type", "input");
    form.append("overwrite", "true");

    log(`上传图片：${file.name}`);
    const res = await fetch(apiUrl("/api/upload"), { method: "POST", body: form });
    const data = await readJson(res);

    state.uploads.push({
      original: file.name,
      name: data.name || file.name,
      mime: file.type,
      preview: URL.createObjectURL(file),
      base64,
    });
    renderUpload();
    log("图片已上传，可以生成视频");
  } catch (error) {
    log(`上传失败：${error.message}`);
  } finally {
    els.mediaFiles.disabled = false;
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      resolve(dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl);
    };
    reader.onerror = () => reject(reader.error || new Error("读取图片失败"));
    reader.readAsDataURL(file);
  });
}

function renderUpload() {
  els.uploads.innerHTML = "";
  const item = state.uploads[0];
  if (!item) return;

  const node = document.createElement("div");
  node.className = "uploadItem";
  node.innerHTML = `
    <img class="thumb" src="${item.preview}" alt="">
    <div>
      <div class="uploadName">${escapeHtml(item.original)}</div>
      <div class="uploadMeta">已写入视频工作流</div>
    </div>
    <button class="ghost">移除</button>
  `;
  node.querySelector("button").addEventListener("click", () => {
    state.uploads = [];
    renderUpload();
  });
  els.uploads.append(node);
}

async function runWorkflow() {
  els.runButton.disabled = true;
  try {
    const workflow = cloneWorkflowWithImage();
    els.promptBadge.textContent = "提交中";
    log("提交视频生成任务");
    const res = await fetch(apiUrl("/api/queue"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workflow, client_id: state.clientId }),
    });
    const data = await readJson(res);
    if (!data.prompt_id) throw new Error(JSON.stringify(data));
    els.promptBadge.textContent = "生成中";
    log(`任务已创建：${data.prompt_id}`);
    startPolling(data.prompt_id);
  } catch (error) {
    els.promptBadge.textContent = "失败";
    log(error.message);
  } finally {
    els.runButton.disabled = false;
  }
}

function startPolling(promptId) {
  if (state.polling) clearInterval(state.polling);
  state.polling = setInterval(() => pollHistory(promptId), 2200);
  pollHistory(promptId);
}

async function pollHistory(promptId) {
  try {
    const res = await fetch(apiUrl(`/api/history/${encodeURIComponent(promptId)}`));
    const data = await readJson(res);
    const item = data[promptId];
    if (!item) {
      log("视频生成中...");
      return;
    }

    clearInterval(state.polling);
    state.polling = null;
    els.promptBadge.textContent = "完成";
    const outputs = collectOutputs(item.outputs || {});
    renderOutputs(outputs);
    log(outputs.length ? `完成，输出 ${outputs.length} 个文件` : "完成，但没有发现视频输出");
  } catch (error) {
    log(`轮询失败：${error.message}`);
  }
}

function collectOutputs(outputs) {
  const result = [];
  for (const nodeOutput of Object.values(outputs)) {
    for (const key of ["images", "gifs", "videos", "animated"]) {
      const list = nodeOutput?.[key];
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (item?.filename) result.push({ ...item, kind: key });
      }
    }
  }
  return result;
}

function renderOutputs(outputs) {
  els.outputBadge.textContent = String(outputs.length);
  els.outputs.innerHTML = "";
  for (const item of outputs) {
    const params = new URLSearchParams({
      filename: item.filename,
      type: item.type || "output",
      subfolder: item.subfolder || "",
    });
    if (state.comfyBase) params.set("base", state.comfyBase);
    const url = `/api/view?${params}`;
    const ext = item.filename.split(".").pop()?.toLowerCase() || "";
    const isVideo = ["mp4", "webm", "mov", "mkv"].includes(ext) || item.kind === "videos" || item.kind === "gifs";
    const card = document.createElement("div");
    card.className = "outputCard";
    card.innerHTML = `
      ${isVideo ? `<video src="${url}" controls></video>` : `<img src="${url}" alt="">`}
      <a href="${url}" target="_blank" rel="noreferrer">${escapeHtml(item.filename)}</a>
    `;
    els.outputs.append(card);
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

els.statusButton.addEventListener("click", checkStatus);
els.saveComfyUrl.addEventListener("click", () => {
  try {
    state.comfyBase = normalizeComfyUrl(els.comfyUrl.value);
    localStorage.setItem("comfyBase", state.comfyBase);
    log(`已切换 ComfyUI：${state.comfyBase}`);
    checkStatus();
  } catch (error) {
    log(error.message);
  }
});
els.comfyUrl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") els.saveComfyUrl.click();
});
els.mediaFiles.addEventListener("change", (event) => {
  uploadFiles([...event.target.files]);
  event.target.value = "";
});
els.runButton.addEventListener("click", runWorkflow);

loadConfig();
loadWorkflow();
