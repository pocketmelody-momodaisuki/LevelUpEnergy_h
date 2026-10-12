import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
import {
  getDatabase,
  onValue,
  ref,
  set
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyBtvfBrWkq5zIzDwbmFU_b7Rt0a1u7k-z8",
  authDomain: "study-task-app-aac17.firebaseapp.com",
  databaseURL: "https://study-task-app-aac17-default-rtdb.firebaseio.com",
  projectId: "study-task-app-aac17",
  storageBucket: "study-task-app-aac17.firebasestorage.app",
  messagingSenderId: "797260954076",
  appId: "1:797260954076:web:ce4b909300328a22417719"
};

const LEGACY_STORAGE_KEY = "studyTaskData";
const MAX_OPERATION_LOGS = 500;
const app = initializeApp(firebaseConfig);
const database = getDatabase(app);
const sharedDataRef = ref(database, "studyTaskData");
let data = { tasks: [], days: {}, logs: [] };
let currentDate = null;
let runningTimerId = null;
let runningSessionSeconds = 0;
let runningBaseSeconds = 0;
let runningTaskId = null;
let screenWakeLock = null;
let wakeLockRequestPending = false;
let confirmActionResolver = null;
let initialDataLoaded = false;
let pendingSave = Promise.resolve();
let taskReorderGesture = null;
const taskByRow = new WeakMap();

function formatDateLabel(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const w = ["日", "月", "火", "水", "木", "金", "土"][d.getDay()];
  return `${y}/${m}/${day} (${w})`;
}

function normalizeData(value) {
  const source = value && typeof value === "object" ? value : {};
  const tasks = Array.isArray(source.tasks)
    ? source.tasks.filter(task => typeof task === "string")
    : [];
  const sourceDays = source.days && typeof source.days === "object" ? source.days : {};
  const days = {};
  const logs = Array.isArray(source.logs)
    ? source.logs.filter(entry => entry && typeof entry.timestamp === "string" && typeof entry.message === "string")
    : [];

  Object.entries(sourceDays).forEach(([date, dayTasks]) => {
    if (Array.isArray(dayTasks)) {
      days[date] = dayTasks.filter(task => task && typeof task === "object");
    }
  });
  return { tasks, days, logs };
}

function readLegacyData() {
  const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
  if (!raw) return null;
  return normalizeData(JSON.parse(raw));
}

function mergeLegacyData(sharedData, legacyData) {
  const merged = normalizeData(sharedData);
  merged.tasks = Array.from(new Set([...merged.tasks, ...legacyData.tasks]));

  Object.entries(legacyData.days).forEach(([date, legacyTasks]) => {
    const sharedTasks = merged.days[date] || [];
    const sharedIds = new Set(
      sharedTasks.map(task => task.id).filter(id => id != null)
    );
    merged.days[date] = sharedTasks.concat(
      legacyTasks.filter(task => task.id == null || !sharedIds.has(task.id))
    );
  });
  return merged;
}

function setSyncStatus(message, isError = false) {
  const status = document.getElementById("syncStatus");
  status.textContent = message;
  status.classList.toggle("sync-error", isError);
}

function getLogTimestamp() {
  const now = new Date();
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0")
  ].join("/");
  const time = [
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0")
  ].join(":");
  return `${date} ${time}`;
}

function formatLogDate(dateStr) {
  return dateStr.replaceAll("-", "/");
}

function getTaskLabel(task) {
  return task.name && task.name.trim() ? `「${task.name.trim()}」` : "未入力のタスク";
}

function addOperationLog(message) {
  data.logs.push({ timestamp: getLogTimestamp(), message });
  if (data.logs.length > MAX_OPERATION_LOGS) {
    data.logs.splice(0, data.logs.length - MAX_OPERATION_LOGS);
  }
}

function renderOperationLogs() {
  const list = document.getElementById("operationLogList");
  list.innerHTML = "";
  if (data.logs.length === 0) {
    const emptyMessage = document.createElement("li");
    emptyMessage.className = "operation-log-empty";
    emptyMessage.textContent = "操作ログはまだありません。";
    list.appendChild(emptyMessage);
    return;
  }

  [...data.logs].reverse().forEach(entry => {
    const item = document.createElement("li");
    item.className = "operation-log-item";
    const timestamp = document.createElement("time");
    timestamp.className = "operation-log-timestamp";
    timestamp.textContent = entry.timestamp;
    const message = document.createElement("span");
    message.textContent = entry.message;
    item.append(timestamp, message);
    list.appendChild(item);
  });
}

