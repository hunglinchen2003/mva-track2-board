const STORAGE_KEYS = {
  webapp: "mvaTrack2WebAppUrl",
  author: "mvaTrack2Author",
};

const state = {
  config: null,
  webapp: "",
  messages: [],
  heartbeat: "",
};

function byId(id) {
  return document.getElementById(id);
}

async function loadConfig() {
  const res = await fetch("config.json", { cache: "no-store" });
  if (!res.ok) throw new Error("無法讀取 config.json");
  state.config = await res.json();
  const localUrl = localStorage.getItem(STORAGE_KEYS.webapp) || "";
  state.webapp = (localUrl || state.config.sheetsWebAppUrl || "").trim();
  const savedAuthor = localStorage.getItem(STORAGE_KEYS.author);
  if (savedAuthor) byId("author-input").value = savedAuthor;
}

function showSetup(show) {
  byId("setup-banner").hidden = !show;
  if (show && state.webapp) byId("webapp-url-input").value = state.webapp;
}

function webappReady() {
  return /^https:\/\/script\.google\.com\/macros\/s\//.test(state.webapp);
}

function jsonp(url) {
  return new Promise((resolve, reject) => {
    const cb = `mva_cb_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("連線逾時"));
    }, 20000);
    function cleanup() {
      clearTimeout(timer);
      delete window[cb];
      script.remove();
    }
    window[cb] = (data) => {
      cleanup();
      resolve(data);
    };
    const script = document.createElement("script");
    const join = url.includes("?") ? "&" : "?";
    script.src = `${url}${join}callback=${cb}`;
    script.onerror = () => {
      cleanup();
      reject(new Error("JSONP 失敗"));
    };
    document.body.appendChild(script);
  });
}

async function gasGet(action) {
  const url = `${state.webapp}?action=${encodeURIComponent(action)}`;
  try {
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) throw new Error(String(res.status));
    return await res.json();
  } catch {
    return jsonp(url);
  }
}

function postViaIframe(payload) {
  return new Promise((resolve) => {
    const iframe = document.createElement("iframe");
    iframe.name = `mva_sink_${Date.now()}`;
    iframe.style.display = "none";
    const form = document.createElement("form");
    form.method = "POST";
    form.action = state.webapp;
    form.target = iframe.name;
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = "payload";
    input.value = JSON.stringify(payload);
    form.appendChild(input);
    document.body.appendChild(iframe);
    document.body.appendChild(form);
    form.submit();
    setTimeout(() => {
      form.remove();
      iframe.remove();
      resolve({ ok: true });
    }, 1600);
  });
}

async function gasWrite(payload) {
  payload.token = state.config.teamToken;
  const encoded = JSON.stringify(payload);
  if (encoded.length < 1800) {
    try {
      const url = `${state.webapp}?payload=${encodeURIComponent(encoded)}`;
      return await gasGetFromUrl(url);
    } catch {
      /* fall through */
    }
  }
  await postViaIframe(payload);
  return { ok: true, deferred: true };
}

async function gasGetFromUrl(url) {
  try {
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) throw new Error(String(res.status));
    return await res.json();
  } catch {
    return jsonp(url);
  }
}

function parseTime(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso || "";
  return new Intl.DateTimeFormat("zh-TW", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(t));
}

function heartbeatFresh(iso) {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  return Date.now() - t < 45000;
}

function setAiStatus(listing) {
  const el = byId("ai-status");
  const text = byId("ai-status-text");
  const pending = (listing.messages || []).some(
    (m) => m.ask_ai && m.ai_status === "pending"
  );
  if (heartbeatFresh(listing.heartbeat || "")) {
    el.dataset.state = pending ? "pending" : "online";
    text.textContent = pending
      ? `AI 規劃中 · ${listing.model || "gpt-oss:20b"}`
      : `AI 在線 · ${listing.model || "gpt-oss:20b"}`;
    return;
  }
  if (pending) {
    el.dataset.state = "pending";
    text.textContent = "等待本機 worker";
    return;
  }
  el.dataset.state = "offline";
  text.textContent = "AI worker 未連線";
}

function buildTree(messages) {
  const roots = [];
  const byParent = new Map();
  for (const m of messages) {
    if (!m.parent_id) roots.push(m);
    else {
      if (!byParent.has(m.parent_id)) byParent.set(m.parent_id, []);
      byParent.get(m.parent_id).push(m);
    }
  }
  const sortFn = (a, b) => String(a.created_at).localeCompare(String(b.created_at));
  roots.sort(sortFn).reverse();
  for (const arr of byParent.values()) arr.sort(sortFn);
  return { roots, byParent };
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function postView(m, childHtmlParts) {
  const ai = m.role === "ai";
  const pending = m.ask_ai && m.ai_status === "pending";
  const childHtml = childHtmlParts.length
    ? `<div class="replies">${childHtmlParts.join("")}</div>`
    : "";
  return `
    <article class="post" data-id="${escapeHtml(m.id)}">
      <div class="post-meta">
        <span class="author">${escapeHtml(m.author || "匿名")}</span>
        ${ai ? '<span class="badge ai">AI 規劃</span>' : ""}
        ${pending ? '<span class="badge pending">等待 AI</span>' : ""}
        <span>${escapeHtml(parseTime(m.created_at))}</span>
      </div>
      <div class="post-body">${escapeHtml(m.content)}</div>
      ${
        ai
          ? ""
          : `<div class="post-actions">
              <button type="button" class="btn ghost small" data-reply="${escapeHtml(m.id)}">回覆</button>
              <button type="button" class="btn ghost small" data-ai="${escapeHtml(m.id)}">請 AI 規劃</button>
            </div>
            <form class="reply-form" data-form="${escapeHtml(m.id)}" hidden>
              <textarea rows="4" maxlength="8000" placeholder="回覆這則提案…" required></textarea>
              <div class="row">
                <label class="check"><input type="checkbox" /> 請 AI 依這則回覆規劃</label>
                <button type="submit" class="btn small">送出回覆</button>
              </div>
            </form>`
      }
      ${childHtml}
    </article>
  `;
}

function renderPost(m, byParent) {
  const children = byParent.get(m.id) || [];
  return postView(m, children.map((child) => renderPost(child, byParent)));
}

function render() {
  const list = byId("thread-list");
  if (!state.messages.length) {
    list.innerHTML = `<p class="empty">還沒有提案。上面寫下你認為 Track 2 該怎麼進行。</p>`;
    return;
  }
  const { roots, byParent } = buildTree(state.messages);
  list.innerHTML = roots
    .map((root) => `<section class="thread">${renderPost(root, byParent)}</section>`)
    .join("");
}

async function refresh() {
  if (!webappReady()) {
    showSetup(true);
    return;
  }
  showSetup(false);
  try {
    const listing = await gasGet("list");
    if (!listing.ok) throw new Error(listing.error || "讀取失敗");
    state.messages = listing.messages || [];
    state.heartbeat = listing.heartbeat || "";
    setAiStatus(listing);
    render();
  } catch (err) {
    showSetup(true);
    byId("composer-msg").textContent = `讀取試算表失敗：${err.message}。請確認 Web App 已部署且存取權為「任何人」。`;
  }
}

async function createMessage({ author, content, parentId, askAi }) {
  const payload = {
    action: parentId ? "reply" : "create",
    author,
    content,
    parent_id: parentId || "",
    role: "human",
    ask_ai: !!askAi,
  };
  const result = await gasWrite(payload);
  if (result && result.ok === false) throw new Error(result.error || "寫入失敗");
  await new Promise((r) => setTimeout(r, result.deferred ? 1800 : 400));
  await refresh();
}

function bindBoardEvents() {
  byId("thread-list").addEventListener("click", (ev) => {
    const replyBtn = ev.target.closest("[data-reply]");
    if (replyBtn) {
      const form = byId("thread-list").querySelector(`[data-form="${replyBtn.dataset.reply}"]`);
      if (form) form.hidden = !form.hidden;
    }
  });

  byId("thread-list").addEventListener("click", async (ev) => {
    const aiBtn = ev.target.closest("[data-ai]");
    if (!aiBtn) return;
    aiBtn.disabled = true;
    try {
      await gasWrite({ action: "request_ai", id: aiBtn.dataset.ai });
      await new Promise((r) => setTimeout(r, 1200));
      await refresh();
    } catch (err) {
      byId("composer-msg").textContent = err.message;
    } finally {
      aiBtn.disabled = false;
    }
  });

  byId("thread-list").addEventListener("submit", async (ev) => {
    const form = ev.target.closest(".reply-form");
    if (!form) return;
    ev.preventDefault();
    const textarea = form.querySelector("textarea");
    const ask = form.querySelector("input[type=checkbox]").checked;
    const author = byId("author-input").value.trim();
    if (!author) {
      byId("author-input").focus();
      byId("composer-msg").textContent = "請先在上方填姓名，回覆才知道是誰說的。";
      return;
    }
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      await createMessage({
        author,
        content: textarea.value.trim(),
        parentId: form.dataset.form,
        askAi: ask,
      });
      form.reset();
      form.hidden = true;
    } catch (err) {
      byId("composer-msg").textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
}

async function init() {
  await loadConfig();
  showSetup(!webappReady());
  byId("save-webapp").addEventListener("click", () => {
    const url = byId("webapp-url-input").value.trim();
    localStorage.setItem(STORAGE_KEYS.webapp, url);
    state.webapp = url;
    refresh();
  });
  byId("refresh-btn").addEventListener("click", refresh);
  byId("composer").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const author = byId("author-input").value.trim();
    const content = byId("content-input").value.trim();
    localStorage.setItem(STORAGE_KEYS.author, author);
    const btn = byId("submit-btn");
    btn.disabled = true;
    byId("composer-msg").textContent = "送出中…";
    try {
      await createMessage({
        author,
        content,
        askAi: byId("ask-ai-input").checked,
      });
      byId("content-input").value = "";
      byId("ask-ai-input").checked = false;
      byId("composer-msg").textContent = "已寫入試算表。";
    } catch (err) {
      byId("composer-msg").textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
  bindBoardEvents();
  if (webappReady()) await refresh();
  setInterval(() => {
    if (webappReady()) refresh();
  }, 12000);
}

init().catch((err) => {
  byId("composer-msg").textContent = err.message;
});
