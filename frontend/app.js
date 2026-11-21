const el = (id) => document.getElementById(id);
const $ = (sel) => document.querySelector(sel);
const fmtSize = (n) => {
  if (n == null) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let x = n;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return `${x.toFixed(1)} ${units[i]}`;
};
const fmtTime = (ms) => {
  const d = new Date(ms);
  const z2 = (n) => String(n).padStart(2, "0");
  return `${z2(d.getMonth() + 1)}/${z2(d.getDate())} ${z2(d.getHours())}:${z2(d.getMinutes())}`;
};

let CONFIG = { maxFileBytes: 2 * 1024 * 1024 * 1024 };

let session = null;
let ws = null;

async function init() {
  try {
    const c = await fetchJSON("/api/config");
    if (c?.maxFileBytes) CONFIG.maxFileBytes = c.maxFileBytes;
  } catch {}
  // PWA install prompt
  let deferredPrompt = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    el("btn-install").hidden = false;
  });
  el("btn-install").addEventListener("click", async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    el("btn-install").hidden = true;
  });

  // Routes
  await routeDecide();

  // Main UI
  el("btn-pair").addEventListener("click", startPair);
  el("btn-devices").addEventListener("click", openDevices);
  el("devices-close").addEventListener("click", () => el("devices-dialog").close());
  el("share-close").addEventListener("click", () => el("share-dialog").close());

  // Send: text
  el("send-text").addEventListener("click", sendText);
  // Send: drop
  const drop = el("drop");
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("drag"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("drag"); const files = e.dataTransfer.files; if (files?.length) uploadFiles(files); });
  el("file-input").addEventListener("change", async (e) => {
    const input = e.target;
    const files = Array.from(input.files || []);
    input.value = ""; // allow picking the same file again
    await uploadFiles(files);
  });

  // Pair claim & login
  el("pair-claim").addEventListener("click", claimPair);
  const setupForm = el("setup-form");
  if (setupForm) setupForm.addEventListener("submit", (e) => { e.preventDefault(); doSetup(); });
  const loginForm = el("login-form");
  if (loginForm) loginForm.addEventListener("submit", (e) => { e.preventDefault(); doLogin(); });
  const loginClaimForm = el("login-claim-form");
  if (loginClaimForm) loginClaimForm.addEventListener("submit", (e) => { e.preventDefault(); doLoginClaim(); });
  const setupPassToggle = el("setup-pass-toggle");
  if (setupPassToggle) setupPassToggle.addEventListener("click", () => togglePassword("setup-pass", "setup-pass-toggle"));
  const loginPassToggle = el("login-pass-toggle");
  if (loginPassToggle) loginPassToggle.addEventListener("click", () => togglePassword("login-pass", "login-pass-toggle"));

  // Timeline
  initLoadMore();
  await refreshTimeline(true);
  connectWS();
}

function guessDeviceName() {
  const ua = navigator.userAgent || "";
  // iPadOS 13+ Safari reports Macintosh; detect via touch points
  const isMacLike = /Macintosh|Mac OS X/i.test(ua);
  if (isMacLike && navigator.maxTouchPoints > 1) return "iPad";
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  if (/Pixel/i.test(ua)) return "Pixel";
  if (/Android/i.test(ua)) return "Android";
  if (/Windows NT/i.test(ua)) return "Windows PC";
  if (/Macintosh|Mac OS X/i.test(ua)) return "Mac";
  if (/CrOS/i.test(ua)) return "ChromeOS";
  if (/Linux/i.test(ua)) return "Linux";
  return "My Device";
}

async function routeDecide() {
  const url = new URL(location.href);
  const pathname = url.pathname;
  if (pathname === "/pair") {
    hideAll();
    $("#pair-claim-section").hidden = false;
    const guess = guessDeviceName();
    const inp = $("#pair-device-name");
    if (inp && !inp.value) inp.value = guess;
    const t = url.searchParams.get("t");
    if (t) $("#pair-code").value = ""; // show token QR flow; we still need device name
    return;
  }
  const st = await fetchJSON("/api/status");
  if (st?.signedIn) { session = st; showMain(); return; }
  hideAll();
  if (!st?.initialized) {
    $("#setup-section").hidden = false;
    const guess = guessDeviceName();
    const sdn = $("#setup-device-name");
    if (sdn && !sdn.value) sdn.value = guess;
    // setup handled by form submit (doSetup)
  } else {
    $("#login-section").hidden = false;
    const guess = guessDeviceName();
    const ldn = $("#login-device-name");
    if (ldn && !ldn.value) ldn.value = guess;
  }
}

