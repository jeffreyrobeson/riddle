/*
 * landing.js — the diary's front gate. Validates the key the visitor typed via
 * /api/check_key, then redirects to /diary?key=<key> which sets the access
 * cookie and 302-strips the query string from the address bar.
 */
(function () {
  "use strict";

  const keyInput = document.getElementById("keyInput");
  const enterBtn = document.getElementById("enterBtn");
  const keyError = document.getElementById("keyError");

  function showError(msg) {
    keyError.textContent = msg;
    keyError.classList.remove("hidden");
  }

  async function tryEnter() {
    const key = keyInput.value.trim();
    if (!key) {
      showError("请输入钥匙。");
      return;
    }
    enterBtn.disabled = true;
    try {
      const resp = await fetch("/api/check_key?key=" + encodeURIComponent(key));
      const data = await resp.json();
      if (data.ok) {
        window.location.href = "/diary?key=" + encodeURIComponent(key);
      } else {
        showError("钥匙不对，再试试。");
        enterBtn.disabled = false;
      }
    } catch (e) {
      showError("网络出了点问题……");
      enterBtn.disabled = false;
    }
  }

  enterBtn.addEventListener("click", tryEnter);
  keyInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") tryEnter();
  });
  keyInput.focus();
})();