function isTaskRowControl(target) {
  return target.closest("button, input, select, textarea, a, label");
}

function beginTaskReorder(row, clientX, clientY, source, event) {
  if (taskReorderGesture || isTaskRowControl(event.target)) return;
  const task = taskByRow.get(row);
  if (!task || !currentDate) return;

  const gesture = {
    row,
    task,
    source,
    startX: clientX,
    startY: clientY,
    dragging: false,
    timerId: null
  };
  taskReorderGesture = gesture;
  gesture.timerId = setTimeout(() => {
    if (taskReorderGesture !== gesture) return;
    gesture.dragging = true;
    row.classList.add("task-row-dragging");
    row.setAttribute("aria-grabbed", "true");
  }, 500);
}

function moveTaskReorder(clientX, clientY, event) {
  const gesture = taskReorderGesture;
  if (!gesture) return;

  if (!gesture.dragging) {
    const distance = Math.hypot(clientX - gesture.startX, clientY - gesture.startY);
    if (distance > 10) cancelTaskReorder();
    return;
  }

  if (event.cancelable) event.preventDefault();
  const target = document.elementFromPoint(clientX, clientY)?.closest("tr.task-row");
  if (!target || target === gesture.row || target.parentElement !== gesture.row.parentElement) return;

  const targetBounds = target.getBoundingClientRect();
  if (clientY < targetBounds.top + targetBounds.height / 2) {
    target.parentElement.insertBefore(gesture.row, target);
  } else {
    target.parentElement.insertBefore(gesture.row, target.nextElementSibling);
  }
}

function cancelTaskReorder() {
  const gesture = taskReorderGesture;
  if (!gesture) return;
  clearTimeout(gesture.timerId);
  gesture.row.classList.remove("task-row-dragging");
  gesture.row.removeAttribute("aria-grabbed");
  taskReorderGesture = null;
  if (gesture.dragging) renderTaskList();
}

function finishTaskReorder() {
  const gesture = taskReorderGesture;
  if (!gesture) return;
  clearTimeout(gesture.timerId);
  gesture.row.classList.remove("task-row-dragging");
  gesture.row.removeAttribute("aria-grabbed");
  taskReorderGesture = null;
  if (!gesture.dragging) return;

  const tasks = Array.from(gesture.row.parentElement.querySelectorAll("tr.task-row"))
    .map(row => taskByRow.get(row))
    .filter(task => task);
  const previousIndex = data.days[currentDate].indexOf(gesture.task);
  const nextIndex = tasks.indexOf(gesture.task);
  if (previousIndex === nextIndex) return;

  data.days[currentDate] = tasks;
  addOperationLog(
    `${formatLogDate(currentDate)}の${getTaskLabel(gesture.task)}を${previousIndex + 1}番目から${nextIndex + 1}番目へ並べ替えました。`
  );
  saveData();
  renderTaskList();
}

function handleMouseMove(event) {
  if (taskReorderGesture?.source === "mouse") {
    moveTaskReorder(event.clientX, event.clientY, event);
  }
}

function handleTouchMove(event) {
  if (taskReorderGesture?.source !== "touch" || event.touches.length !== 1) return;
  const touch = event.touches[0];
  moveTaskReorder(touch.clientX, touch.clientY, event);
}

function setEditingEnabled(enabled) {
  ["datePicker", "addDateBtn", "clearTasksBtn", "addTaskBtn", "operationLogBtn"].forEach(id => {
    document.getElementById(id).disabled = !enabled;
  });
}

function saveData(removeLegacyData = false) {
  const snapshot = JSON.parse(JSON.stringify(data));
  setSyncStatus("Firebaseに保存中...");
  pendingSave = pendingSave
    .then(() => set(sharedDataRef, snapshot))
    .then(() => {
      if (removeLegacyData) localStorage.removeItem(LEGACY_STORAGE_KEY);
      setSyncStatus("Firebaseと同期済み");
    })
    .catch(error => {
      console.error("Firebaseへの保存に失敗しました。", error);
      setSyncStatus(`Firebaseへの保存に失敗しました: ${error.message}`, true);
    });
  return pendingSave;
}