function hideAll() {
  ["setup-section", "pair-claim-section", "pair-start-section", "send-section", "timeline-section"].forEach(id => { el(id).hidden = true; });
}
function showMain() {
  hideAll();
  $("#send-section").hidden = false;
  $("#timeline-section").hidden = false;
}

async function startPair() {
  const r = await fetchJSON("/api/pair/start", { method: "POST", headers: csrfHeader() });
  if (!r) return;
  hideAll();
  $("#pair-start-section").hidden = true; // initially hidden; we will reveal
  // Render
  $("#pair-code-text").textContent = r.pairCode;
  $("#pair-exp").textContent = new Date(r.expiresAt).toLocaleTimeString();
  const a = $("#pair-url");
  a.textContent = r.pairUrl;
  a.href = r.pairUrl;
  // QR
  try { window.QRDraw($("#pair-qr"), r.pairUrl, 4); } catch (e) { console.error(e); }
  $("#pair-start-section").hidden = false;
}

async function claimPair() {
  const deviceName = $("#pair-device-name").value.trim();
  const token = new URL(location.href).searchParams.get("t");
  const code = $("#pair-code").value.trim();
  if (!deviceName) return alert("端末名を入力してください");
  const resp = await fetch("/api/pair/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, code, deviceName }),
  });
  if (!resp.ok) { const msg = await resp.text(); alert(`${msg || "無効または期限切れのコード/トークンです"} (${resp.status})`); return; }
  location.href = "/";
}

async function doSetup() {
  const deviceName = $("#setup-device-name").value.trim() || guessDeviceName();
  const pass = $("#setup-pass").value;
  const res = await fetch("/api/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceName, password: pass }),
  });
  if (!res.ok) { const msg = await res.text(); alert(`${msg || "セットアップに失敗しました"} (${res.status})`); return; }
  location.reload();
}

async function doLogin() {
  const deviceName = $("#login-device-name").value.trim() || guessDeviceName();
  const pass = $("#login-pass").value;
  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceName, password: pass }),
  });
  if (!res.ok) { const msg = await res.text(); alert(`${msg || "ログインに失敗しました"} (${res.status})`); return; }
  location.reload();
}

async function doLoginClaim() {
  const deviceName = $("#login-device-name").value.trim() || guessDeviceName();
  const code = $("#login-pair-code").value.trim();
  if (!deviceName) return alert("端末名を入力してください");
  if (!code || code.length !== 6) return alert("6桁コードを入力してください");
  const resp = await fetch("/api/pair/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceName, code }),
  });
  if (!resp.ok) { const msg = await resp.text(); alert(`${msg || "無効または期限切れのコード"} (${resp.status})`); return; }
  location.reload();
}

function togglePassword(inputId, btnId) {
  const inp = document.getElementById(inputId);
  const btn = document.getElementById(btnId);
  if (!inp || !btn) return;
  inp.type = inp.type === "password" ? "text" : "password";
  btn.textContent = inp.type === "password" ? "表示" : "非表示";
}

