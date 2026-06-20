/* Alarm app with local storage, notifications, snooze, and recurring days. */
(function () {
  "use strict";

  const STORAGE_KEY = "budilnik.alarms.v1";
  const THEME_KEY = "budilnik.theme.v1";
  const WEEKDAYS = [
    { id: 1, short: "Пн", long: "Понедельник" },
    { id: 2, short: "Вт", long: "Вторник" },
    { id: 3, short: "Ср", long: "Среда" },
    { id: 4, short: "Чт", long: "Четверг" },
    { id: 5, short: "Пт", long: "Пятница" },
    { id: 6, short: "Сб", long: "Суббота" },
    { id: 0, short: "Вс", long: "Воскресенье" }
  ];

  const MELODIES = [
    { id: "classic", label: "Классика" },
    { id: "digital", label: "Цифровая" },
    { id: "soft", label: "Мягкая" }
  ];

  const REPEAT_OPTIONS = [
    { value: 0, label: "Один раз" },
    { value: 5, label: "Каждые 5 сек" },
    { value: 10, label: "Каждые 10 сек" },
    { value: 15, label: "Каждые 15 сек" }
  ];

  const SNOOZE_OPTIONS = [5, 10, 15];

  const state = {
    alarms: loadAlarms(),
    theme: localStorage.getItem(THEME_KEY) || "dark",
    modal: null,
    deleteId: null,
    ringId: null,
    formError: "",
    notificationPermission: typeof Notification !== "undefined" ? Notification.permission : "unsupported",
    leavingId: null
  };

  const dom = {
    app: document.getElementById("app")
  };

  let ticker = null;
  let audioContext = null;
  let activeNode = null;
  let activeGain = null;
  let soundInterval = null;
  let stopTimeout = null;

  init();

  function init() {
    applyTheme(state.theme);
    bindGlobalEvents();
    registerServiceWorker();
    startTicker();
    render();
    tick();
  }

  function bindGlobalEvents() {
    document.addEventListener("click", handleClick);
    document.addEventListener("input", handleInput);
    document.addEventListener("change", handleChange);
    document.addEventListener("submit", handleSubmit);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) tick();
    });
  }

  function loadAlarms() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function saveAlarms() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.alarms));
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }

  function render() {
    dom.app.innerHTML = `
      <section class="screen">
        ${renderHeader()}
        ${renderNotice()}
        ${renderAlarmList()}
      </section>
      <button class="floating-button" data-action="open-create" aria-label="Создать новый будильник">+</button>
      ${state.modal ? renderModal() : ""}
      ${state.deleteId ? renderDeleteConfirm() : ""}
      ${state.ringId ? renderRingingScreen() : ""}
    `;
  }

  function renderHeader() {
    const themeLabel = state.theme === "dark" ? "Светлая тема" : "Тёмная тема";
    return `
      <header class="topbar">
        <div class="title-wrap">
          <div class="eyebrow">Простое приложение</div>
          <h1 class="title">Будильники</h1>
        </div>
        <div class="toolbar">
          <button class="icon-button" data-action="toggle-theme" aria-label="${themeLabel}">☼</button>
          <button class="icon-button" data-action="request-notifications" aria-label="Включить уведомления">🔔</button>
        </div>
      </header>
    `;
  }

  function renderNotice() {
    const permissionText = {
      granted: "Уведомления включены.",
      denied: "Уведомления отключены в браузере.",
      default: "Включите уведомления, чтобы не пропускать срабатывания.",
      unsupported: "Этот браузер не поддерживает уведомления."
    }[state.notificationPermission] || "";

    return `
      <section class="panel notice">
        <div>
          <strong>Локальные уведомления</strong>
          <p>${escapeHtml(permissionText)}</p>
        </div>
        <button class="secondary-button" data-action="request-notifications">Разрешить</button>
      </section>
    `;
  }

  function renderAlarmList() {
    if (!state.alarms.length) {
      return `
        <section class="panel empty-state">
          <strong>Пока нет будильников</strong>
          <div>Создайте первый будильник через кнопку “+”.</div>
        </section>
      `;
    }

    const sorted = [...state.alarms].sort((a, b) => a.time.localeCompare(b.time));

    return `
      <section class="alarm-list" aria-label="Список будильников">
        ${sorted.map(renderAlarmCard).join("")}
      </section>
    `;
  }

  function renderAlarmCard(alarm) {
    const weekdaysText = describeWeekdays(alarm.days);
    const isLeaving = state.leavingId === alarm.id;
    return `
      <article class="alarm-card ${isLeaving ? "is-leaving" : ""}" data-alarm-card="${alarm.id}">
        <div class="alarm-main">
          <div class="alarm-row">
            <div>
              <div class="alarm-time">${escapeHtml(formatTime(alarm.time))}</div>
            </div>
            <div class="alarm-meta">
              <h2 class="alarm-title">${escapeHtml(alarm.title || "Без названия")}</h2>
              <div class="alarm-days">${escapeHtml(weekdaysText)}</div>
            </div>
          </div>
          <div class="alarm-actions">
            <label class="switch" aria-label="Включить или выключить будильник">
              <input type="checkbox" data-action="toggle-alarm" data-id="${alarm.id}" ${alarm.enabled ? "checked" : ""} />
              <span class="switch-ui"></span>
              <span>${alarm.enabled ? "Включён" : "Выключен"}</span>
            </label>
            <div class="card-buttons">
              <button class="secondary-button" data-action="edit-alarm" data-id="${alarm.id}">Редактировать</button>
              <button class="danger-button" data-action="delete-alarm" data-id="${alarm.id}">Удалить</button>
            </div>
          </div>
        </div>
      </article>
    `;
  }

  function renderModal() {
    const isEdit = state.modal.mode === "edit";
    const draft = state.modal.draft;

    return `
      <div class="modal-backdrop">
        <section class="modal" role="dialog" aria-modal="true" aria-label="${isEdit ? "Редактирование будильника" : "Создание будильника"}">
          <div class="modal-header">
            <div>
              <div class="eyebrow">${isEdit ? "Редактирование" : "Новый будильник"}</div>
              <h2 class="modal-title">${isEdit ? "Изменить будильник" : "Создать будильник"}</h2>
            </div>
            <button class="icon-button" data-action="close-modal" aria-label="Закрыть">✕</button>
          </div>
          <form id="alarm-form" class="modal-body">
            <div class="form-grid">
              <div class="field">
                <label for="alarm-time">Время</label>
                <input id="alarm-time" name="time" type="time" value="${escapeAttr(draft.time)}" />
              </div>

              <div class="field">
                <label for="alarm-title">Название</label>
                <input id="alarm-title" name="title" type="text" maxlength="48" placeholder="Например, Подъём" value="${escapeAttr(draft.title)}" />
              </div>

              <div class="field">
                <span>Дни недели</span>
                <div class="day-grid">
                  ${WEEKDAYS.map((day) => `
                    <button type="button" class="chip-button ${draft.days.includes(day.id) ? "is-active" : ""}" data-action="toggle-day" data-day="${day.id}">
                      ${day.short}
                    </button>
                  `).join("")}
                </div>
                <div class="hint">Если дни не выбраны, будильник сработает один раз.</div>
              </div>

              <div class="field">
                <label for="alarm-melody">Мелодия</label>
                <select id="alarm-melody" name="melody">
                  ${MELODIES.map((item) => `<option value="${item.id}" ${item.id === draft.melody ? "selected" : ""}>${item.label}</option>`).join("")}
                </select>
              </div>

              <div class="field">
                <label for="alarm-volume">Громкость</label>
                <div class="range-row">
                  <input id="alarm-volume" name="volume" type="range" min="0" max="100" step="1" value="${escapeAttr(String(draft.volume))}" />
                  <div class="helper-row">
                    <span class="tiny-note">Текущая громкость: <strong>${draft.volume}%</strong></span>
                  </div>
                </div>
              </div>

              <div class="field">
                <label class="switch">
                  <input id="alarm-vibration" name="vibration" type="checkbox" ${draft.vibration ? "checked" : ""} />
                  <span class="switch-ui"></span>
                  <span>Вибрация</span>
                </label>
              </div>

              <div class="field">
                <label for="alarm-repeat">Повтор сигнала</label>
                <select id="alarm-repeat" name="repeatSignal">
                  ${REPEAT_OPTIONS.map((item) => `<option value="${item.value}" ${Number(item.value) === Number(draft.repeatSignal) ? "selected" : ""}>${item.label}</option>`).join("")}
                </select>
              </div>

              <div class="field">
                <label for="alarm-snooze">Отложить на</label>
                <select id="alarm-snooze" name="snoozeMinutes">
                  ${SNOOZE_OPTIONS.map((minutes) => `<option value="${minutes}" ${Number(minutes) === Number(draft.snoozeMinutes) ? "selected" : ""}>${minutes} минут</option>`).join("")}
                </select>
              </div>

              ${state.formError ? `<div class="error">${escapeHtml(state.formError)}</div>` : ""}
            </div>
          </form>
          <div class="form-actions">
            <button type="button" class="secondary-button" data-action="close-modal">Отмена</button>
            <button type="submit" class="primary-button" form="alarm-form">Сохранить</button>
          </div>
        </section>
      </div>
    `;
  }

  function renderDeleteConfirm() {
    const alarm = state.alarms.find((item) => item.id === state.deleteId);
    if (!alarm) return "";

    return `
      <div class="confirm-backdrop">
        <section class="confirm-card" role="dialog" aria-modal="true" aria-label="Удаление будильника">
          <div class="confirm-header">
            <div>
              <div class="eyebrow">Подтверждение</div>
              <h2 class="confirm-title">Удалить этот будильник?</h2>
            </div>
            <button class="icon-button" data-action="close-delete" aria-label="Закрыть">✕</button>
          </div>
          <div class="confirm-body">
            <p class="hint">${escapeHtml(formatTime(alarm.time))} · ${escapeHtml(alarm.title || "Без названия")}</p>
          </div>
          <div class="confirm-actions">
            <button class="secondary-button" data-action="close-delete">Отмена</button>
            <button class="danger-button" data-action="confirm-delete">Удалить</button>
          </div>
        </section>
      </div>
    `;
  }

  function renderRingingScreen() {
    const alarm = state.alarms.find((item) => item.id === state.ringId);
    if (!alarm) return "";

    return `
      <div class="ringing-backdrop">
        <section class="ringing-card" role="dialog" aria-modal="true" aria-label="Будильник сработал">
          <div class="ringing-header">
            <div>
              <div class="eyebrow">Сигнал</div>
              <h2 class="confirm-title">Будильник</h2>
            </div>
            <div class="tiny-note">Не откладывайте важное</div>
          </div>
          <div class="ringing-stage">
            <div class="ringing-hero" aria-hidden="true"><span>⏰</span></div>
            <p class="ringing-time">${escapeHtml(formatTime(alarm.time))}</p>
            <p class="ringing-name">${escapeHtml(alarm.title || "Без названия")}</p>
          </div>
          <div class="ringing-actions">
            <button class="primary-button" data-action="snooze-alarm" data-snooze="5">Отложить</button>
            <button class="secondary-button" data-action="snooze-alarm" data-snooze="10">Отложить 10 мин</button>
            <button class="secondary-button" data-action="snooze-alarm" data-snooze="15">Отложить 15 мин</button>
            <button class="secondary-button" data-action="dismiss-alarm">Отключить</button>
          </div>
        </section>
      </div>
    `;
  }

  function handleClick(event) {
    const target = event.target.closest("[data-action]");
    if (!target) return;

    const action = target.dataset.action;

    if (action === "open-create") {
      openForm("create");
      return;
    }

    if (action === "toggle-theme") {
      state.theme = state.theme === "dark" ? "light" : "dark";
      applyTheme(state.theme);
      render();
      return;
    }

    if (action === "request-notifications") {
      requestNotificationPermission();
      return;
    }

    if (action === "close-modal") {
      closeForm();
      return;
    }

    if (action === "edit-alarm") {
      openForm("edit", target.dataset.id);
      return;
    }

    if (action === "delete-alarm") {
      state.deleteId = target.dataset.id;
      render();
      return;
    }

    if (action === "close-delete") {
      state.deleteId = null;
      render();
      return;
    }

    if (action === "confirm-delete") {
      removeAlarm(state.deleteId);
      state.deleteId = null;
      render();
      return;
    }

    if (action === "toggle-day") {
      toggleDraftDay(Number(target.dataset.day));
      return;
    }

    if (action === "dismiss-alarm") {
      dismissRingingAlarm();
      return;
    }

    if (action === "snooze-alarm") {
      const minutes = Number(target.dataset.snooze || 5);
      snoozeRingingAlarm(minutes);
      return;
    }
  }

  function handleInput(event) {
    if (!state.modal) return;
    const { target } = event;
    if (!target.closest("#alarm-form")) return;

    if (target.name === "title") {
      state.modal.draft.title = target.value;
    }

    if (target.name === "time") {
      state.modal.draft.time = target.value;
      state.formError = "";
    }

    if (target.name === "melody") {
      state.modal.draft.melody = target.value;
    }

    if (target.name === "volume") {
      state.modal.draft.volume = Number(target.value);
      updateVolumeLabel(target.value);
    }

    if (target.name === "vibration") {
      state.modal.draft.vibration = target.checked;
    }

    if (target.name === "repeatSignal") {
      state.modal.draft.repeatSignal = Number(target.value);
    }

    if (target.name === "snoozeMinutes") {
      state.modal.draft.snoozeMinutes = Number(target.value);
    }
  }

  function handleChange(event) {
    const { target } = event;
    if (target.matches('input[type="checkbox"][data-action="toggle-alarm"]')) {
      toggleAlarmEnabled(target.dataset.id, target.checked);
      return;
    }

    if (!state.modal) return;
    if (!target.closest("#alarm-form")) return;

    if (target.name === "volume") {
      state.modal.draft.volume = Number(target.value);
      updateVolumeLabel(target.value);
    }
  }

  function handleSubmit(event) {
    if (!event.target || event.target.id !== "alarm-form") return;
    event.preventDefault();
    saveForm();
  }

  function openForm(mode, alarmId = null) {
    const alarm = alarmId ? state.alarms.find((item) => item.id === alarmId) : null;
    state.formError = "";
    state.modal = {
      mode,
      alarmId,
      draft: alarm ? cloneAlarm(alarm) : createDraft()
    };
    render();
  }

  function closeForm() {
    state.modal = null;
    state.formError = "";
    render();
  }

  function createDraft() {
    return {
      id: cryptoId(),
      time: "",
      title: "",
      days: [],
      melody: "classic",
      volume: 80,
      vibration: true,
      repeatSignal: 5,
      snoozeMinutes: 5,
      enabled: true,
      snoozedUntil: null,
      createdAt: new Date().toISOString(),
      lastTriggeredAt: null
    };
  }

  function cloneAlarm(alarm) {
    return {
      id: alarm.id,
      time: alarm.time,
      title: alarm.title || "",
      days: Array.isArray(alarm.days) ? [...alarm.days] : [],
      melody: alarm.melody || "classic",
      volume: Number(alarm.volume ?? 80),
      vibration: Boolean(alarm.vibration),
      repeatSignal: Number(alarm.repeatSignal ?? 5),
      snoozeMinutes: Number(alarm.snoozeMinutes ?? 5),
      enabled: Boolean(alarm.enabled),
      snoozedUntil: alarm.snoozedUntil || null,
      createdAt: alarm.createdAt || new Date().toISOString(),
      lastTriggeredAt: alarm.lastTriggeredAt || null
    };
  }

  function saveForm() {
    // Проверяем обязательные поля и собираем новый объект будильника.
    const draft = state.modal?.draft;
    if (!draft) return;

    if (!draft.time) {
      state.formError = "Нельзя сохранить будильник без времени.";
      render();
      return;
    }

    const nextAlarm = {
      id: state.modal.alarmId || draft.id || cryptoId(),
      time: draft.time,
      title: draft.title.trim(),
      days: [...draft.days],
      melody: draft.melody,
      volume: Number(draft.volume),
      vibration: Boolean(draft.vibration),
      repeatSignal: Number(draft.repeatSignal),
      snoozeMinutes: Number(draft.snoozeMinutes),
      enabled: state.modal.mode === "edit" ? Boolean(draft.enabled) : true,
      snoozedUntil: state.modal.mode === "edit" ? draft.snoozedUntil : null,
      createdAt: draft.createdAt || new Date().toISOString(),
      lastTriggeredAt: draft.lastTriggeredAt || null
    };

    const index = state.alarms.findIndex((item) => item.id === nextAlarm.id);
    if (index >= 0) {
      state.alarms[index] = nextAlarm;
    } else {
      state.alarms.unshift(nextAlarm);
    }

    saveAlarms();
    state.modal = null;
    state.formError = "";
    render();
    if (index < 0) {
      window.requestAnimationFrame(() => animateCardEntrance(nextAlarm.id));
    }
  }

  function toggleDraftDay(dayId) {
    if (!state.modal) return;
    const days = state.modal.draft.days;
    const index = days.indexOf(dayId);
    if (index >= 0) {
      days.splice(index, 1);
    } else {
      days.push(dayId);
    }
    render();
  }

  function removeAlarm(id) {
    if (!id) return;
    state.leavingId = id;
    render();
    window.setTimeout(() => {
      state.alarms = state.alarms.filter((alarm) => alarm.id !== id);
      if (state.ringId === id) {
        state.ringId = null;
        stopAlarmSound();
      }
      state.leavingId = null;
      saveAlarms();
      render();
    }, 220);
  }

  function toggleAlarmEnabled(id, enabled) {
    const alarm = state.alarms.find((item) => item.id === id);
    if (!alarm) return;
    alarm.enabled = enabled;
    if (!enabled) {
      alarm.snoozedUntil = null;
    }
    if (state.ringId === id && !enabled) {
      state.ringId = null;
      stopAlarmSound();
    }
    saveAlarms();
    render();
  }

  function requestNotificationPermission() {
    if (!("Notification" in window)) {
      state.notificationPermission = "unsupported";
      render();
      return;
    }

    Notification.requestPermission().then((permission) => {
      state.notificationPermission = permission;
      render();
    });
  }

  function startTicker() {
    stopTicker();
    ticker = window.setInterval(tick, 1000);
  }

  function stopTicker() {
    if (ticker) window.clearInterval(ticker);
    ticker = null;
  }

  function tick() {
    // Каждый тик ищем первый будильник, который уже пора запускать.
    if (state.ringId) return;

    const now = new Date();
    const dueAlarm = state.alarms.find((alarm) => {
      if (!alarm.enabled) return false;
      const next = getNextOccurrence(alarm, now);
      if (!next) return false;
      const lastTriggeredAt = alarm.lastTriggeredAt ? new Date(alarm.lastTriggeredAt).getTime() : 0;
      return next.getTime() <= now.getTime() && next.getTime() > lastTriggeredAt;
    });

    if (dueAlarm) {
      triggerAlarm(dueAlarm.id);
    }
  }

  function triggerAlarm(id) {
    // Фиксируем запуск и открываем экран срабатывания.
    const alarm = state.alarms.find((item) => item.id === id);
    if (!alarm) return;

    state.ringId = id;
    alarm.lastTriggeredAt = new Date().toISOString();
    alarm.snoozedUntil = null;
    saveAlarms();
    render();
    playAlarmSound(alarm);
    vibrateAlarm(alarm);
    showNotification(alarm);
  }

  function dismissRingingAlarm() {
    const alarm = state.alarms.find((item) => item.id === state.ringId);
    if (!alarm) {
      state.ringId = null;
      stopAlarmSound();
      render();
      return;
    }

    if (isOneTimeAlarm(alarm)) {
      alarm.enabled = false;
    }

    alarm.snoozedUntil = null;
    state.ringId = null;
    stopAlarmSound();
    saveAlarms();
    render();
  }

  function snoozeRingingAlarm(minutes) {
    const alarm = state.alarms.find((item) => item.id === state.ringId);
    if (!alarm) return;

    alarm.snoozedUntil = new Date(Date.now() + minutes * 60 * 1000).toISOString();
    state.ringId = null;
    stopAlarmSound();
    saveAlarms();
    render();
  }

  function isOneTimeAlarm(alarm) {
    return !Array.isArray(alarm.days) || alarm.days.length === 0;
  }

  function showNotification(alarm) {
    if (state.notificationPermission !== "granted") return;

    const body = `${alarm.title || "Будильник"} · ${formatTime(alarm.time)}`;

    if (navigator.serviceWorker && navigator.serviceWorker.ready) {
      navigator.serviceWorker.ready
        .then((registration) => registration.showNotification("Будильник", {
          body,
          icon: "icon.svg",
          badge: "icon.svg",
          tag: `alarm-${alarm.id}`,
          renotify: true
        }))
        .catch(() => {
          new Notification("Будильник", {
            body,
            icon: "icon.svg"
          });
        });
      return;
    }

    try {
      new Notification("Будильник", {
        body,
        icon: "icon.svg"
      });
    } catch {
      /* Notification API not available in this environment. */
    }
  }

  function vibrateAlarm(alarm) {
    if (!alarm.vibration || !navigator.vibrate) return;
    navigator.vibrate([300, 150, 300, 150, 500]);
  }

  function playAlarmSound(alarm) {
    // Генерируем короткий звуковой сигнал без внешних файлов.
    stopAlarmSound();
    try {
      audioContext = audioContext || new (window.AudioContext || window.webkitAudioContext)();
      if (audioContext.state === "suspended") {
        audioContext.resume().catch(() => {});
      }
    } catch {
      return;
    }

    const intervalMs = Number(alarm.repeatSignal || 0) * 1000;
    const step = alarm.melody === "digital" ? 660 : alarm.melody === "soft" ? 440 : 520;

    const playBurst = () => {
      if (!audioContext) return;
      const gain = audioContext.createGain();
      const osc = audioContext.createOscillator();
      osc.type = alarm.melody === "soft" ? "triangle" : "sine";
      osc.frequency.setValueAtTime(step, audioContext.currentTime);
      osc.frequency.exponentialRampToValueAtTime(step * 1.45, audioContext.currentTime + 0.08);
      gain.gain.value = Math.max(0.02, Math.min(0.9, alarm.volume / 100));
      gain.gain.setValueAtTime(gain.gain.value, audioContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.28);
      osc.connect(gain);
      gain.connect(audioContext.destination);
      osc.start();
      osc.stop(audioContext.currentTime + 0.3);
      activeNode = osc;
      activeGain = gain;
    };

    playBurst();
    if (intervalMs > 0) {
      soundInterval = window.setInterval(playBurst, intervalMs);
    } else {
      stopTimeout = window.setTimeout(() => {
        stopAlarmSound();
      }, 1100);
    }
  }

  function stopAlarmSound() {
    if (soundInterval) window.clearInterval(soundInterval);
    soundInterval = null;

    if (stopTimeout) window.clearTimeout(stopTimeout);
    stopTimeout = null;

    try {
      if (activeNode) {
        activeNode.stop();
        activeNode.disconnect();
      }
      if (activeGain) {
        activeGain.disconnect();
      }
    } catch {
      /* Ignore audio cleanup failures. */
    }

    activeNode = null;
    activeGain = null;
  }

  function getNextOccurrence(alarm, fromDate = new Date()) {
    // Рассчитываем ближайший момент срабатывания, включая отложенный сигнал.
    const [hour, minute] = alarm.time.split(":").map(Number);
    if (Number.isNaN(hour) || Number.isNaN(minute)) return null;

    const snoozeUntil = alarm.snoozedUntil ? new Date(alarm.snoozedUntil) : null;
    if (snoozeUntil && snoozeUntil.getTime() > fromDate.getTime()) {
      return snoozeUntil;
    }

    const hasDays = Array.isArray(alarm.days) && alarm.days.length > 0;
    const candidate = new Date(fromDate);
    candidate.setSeconds(0, 0);
    candidate.setHours(hour, minute, 0, 0);

    if (!hasDays) {
      if (candidate.getTime() <= fromDate.getTime()) {
        candidate.setDate(candidate.getDate() + 1);
      }
      return candidate;
    }

    for (let offset = 0; offset < 8; offset += 1) {
      const next = new Date(fromDate);
      next.setDate(fromDate.getDate() + offset);
      next.setSeconds(0, 0);
      next.setHours(hour, minute, 0, 0);
      if (alarm.days.includes(next.getDay()) && next.getTime() > fromDate.getTime()) {
        return next;
      }
    }

    return null;
  }

  function describeWeekdays(days) {
    if (!Array.isArray(days) || days.length === 0) return "Один раз";
    if (days.length === 7) return "Каждый день";
    const order = [1, 2, 3, 4, 5, 6, 0];
    const sorted = [...days].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    return sorted.map((dayId) => WEEKDAYS.find((day) => day.id === dayId)?.short || "").join(" ");
  }

  function formatTime(value) {
    if (!value) return "--:--";
    const [hours, minutes] = value.split(":").map((part) => Number(part));
    if (Number.isNaN(hours) || Number.isNaN(minutes)) return value;
    const hh = String(hours).padStart(2, "0");
    const mm = String(minutes).padStart(2, "0");
    return `${hh}:${mm}`;
  }

  function escapeHtml(text) {
    return String(text)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function escapeAttr(text) {
    return escapeHtml(text).replaceAll("`", "&#96;");
  }

  function cryptoId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return `alarm-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function animateCardEntrance(id) {
    const card = document.querySelector(`[data-alarm-card="${id}"]`);
    if (!card) return;
    card.animate(
      [
        { opacity: 0, transform: "translateY(16px) scale(0.98)" },
        { opacity: 1, transform: "translateY(0) scale(1)" }
      ],
      { duration: 320, easing: "ease-out" }
    );
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("sw.js").catch(() => {
      /* Optional progressive enhancement only. */
    });
  }

  function updateVolumeLabel(value) {
    if (!state.modal) return;
    const note = document.querySelector("#alarm-form .tiny-note strong");
    if (note) note.textContent = `${Number(value)}%`;
  }

})();