function renderData() {
  renderDateList();
  renderTaskMasterList();
  renderTaskList();
  if (!document.getElementById("operationLogOverlay").classList.contains("hidden")) {
    renderOperationLogs();
  }
}

function handleSharedData(snapshot) {
  const isFirstLoad = !initialDataLoaded;
  const needsInitialSave = !snapshot.exists();
  let legacyData = null;

  if (isFirstLoad) {
    try {
      legacyData = readLegacyData();
    } catch (error) {
      console.error("この端末に保存された旧データを読み込めませんでした。", error);
      setSyncStatus("この端末の旧データを読み込めませんでした。", true);
      return;
    }
  }

  data = snapshot.exists()
    ? normalizeData(snapshot.val())
    : { tasks: [], days: {}, logs: [] };
  if (legacyData) data = mergeLegacyData(data, legacyData);

  if (isFirstLoad) {
    initialDataLoaded = true;
    setEditingEnabled(true);
    currentDate = getTodayStr();
    document.getElementById("datePicker").value = currentDate;
  }

  const addedToday = !data.days[currentDate];
  if (addedToday) data.days[currentDate] = [];
  renderData();

  if (needsInitialSave || legacyData !== null || addedToday) {
    saveData(legacyData !== null);
  } else if (isFirstLoad) {
    setSyncStatus("Firebaseと同期済み");
  }
}

function showConfirmation(message) {
  const overlay = document.getElementById("confirmOverlay");
  document.getElementById("confirmMessage").textContent = message;
  overlay.classList.remove("hidden");
  document.getElementById("confirmCancelBtn").focus();
  return new Promise(resolve => {
    confirmActionResolver = resolve;
  });
}

function resolveConfirmation(confirmed) {
  if (!confirmActionResolver) return;
  const resolve = confirmActionResolver;
  confirmActionResolver = null;
  document.getElementById("confirmOverlay").classList.add("hidden");
  resolve(confirmed);
}

function getTodayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function ensureDay(dateStr) {
  if (!data.days[dateStr]) {
    data.days[dateStr] = [];
  }
}

function renderDateList() {
  const listEl = document.getElementById("dateList");
  listEl.innerHTML = "";
  const dates = Object.keys(data.days).sort();
  dates.forEach(dateStr => {
    const li = document.createElement("li");
    li.className = "date-item";
    if (dateStr === currentDate) {
      li.classList.add("active");
    }
    const spanLabel = document.createElement("span");
    spanLabel.className = "date-label";
    spanLabel.textContent = formatDateLabel(dateStr);
    li.appendChild(spanLabel);
    if (data.days[dateStr].some(task => !task.completed)) {
      const pendingLabel = document.createElement("span");
      pendingLabel.className = "pending-label";
      pendingLabel.textContent = "残あり";
      li.appendChild(pendingLabel);
    }
    li.onclick = () => {
      currentDate = dateStr;
      renderDateList();
      renderTaskList();
    };
    listEl.appendChild(li);
  });
}

function renderTaskMasterList() {
  const dl = document.getElementById("taskMasterList");
  dl.innerHTML = "";
  const uniqueNames = Array.from(new Set(data.tasks));
  uniqueNames.forEach(name => {
    const opt = document.createElement("option");
    opt.value = name;
    dl.appendChild(opt);
  });
}

function getTaskDurationSeconds(task, property) {
  const minutes = task[property];
  return Number.isFinite(minutes) ? Math.max(0, Math.round(minutes * 60)) : null;
}

function getPlannedDurationSeconds(task) {
  const plannedSeconds = getTaskDurationSeconds(task, "plannedMinutes");
  return plannedSeconds == null ? 30 * 60 : plannedSeconds;
}

function getTaskRemainingSeconds(task) {
  const actualSeconds = getTaskDurationSeconds(task, "actualMinutes") || 0;
  return Math.max(0, getPlannedDurationSeconds(task) - actualSeconds);
}

function formatDuration(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  let formatted = "";
  if (hours > 0) formatted += `${hours}時間`;
  if (minutes > 0) formatted += `${minutes}分`;
  if (seconds > 0) formatted += `${seconds}秒`;
  return formatted || "0分";
}