async function openDevices() {
  const r = await fetchJSON("/api/devices");
  const ul = $("#device-list");
  ul.innerHTML = "";
  (r?.devices ?? []).forEach((d) => {
    const li = document.createElement("li");
    li.innerHTML = `<div class="dev-header"><div>${escapeHtml(d.name)}</div><div class="small">${fmtTime(d.lastSeenAt)}</div></div>
    <div class="dev-actions">
      <button data-act="issue" data-id="${d.id}" class="ghost">トークン発行</button>
      <button data-act="copy" data-id="${d.id}" class="ghost">コピー</button>
      <button data-act="revoke" data-id="${d.id}" class="ghost">無効化</button>
      <button data-act="revoke-device" data-id="${d.id}" class="ghost">解除</button>
    </div>`;
    li.addEventListener("click", async (e) => {
      const t = e.target;
      if (t.tagName !== "BUTTON") return;
      const id = t.getAttribute("data-id");
      const act = t.getAttribute("data-act");
      if (act === "revoke-device") {
      if (!confirm("この端末のアクセスを取り消しますか？")) return;
      await fetchJSON(`/api/devices/${encodeURIComponent(d.id)}`, { method: "DELETE", headers: csrfHeader() });
      await openDevices();
      } else if (act === "issue") {
        const res = await fetchJSON("/api/device/token/issue", { method: "POST", headers: { ...csrfHeader(), "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
        if (!res?.ok) return alert("発行に失敗しました");
        await navigator.clipboard.writeText(res.token);
        alert("APIトークンをコピーしました");
      } else if (act === "copy") {
        const res = await fetchJSON("/api/device/token/get", { method: "POST", headers: { ...csrfHeader(), "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
        if (!res?.ok || !res.token) return alert("トークンがありません。発行してください。");
        await navigator.clipboard.writeText(res.token);
        alert("APIトークンをコピーしました");
      } else if (act === "revoke") {
        if (!confirm("この端末のAPIトークンを無効化しますか？")) return;
        await fetchJSON("/api/device/token/revoke", { method: "POST", headers: { ...csrfHeader(), "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
        alert("無効化しました");
      }
    });
    ul.append(li);
  });
  $("#devices-dialog").showModal();
}

async function sendText() {
  const text = $("#text-input").value;
  if (!text.trim()) return;
  $("#text-input").value = "";
  const ok = await fetchJSON("/api/items/text", { method: "POST", headers: { ...csrfHeader(), "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
  if (!ok) alert("送信に失敗しました");
  else await refreshTimeline(true);
}

async function uploadFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  for (const f of files) {
    if (f.size > CONFIG.maxFileBytes) {
      alert(`「${f.name}」は上限(${fmtSize(CONFIG.maxFileBytes)})を超えています。`);
      return;
    }
  }
  let total = files.reduce((s, f) => s + f.size, 0);
  let uploaded = 0;
  const fail = async (what, res) => {
    let msg = "";
    try { msg = res ? (await res.text()).slice(0, 300) : ""; } catch {}
    hideProgress();
    alert(`アップロードに失敗しました: ${what}${res ? ` (${res.status})` : ""}${msg ? `\n${msg}` : ""}`);
    await refreshTimeline(true);
  };
  showProgress(0);
  for (const f of files) {
    try {
      if (f.size < 8 * 1024 * 1024) {
        // small file: direct PUT path
        const u = `/api/upload/direct?filename=${encodeURIComponent(f.name)}&contentType=${encodeURIComponent(f.type||"application/octet-stream")}&size=${f.size}`;
        const r = await fetch(u, { method: "PUT", headers: { ...csrfHeader() }, body: await f.arrayBuffer() });
        if (!r.ok) return await fail(f.name, r);
        uploaded += f.size;
        showProgress(uploaded / total);
        continue;
      }
      // multipart
      const cr = await fetch("/api/multipart/create", {
        method: "POST", headers: { ...csrfHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({ filename: f.name, contentType: f.type, size: f.size }),
      });
      if (!cr.ok) return await fail(`${f.name} (開始)`, cr);
      const { uploadId, key, itemId } = await cr.json();
      if (!uploadId || !key || !itemId) return await fail(`${f.name} (開始: 不正な応答)`, null);
      const partSize = 8 * 1024 * 1024;
      const partCount = Math.ceil(f.size / partSize);
      const parts = [];
      for (let i = 0; i < partCount; i++) {
        const start = i * partSize;
        const end = Math.min(f.size, start + partSize);
        const blob = f.slice(start, end);
        const pr = await fetch(`/api/multipart/upload?uploadId=${encodeURIComponent(uploadId)}&key=${encodeURIComponent(key)}&partNumber=${i + 1}`, {
          method: "PUT", headers: { ...csrfHeader() }, body: await blob.arrayBuffer(),
        });
        if (!pr.ok) return await fail(`${f.name} (パート ${i + 1}/${partCount})`, pr);
        const pj = await pr.json().catch(() => null);
        const etag = typeof pj?.etag === "string" ? pj.etag : pj?.etag?.etag;
        if (!etag) return await fail(`${f.name} (パート ${i + 1}/${partCount}: etagなし)`, null);
        parts.push({ partNumber: i + 1, etag });
        uploaded += blob.size;
        showProgress(uploaded / total);
      }
      const cp = await fetch("/api/multipart/complete", {
        method: "POST", headers: { ...csrfHeader(), "Content-Type": "application/json" },
        body: JSON.stringify({ uploadId, key, itemId, parts, filename: f.name, contentType: f.type, size: f.size })
      });
      if (!cp.ok) return await fail(`${f.name} (完了)`, cp);
    } catch (e) {
      return await fail(`${f.name}: ${e?.message || e}`, null);
    }
  }
  hideProgress();
  await refreshTimeline(true);
}

let listOffset = 0;
function initLoadMore() {
  const btn = el("load-more");
  if (btn) btn.onclick = async () => { await refreshTimeline(false); };
}

function showProgress(p) {
  $("#progress").hidden = false;
  $("#progress-bar").style.width = `${Math.floor(p * 100)}%`;
}
function hideProgress() {
  $("#progress").hidden = true;
  $("#progress-bar").style.width = "0%";
}

async function refreshTimeline(reset) {
  if (reset) {
    listOffset = 0;
    $("#timeline").innerHTML = "";
  }
  const r = await fetchJSON(`/api/items?offset=${listOffset}&limit=50`);
  const ul = $("#timeline");
  (r?.items ?? []).forEach((it) => {
    const li = document.createElement("li");
    li.className = "card";
    const meta = `${escapeHtml(it.deviceName)}・${fmtTime(it.createdAt)}${it.size ? "・" + fmtSize(it.size) : ""}`;
    if (it.kind === "text" || (!it.r2Key && it.text)) {
      li.innerHTML = `<div class="sub">${meta}</div><div class="wrap">${escapeHtml(it.text || "")}</div><div class="actions">
        <button data-id="${it.id}" data-act="copy">コピー</button>
        <button data-id="${it.id}" data-act="share">共有リンク</button>
        <button data-id="${it.id}" data-act="delete" class="ghost">削除</button>
      </div>`;
    } else {
      const isImg = (it.contentType || "").startsWith("image/");
      const thumb = isImg ? `<img class="thumb" src="/api/items/${encodeURIComponent(it.id)}/download?inline=1" alt="${escapeHtml(it.filename||'image')}">` : "";
      li.innerHTML = `<div class="sub">${meta}</div>
        <div class="row" style="gap:12px;align-items:center;">
          ${thumb}
          <div class="wrap">${escapeHtml(it.filename || "file")}</div>
        </div>
        <div class="actions">
        <a href="/api/items/${encodeURIComponent(it.id)}/download" class="button" download>ダウンロード</a>
        <button data-id="${it.id}" data-act="share">共有リンク</button>
        <button data-id="${it.id}" data-act="delete" class="ghost">削除</button>
      </div>`;
    }
    li.addEventListener("click", async (e) => {
      const t = e.target;
      if (t.tagName === "BUTTON") {
        const id = t.getAttribute("data-id");
        const act = t.getAttribute("data-act");
        if (act === "copy") {
          await navigator.clipboard.writeText((it.text || ""));
          t.textContent = "コピー済み";
          setTimeout(() => (t.textContent = "コピー"), 1500);
        } else if (act === "share") {
          const r = await fetchJSON(`/api/items/${encodeURIComponent(id)}/share`, { method: "POST", headers: csrfHeader() });
          if (!r?.ok) return alert("共有リンクの作成に失敗しました");
          const u = r.url;
          await navigator.clipboard.writeText(u);
          // Show QR dialog
          const dialog = $("#share-dialog");
          const a = $("#share-url");
          a.textContent = u; a.href = u;
          try { window.QRDraw($("#share-qr"), u, 4); } catch (e) { console.error(e); }
          dialog.showModal();
        } else if (act === "delete") {
          if (!confirm("削除しますか？")) return;
          await fetchJSON(`/api/items/${encodeURIComponent(id)}`, { method: "DELETE", headers: csrfHeader() });
          await refreshTimeline();
        }
      }
    });
    ul.append(li);
  });
}

function connectWS() {
  try {
    ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws");
    ws.onmessage = (ev) => {
      try {
        const d = JSON.parse(ev.data);
        if (d.type === "items_changed") refreshTimeline();
        if (d.type === "items_changed") refreshTimeline(true);
        if (d.type === "devices_changed") {/* no-op */}
      } catch {}
    };
    ws.onclose = () => setTimeout(connectWS, 1500);
  } catch {}
}

// Expose for automation to force refresh before screenshots
// eslint-disable-next-line no-undef
window.__forceRefresh = refreshTimeline;
function csrfHeader() {
  const v = getCookie("csrftoken");
  return v ? { "X-CSRF-Token": v } : {};
}

function getCookie(name) {
  return document.cookie.split("; ").map(s => s.split("=")).find(x => x[0] === name)?.[1];
}

async function fetchJSON(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) return null;
  const ct = res.headers.get("Content-Type") || "";
  if (!ct.includes("application/json")) return null;
  return await res.json();
}

function escapeHtml(s) { return (s ?? "").toString().replace(/[&<>'"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;","\"":"&quot;" }[c])); }

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
init().catch((e) => console.error(e));

