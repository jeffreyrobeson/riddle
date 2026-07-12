/*
 * admin.js — login at /admin, then generate access keys. Each generated key
 * is appended to keys.json on the server and is immediately a valid diary
 * access token. Keys render newest-first with a copy button.
 */
(function () {
  "use strict";

  const loginSection = document.getElementById("loginSection");
  const genSection = document.getElementById("genSection");
  const whoami = document.getElementById("whoami");
  const adminUser = document.getElementById("adminUser");
  const adminPass = document.getElementById("adminPass");
  const adminLoginBtn = document.getElementById("adminLoginBtn");
  const loginError = document.getElementById("loginError");
  const genKeyBtn = document.getElementById("genKeyBtn");
  const keyBytes = document.getElementById("keyBytes");
  const keyList = document.getElementById("keyList");
  const genError = document.getElementById("genError");
  const changeBtn = document.getElementById("changeBtn");
  const cwUser = document.getElementById("cwUser");
  const cwCurPass = document.getElementById("cwCurPass");
  const cwNewPass = document.getElementById("cwNewPass");
  const changeError = document.getElementById("changeError");

  function show(el, msg) {
    el.textContent = msg;
    el.classList.remove("hidden");
  }

  // Copy to clipboard with a fallback for non-secure contexts (plain http://
  // from a remote host blocks navigator.clipboard). Promise resolves true on
  // success, false otherwise; callers flash the button themselves.
  function copyText(text) {
    return new Promise((resolve) => {
      const done = (ok) => resolve(ok);
      try {
        if (navigator.clipboard && window.isSecureContext) {
          navigator.clipboard.writeText(text).then(() => done(true), () => fallback());
          return;
        }
      } catch (_) { /* fall through to fallback */ }
      fallback();
      function fallback() {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.top = "-1000px";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, text.length);
        let ok = false;
        try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
        document.body.removeChild(ta);
        done(ok);
      }
    });
  }

  async function adminLogin() {
    const user = adminUser.value.trim();
    const pass = adminPass.value;
    if (!user || !pass) {
      show(loginError, "请输入账号和密码。");
      return;
    }
    adminLoginBtn.disabled = true;
    try {
      const resp = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user, pass }),
      });
      const data = await resp.json();
      if (data.ok) {
        loginSection.classList.add("hidden");
        genSection.classList.remove("hidden");
        loadWhoami();
        await loadKeys();
      } else {
        show(loginError, "账号或密码不对。");
        adminLoginBtn.disabled = false;
      }
    } catch (e) {
      show(loginError, "网络出了点问题……");
      adminLoginBtn.disabled = false;
    }
  }

  function loadWhoami() {
    // Show the current admin account name above the key panel.
    fetch("/api/admin/whoami")
      .then((r) => r.json())
      .then((d) => {
        if (d.ok && d.user) {
          whoami.textContent = "当前账号：" + d.user;
          whoami.classList.remove("hidden");
        }
      })
      .catch(() => { /* whoami is informational; stay silent on failure */ });
  }

  async function loadKeys() {
    try {
      const resp = await fetch("/api/admin/listkeys");
      const data = await resp.json();
      if (data.ok) renderKeys(data.keys || []);
    } catch (e) { /* leave the list as-is */ }
  }

  async function genKey() {
    genKeyBtn.disabled = true;
    const bytes = Math.max(8, Math.min(64, parseInt(keyBytes.value, 10) || 32));
    try {
      const resp = await fetch("/api/admin/genkey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bytes }),
      });
      const data = await resp.json();
      if (data.ok) {
        renderKeys(data.keys || []);
        genError.classList.add("hidden");
      } else {
        show(genError, data.error || "生成失败。");
      }
    } catch (e) {
      show(genError, "网络出了点问题……");
    } finally {
      genKeyBtn.disabled = false;
    }
  }

  async function delKey(key) {
    if (!confirm("确定删除这把钥匙吗?删除后用此钥匙的人将无法进入日记本。")) return;
    try {
      const resp = await fetch("/api/admin/delkey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      const data = await resp.json();
      if (data.ok) {
        renderKeys(data.keys || []);
        genError.classList.add("hidden");
      } else {
        show(genError, data.error || "删除失败。");
      }
    } catch (e) {
      show(genError, "网络出了点问题……");
    }
  }

  async function changeCreds() {
    const user = cwUser.value.trim();
    const curPass = cwCurPass.value;
    const newPass = cwNewPass.value;
    if (!user || !curPass || !newPass) {
      show(changeError, "请填完整。");
      return;
    }
    if (newPass.length < 6) {
      show(changeError, "新密码至少 6 位。");
      return;
    }
    changeBtn.disabled = true;
    try {
      const resp = await fetch("/api/admin/changepw", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user, cur_pass: curPass, pass: newPass }),
      });
      const data = await resp.json();
      if (data.ok) {
        changeError.classList.add("hidden");
        changeBtn.textContent = "已保存,正在重启…";
        // server restarts ~1s; cookie is invalidated — bounce to login.
        setTimeout(() => {
          alert("服务已重启,请用新账号重新登录。");
          location.reload();
        }, 2500);
      } else {
        show(changeError, data.error || "保存失败。");
        changeBtn.disabled = false;
      }
    } catch (e) {
      show(changeError, "网络出了点问题……");
      changeBtn.disabled = false;
    }
  }

  function fmtDate(iso) {
    try {
      const d = new Date(iso);
      if (isNaN(d)) return "";
      return d.toLocaleString("zh-CN", { hour12: false });
    } catch (_) { return ""; }
  }

  function renderKeys(keys) {
    keyList.innerHTML = "";
    // newest first: the server appends; reverse for display.
    const ordered = keys.slice().reverse();
    if (!ordered.length) {
      const empty = document.createElement("div");
      empty.className = "key-empty";
      empty.textContent = "还没有生成任何钥匙。";
      keyList.appendChild(empty);
      return;
    }
    for (const rec of ordered) {
      const key = (rec && rec.key) || "";
      const wrap = document.createElement("div");
      wrap.className = "key-item";

      const value = document.createElement("div");
      value.className = "key-value";
      value.textContent = key;

      const meta = document.createElement("div");
      meta.className = "key-meta";
      meta.textContent = fmtDate(rec.created_at);

      const copy = document.createElement("button");
      copy.className = "key-copy";
      copy.textContent = "复制";
      copy.addEventListener("click", async () => {
        const ok = await copyText(key);
        if (ok) {
          copy.textContent = "已复制";
          setTimeout(() => (copy.textContent = "复制"), 1200);
        } else {
          // last resort: select the value text so the user can Ctrl+C
          value.style.userSelect = "all";
          const range = document.createRange();
          range.selectNodeContents(value);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          show(genError, "复制失败，已选中钥匙，请按 Ctrl+C 复制。");
        }
      });

      const del = document.createElement("button");
      del.className = "key-del";
      del.textContent = "删除";
      del.addEventListener("click", () => delKey(key));

      const actions = document.createElement("div");
      actions.className = "key-actions";
      actions.appendChild(copy);
      actions.appendChild(del);

      wrap.appendChild(value);
      wrap.appendChild(meta);
      wrap.appendChild(actions);
      keyList.appendChild(wrap);
    }
  }

  adminLoginBtn.addEventListener("click", adminLogin);
  adminPass.addEventListener("keydown", (e) => {
    if (e.key === "Enter") adminLogin();
  });
  genKeyBtn.addEventListener("click", genKey);
  if (changeBtn) changeBtn.addEventListener("click", changeCreds);
  adminUser.focus();
})();