function updatePlannedDurationTotal(tasks) {
  const totalSeconds = tasks.reduce((total, task) => {
    return total + getPlannedDurationSeconds(task);
  }, 0);
  document.getElementById("plannedDurationTotal").textContent =
    `所要時間計：${formatDuration(totalSeconds)}`;
  const remainingSeconds = tasks.reduce((total, task) => {
    return task.completed ? total : total + getTaskRemainingSeconds(task);
  }, 0);
  document.getElementById("remainingDurationTotal").textContent =
    `（残：${formatDuration(remainingSeconds)}）`;
}

function updateCompletionRate(tasks) {
  const totalPlannedSeconds = tasks.reduce((total, task) => {
    return total + getPlannedDurationSeconds(task);
  }, 0);
  const completedPlannedSeconds = tasks.reduce((total, task) => {
    if (!task.completed) return total;
    return total + getPlannedDurationSeconds(task);
  }, 0);
  const completionRate = totalPlannedSeconds === 0
    ? 0
    : Math.round((completedPlannedSeconds / totalPlannedSeconds) * 100);

  document.getElementById("completionRate").textContent = `達成率：${completionRate}%`;
  const progress = document.getElementById("completionProgress");
  progress.setAttribute("aria-valuenow", String(completionRate));
  document.getElementById("completionProgressFill").style.width = `${completionRate}%`;
}

function createDurationControls(totalSeconds, onChange, allowEmpty = false) {
  const controls = document.createElement("div");
  controls.className = "duration-controls";

  const minutesSelect = document.createElement("select");
  minutesSelect.className = "duration-select";
  const secondsSelect = document.createElement("select");
  secondsSelect.className = "duration-select";

  if (allowEmpty) {
    [minutesSelect, secondsSelect].forEach(select => {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "";
      select.appendChild(option);
    });
  }

  const selectedMinutes = totalSeconds == null ? null : Math.floor(totalSeconds / 60);
  const selectedSeconds = totalSeconds == null ? null : totalSeconds % 60;
  const minuteLimit = Math.max(180, selectedMinutes || 0);
  for (let minute = 0; minute <= minuteLimit; minute += 1) {
    const option = document.createElement("option");
    option.value = String(minute);
    option.textContent = String(minute);
    minutesSelect.appendChild(option);
  }
  for (let second = 0; second < 60; second += 1) {
    const option = document.createElement("option");
    option.value = String(second);
    option.textContent = String(second);
    secondsSelect.appendChild(option);
  }

  if (totalSeconds == null) {
    minutesSelect.value = "";
    secondsSelect.value = "";
  } else {
    minutesSelect.value = String(selectedMinutes);
    secondsSelect.value = String(selectedSeconds);
  }

  const handleChange = () => {
    const minutes = parseInt(minutesSelect.value || "0", 10);
    const seconds = parseInt(secondsSelect.value || "0", 10);
    minutesSelect.value = String(minutes);
    secondsSelect.value = String(seconds);
    onChange(minutes * 60 + seconds);
  };
  minutesSelect.onchange = handleChange;
  secondsSelect.onchange = handleChange;

  controls.appendChild(minutesSelect);
  const minuteLabel = document.createElement("span");
  minuteLabel.className = "duration-unit";
  minuteLabel.textContent = "分";
  controls.appendChild(minuteLabel);
  controls.appendChild(secondsSelect);
  const secondLabel = document.createElement("span");
  secondLabel.className = "duration-unit";
  secondLabel.textContent = "秒";
  controls.appendChild(secondLabel);
  return controls;
}

