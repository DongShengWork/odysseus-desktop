// Cookbook 定时调度 — 打开一个小型内联表单（使用应用已有的 .cookbook-* 类样式），
// 创建一个 action=cookbook_serve 的 ScheduledTask。从两个入口挂载：
//
//   1. Serve 面板中 Launch 旁边的 ^ 按钮。
//   2. 已缓存模型 ⋯ 下拉菜单中的 "Schedule…" 条目（通过编程方式点击 ^ 按钮，
//      使本模块拥有唯一的权威数据源）。
//
// 反馈使用 uiModule.showToast() —— 与应用中 "Saved"、"Favorited" 等使用的
// 同一种 Toast —— 成功消息不会引入新的通知样式。
//
// 要移除：删除此文件 + index.html 中的 <script> 标签 + cookbookServe.js 中的
// ^ 按钮 + BUILTIN_ACTIONS 中的 "cookbook_serve" 条目 +
// src/cookbook_serve_lifecycle.py + app.py 中对应的注册行。

try { (function () {
  function _safe(fn) {
    return function () {
      try { return fn.apply(this, arguments); }
      catch (e) { try { console.warn("[cookbookSchedule]", e); } catch (_) {} }
    };
  }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  // 缓存的 ui.js showToast 函数句柄。延迟绑定在首次使用时，因为 ui.js 是 ES 模块
  // —— 除非有其他代码显式暴露它，否则它不在 `window` 上。
  let _toastFn = null;
  async function _getToast() {
    if (_toastFn) return _toastFn;
    try {
      const m = await import("/static/js/ui.js");
      _toastFn = m.default?.showToast || m.showToast || null;
    } catch (_) { _toastFn = null; }
    return _toastFn;
  }
  // 可选参数 opts: {action, onAction, duration, leadingIcon}
  async function toast(msg, opts) {
    const fn = await _getToast();
    if (fn) {
      try { fn(msg, opts); return; } catch (_) {}
    }
    try { console.log("[toast]", msg); } catch (_) {}
  }

  // 缓存的 tasks 模块句柄，用于成功 Toast 的 "Open" 操作直接跳转到 Tasks 标签页中的新任务。
  let _tasksMod = null;
  async function _getTasksMod() {
    if (_tasksMod) return _tasksMod;
    try { _tasksMod = await import("/static/js/tasks.js"); } catch (_) {}
    return _tasksMod;
  }
  async function openTaskInTasksTab(taskId) {
    const m = await _getTasksMod();
    if (m && typeof m.openTasks === "function") {
      try { m.openTasks(taskId); return; } catch (_) {}
    }
    // 最后的回退方案：点击侧边栏 Tasks 按钮。
    document.getElementById("tool-tasks-btn")?.click();
  }

  const DAYS = [
    { k: "MO", l: "Mon", idx: 0 },
    { k: "TU", l: "Tue", idx: 1 },
    { k: "WE", l: "Wed", idx: 2 },
    { k: "TH", l: "Thu", idx: 3 },
    { k: "FR", l: "Fri", idx: 4 },
    { k: "SA", l: "Sat", idx: 5 },
    { k: "SU", l: "Sun", idx: 6 },
  ];
  const WEEKDAYS = new Set(["MO","TU","WE","TH","FR"]);

  // 解析模型标识：从最近的 .memory-item 卡片中获取 —— 这是 cookbook serve UI 使用的
  // 规范容器，模型仓库 ID 存储在 data-repo 上。我们不通过 textContent 获取标题，
  // 因为标题行也包含内联状态标签（"running"、"downloading"）和 "HF ↗" 链接 ——
  // 将所有这些内容一起抓取会把 "Qwen3.5-397B-A17B-AWQ" 这样的干净预设名称变成
  // "Qwen3.5-397B-A17B-AWQ running HF ↗"，这会在 action_cookbook_serve 中
  // 导致预设查找失败。
  function readPanelConfig(arrowBtn) {
    const item = arrowBtn.closest(".memory-item") || arrowBtn.closest(".hwfit-cached-item");
    const panel = arrowBtn.closest(".hwfit-serve-panel");
    const repo = item?.dataset?.repo
      || arrowBtn.closest(".hwfit-serve-panel")?.dataset?.repo
      || "";
    // 标题 = 仓库 ID 的最后一段（最终 / 后面的部分），这与 cookbook UI 在卡片标题中
    // 渲染的内容完全一致，也是预设注册表使用的简称。例如：
    //   cyankiwi/Qwen3.5-397B-A17B-AWQ → Qwen3.5-397B-A17B-AWQ
    // 对于没有斜杠的 ollama 风格条目，回退到 data-modelName 或原始仓库 ID。
    let title = "";
    if (repo) {
      title = repo.includes("/") ? repo.split("/").pop() : repo;
    }
    if (!title) {
      title = item?.dataset?.modelName || "model";
    }
    return { panel, item, title, repo_id: repo, host: item?.dataset?.host || "" };
  }

  function buildFormHtml(cfg) {
    return `
      <div class="hwfit-schedule-form cookbook-panel">
        <div class="hwfit-schedule-title">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="2"/>
            <line x1="16" y1="2" x2="16" y2="6"/>
            <line x1="8" y1="2" x2="8" y2="6"/>
            <line x1="3" y1="10" x2="21" y2="10"/>
          </svg>
          <span class="hwfit-schedule-title-text">Schedule serve: <strong>${esc(cfg.title)}</strong></span>
          <span class="hwfit-schedule-title-spacer"></span>
          <label class="hwfit-schedule-mirror-toggle" title="Also create a calendar event on the Cookbook calendar">
            <span class="hwfit-schedule-mirror-label">Create event in calendar</span>
            <span class="admin-switch hwfit-schedule-mirror-switch">
              <input type="checkbox" class="hwfit-sched-calendar-mirror" />
              <span class="admin-slider"></span>
            </span>
          </label>
        </div>

        <div class="hwfit-schedule-row hwfit-schedule-when-row">
          <label class="hwfit-schedule-field">
            <span>From</span>
            <input type="time" class="hwfit-sched-start cookbook-field-input" value="09:00" />
          </label>
          <label class="hwfit-schedule-field">
            <span>Until</span>
            <input type="time" class="hwfit-sched-end cookbook-field-input" value="17:00" />
          </label>
          <label class="hwfit-schedule-field hwfit-schedule-days-field">
            <span>Days</span>
            <div class="hwfit-sched-days">
              ${DAYS.map(d => `
                <button type="button" class="hwfit-sched-day-chip${WEEKDAYS.has(d.k) ? " is-on" : ""}" data-day="${d.k}">${d.l}</button>
              `).join("")}
            </div>
          </label>
          <div class="hwfit-schedule-actions-inline">
            <button type="button" class="cookbook-btn hwfit-sched-cancel" title="Cancel">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:5px;flex-shrink:0;"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              <span>Cancel</span>
            </button>
            <button type="button" class="cookbook-btn hwfit-sched-save" title="Save schedule" aria-label="Save schedule">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-1px;margin-right:5px;flex-shrink:0;"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
              <span>Save</span>
            </button>
          </div>
        </div>

        <div class="hwfit-sched-err"></div>
      </div>`;
  }

  function openForm(arrowBtn) {
    const cfg = readPanelConfig(arrowBtn);
    const anchor = cfg.panel
      || cfg.item
      || arrowBtn.closest(".cookbook-saved-item")
      || arrowBtn.parentElement?.parentElement
      || arrowBtn.parentElement;
    if (!anchor) {
      toast("Couldn't find a panel to mount the schedule form");
      return;
    }
    // 切换：如果已存在表单则关闭。
    const existing = anchor.querySelector(".hwfit-schedule-form");
    if (existing) { existing.remove(); return; }
    const tmp = document.createElement("div");
    tmp.innerHTML = buildFormHtml(cfg);
    const form = tmp.firstElementChild;
    anchor.appendChild(form);
    setTimeout(() => {
      try { form.scrollIntoView({ behavior: "smooth", block: "nearest" }); } catch (_) {}
    }, 50);
    wireForm(form, cfg);
  }

  function wireForm(form, cfg) {
    form.querySelectorAll(".hwfit-sched-day-chip").forEach(chip => {
      chip.addEventListener("click", () => chip.classList.toggle("is-on"));
    });
    form.querySelector(".hwfit-sched-cancel").addEventListener("click", () => form.remove());
    form.querySelector(".hwfit-sched-save").addEventListener("click", _safe(async () => {
      const startTime = form.querySelector(".hwfit-sched-start").value;
      const endTime = form.querySelector(".hwfit-sched-end").value;
      const days = Array.from(form.querySelectorAll(".hwfit-sched-day-chip.is-on")).map(c => c.dataset.day);
      const mirrorToCalendar = !!form.querySelector(".hwfit-sched-calendar-mirror")?.checked;
      const errEl = form.querySelector(".hwfit-sched-err");
      errEl.textContent = "";
      errEl.classList.remove("is-visible");

      function fail(msg) {
        errEl.textContent = msg;
        errEl.classList.add("is-visible");
      }
      if (!/^\d\d:\d\d$/.test(startTime) || !/^\d\d:\d\d$/.test(endTime)) {
        return fail("Start and end must be HH:MM");
      }
      if (!days.length) {
        return fail("Pick at least one day");
      }

      const [sh, sm] = startTime.split(":").map(Number);
      const [eh, em] = endTime.split(":").map(Number);
      let dur = (eh * 60 + em) - (sh * 60 + sm);
      if (dur <= 0) dur += 24 * 60;

      // 后端将 scheduled_time 存储为 UTC。用户选择的是本地时间。
      // 如果不转换，UTC+9 时区的 "09:55" 会存储为 09:55 UTC = 18:55 本地时间 →
      // 下次运行显示比预期晚约 9 小时，而非 "5 分钟后"。
      // 与 tasks.js 通过 _localTimeToUtc 辅助函数相同的转换方式。
      const _localHHMMToUtc = (hhmm) => {
        const [h, m] = hhmm.split(":").map(Number);
        const d = new Date();
        d.setHours(h, m, 0, 0);
        return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
      };
      const startUtc = _localHHMMToUtc(startTime);
      const [shUtc, smUtc] = startUtc.split(":").map(Number);

      const allDays = days.length === 7;
      const weekdaysOnly = days.length === 5 && ["MO","TU","WE","TH","FR"].every(d => days.includes(d));
      const sched = {};
      if (allDays) {
        sched.schedule = "daily";
        sched.scheduled_time = startUtc;
      } else if (weekdaysOnly) {
        sched.schedule = "cron";
        sched.cron_expression = `${smUtc} ${shUtc} * * 1-5`;
      } else if (days.length === 1) {
        const dayIdx = DAYS.find(d => d.k === days[0]).idx;
        sched.schedule = "weekly";
        sched.scheduled_time = startUtc;
        sched.scheduled_day = dayIdx;
      } else {
        const dayNum = days.map(k => {
          const i = DAYS.find(d => d.k === k).idx;
          return i === 6 ? 0 : i + 1;
        });
        sched.schedule = "cron";
        sched.cron_expression = `${smUtc} ${shUtc} * * ${dayNum.join(",")}`;
      }

      // 名称："Serve: <完整模型名称>" —— 从 .memory-item-title 获取，确保是用户看到的显示名称
      // （例如 "Qwen3.5-397B-A17B-AWQ"），而非像 "model" 这样的占位符。
      const fullName = (cfg.title || cfg.repo_id || "").trim() || "model";
      const payload = {
        name: `Serve: ${fullName}`,
        task_type: "action",
        action: "cookbook_serve",
        trigger_type: "schedule",
        prompt: JSON.stringify({
          preset: fullName,
          repo_id: cfg.repo_id || "",
          host: cfg.host || "",
          end_after_min: dur,
        }),
        ...sched,
      };
      const saveBtn = form.querySelector(".hwfit-sched-save");
      saveBtn.disabled = true;
      saveBtn.textContent = "Saving…";
      try {
        const r = await fetch("/api/tasks", {
          method: "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await r.json();
        if (!r.ok || data.error) {
          fail(data.error || data.detail || `HTTP ${r.status}`);
          saveBtn.disabled = false;
          saveBtn.textContent = "Save schedule";
          toast(`Schedule save failed: ${data.error || data.detail || r.status}`);
          return;
        }
        if (mirrorToCalendar) {
          // 同步到专用的 "Cookbook" 日历，这样用户可以在日历 UI 中将整组服务
          // 作为单元整体开启/关闭。尽力而为：如果这里的任何操作失败，我们仍认为
          // 任务创建是成功的（任务本身无论如何都可以工作）。
          try {
            const calsRes = await fetch("/api/calendar/calendars", { credentials: "same-origin" });
            const calsBody = calsRes.ok ? await calsRes.json() : {};
            let cookbookCal = (calsBody.calendars || []).find(c => (c.name || "").toLowerCase() === "cookbook");
            if (!cookbookCal) {
              const mk = await fetch("/api/calendar/calendars?name=Cookbook&color=%233b82f6", {
                method: "POST", credentials: "same-origin",
              });
              if (mk.ok) {
                const mkData = await mk.json();
                // 创建端点返回 {ok, id, name, color}；列表端点返回
                // {href, name, color}。两者一一对应（href === id），因此我们合成相同的结构。
                cookbookCal = { href: mkData.id, name: mkData.name, color: mkData.color };
              }
            }
            // `cookbook_task_id:` 标记独占一行，让 calendar.js 的事件表单代码
            // 可以检测到此事件是从 Cookbook 定时任务创建的，并在描述旁边渲染
            // "Open task" 按钮，以便用户可以从日历 UI 直接跳转到源任务。
            const evBody = {
              summary: payload.name,
              dtstart: new Date().toISOString(),
              dtend: new Date(Date.now() + dur * 60 * 1000).toISOString(),
              all_day: false,
              description: `Auto-mirrored from Cookbook schedule task ${data.id || ""}.\n`
                + `Edit/delete the task in the Tasks tab — this event will follow.\n`
                + `cookbook_task_id: ${data.id || ""}`,
              rrule: weekdaysOnly
                ? "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR"
                : (sched.schedule === "weekly" ? `FREQ=WEEKLY;BYDAY=${days.join(",")}`
                  : (sched.schedule === "daily" ? "FREQ=DAILY" : "FREQ=WEEKLY")),
              color: "#3b82f6",
            };
            if (cookbookCal?.href) evBody.calendar_href = cookbookCal.href;
            const evRes = await fetch("/api/calendar/events", {
              method: "POST", credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(evBody),
            });
            const evData = evRes.ok ? await evRes.json() : null;
            // 将事件 uid + 日历 href 存储到任务的 prompt JSON 中，以便任务删除钩子
            // 可以级联清理日历事件。使用更新后的 prompt 来 PATCH 任务。
            if (evData && (evData.uid || evData.id)) {
              const eventUid = evData.uid || evData.id;
              try {
                const updatedPrompt = JSON.stringify({
                  ...JSON.parse(payload.prompt),
                  cookbook_event_uid: eventUid,
                  cookbook_event_calendar: cookbookCal?.href || "",
                });
                // /api/tasks/{id} 支持 PUT 而非 PATCH —— 在此发送 PATCH
                // 会静默失败（该路由上没有此方法），因此任务从未获得
                // cookbook_event_uid 标记，服务器端的删除级联在用户之后
                // 删除任务时没有可跟踪的内容。
                await fetch(`/api/tasks/${encodeURIComponent(data.id)}`, {
                  method: "PUT", credentials: "same-origin",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ prompt: updatedPrompt }),
                });
              } catch (_) {}
            }
          } catch (_) {}
        }
        form.remove();
        const newTaskId = data.id || data.task_id || "";
        toast(`Created task: Serve: ${fullName}`, {
          leadingIcon: "check",
          action: "Open",
          duration: 5000,
          onAction: () => openTaskInTasksTab(newTaskId),
        });
      } catch (e) {
        fail(String(e));
        saveBtn.disabled = false;
        saveBtn.textContent = "Save schedule";
        toast(`Schedule save failed: ${e}`);
      }
    }));
  }

  document.addEventListener("click", _safe((e) => {
    const arrow = e.target.closest && e.target.closest(".hwfit-serve-schedule-arrow");
    if (!arrow) return;
    e.preventDefault();
    e.stopPropagation();
    openForm(arrow);
  }));
})(); } catch (e) { try { console.warn("[cookbookSchedule] top-level error:", e); } catch (_) {} }
