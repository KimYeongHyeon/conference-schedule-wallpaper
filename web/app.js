(() => {
  "use strict";

  const STORAGE_KEY = "schedule-wallpaper-app:v3";
  const LEGACY_KEYS = ["schedule-wallpaper-app:v2", "schedule-wallpaper-app:v1"];
  const MAX_PERSONAL = 8;
  const MAX_CONFERENCE = 7;
  const WIDTH = 1920;
  const HEIGHT = 1080;
  const DAILY_RECHECK_MS = 60 * 60 * 1000;
  const SOURCE_URL = "https://paperswithcode.co/ai-deadlines";
  const LEFT_PANEL = { x: 64, y: 60, w: 710, h: 960 };

  const BUILTIN_CONFERENCES = [
    { shortName: "WACV", year: 2027, deadlineAt: "2026-08-29T11:59:59Z", label: "Round 2 Paper Submissions", type: "submission", timezone: "AoE", url: "https://wacv.thecvf.com/" },
    { shortName: "EMNLP", year: 2026, deadlineAt: "2026-08-31T11:59:59Z", label: "Camera-ready deadline", type: "camera_ready", timezone: "AoE", url: "https://2026.emnlp.org/" },
    { shortName: "ICDM", year: 2026, deadlineAt: "2026-09-10T11:59:59Z", label: "Camera Ready Deadline", type: "camera_ready", timezone: "AoE", url: "https://icdm2026.neu.edu.cn/" },
    { shortName: "NeurIPS", year: 2026, deadlineAt: "2026-09-25T11:59:59Z", label: "Author notification", type: "notification", timezone: "AoE", url: "https://neurips.cc/" },
    { shortName: "NAACL", year: 2027, deadlineAt: "2026-10-13T11:59:59Z", label: "Paper Submission", type: "submission", timezone: "AoE", url: "https://naacl.org/" },
    { shortName: "CEC", year: 2027, deadlineAt: "2027-01-16T11:59:59Z", label: "Paper submission deadline", type: "submission", timezone: "AoE", url: "https://wcci2027.org/" }
  ];

  const defaultState = {
    title: "내 일정",
    subtitle: "PERSONAL · THIS WEEK",
    accent: "#2563eb",
    dim: 8,
    backgroundDataUrl: "",
    backgroundName: "",
    backgroundColor: "",
    selectedScreenIDs: [],
    events: []
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const elements = {
    canvas: $("#wallpaperCanvas"),
    canvasShell: $("#canvasShell"),
    addEvent: $("#addEventButton"),
    refreshConference: $("#refreshConferenceButton"),
    conferenceStatus: $("#conferenceStatus"),
    backgroundButton: $("#backgroundButton"),
    backgroundInput: $("#backgroundInput"),
    backgroundLabel: $("#backgroundLabel"),
    clearBackground: $("#clearBackgroundButton"),
    backgroundDialog: $("#backgroundDialog"),
    backgroundForm: $("#backgroundForm"),
    backgroundColorInput: $("#backgroundColorInput"),
    backgroundColorValue: $("#backgroundColorValue"),
    cancelBackground: $("#cancelBackgroundButton"),
    applyWallpaper: $("#applyWallpaperButton"),
    restoreWallpaper: $("#restoreWallpaperButton"),
    screenDialog: $("#screenDialog"),
    screenForm: $("#screenForm"),
    screenDialogTitle: $("#screenDialogTitle"),
    screenDialogDescription: $("#screenDialogDescription"),
    screenList: $("#screenList"),
    selectAllScreens: $("#selectAllScreensButton"),
    selectedScreenCount: $("#selectedScreenCount"),
    screenSelectionError: $("#screenSelectionError"),
    confirmScreen: $("#confirmScreenButton"),
    cancelScreen: $("#cancelScreenButton"),
    download: $("#downloadButton"),
    fullscreen: $("#fullscreenButton"),
    saveStatus: $("#saveStatus"),
    warning: $("#renderWarning"),
    toast: $("#toast"),
    eventDialog: $("#eventDialog"),
    eventForm: $("#eventForm"),
    eventDialogTitle: $("#eventDialogTitle"),
    eventDateTop: $("#eventDateTop"),
    eventDateBottom: $("#eventDateBottom"),
    eventTitle: $("#eventTitle"),
    eventNote: $("#eventNote"),
    deleteEvent: $("#deleteEventButton"),
    moveUp: $("#moveUpButton"),
    moveDown: $("#moveDownButton"),
    cancelEvent: $("#cancelEventButton"),
    titleDialog: $("#titleDialog"),
    titleForm: $("#titleForm"),
    wallpaperTitle: $("#wallpaperTitle"),
    wallpaperSubtitle: $("#wallpaperSubtitle"),
    cancelTitle: $("#cancelTitleButton")
  };

  const ctx = elements.canvas.getContext("2d");
  let state = loadState();
  let conferenceItems = BUILTIN_CONFERENCES.slice();
  let conferenceMeta = { source: "snapshot", fetchedAt: "2026-08-25T00:00:00+09:00" };
  let backgroundImage = null;
  let activeEventIndex = -1;
  let renderToken = 0;
  let saveTimer = 0;
  let toastTimer = 0;
  let nativeActionTimer = 0;
  let lastRenderError = "";
  let activeWallpaperAction = "apply";
  let availableScreens = [];

  function cloneDefault() {
    return JSON.parse(JSON.stringify(defaultState));
  }

  function normalizeBackgroundColor(value) {
    const color = String(value || "").trim();
    return /^#[0-9a-f]{6}$/i.test(color) ? color.toUpperCase() : "";
  }

  function loadState() {
    try {
      const current = localStorage.getItem(STORAGE_KEY);
      if (current) {
        const parsed = JSON.parse(current);
        return {
          ...cloneDefault(),
          ...parsed,
          backgroundColor: normalizeBackgroundColor(parsed.backgroundColor),
          selectedScreenIDs: Array.isArray(parsed.selectedScreenIDs) ? parsed.selectedScreenIDs.filter(value => typeof value === "string") : [],
          events: Array.isArray(parsed.events) ? parsed.events.slice(0, MAX_PERSONAL) : []
        };
      }
      for (const key of LEGACY_KEYS) {
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const legacy = JSON.parse(raw);
        return {
          ...cloneDefault(),
          accent: typeof legacy.accent === "string" ? legacy.accent : defaultState.accent,
          dim: Number.isFinite(Number(legacy.dim)) ? Math.min(45, Number(legacy.dim)) : defaultState.dim,
          backgroundDataUrl: typeof legacy.backgroundDataUrl === "string" ? legacy.backgroundDataUrl : "",
          backgroundName: typeof legacy.backgroundName === "string" ? legacy.backgroundName : "",
          backgroundColor: ""
        };
      }
    } catch (error) {
      console.error("저장된 데이터를 읽지 못했습니다.", error);
    }
    return cloneDefault();
  }

  function saveState() {
    clearTimeout(saveTimer);
    elements.saveStatus.textContent = "저장 중";
    elements.saveStatus.classList.add("saving");
    saveTimer = window.setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        elements.saveStatus.textContent = "자동 저장됨";
        elements.saveStatus.classList.remove("saving");
      } catch (error) {
        console.error("일정을 저장하지 못했습니다.", error);
        elements.saveStatus.textContent = "저장 실패";
        elements.saveStatus.classList.remove("saving");
        showToast("배경 이미지가 너무 커서 저장하지 못했습니다.", true);
      }
    }, 160);
  }

  function updateState(mutator) {
    mutator(state);
    syncUI();
    saveState();
    renderWallpaper();
  }

  function syncUI() {
    if (elements.backgroundLabel) {
      elements.backgroundLabel.textContent = state.backgroundName || (state.backgroundColor ? `단색 ${state.backgroundColor}` : "밝은 기본 배경");
    }
    elements.addEvent.disabled = state.events.length >= MAX_PERSONAL;
  }

  function nativeWallpaperHandler() {
    return window.webkit?.messageHandlers?.wallpaper || null;
  }

  function syncNativeCapabilities() {
    const available = Boolean(nativeWallpaperHandler());
    elements.applyWallpaper.hidden = !available;
    elements.restoreWallpaper.hidden = !available;
  }

  function setNativeActionPending(action, pending) {
    for (const button of [elements.applyWallpaper, elements.restoreWallpaper]) button.disabled = pending;
    elements.applyWallpaper.setAttribute("aria-busy", String(pending && action === "apply"));
    elements.restoreWallpaper.setAttribute("aria-busy", String(pending && action === "restore"));
  }

  function requestScreenSelection(action) {
    activeWallpaperAction = action;
    postNativeWallpaperAction("list", "", [], action);
  }

  function normalizeScreenList(value) {
    if (!Array.isArray(value)) return [];
    return value.flatMap(item => {
      const id = String(item?.id || "").trim();
      const name = String(item?.name || "").trim();
      if (!id || !name) return [];
      return [{ id, name, resolution: String(item.resolution || ""), isCurrent: Boolean(item.isCurrent) }];
    });
  }

  function openScreenDialog(screens) {
    availableScreens = normalizeScreenList(screens);
    if (!availableScreens.length) {
      showToast("연결된 모니터를 찾지 못했습니다.", true);
      return;
    }

    const availableIDs = new Set(availableScreens.map(screen => screen.id));
    const savedIDs = state.selectedScreenIDs.filter(id => availableIDs.has(id));
    const selectedIDs = new Set(savedIDs.length ? savedIDs : availableScreens.map(screen => screen.id));
    elements.screenList.replaceChildren();

    for (const screen of availableScreens) {
      const option = document.createElement("label");
      option.className = `screen-option${selectedIDs.has(screen.id) ? " selected" : ""}`;

      const icon = document.createElement("span");
      icon.className = "screen-option-icon";
      icon.setAttribute("aria-hidden", "true");
      icon.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 5h16v12H4zM8 21h8M12 17v4"/></svg>';

      const copy = document.createElement("span");
      copy.className = "screen-option-copy";
      const title = document.createElement("strong");
      title.textContent = screen.name;
      if (screen.isCurrent) {
        const badge = document.createElement("span");
        badge.className = "screen-current-badge";
        badge.textContent = "CURRENT";
        title.append(" ", badge);
      }
      const details = document.createElement("small");
      details.textContent = screen.resolution || "연결된 디스플레이";
      copy.append(title, details);

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.name = "screen";
      checkbox.value = screen.id;
      checkbox.checked = selectedIDs.has(screen.id);
      checkbox.setAttribute("aria-label", `${screen.name} 선택`);
      checkbox.addEventListener("change", () => {
        option.classList.toggle("selected", checkbox.checked);
        syncScreenSelectionUI();
      });

      option.append(icon, copy, checkbox);
      elements.screenList.append(option);
    }

    const restoring = activeWallpaperAction === "restore";
    elements.screenDialogTitle.textContent = restoring ? "원래 배경화면 복원" : "적용할 모니터";
    elements.screenDialogDescription.textContent = restoring
      ? "원래 배경으로 되돌릴 화면을 선택하세요."
      : "현재 미리보기를 적용할 화면을 선택하세요.";
    elements.confirmScreen.textContent = restoring ? "선택한 화면 복원" : "선택한 화면에 적용";
    elements.confirmScreen.className = `button ${restoring ? "button-primary" : "button-apply"}`;
    syncScreenSelectionUI();
    elements.screenDialog.showModal();
    requestAnimationFrame(() => elements.screenList.querySelector("input")?.focus());
  }

  function selectedScreenIDs() {
    return [...elements.screenList.querySelectorAll('input[name="screen"]:checked')].map(input => input.value);
  }

  function syncScreenSelectionUI() {
    const count = selectedScreenIDs().length;
    const allSelected = count === availableScreens.length;
    elements.selectedScreenCount.textContent = `${availableScreens.length}개 중 ${count}개 선택`;
    elements.selectAllScreens.textContent = allSelected ? "전체 해제" : "모두 선택";
    elements.confirmScreen.disabled = count === 0;
    elements.screenSelectionError.hidden = count > 0;
  }

  function selectAllScreens() {
    const checkboxes = [...elements.screenList.querySelectorAll('input[name="screen"]')];
    const shouldSelect = checkboxes.some(input => !input.checked);
    for (const checkbox of checkboxes) {
      checkbox.checked = shouldSelect;
      checkbox.closest(".screen-option")?.classList.toggle("selected", shouldSelect);
    }
    syncScreenSelectionUI();
  }

  function submitScreenSelection(event) {
    event.preventDefault();
    const screenIDs = selectedScreenIDs();
    if (!screenIDs.length) {
      elements.screenSelectionError.hidden = false;
      return;
    }
    state.selectedScreenIDs = screenIDs;
    saveState();
    elements.screenDialog.close();
    if (activeWallpaperAction === "restore") restoreOriginalWallpaper(screenIDs);
    else applyWallpaperToDesktop(screenIDs);
  }

  function bindControls() {
    elements.addEvent.addEventListener("click", () => openEventDialog(-1));
    elements.refreshConference.addEventListener("click", () => loadConferenceDeadlines(true));
    elements.backgroundButton.addEventListener("click", openBackgroundDialog);
    elements.backgroundInput.addEventListener("change", handleBackgroundUpload);
    elements.backgroundColorInput.addEventListener("input", syncBackgroundColorValue);
    elements.backgroundForm.addEventListener("submit", applyBackgroundColor);
    elements.cancelBackground.addEventListener("click", () => elements.backgroundDialog.close());
    elements.clearBackground.addEventListener("click", () => {
      backgroundImage = null;
      elements.backgroundInput.value = "";
      updateState(s => { s.backgroundDataUrl = ""; s.backgroundName = ""; s.backgroundColor = ""; });
      elements.backgroundDialog.close();
      showToast("기본 밝은 배경으로 돌아왔습니다.");
    });
    elements.applyWallpaper.addEventListener("click", () => requestScreenSelection("apply"));
    elements.restoreWallpaper.addEventListener("click", () => requestScreenSelection("restore"));
    window.addEventListener("schedule-wallpaper:native-result", handleNativeWallpaperResult);
    elements.download.addEventListener("click", downloadWallpaper);
    elements.fullscreen.addEventListener("click", toggleFullscreen);
    elements.canvas.addEventListener("dblclick", handleCanvasDoubleClick);
    elements.canvas.addEventListener("mousemove", handleCanvasPointerMove);
    elements.canvas.addEventListener("mouseleave", () => { elements.canvas.style.cursor = "default"; });
    elements.canvasShell.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openEventDialog(-1);
      }
    });

    elements.eventForm.addEventListener("submit", saveEventFromDialog);
    elements.cancelEvent.addEventListener("click", () => elements.eventDialog.close());
    elements.deleteEvent.addEventListener("click", deleteActiveEvent);
    elements.moveUp.addEventListener("click", () => moveActiveEvent(-1));
    elements.moveDown.addEventListener("click", () => moveActiveEvent(1));
    elements.titleForm.addEventListener("submit", saveTitleFromDialog);
    elements.cancelTitle.addEventListener("click", () => elements.titleDialog.close());
    elements.screenForm.addEventListener("submit", submitScreenSelection);
    elements.cancelScreen.addEventListener("click", () => elements.screenDialog.close());
    elements.selectAllScreens.addEventListener("click", selectAllScreens);
    document.querySelectorAll("[data-dialog-cancel]").forEach(button => {
      button.addEventListener("click", () => button.closest("dialog")?.close());
    });
    for (const dialog of [elements.backgroundDialog, elements.screenDialog, elements.eventDialog, elements.titleDialog]) {
      dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
    }
  }

  function syncBackgroundColorValue() {
    const color = normalizeBackgroundColor(elements.backgroundColorInput.value) || "#F7F4ED";
    elements.backgroundColorValue.textContent = color;
  }

  function openBackgroundDialog() {
    const color = state.backgroundColor || "#F7F4ED";
    elements.backgroundColorInput.value = color;
    syncBackgroundColorValue();
    elements.backgroundDialog.showModal();
    requestAnimationFrame(() => elements.backgroundColorInput.focus());
  }

  function applyBackgroundColor(event) {
    event.preventDefault();
    const color = normalizeBackgroundColor(elements.backgroundColorInput.value);
    if (!color) return showToast("유효한 색상을 선택해 주세요.", true);
    backgroundImage = null;
    elements.backgroundInput.value = "";
    updateState(s => { s.backgroundDataUrl = ""; s.backgroundName = ""; s.backgroundColor = color; });
    elements.backgroundDialog.close();
    showToast(`단색 ${color}을 적용했습니다.`);
  }

  function pointOnCanvas(event) {
    const rect = elements.canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * WIDTH / rect.width,
      y: (event.clientY - rect.top) * HEIGHT / rect.height
    };
  }

  function personalHit(point) {
    const inside = point.x >= LEFT_PANEL.x && point.x <= LEFT_PANEL.x + LEFT_PANEL.w && point.y >= LEFT_PANEL.y && point.y <= LEFT_PANEL.y + LEFT_PANEL.h;
    if (!inside) return { kind: "outside", index: -1 };
    if (point.y <= LEFT_PANEL.y + 225) return { kind: "title", index: -1 };
    for (let index = 0; index < state.events.length; index += 1) {
      const rowY = LEFT_PANEL.y + 258 + index * 82;
      if (point.y >= rowY - 12 && point.y <= rowY + 68) return { kind: "event", index };
    }
    return { kind: "new", index: -1 };
  }

  function handleCanvasDoubleClick(event) {
    const hit = personalHit(pointOnCanvas(event));
    if (hit.kind === "title") return openTitleDialog();
    if (hit.kind === "event") return openEventDialog(hit.index);
    if (hit.kind === "new") return openEventDialog(-1);
    const point = pointOnCanvas(event);
    if (point.x >= 1146 && point.x <= 1856 && point.y >= 60 && point.y <= 1020) {
      showToast("Conference deadlines are synced automatically.");
    }
  }

  function handleCanvasPointerMove(event) {
    const hit = personalHit(pointOnCanvas(event));
    if (hit.kind === "title") elements.canvas.style.cursor = "text";
    else if (hit.kind === "event") elements.canvas.style.cursor = "pointer";
    else if (hit.kind === "new") elements.canvas.style.cursor = state.events.length < MAX_PERSONAL ? "copy" : "not-allowed";
    else elements.canvas.style.cursor = "default";
  }

  const PERSONAL_MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

  function calendarDateParts(value) {
    const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
    return { year, month, day, date };
  }

  function defaultEventDate() {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, "0");
    const day = String(today.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function eventDateInputValue(value) {
    const direct = calendarDateParts(value);
    if (direct) return `${direct.year}-${String(direct.month).padStart(2, "0")}-${String(direct.day).padStart(2, "0")}`;
    const legacy = String(value || "").trim().toUpperCase().match(/^([A-Z]{3})\s+(\d{1,2})$/);
    if (!legacy) return "";
    const monthIndex = PERSONAL_MONTHS.indexOf(legacy[1]);
    const day = Number(legacy[2]);
    if (monthIndex < 0) return "";
    const year = new Date().getFullYear();
    const date = new Date(year, monthIndex, day);
    if (date.getMonth() !== monthIndex || date.getDate() !== day) return "";
    return `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  function personalDateLabel(value) {
    const parts = calendarDateParts(value);
    if (!parts) return String(value || "DATE").toUpperCase();
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "2-digit" }).format(parts.date).toUpperCase();
  }

  function openEventDialog(index) {
    if (index < 0 && state.events.length >= MAX_PERSONAL) return showToast(`내 일정은 최대 ${MAX_PERSONAL}개까지 넣을 수 있습니다.`, true);
    activeEventIndex = index;
    const item = index >= 0 ? state.events[index] : { dateTop: defaultEventDate(), dateBottom: "09:00", title: "", note: "" };
    elements.eventDialogTitle.textContent = index >= 0 ? "내 일정 수정" : "내 일정 추가";
    elements.eventDateTop.value = eventDateInputValue(item.dateTop);
    elements.eventDateBottom.value = item.dateBottom || "";
    elements.eventTitle.value = item.title || "";
    elements.eventNote.value = item.note || "";
    const editing = index >= 0;
    elements.deleteEvent.hidden = !editing;
    elements.moveUp.parentElement.hidden = !editing;
    elements.moveUp.hidden = false;
    elements.moveDown.hidden = false;
    elements.moveUp.disabled = !editing || index === 0;
    elements.moveDown.disabled = !editing || index === state.events.length - 1;
    elements.eventDialog.showModal();
    requestAnimationFrame(() => elements.eventTitle.focus());
  }

  function saveEventFromDialog(event) {
    event.preventDefault();
    const title = elements.eventTitle.value.trim();
    if (!title) {
      elements.eventTitle.focus();
      return showToast("일정 이름을 입력해 주세요.", true);
    }
    const item = {
      dateTop: elements.eventDateTop.value || "",
      dateBottom: elements.eventDateBottom.value.trim().toUpperCase() || "TIME",
      title,
      note: elements.eventNote.value.trim()
    };
    updateState(s => {
      if (activeEventIndex >= 0) s.events[activeEventIndex] = item;
      else s.events.push(item);
    });
    elements.eventDialog.close();
    showToast(activeEventIndex >= 0 ? "일정을 수정했습니다." : "일정을 추가했습니다.");
  }

  function deleteActiveEvent() {
    if (activeEventIndex < 0) return;
    updateState(s => s.events.splice(activeEventIndex, 1));
    elements.eventDialog.close();
    showToast("일정을 삭제했습니다.");
  }

  function moveActiveEvent(direction) {
    const next = activeEventIndex + direction;
    if (activeEventIndex < 0 || next < 0 || next >= state.events.length) return;
    updateState(s => {
      const [item] = s.events.splice(activeEventIndex, 1);
      s.events.splice(next, 0, item);
    });
    activeEventIndex = next;
    elements.moveUp.disabled = next === 0;
    elements.moveDown.disabled = next === state.events.length - 1;
  }

  function openTitleDialog() {
    elements.wallpaperTitle.value = state.title;
    elements.wallpaperSubtitle.value = state.subtitle;
    elements.titleDialog.showModal();
    requestAnimationFrame(() => elements.wallpaperTitle.focus());
  }

  function saveTitleFromDialog(event) {
    event.preventDefault();
    updateState(s => {
      s.title = elements.wallpaperTitle.value.trim() || "내 일정";
      s.subtitle = elements.wallpaperSubtitle.value.trim().toUpperCase() || "PERSONAL · THIS WEEK";
    });
    elements.titleDialog.close();
    showToast("제목을 수정했습니다.");
  }

  function deadlineTypeLabel(type, label = "") {
    const labels = {
      abstract: "Abstract registration",
      paper: "Paper submission",
      submission: "Submission",
      registration: "Registration",
      notification: "Notification",
      camera_ready: "Camera-ready",
      reviewer_registration: "Reviewer registration",
      supplementary: "Supplementary material",
      review_release: "Review release",
      rebuttal_start: "Rebuttal starts",
      rebuttal_end: "Rebuttal ends",
      commitment_deadline: "Commitment deadline"
    };
    if (labels[type]) return labels[type];
    const lower = label.toLowerCase();
    if (lower.includes("abstract")) return "Abstract registration";
    if (lower.includes("registration")) return "Registration";
    if (lower.includes("notification")) return "Notification";
    if (lower.includes("camera")) return "Camera-ready";
    if (lower.includes("submission") || lower.includes("paper")) return "Submission";
    return "Deadline";
  }

  function timezoneLabel(value) {
    const raw = String(value || "UTC").trim();
    if (/^(aoe|anywhere on earth)$/i.test(raw)) return "AoE";
    if (/^(kst|ktc|utc\+?9|asia\/seoul)$/i.test(raw)) return "KST";
    return raw.replace(/^UTC([+-])0?(\d)$/, "UTC$1$2");
  }

  function dDayLabel(value) {
    const target = new Date(value);
    if (!Number.isFinite(target.getTime())) return "D-?";
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const targetDay = new Date(target.getFullYear(), target.getMonth(), target.getDate());
    const days = Math.round((targetDay - today) / 86400000);
    if (days === 0) return "D-DAY";
    return days > 0 ? `D-${days}` : `D+${Math.abs(days)}`;
  }

  function processConferencePayload(payload) {
    if (!payload || !Array.isArray(payload.results)) throw new Error("API 응답에 results 배열이 없습니다.");
    const topTier = payload.results.filter(item => item.tier === "a");
    if (topTier.length < 20) throw new Error(`Top tier 학회 수가 비정상적으로 적습니다: ${topTier.length}`);
    const now = Date.now();
    const items = topTier.flatMap(conference => {
      const deadline = (Array.isArray(conference.deadlines) ? conference.deadlines : [])
        .filter(item => Number.isFinite(Date.parse(item.deadline_at)) && Date.parse(item.deadline_at) > now)
        .sort((a, b) => Date.parse(a.deadline_at) - Date.parse(b.deadline_at))[0];
      if (!deadline) return [];
      return [{
        shortName: conference.short_name || conference.name || "Conference",
        year: conference.year || "",
        deadlineAt: deadline.deadline_at,
        label: deadline.label || deadline.type || "Deadline",
        type: deadline.type || "deadline",
        timezone: deadline.timezone || "UTC",
        url: conference.url || SOURCE_URL
      }];
    }).sort((a, b) => Date.parse(a.deadlineAt) - Date.parse(b.deadlineAt));
    if (!items.length) throw new Error("앞으로 예정된 Top tier 마감이 없습니다.");
    return items.slice(0, MAX_CONFERENCE);
  }

  function formatShortDate(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "DATE";
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "2-digit" }).format(date).toUpperCase();
  }

  function formatSyncTime(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "시각 정보 없음";
    return new Intl.DateTimeFormat("ko-KR", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
  }

  function setConferenceStatus(kind, title, description) {
    elements.conferenceStatus.className = `conference-status ${kind}`;
    elements.conferenceStatus.textContent = `${title} · ${description}`;
  }

  async function loadConferenceDeadlines(manual = false, quiet = false) {
    elements.refreshConference.disabled = true;
    elements.refreshConference.classList.add("loading");
    if (!quiet) setConferenceStatus("loading", "동기화 중", "Top tier deadlines");
    try {
      if (window.location.protocol === "file:") {
        conferenceItems = BUILTIN_CONFERENCES.slice();
        conferenceMeta = { source: "snapshot", fetchedAt: "2026-08-25T00:00:00+09:00" };
        setConferenceStatus("cached", "내장 데이터", "launch.command로 자동 동기화");
        if (manual) showToast("자동 동기화는 launch.command로 앱을 열 때 사용할 수 있습니다.");
      } else {
        const response = await fetch("/api/conference-deadlines", { cache: "no-store" });
        if (!response.ok) throw new Error(`학회 API 프록시 응답 오류: ${response.status}`);
        const envelope = await response.json();
        conferenceItems = processConferencePayload(envelope.data || envelope);
        conferenceMeta = {
          source: envelope.source || "live",
          fetchedAt: envelope.cache_updated_at || envelope.fetched_at || new Date().toISOString()
        };
        const cached = conferenceMeta.source.includes("cache");
        const stale = conferenceMeta.source === "stale-cache";
        setConferenceStatus(stale ? "error" : cached ? "cached" : "live", stale ? "최근 데이터" : cached ? "오늘 데이터" : "오늘 갱신됨", `하루 1회 · ${formatSyncTime(conferenceMeta.fetchedAt)}`);
        if (manual) showToast(stale ? "연결 문제로 최근 정상 데이터를 유지합니다." : "오늘의 학회 데이터를 확인했습니다.");
      }
    } catch (error) {
      console.error("학회 데이터를 불러오지 못했습니다.", error);
      conferenceItems = BUILTIN_CONFERENCES.slice();
      conferenceMeta = { source: "fallback", fetchedAt: "2026-08-25T00:00:00+09:00" };
      setConferenceStatus("error", "동기화 실패", "내장 데이터 표시 중");
      if (manual) showToast("자동 동기화에 실패해 내장 데이터를 표시합니다.", true);
    } finally {
      elements.refreshConference.disabled = false;
      elements.refreshConference.classList.remove("loading");
      renderWallpaper();
    }
  }

  function handleBackgroundUpload(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) return showToast("이미지 파일을 선택해 주세요.", true);
    if (file.size > 12 * 1024 * 1024) return showToast("12MB 이하 이미지를 선택해 주세요.", true);
    const reader = new FileReader();
    reader.onerror = () => showToast("이미지를 읽지 못했습니다.", true);
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => showToast("지원하지 않는 이미지입니다.", true);
      image.onload = () => {
        backgroundImage = image;
        updateState(s => { s.backgroundDataUrl = String(reader.result); s.backgroundName = file.name; s.backgroundColor = ""; });
        elements.backgroundDialog.close();
        showToast("배경 이미지를 적용했습니다.");
      };
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  }

  function loadBackgroundFromState() {
    if (!state.backgroundDataUrl) {
      backgroundImage = null;
      return Promise.resolve();
    }
    return new Promise(resolve => {
      const image = new Image();
      image.onload = () => { backgroundImage = image; resolve(); };
      image.onerror = () => { backgroundImage = null; elements.warning.textContent = "저장된 배경을 읽지 못해 기본 배경을 사용합니다."; resolve(); };
      image.src = state.backgroundDataUrl;
    });
  }

  function drawCoverImage(image) {
    const scale = Math.max(WIDTH / image.naturalWidth, HEIGHT / image.naturalHeight);
    const w = image.naturalWidth * scale;
    const h = image.naturalHeight * scale;
    ctx.drawImage(image, (WIDTH - w) / 2, (HEIGHT - h) / 2, w, h);
    ctx.fillStyle = `rgba(255,255,255,${state.dim / 100})`;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
  }

  function drawDefaultBackground() {
    const gradient = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
    gradient.addColorStop(0, "#fbf8f2");
    gradient.addColorStop(.58, "#f4f8fc");
    gradient.addColorStop(1, "#eaf3ff");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    const blueGlow = ctx.createRadialGradient(1490, 130, 20, 1490, 130, 620);
    blueGlow.addColorStop(0, "rgba(147,197,253,.28)");
    blueGlow.addColorStop(1, "rgba(147,197,253,0)");
    ctx.fillStyle = blueGlow;
    ctx.fillRect(860, 0, 1060, 760);
    const peachGlow = ctx.createRadialGradient(160, 1000, 20, 160, 1000, 530);
    peachGlow.addColorStop(0, "rgba(251,191,148,.22)");
    peachGlow.addColorStop(1, "rgba(251,191,148,0)");
    ctx.fillStyle = peachGlow;
    ctx.fillRect(0, 430, 790, 650);
    ctx.save();
    ctx.globalAlpha = .18;
    ctx.strokeStyle = "#93b4d9";
    ctx.lineWidth = 2;
    for (let index = 0; index < 5; index += 1) {
      ctx.beginPath();
      ctx.arc(1550, 120, 160 + index * 68, .2, 2.2);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawSolidBackground(color) {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
  }

  function roundedRect(x, y, w, h, r) {
    const radius = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  }

  function drawPanelFrame(x, y, w, h) {
    ctx.save();
    ctx.shadowColor = "rgba(68,83,104,.14)";
    ctx.shadowBlur = 42;
    ctx.shadowOffsetY = 16;
    roundedRect(x, y, w, h, 26);
    ctx.fillStyle = "rgba(255,255,255,.88)";
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(100,116,139,.12)";
    ctx.stroke();
    ctx.restore();
  }

  function fitText(text, maxWidth, initialSize, weight = 700) {
    let size = initialSize;
    do {
      ctx.font = `${weight} ${size}px -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", sans-serif`;
      if (ctx.measureText(text).width <= maxWidth) break;
      size -= 1;
    } while (size > 20);
    return size;
  }

  function drawPanelHeader(x, y, w, kicker, title, subtitle, accent) {
    ctx.fillStyle = accent;
    roundedRect(x + 48, y + 48, 36, 7, 4);
    ctx.fill();
    ctx.font = "750 17px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.fillStyle = accent;
    ctx.fillText(kicker, x + 48, y + 92);
    const titleSize = fitText(title, w - 96, 48, 760);
    ctx.font = `760 ${titleSize}px -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", sans-serif`;
    ctx.fillStyle = "#172033";
    ctx.fillText(title, x + 48, y + 152);
    ctx.font = "650 15px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.fillStyle = "#7b8798";
    ctx.fillText(subtitle, x + 48, y + 190);
    ctx.strokeStyle = "rgba(100,116,139,.14)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x + 48, y + 220);
    ctx.lineTo(x + w - 48, y + 220);
    ctx.stroke();
  }

  function drawPersonalPanel() {
    const { x, y, w, h } = LEFT_PANEL;
    drawPanelFrame(x, y, w, h);
    drawPanelHeader(x, y, w, "MY SCHEDULE", state.title || "내 일정", state.subtitle || "PERSONAL · THIS WEEK", state.accent);
    if (!state.events.length) return;
    state.events.slice(0, MAX_PERSONAL).forEach((item, index) => {
      const rowY = y + 258 + index * 82;
      ctx.fillStyle = index === 0 ? state.accent : "rgba(37,99,235,.12)";
      roundedRect(x + 48, rowY + 4, 7, 54, 4);
      ctx.fill();
      ctx.font = "760 16px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.fillStyle = state.accent;
      ctx.fillText(personalDateLabel(item.dateTop), x + 76, rowY + 22);
      ctx.font = "640 14px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.fillStyle = "#8a96a8";
      ctx.fillText((item.dateBottom || "TIME").toUpperCase(), x + 76, rowY + 48);
      ctx.font = `720 ${fitText(item.title || "새 일정", 350, 23, 720)}px -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", sans-serif`;
      ctx.fillStyle = "#172033";
      ctx.fillText(item.title || "새 일정", x + 220, rowY + 23);
      ctx.font = "500 15px -apple-system, BlinkMacSystemFont, \"Apple SD Gothic Neo\", sans-serif";
      ctx.fillStyle = "#7d8999";
      ctx.fillText((item.note || "").slice(0, 42), x + 220, rowY + 49);
    });
  }

  function drawConferencePanel() {
    const x = 1146, y = 60, w = 710, h = 960;
    const accent = "#d97745";
    drawPanelFrame(x, y, w, h);
    drawPanelHeader(x, y, w, "TOP TIER DEADLINES", "학회 데드라인", "", accent);
    conferenceItems.slice(0, MAX_CONFERENCE).forEach((item, index) => {
      const rowY = y + 255 + index * 91;
      ctx.fillStyle = index === 0 ? "rgba(217,119,69,.13)" : "rgba(100,116,139,.06)";
      roundedRect(x + 43, rowY - 7, w - 86, 74, 14);
      ctx.fill();
      ctx.font = "780 17px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.fillStyle = accent;
      ctx.fillText(formatShortDate(item.deadlineAt), x + 61, rowY + 19);
      ctx.font = "700 13px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.fillStyle = "#9a705d";
      ctx.fillText(`${dDayLabel(item.deadlineAt)} · ${timezoneLabel(item.timezone)}`, x + 61, rowY + 45);
      ctx.font = "740 23px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.fillStyle = "#172033";
      ctx.fillText(`${item.shortName} ${item.year}`.trim(), x + 225, rowY + 20);
      ctx.font = "540 14px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.fillStyle = "#7d8999";
      ctx.fillText(deadlineTypeLabel(item.type, item.label), x + 225, rowY + 47);
      ctx.font = "650 12px -apple-system, BlinkMacSystemFont, sans-serif";
      ctx.fillStyle = "#9a705d";
      ctx.textAlign = "right";
      ctx.fillText((item.label || "Deadline").slice(0, 28), x + w - 59, rowY + 20);
      ctx.textAlign = "left";
    });
  }

  function renderWallpaper() {
    const personalSummary = state.events.slice(0, MAX_PERSONAL).map(item =>
      `${personalDateLabel(item.dateTop)}, ${(item.dateBottom || "TIME").toUpperCase()}, ${item.title || "새 일정"}`
    ).join("; ");
    const conferenceSummary = conferenceItems.slice(0, MAX_CONFERENCE).map(item =>
      `${item.shortName} ${item.year}, ${dDayLabel(item.deadlineAt)}, ${timezoneLabel(item.timezone)}, ${deadlineTypeLabel(item.type, item.label)}`
    ).join("; ");
    elements.canvas.setAttribute("aria-label", `일정 배경화면. Personal schedule: ${personalSummary || "none"}. Top tier conference deadlines: ${conferenceSummary}`);
    const token = ++renderToken;
    requestAnimationFrame(() => {
      if (token !== renderToken) return;
      try {
        ctx.clearRect(0, 0, WIDTH, HEIGHT);
        if (backgroundImage) drawCoverImage(backgroundImage);
        else if (state.backgroundColor) drawSolidBackground(state.backgroundColor);
        else drawDefaultBackground();
        drawPersonalPanel();
        drawConferencePanel();
        lastRenderError = "";
        if (elements.warning.textContent.startsWith("미리보기 렌더링")) elements.warning.textContent = "";
      } catch (error) {
        lastRenderError = error instanceof Error ? error.message : String(error);
        elements.warning.textContent = "미리보기 렌더링 오류";
        console.error("미리보기 렌더링에 실패했습니다.", error);
      }
    });
  }

  function canvasLooksRendered() {
    if (lastRenderError) return false;
    try {
      const probe = document.createElement("canvas");
      probe.width = 16;
      probe.height = 9;
      const probeContext = probe.getContext("2d", { willReadFrequently: true });
      if (!probeContext) return false;
      probeContext.drawImage(elements.canvas, 0, 0, probe.width, probe.height);
      const pixels = probeContext.getImageData(0, 0, probe.width, probe.height).data;
      let opaquePixels = 0;
      const colors = new Set();
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index + 3] > 240) opaquePixels += 1;
        colors.add(`${pixels[index] >> 4},${pixels[index + 1] >> 4},${pixels[index + 2] >> 4}`);
      }
      return opaquePixels >= probe.width * probe.height * .95 && colors.size >= 3;
    } catch (error) {
      console.error("미리보기 검증에 실패했습니다.", error);
      return false;
    }
  }

  function downloadWallpaper() {
    renderWallpaper();
    requestAnimationFrame(() => {
      const link = document.createElement("a");
      link.download = `schedule-wallpaper-${new Date().toISOString().slice(0, 10)}.png`;
      link.href = elements.canvas.toDataURL("image/png");
      link.click();
      showToast("1920 × 1080 PNG를 저장했습니다.");
    });
  }

  function postNativeWallpaperAction(action, data = "", screenIDs = [], busyAction = action) {
    const handler = nativeWallpaperHandler();
    if (!handler) {
      showToast("배경화면 직접 적용은 Mac 앱에서 사용할 수 있습니다.", true);
      return;
    }
    setNativeActionPending(busyAction, true);
    clearTimeout(nativeActionTimer);
    nativeActionTimer = window.setTimeout(() => {
      setNativeActionPending(busyAction, false);
      showToast("macOS가 응답하지 않았습니다. 다시 시도해 주세요.", true);
    }, 10000);
    try {
      handler.postMessage({ action, data, screenIDs });
    } catch (error) {
      clearTimeout(nativeActionTimer);
      setNativeActionPending(busyAction, false);
      console.error("macOS 배경화면 요청을 보내지 못했습니다.", error);
      showToast("배경화면 요청을 보내지 못했습니다.", true);
    }
  }

  function applyWallpaperToDesktop(screenIDs) {
    renderWallpaper();
    requestAnimationFrame(() => {
      if (!canvasLooksRendered()) {
        showToast("미리보기가 완성되지 않아 배경화면을 적용하지 않았습니다.", true);
        return;
      }
      postNativeWallpaperAction("apply", elements.canvas.toDataURL("image/png"), screenIDs);
    });
  }

  function restoreOriginalWallpaper(screenIDs) {
    postNativeWallpaperAction("restore", "", screenIDs);
  }

  function handleNativeWallpaperResult(event) {
    const detail = event.detail || {};
    if (detail.action === "list") {
      clearTimeout(nativeActionTimer);
      setNativeActionPending(activeWallpaperAction, false);
      if (detail.ok) openScreenDialog(detail.screens);
      else showToast(detail.message || "모니터 목록을 불러오지 못했습니다.", true);
      return;
    }
    if (!["apply", "restore"].includes(detail.action)) return;
    clearTimeout(nativeActionTimer);
    setNativeActionPending(detail.action, false);
    showToast(detail.message || (detail.ok ? "배경화면을 변경했습니다." : "배경화면을 변경하지 못했습니다."), !detail.ok);
  }

  async function toggleFullscreen() {
    try {
      if (!document.fullscreenElement) await elements.canvasShell.requestFullscreen();
      else await document.exitFullscreen();
    } catch (error) {
      console.error("전체 화면 전환에 실패했습니다.", error);
      showToast("이 브라우저에서는 전체 화면을 열 수 없습니다.", true);
    }
  }

  function showToast(message, isError = false) {
    clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.className = `toast show${isError ? " error" : ""}`;
    toastTimer = window.setTimeout(() => { elements.toast.className = "toast"; }, 2600);
  }

  async function init() {
    syncNativeCapabilities();
    bindControls();
    syncUI();
    await loadBackgroundFromState();
    renderWallpaper();
    await loadConferenceDeadlines();
    window.setInterval(() => loadConferenceDeadlines(false, true), DAILY_RECHECK_MS);
  }

  init();
})();