function createTaskRow(task, index) {
  const tr = document.createElement("tr");
  tr.className = "task-row";
  taskByRow.set(tr, task);
  tr.addEventListener("mousedown", event => {
    if (event.button !== 0) return;
    beginTaskReorder(tr, event.clientX, event.clientY, "mouse", event);
  });
  tr.addEventListener("touchstart", event => {
    if (event.touches.length !== 1) return;
    const touch = event.touches[0];
    beginTaskReorder(tr, touch.clientX, touch.clientY, "touch", event);
  }, { passive: true });
  const tdCheck = document.createElement("td");
  tdCheck.className = "checkbox-cell";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = !!task.completed;
  cb.onchange = () => {
    task.completed = cb.checked;
    addOperationLog(
      `${formatLogDate(currentDate)}の${getTaskLabel(task)}を${task.completed ? "完了しました" : "未完了に戻しました"}。`
    );
    saveData();
    renderDateList();
    updateCompletionRate(data.days[currentDate]);
    updatePlannedDurationTotal(data.days[currentDate]);
  };
  tdCheck.appendChild(cb);
  tr.appendChild(tdCheck);
  const tdName = document.createElement("td");
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "task-name-input";
  nameInput.setAttribute("list", "taskMasterList");
  nameInput.value = task.name || "";
  nameInput.onchange = () => {
    const previousName = task.name || "";
    task.name = nameInput.value.trim();
    if (previousName !== task.name) {
      addOperationLog(
        `${formatLogDate(currentDate)}のタスク名を「${previousName || "未入力"}」から「${task.name || "未入力"}」に変更しました。`
      );
    }
    if (task.name) {
      data.tasks.push(task.name);
      renderTaskMasterList();
    }
    saveData();
  };
  tdName.appendChild(nameInput);
  tr.appendChild(tdName);
  const tdPlanned = document.createElement("td");
  const plannedSeconds = getTaskDurationSeconds(task, "plannedMinutes");
  tdPlanned.appendChild(createDurationControls(
    plannedSeconds == null ? 30 * 60 : plannedSeconds,
    totalSeconds => {
      const previousSeconds = getPlannedDurationSeconds(task);
      task.plannedMinutes = totalSeconds / 60;
      if (previousSeconds !== totalSeconds) {
        addOperationLog(
          `${formatLogDate(currentDate)}の${getTaskLabel(task)}の所要時間を${formatDuration(previousSeconds)}から${formatDuration(totalSeconds)}に変更しました。`
        );
      }
      saveData();
      updateCompletionRate(data.days[currentDate]);
      updatePlannedDurationTotal(data.days[currentDate]);
      updateOverlayPlannedRemaining();
    }
  ));
  tr.appendChild(tdPlanned);
  const tdActual = document.createElement("td");
  tdActual.appendChild(createDurationControls(
    getTaskDurationSeconds(task, "actualMinutes"),
    totalSeconds => {
      const previousSeconds = getTaskDurationSeconds(task, "actualMinutes");
      task.actualMinutes = totalSeconds / 60;
      if (previousSeconds !== totalSeconds) {
        addOperationLog(
          `${formatLogDate(currentDate)}の${getTaskLabel(task)}の実績時間を${previousSeconds == null ? "未記録" : formatDuration(previousSeconds)}から${formatDuration(totalSeconds)}に変更しました。`
        );
      }
      saveData();
      updatePlannedDurationTotal(data.days[currentDate]);
      updateOverlayPlannedRemaining();
    },
    true
  ));
  tr.appendChild(tdActual);
  const tdAction = document.createElement("td");
  tdAction.className = "action-buttons";
  const startBtn = document.createElement("button");
  startBtn.textContent = "▶";
  startBtn.setAttribute("aria-label", `${task.name || "選択されたタスク"}を進める`);
  startBtn.title = "進める";
  startBtn.onclick = () => {
    openOverlayForTask(task);
  };
  tdAction.appendChild(startBtn);
  const moveBtn = document.createElement("button");
  moveBtn.type = "button";
  moveBtn.className = "move-task-btn";
  moveBtn.textContent = "⇔";
  moveBtn.setAttribute("aria-label", `${task.name || "選択されたタスク"}を別の日付へ移動`);
  moveBtn.title = "移動";
  moveBtn.onclick = () => {
    openMoveDialog(task);
  };
  tdAction.appendChild(moveBtn);

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "delete-task-btn";
  deleteBtn.textContent = "✖";
  deleteBtn.setAttribute("aria-label", `${task.name || "選択されたタスク"}を削除`);
  deleteBtn.title = "削除";
  deleteBtn.onclick = async () => {
    const taskDate = currentDate;
    const taskName = task.name || "(タスク名未入力)";
    if (!await showConfirmation(`選択されたタスク\n\n${taskName}\n\nを削除しますか？`)) return;
    if (runningTaskId === task.id) closeOverlay();
    data.days[taskDate].splice(index, 1);
    addOperationLog(`${formatLogDate(taskDate)}の${getTaskLabel(task)}が削除されました。`);
    saveData();
    renderDateList();
    renderTaskList();
  };
  tdAction.appendChild(deleteBtn);
  tr.appendChild(tdAction);
  return tr;
}

