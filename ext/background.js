const TARGET_HOST = "www.pokemoncenter-online.com";
const URL_GLOB = "*://www.pokemoncenter-online.com/on/demandware.static/Sites-POL-Site/-/ja_JP/*/js/loginAccount.js";

// ---- BLOCKERS (chặn tracker phổ biến) ----
// LƯU Ý: không chặn reCAPTCHA (www.google.com/recaptcha, www.gstatic.com/recaptcha) để tránh hỏng login
const BLOCK_GLOBS = [
  // Google / GA / GTM / DoubleClick
  "*://www.google-analytics.com/*",
  "*://ssl.google-analytics.com/*",
  "*://stats.g.doubleclick.net/*",
  "*://www.googletagmanager.com/*",
  "*://analytics.google.com/*/g/collect*",

  // Facebook Pixel / SDK
  "*://connect.facebook.net/*",
  "*://*.facebook.com/tr*",
  "*://graph.facebook.com/*/events*",
];

// ---- METRICS ----
const metrics = {
  blockedTotal: 0,
  blockedByHost: {},     // { host: count }
  replacedJS: 0
};
function incBlocked(host) {
  metrics.blockedTotal++;
  metrics.blockedByHost[host] = (metrics.blockedByHost[host] || 0) + 1;
  chrome.action.setBadgeText({ text: String(metrics.blockedTotal) });
}
chrome.action.setBadgeBackgroundColor?.({ color: "#555" });

// set tab đã attach
const attachedTabs = new Set();

// tiện ích
function urlIsTarget(u) {
  try {
    const url = new URL(u);
    return (
      url.host === TARGET_HOST &&
      /\/on\/demandware\.static\/Sites-POL-Site\/-\/ja_JP\/[^/]+\/js\/loginAccount\.js$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}
function urlMatchesAny(u, globs) {
  // Dùng URLPattern-like đơn giản qua RegExp chuyển đổi dấu *
  return globs.some(g => {
    const re = new RegExp("^" + g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
    return re.test(u);
  });
}
function send(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (res) => {
      const err = chrome.runtime.lastError;
      if (err) reject(err);
      else resolve(res);
    });
  });
}
function base64FromBytes(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// ---- Attach khi user vào site đích ----
async function attachIfNeeded(tabId) {
  if (attachedTabs.has(tabId)) return;
  try {
    await new Promise((res, rej) =>
      chrome.debugger.attach({ tabId }, "1.3", () =>
        chrome.runtime.lastError ? rej(chrome.runtime.lastError) : res()
      )
    );
    attachedTabs.add(tabId);

    // Bật Fetch với 2 nhóm pattern:
    // 1) Response stage cho file JS mục tiêu (để replace nội dung)
    // 2) Request stage cho các tracker (để chặn sớm)
    const patterns = [
      { urlPattern: URL_GLOB, resourceType: "Script", requestStage: "Response" },
      ...BLOCK_GLOBS.map(p => ({ urlPattern: p, requestStage: "Request" }))
    ];
    await send(tabId, "Fetch.enable", { patterns });

    // (Tùy chọn) Bật Network để nhận thêm sự kiện thống kê nếu bạn muốn
    // await send(tabId, "Network.enable");

  } catch (e) {
    console.warn("[Replacer] attach failed:", e);
  }
}

// Lắng nghe cập nhật tab để attach
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "loading" && tab?.url?.includes(TARGET_HOST)) {
    attachIfNeeded(tabId);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  if (attachedTabs.has(tabId)) {
    try { chrome.debugger.detach({ tabId }); } catch {}
    attachedTabs.delete(tabId);
  }
});

// ---- CDP Events ----
chrome.debugger.onEvent.addListener(async (source, method, params) => {
  const tabId = source.tabId;
  if (!attachedTabs.has(tabId)) return;
  if (method !== "Fetch.requestPaused") return;

  const { requestId, request, responseStatusCode } = params;
  const url = request?.url || "";

  // 1) CHẶN TRACKERS Ở REQUEST STAGE
  // Khi requestStage === "Request" thì không có responseStatusCode
  if (responseStatusCode === undefined) {
    // Bỏ qua recaptcha để tránh hỏng login
    if (/^https?:\/\/(www\.)?google\.com\/recaptcha\//.test(url) ||
        /^https?:\/\/www\.gstatic\.com\/recaptcha\//.test(url)) {
      try { await send(tabId, "Fetch.continueRequest", { requestId }); } catch {}
      return;
    }

    if (urlMatchesAny(url, BLOCK_GLOBS)) {
      try {
        // Lý do fail: dùng "Aborted" để nhất quán
        await send(tabId, "Fetch.failRequest", { requestId, errorReason: "Aborted" });
        let host = "";
        try { host = new URL(url).host; } catch {}
        incBlocked(host);
      } catch (e) {
        console.warn("[Replacer] failRequest error, continue:", e);
        try { await send(tabId, "Fetch.continueRequest", { requestId }); } catch {}
      }
      return;
    }

    // Không match — cho qua
    try { await send(tabId, "Fetch.continueRequest", { requestId }); } catch {}
    return;
  }

  // 2) THAY NỘI DUNG FILE JS Ở RESPONSE STAGE
  // Chỉ xử lý đúng file JS và status 200
  if (!urlIsTarget(url) || responseStatusCode !== 200) {
    try { await send(tabId, "Fetch.continueRequest", { requestId }); } catch {}
    return;
  }

  try {
    // Lấy body gốc
    const bodyObj = await send(tabId, "Fetch.getResponseBody", { requestId });

    // Lấy string (ưu tiên coi là text JS)
    let text;
    if (bodyObj.base64Encoded) {
      const raw = atob(bodyObj.body);
      const buf = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
      text = new TextDecoder("utf-8").decode(buf);
    } else {
      text = bodyObj.body;
    }

    // ---- PATCH: captchaToken:t  => captchaToken: document.querySelector('#g-recaptcha-token').value
    const patched = text.replace(
      /captchaToken\s*:\s*t(\b)/g,
      `captchaToken:document.querySelector('#g-recaptcha-token').value$1`
    );

    const bytes = new TextEncoder().encode(patched);
    const b64 = base64FromBytes(bytes);

    // Dựng header mới
    const headers = (params.responseHeaders || []).filter(h => {
      const n = (h.name || "").toLowerCase();
      return n !== "content-encoding" && n !== "content-length";
    });
    headers.push({ name: "Content-Type", value: "application/javascript; charset=utf-8" });
    headers.push({ name: "Cache-Control", value: "no-cache, no-store, must-revalidate" });
    headers.push({ name: "Content-Length", value: String(bytes.length) });

    await send(tabId, "Fetch.fulfillRequest", {
      requestId,
      responseCode: 200,
      responseHeaders: headers,
      body: b64
    });

    metrics.replacedJS++;

  } catch (e) {
    console.error("[Replacer] error:", e);
    try { await send(tabId, "Fetch.continueRequest", { requestId }); } catch {}
  }
});

// ---- API xuất metrics (nếu muốn xem trong popup/options) ----
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "getMetrics") {
    sendResponse({ ok: true, metrics });
    return true;
  }
});