function renderTaskList() {
  const titleEl = document.getElementById("taskListTitle");
  if (currentDate) {
    titleEl.textContent = `タスク一覧: ${formatDateLabel(currentDate)}`;
  } else {
    titleEl.textContent = "タスク一覧";
  }
  const currentTasks = currentDate ? data.days[currentDate] || [] : [];
  updateCompletionRate(currentTasks);
  updatePlannedDurationTotal(currentTasks);
  const tbody = document.getElementById("taskTableBody");
  tbody.innerHTML = "";
  if (!currentDate) return;
  ensureDay(currentDate);
  const tasks = data.days[currentDate];
  tasks.forEach((task, index) => {
    const tr = createTaskRow(task, index);
    tbody.appendChild(tr);
  });
}

function addTaskToCurrentDate() {
  if (!currentDate) return;
  ensureDay(currentDate);
  const newTask = {
    id: Date.now() + "_" + Math.random().toString(16).slice(2),
    name: "",
    plannedMinutes: 30,
    actualMinutes: null,
    completed: false
  };
  data.days[currentDate].push(newTask);
  addOperationLog(`${formatLogDate(currentDate)}にタスクを追加しました。`);
  saveData();
  renderDateList();
  renderTaskList();
}

function openOverlayForTask(task) {
  const overlay = document.getElementById("overlay");
  const nameEl = document.getElementById("overlayTaskName");
  const dateEl = document.getElementById("overlayDate");
  const timerEl = document.getElementById("overlayTimer");
  nameEl.textContent = task.name || "(タスク名未入力)";
  dateEl.textContent = formatDateLabel(currentDate);
  runningTaskId = task.id;
  runningBaseSeconds = getTaskDurationSeconds(task, "actualMinutes") || 0;
  runningSessionSeconds = 0;
  timerEl.textContent = "00:00";
  updateOverlayPlannedRemaining();
  const startBtn = document.getElementById("overlayStartBtn");
  const pauseBtn = document.getElementById("overlayPauseBtn");
  const finishBtn = document.getElementById("overlayFinishBtn");
  startBtn.disabled = false;
  pauseBtn.disabled = true;
  finishBtn.disabled = false;
  overlay.classList.remove("hidden");
}

function closeOverlay() {
  const overlay = document.getElementById("overlay");
  overlay.classList.add("hidden");
  stopTimer();
  runningTaskId = null;
  runningSessionSeconds = 0;
  runningBaseSeconds = 0;
}

function updateOverlayTimerDisplay() {
  const timerEl = document.getElementById("overlayTimer");
  const totalSeconds = runningSessionSeconds;
  const m = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const s = String(totalSeconds % 60).padStart(2, "0");
  timerEl.textContent = `${m}:${s}`;
  updateOverlayPlannedRemaining();
}

function updateOverlayPlannedRemaining() {
  if (!currentDate || !runningTaskId) return;
  const task = (data.days[currentDate] || []).find(item => item.id === runningTaskId);
  if (!task) return;
  const elapsedSeconds = runningBaseSeconds + runningSessionSeconds;
  const remainingSeconds = Math.max(0, getPlannedDurationSeconds(task) - elapsedSeconds);
  document.getElementById("overlayPlannedRemaining").textContent =
    `所要時間：${formatDuration(remainingSeconds)}`;
}

function openMoveDialog(task) {
  const sourceDate = currentDate;
  const sourceTasks = data.days[sourceDate];
  const taskIndex = sourceTasks.indexOf(task);
  if (taskIndex < 0) return;

  const moveOverlay = document.getElementById("moveOverlay");
  const moveDatePicker = document.getElementById("moveDatePicker");
  const moveError = document.getElementById("moveError");
  const nextDate = new Date(`${sourceDate}T00:00:00`);
  nextDate.setDate(nextDate.getDate() + 1);
  moveDatePicker.value = [
    nextDate.getFullYear(),
    String(nextDate.getMonth() + 1).padStart(2, "0"),
    String(nextDate.getDate()).padStart(2, "0")
  ].join("-");
  moveError.textContent = "";
  moveDatePicker.onchange = () => {
    moveError.textContent = "";
  };
  moveOverlay.classList.remove("hidden");
  moveDatePicker.focus();

  document.getElementById("moveCancelBtn").onclick = () => {
    moveOverlay.classList.add("hidden");
  };
  document.getElementById("moveAcceptBtn").onclick = () => {
    const destinationDate = moveDatePicker.value;
    if (!destinationDate || destinationDate === sourceDate) {
      moveError.textContent = "移動元とは異なる日付を選択してください。";
      moveDatePicker.focus();
      return;
    }
    if (runningTaskId === task.id) closeOverlay();

    sourceTasks.splice(taskIndex, 1);
    ensureDay(destinationDate);
    data.days[destinationDate].push(task);
    addOperationLog(
      `${formatLogDate(sourceDate)}の${getTaskLabel(task)}を${formatLogDate(destinationDate)}へ移動しました。`
    );
    currentDate = destinationDate;
    document.getElementById("datePicker").value = destinationDate;
    moveOverlay.classList.add("hidden");
    saveData();
    renderDateList();
    renderTaskList();
  };
  moveOverlay.onkeydown = event => {
    if (event.key === "Escape") moveOverlay.classList.add("hidden");
  };
}

function startTimer() {
  if (runningTimerId) return;
  const task = currentDate && (data.days[currentDate] || []).find(item => item.id === runningTaskId);
  if (task) {
    addOperationLog(`${formatLogDate(currentDate)}の${getTaskLabel(task)}のタイマーを開始しました。`);
    saveData();
  }
  const startBtn = document.getElementById("overlayStartBtn");
  const pauseBtn = document.getElementById("overlayPauseBtn");
  document.getElementById("wakeLockStatus").textContent = "";
  startBtn.disabled = true;
  pauseBtn.disabled = false;
  runningTimerId = setInterval(() => {
    runningSessionSeconds += 1;
    updateOverlayTimerDisplay();
  }, 1000);
  void requestScreenWakeLock();
}

async function requestScreenWakeLock() {
  if (!runningTimerId) return;
  if (!("wakeLock" in navigator)) {
    document.getElementById("wakeLockStatus").textContent =
      "このブラウザーは画面スリープ防止に対応していません。iPadの自動ロック設定をご確認ください。";
    return;
  }
  if (document.visibilityState !== "visible") return;
  if (screenWakeLock && !screenWakeLock.released) return;
  if (wakeLockRequestPending) return;

  wakeLockRequestPending = true;
  try {
    const wakeLock = await navigator.wakeLock.request("screen");
    if (!runningTimerId || document.visibilityState !== "visible") {
      await wakeLock.release();
      return;
    }
    screenWakeLock = wakeLock;
    document.getElementById("wakeLockStatus").textContent = "";
    wakeLock.addEventListener("release", () => {
      if (screenWakeLock === wakeLock) screenWakeLock = null;
      if (runningTimerId && document.visibilityState === "visible") {
        void requestScreenWakeLock();
      }
    });
  } catch (error) {
    console.warn("画面スリープ防止を有効にできませんでした。", error);
    document.getElementById("wakeLockStatus").textContent =
      "画面スリープ防止を利用できません。iPadの自動ロック設定をご確認ください。";
  } finally {
    wakeLockRequestPending = false;
  }
}

function releaseScreenWakeLock() {
  const wakeLock = screenWakeLock;
  screenWakeLock = null;
  if (wakeLock) {
    wakeLock.release().catch(error => {
      console.warn("画面スリープ防止を解除できませんでした。", error);
    });
  }
}

function handleVisibilityChange() {
  if (document.visibilityState === "visible" && runningTimerId) {
    void requestScreenWakeLock();
  }
}

function stopTimer() {
  if (runningTimerId) {
    clearInterval(runningTimerId);
    runningTimerId = null;
  }
  releaseScreenWakeLock();
  const startBtn = document.getElementById("overlayStartBtn");
  const pauseBtn = document.getElementById("overlayPauseBtn");
  if (startBtn && pauseBtn) {
    startBtn.disabled = false;
    pauseBtn.disabled = true;
  }
}

function applySessionToTask(markCompleted) {
  if (!currentDate || !runningTaskId) return;
  ensureDay(currentDate);
  const tasks = data.days[currentDate];
  const task = tasks.find(t => t.id === runningTaskId);
  if (!task) return;
  task.actualMinutes = (runningBaseSeconds + runningSessionSeconds) / 60;
  if (markCompleted) {
    task.completed = true;
    addOperationLog(
      `${formatLogDate(currentDate)}の${getTaskLabel(task)}が完了しました（実績時間：${formatDuration(Math.round(task.actualMinutes * 60))}）。`
    );
  } else {
    addOperationLog(
      `${formatLogDate(currentDate)}の${getTaskLabel(task)}の実績時間を${formatDuration(Math.round(task.actualMinutes * 60))}に更新しました。`
    );
  }
  saveData();
  renderTaskList();
}

function init() {
  const todayStr = getTodayStr();
  document.getElementById("todayText").textContent = formatDateLabel(todayStr);
  const datePicker = document.getElementById("datePicker");
  datePicker.value = todayStr;
  currentDate = todayStr;
  setEditingEnabled(false);
  document.getElementById("addDateBtn").onclick = () => {
    const selected = datePicker.value;
    if (!selected) return;
    const isNewDate = !data.days[selected];
    ensureDay(selected);
    currentDate = selected;
    if (isNewDate) {
      addOperationLog(`${formatLogDate(selected)}のタスクリストを作成しました。`);
    }
    saveData();
    renderDateList();
    renderTaskList();
  };
  document.getElementById("addTaskBtn").onclick = () => {
    addTaskToCurrentDate();
  };
  document.getElementById("clearTasksBtn").onclick = async () => {
    if (!currentDate) return;
    const taskDate = currentDate;
    const dateLabel = formatDateLabel(taskDate);
    if (!await showConfirmation(`${dateLabel}の\nすべてのタスクを削除しますか？`)) return;
    if (data.days[taskDate].some(task => task.id === runningTaskId)) closeOverlay();
    const deletedTasks = data.days[taskDate];
    const deletedNames = deletedTasks.map(getTaskLabel).join("、");
    data.days[taskDate] = [];
    addOperationLog(
      `${formatLogDate(taskDate)}のタスク${deletedTasks.length}件${deletedNames ? `（${deletedNames}）` : ""}を一括削除しました。`
    );
    saveData();
    renderDateList();
    renderTaskList();
  };
  document.getElementById("confirmAcceptBtn").onclick = () => {
    resolveConfirmation(true);
  };
  document.getElementById("confirmCancelBtn").onclick = () => {
    resolveConfirmation(false);
  };
  document.getElementById("confirmOverlay").onkeydown = event => {
    if (event.key === "Escape") resolveConfirmation(false);
  };
  document.getElementById("overlayStartBtn").onclick = () => {
    startTimer();
  };
  document.getElementById("overlayPauseBtn").onclick = () => {
    stopTimer();
    applySessionToTask(false);
    const task = data.days[currentDate].find(t => t.id === runningTaskId);
    runningBaseSeconds = task ? getTaskDurationSeconds(task, "actualMinutes") || 0 : 0;
    runningSessionSeconds = 0;
    document.getElementById("overlayTimer").textContent = "00:00";
    updateOverlayPlannedRemaining();
  };
  document.getElementById("overlayFinishBtn").onclick = () => {
    stopTimer();
    applySessionToTask(true);
    closeOverlay();
  };
  document.getElementById("overlayCloseBtn").onclick = () => {
    closeOverlay();
  };
  document.getElementById("operationLogBtn").onclick = () => {
    renderOperationLogs();
    document.getElementById("operationLogOverlay").classList.remove("hidden");
  };
  document.getElementById("operationLogCloseBtn").onclick = () => {
    document.getElementById("operationLogOverlay").classList.add("hidden");
  };
  document.getElementById("operationLogOverlay").onkeydown = event => {
    if (event.key === "Escape") {
      document.getElementById("operationLogOverlay").classList.add("hidden");
    }
  };
  document.addEventListener("mousemove", handleMouseMove);
  document.addEventListener("mouseup", finishTaskReorder);
  document.addEventListener("touchmove", handleTouchMove, { passive: false });
  document.addEventListener("touchend", finishTaskReorder);
  document.addEventListener("touchcancel", cancelTaskReorder);
  document.addEventListener("visibilitychange", handleVisibilityChange);

  onValue(
    sharedDataRef,
    handleSharedData,
    error => {
      console.error("Firebaseからデータを読み込めませんでした。", error);
      setSyncStatus(`Firebaseから読み込めませんでした: ${error.message}`, true);
    }
  );
}

document.addEventListener("DOMContentLoaded", init);
