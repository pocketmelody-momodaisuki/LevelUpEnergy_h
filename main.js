import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
import {
  getDatabase,
  get,
  onValue,
  ref,
  set,
  update,
  remove
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-database.js";

const firebaseConfig = {
  apiKey: "AIzaSyBaAfoK3e5gKaNKWD09MJmMct_4uWrcjJw",
  authDomain: "study-task-app-2.firebaseapp.com",
  databaseURL: "https://study-task-app-2-default-rtdb.firebaseio.com",
  projectId: "study-task-app-2",
  storageBucket: "study-task-app-2.firebasestorage.app",
  messagingSenderId: "881027647543",
  appId: "1:881027647543:web:5c22e139388f6ed1f117b2"
};

const LEGACY_STORAGE_KEY = "studyTaskData";
const MAX_OPERATION_LOGS = 500;
const WEEKDAYS = [
  ["mon", "月"],
  ["tue", "火"],
  ["wed", "水"],
  ["thu", "木"],
  ["fri", "金"],
  ["sat", "土"],
  ["sun", "日"]
];
const app = initializeApp(firebaseConfig);
const database = getDatabase(app);
const sharedDataRef = ref(database, "studyTaskData");
let data = { tasks: [], days: {}, logs: [], presets: {} };
let dragons = {};
let currentDragonId = null;
let currentDate = null;
let runningTimerId = null;
let runningSessionSeconds = 0;
let runningBaseSeconds = 0;
let runningTaskId = null;
let screenWakeLock = null;
let wakeLockRequestPending = false;
let confirmActionResolver = null;
let initialDataLoaded = false;
let dragonsLoaded = false;
let currentDragonLoaded = false;
let dragonInitializationStarted = false;
let pendingSave = Promise.resolve();
let pendingDragonSave = Promise.resolve();
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
  const sourcePresets = source.presets && typeof source.presets === "object"
    ? source.presets
    : {};
  const presets = {};
  const logs = Array.isArray(source.logs)
    ? source.logs.filter(entry => entry && typeof entry.timestamp === "string" && typeof entry.message === "string")
    : [];

  Object.entries(sourceDays).forEach(([date, dayTasks]) => {
    if (Array.isArray(dayTasks)) {
      days[date] = dayTasks.filter(task => task && typeof task === "object");
    } else if (dayTasks && typeof dayTasks === "object") {
      const entries = Object.entries(dayTasks);
      if (entries.every(([key]) => /^\d+$/.test(key))) {
        days[date] = entries
          .sort(([left], [right]) => Number(left) - Number(right))
          .map(([, task]) => task)
          .filter(task => task && typeof task === "object");
      }
    }
  });
  Object.entries(sourcePresets).forEach(([id, preset]) => {
    if (!preset || typeof preset !== "object") return;
    const sourceRepeat = preset.repeat && typeof preset.repeat === "object" ? preset.repeat : {};
    const repeat = {};
    WEEKDAYS.forEach(([key]) => {
      repeat[key] = sourceRepeat[key] === true;
    });
    presets[id] = {
      name: typeof preset.name === "string" ? preset.name : "",
      plannedMinutes: Number(preset.plannedMinutes) || 30,
      repeat
    };
  });
  return { tasks, days, logs, presets };
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

function getWeekdayKey(dateStr) {
  const date = new Date(`${dateStr}T00:00:00`);
  if (isNaN(date.getTime())) return null;
  return WEEKDAYS[(date.getDay() + 6) % 7][0];
}

function getTasksFromPresets(dateStr) {
  const weekday = getWeekdayKey(dateStr);
  if (!weekday) return [];
  return Object.values(data.presets)
    .filter(preset => preset.repeat[weekday])
    .map(preset => ({
      id: Date.now() + "_" + Math.random().toString(16).slice(2),
      name: preset.name,
      plannedMinutes: preset.plannedMinutes,
      actualMinutes: null,
      completed: false
    }));
}

function renderPresetList() {
  const list = document.getElementById("presetList");
  list.innerHTML = "";
  const entries = Object.entries(data.presets);
  if (entries.length === 0) {
    const emptyMessage = document.createElement("li");
    emptyMessage.className = "preset-empty";
    emptyMessage.textContent = "プリセットはまだありません。";
    list.appendChild(emptyMessage);
    return;
  }

  entries.forEach(([id, preset]) => {
    const item = document.createElement("li");
    item.className = "preset-item";
    const details = document.createElement("div");
    details.className = "preset-details";
    const name = document.createElement("strong");
    name.textContent = preset.name;
    const schedule = document.createElement("span");
    const repeatedDays = WEEKDAYS
      .filter(([key]) => preset.repeat[key])
      .map(([, label]) => label)
      .join("・");
    schedule.textContent =
      `${preset.plannedMinutes}分 / ${repeatedDays || "曜日指定なし"}`;
    details.append(name, schedule);

    const actions = document.createElement("div");
    actions.className = "preset-actions";
    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.className = "secondary";
    editButton.textContent = "編集";
    editButton.onclick = () => editPreset(id, preset);
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "delete-task-btn";
    deleteButton.textContent = "削除";
    deleteButton.onclick = () => deletePreset(id, preset);
    actions.append(editButton, deleteButton);
    item.append(details, actions);
    list.appendChild(item);
  });
}

function resetPresetForm() {
  document.getElementById("presetForm").reset();
  document.getElementById("presetMinutes").value = "30";
  document.getElementById("presetFormTitle").textContent = "プリセットを追加";
  document.getElementById("savePresetBtn").textContent = "追加";
  document.getElementById("cancelPresetEditBtn").classList.add("hidden");
  document.getElementById("presetError").textContent = "";
  document.getElementById("presetForm").dataset.editingId = "";
}

function editPreset(id, preset) {
  const form = document.getElementById("presetForm");
  form.dataset.editingId = id;
  document.getElementById("presetName").value = preset.name;
  document.getElementById("presetMinutes").value = String(preset.plannedMinutes);
  form.querySelectorAll('input[name="presetDay"]').forEach(checkbox => {
    checkbox.checked = preset.repeat[checkbox.value] === true;
  });
  document.getElementById("presetFormTitle").textContent = "プリセットを編集";
  document.getElementById("savePresetBtn").textContent = "変更を保存";
  document.getElementById("cancelPresetEditBtn").classList.remove("hidden");
  document.getElementById("presetError").textContent = "";
  document.getElementById("presetName").focus();
}

async function deletePreset(id, preset) {
  if (!await showConfirmation(`プリセット「${preset.name}」を削除しますか？`)) return;
  try {
    await remove(ref(database, `studyTaskData/presets/${id}`));
    delete data.presets[id];
    renderPresetList();
    setSyncStatus("Firebaseと同期済み");
  } catch (error) {
    console.error("プリセットの削除に失敗しました。", error);
    document.getElementById("presetError").textContent =
      `プリセットを削除できませんでした: ${error.message}`;
    setSyncStatus(`プリセットの削除に失敗しました: ${error.message}`, true);
  }
}

function setEditingEnabled(enabled) {
  ["datePicker", "addDateBtn", "clearTasksBtn", "addTaskBtn", "operationLogBtn", "openPresetsBtn", "dragonManagerBtn"].forEach(id => {
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
  renderPresetList();
  if (!document.getElementById("operationLogOverlay").classList.contains("hidden")) {
    renderOperationLogs();
  }
}

async function handleSharedData(snapshot) {
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
    : { tasks: [], days: {}, logs: [], presets: {} };
  if (legacyData) data = mergeLegacyData(data, legacyData);

  if (isFirstLoad) {
    initialDataLoaded = true;
    currentDate = getTodayStr();
    document.getElementById("datePicker").value = currentDate;
  }

  const addedToday = !data.days[currentDate];
  if (addedToday) data.days[currentDate] = getTasksFromPresets(currentDate);
  renderData();

  if (legacyData !== null) {
    setEditingEnabled(true);
    saveData(true);
  } else if (addedToday) {
    setEditingEnabled(false);
    try {
      const tasks = data.days[currentDate];
      await pendingSave;
      await update(sharedDataRef, {
        [`days/${currentDate}`]: tasks.length > 0 ? tasks : {}
      });
      const refreshed = await get(sharedDataRef);
      data = normalizeData(refreshed.val());
      renderData();
      setSyncStatus("Firebaseと同期済み");
    } catch (error) {
      console.error("今日の日付の保存に失敗しました。", error);
      setSyncStatus(`今日の日付を保存できませんでした: ${error.message}`, true);
    } finally {
      setEditingEnabled(true);
    }
  } else {
    setEditingEnabled(true);
    if (needsInitialSave) {
      saveData();
    } else if (isFirstLoad) {
      setSyncStatus("Firebaseと同期済み");
    }
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

function createDragon(name) {
  return {
    name: name.slice(0, 10),
    stage: "egg",
    type: null,
    branch: null,
    level: 1,
    xp: 0,
    nextLevelXp: 10,
    attack: 1,
    defense: 1,
    createdAt: getTodayStr(),
    logs: {
      hatchedAt: "",
      becameChildAt: "",
      becameAdultAt: "",
      becameElderAt: "",
      totalTasksCompleted: 0,
      totalXpEarned: 0,
      dailyBonusDates: {}
    }
  };
}

function normalizeDragon(value) {
  const source = value && typeof value === "object" ? value : {};
  const level = Number.isInteger(source.level) && source.level > 0 ? source.level : 1;
  const logs = source.logs && typeof source.logs === "object" ? source.logs : {};
  const stage = ["egg", "child", "adult", "elder"].includes(source.stage) ? source.stage : "egg";
  const validType = ["cute", "cool", "yuru"].includes(source.type);
  return {
    name: typeof source.name === "string" ? source.name.slice(0, 10) : "たまご",
    stage,
    type: stage === "egg" ? null : validType ? source.type : "cute",
    branch: stage === "elder"
      ? source.branch === 1 ? 1 : 0
      : null,
    level,
    xp: Number.isFinite(source.xp) && source.xp >= 0 ? source.xp : 0,
    nextLevelXp: Number.isFinite(source.nextLevelXp) && source.nextLevelXp > 0
      ? source.nextLevelXp
      : level * 10,
    attack: Number.isFinite(source.attack) && source.attack >= 1 ? source.attack : 1,
    defense: Number.isFinite(source.defense) && source.defense >= 1 ? source.defense : 1,
    createdAt: typeof source.createdAt === "string" ? source.createdAt : getTodayStr(),
    logs: {
      hatchedAt: typeof logs.hatchedAt === "string" ? logs.hatchedAt : "",
      becameChildAt: typeof logs.becameChildAt === "string" ? logs.becameChildAt : "",
      becameAdultAt: typeof logs.becameAdultAt === "string" ? logs.becameAdultAt : "",
      becameElderAt: typeof logs.becameElderAt === "string" ? logs.becameElderAt : "",
      totalTasksCompleted: Number.isFinite(logs.totalTasksCompleted)
        ? logs.totalTasksCompleted
        : 0,
      totalXpEarned: Number.isFinite(logs.totalXpEarned) ? logs.totalXpEarned : 0,
      dailyBonusDates: logs.dailyBonusDates && typeof logs.dailyBonusDates === "object"
        ? logs.dailyBonusDates
        : {}
    }
  };
}

function getDragonImagePath(dragon) {
  if (dragon.stage === "egg") return "/images/dragons/egg.png";
  const branchSuffix = dragon.stage === "elder" ? `_${dragon.branch}` : "";
  return `/images/dragons/${dragon.stage}_${dragon.type}${branchSuffix}.png`;
}

function getDragonRarity(dragon) {
  if (dragon.stage === "elder") return dragon.branch === 1 ? 4 : 3;
  if (dragon.stage === "adult") return 2;
  return 1;
}

function persistDragon(id, dragon) {
  const snapshot = JSON.parse(JSON.stringify(dragon));
  pendingDragonSave = pendingDragonSave
    .then(() => set(ref(database, `dragons/${id}`), snapshot))
    .catch(error => {
      console.error("ドラゴンの保存に失敗しました。", error);
      document.getElementById("dragonStatus").textContent =
        `ドラゴンを保存できませんでした: ${error.message}`;
      setSyncStatus(`ドラゴンの保存に失敗しました: ${error.message}`, true);
    });
  return pendingDragonSave;
}

function renderDragonMemories(dragon) {
  const logs = dragon.logs || {};
  document.getElementById("memoryHatched").textContent = logs.hatchedAt || "まだ";
  document.getElementById("memoryChild").textContent = logs.becameChildAt || "まだ";
  document.getElementById("memoryAdult").textContent = logs.becameAdultAt || "まだ";
  document.getElementById("memoryElder").textContent = logs.becameElderAt || "まだ";
  document.getElementById("memoryTasks").textContent = String(logs.totalTasksCompleted || 0);
  document.getElementById("memoryXp").textContent = String(logs.totalXpEarned || 0);
}

function renderDragonCollection() {
  const collection = document.getElementById("dragonCollection");
  collection.innerHTML = "";
  Object.entries(dragons).forEach(([id, dragon]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "dragon-collection-item";
    if (id === currentDragonId) button.classList.add("active");
    button.setAttribute("aria-label", `${dragon.name}、レア度${getDragonRarity(dragon)}`);
    button.onclick = async () => {
      try {
        await set(ref(database, "currentDragon"), id);
        currentDragonId = id;
        renderDragonManager();
      } catch (error) {
        console.error("育成中のドラゴンの切り替えに失敗しました。", error);
        document.getElementById("dragonStatus").textContent =
          `ドラゴンを切り替えられませんでした: ${error.message}`;
      }
    };
    const image = document.createElement("img");
    image.src = getDragonImagePath(dragon);
    image.alt = "";
    const rarity = document.createElement("span");
    rarity.className = "dragon-rarity";
    rarity.textContent = "★".repeat(getDragonRarity(dragon));
    const name = document.createElement("span");
    name.className = "dragon-collection-name";
    name.textContent = dragon.name;
    button.append(image, rarity, name);
    collection.appendChild(button);
  });
}

function renderDragonManager() {
  const dragon = dragons[currentDragonId];
  const panel = document.getElementById("dragonCurrentPanel");
  const newDragonForm = document.getElementById("newDragonForm");
  if (!dragon) {
    panel.classList.add("hidden");
    newDragonForm.classList.add("hidden");
    renderDragonCollection();
    return;
  }

  panel.classList.remove("hidden");
  panel.dataset.type = dragon.type || "egg";
  const image = document.getElementById("dragonImage");
  image.src = getDragonImagePath(dragon);
  image.alt = `${dragon.name}（${dragon.stage}）`;
  document.getElementById("dragonNameInput").value = dragon.name;
  document.getElementById("dragonStageLabel").textContent =
    ({ egg: "🥚 卵", child: "🐣 子竜", adult: "🐉 成竜", elder: "🐲 古竜" })[dragon.stage] || dragon.stage;
  document.getElementById("dragonLevelLabel").textContent = `Lv. ${dragon.level}`;
  const xpPercent = dragon.nextLevelXp > 0
    ? Math.min(100, Math.round((dragon.xp / dragon.nextLevelXp) * 100))
    : 0;
  const xpTrack = document.querySelector(".dragon-xp-track");
  xpTrack.setAttribute("aria-valuemax", String(dragon.nextLevelXp));
  xpTrack.setAttribute("aria-valuenow", String(dragon.xp));
  document.getElementById("dragonXpFill").style.width = `${xpPercent}%`;
  document.getElementById("dragonXpLabel").textContent =
    `XP ${dragon.xp} / ${dragon.nextLevelXp}`;
  document.getElementById("dragonStats").textContent =
    `攻撃力 ${dragon.attack}　/　防御力 ${dragon.defense}`;
  const typeLabel = ({ cute: "キュート", cool: "クール", yuru: "ゆる" })[dragon.type];
  document.getElementById("dragonType").textContent =
    typeLabel ? `属性: ${typeLabel}` : "属性: 孵化後に決定";
  newDragonForm.classList.toggle(
    "hidden",
    !Object.values(dragons).some(item => item.stage === "elder")
  );
  renderDragonMemories(dragon);
  renderDragonCollection();
}

function getLocalDateString() {
  return getTodayStr();
}

function applyDragonEvolution(dragon) {
  const today = getLocalDateString();
  if (dragon.level >= 5 && dragon.stage === "egg") {
    const types = ["cute", "cool", "yuru"];
    dragon.type = types[Math.floor(Math.random() * types.length)];
    dragon.stage = "child";
    dragon.logs.hatchedAt = today;
    dragon.logs.becameChildAt = today;
  }
  if (dragon.level >= 10 && dragon.stage === "child") {
    dragon.stage = "adult";
    dragon.logs.becameAdultAt = today;
  }
  if (dragon.level >= 20 && dragon.stage === "adult") {
    dragon.stage = "elder";
    dragon.branch = Math.floor(Math.random() * 2);
    dragon.logs.becameElderAt = today;
  }
}

function addDragonXp(dragon, amount) {
  dragon.xp += amount;
  dragon.logs.totalXpEarned = (dragon.logs.totalXpEarned || 0) + amount;
  while (dragon.xp >= dragon.nextLevelXp) {
    dragon.xp -= dragon.nextLevelXp;
    dragon.level += 1;
    dragon.nextLevelXp = dragon.level * 10;
    const targets = Math.floor(Math.random() * 3);
    const statGain = 1 + Math.floor(Math.random() * 3);
    if (targets !== 1) dragon.attack += statGain;
    if (targets !== 0) dragon.defense += statGain;
    applyDragonEvolution(dragon);
  }
}

function awardDragonRewardsForCompletion(date, task) {
  const dragon = dragons[currentDragonId];
  if (!dragon || task.dragonXpAwarded) return;
  task.dragonXpAwarded = true;
  dragon.logs.totalTasksCompleted = (dragon.logs.totalTasksCompleted || 0) + 1;
  addDragonXp(dragon, 1);

  const dayTasks = data.days[date] || [];
  const dailyBonusDates = dragon.logs.dailyBonusDates || {};
  if (
    dayTasks.length > 0 &&
    dayTasks.every(dayTask => dayTask.completed) &&
    !dailyBonusDates[date]
  ) {
    dragon.logs.dailyBonusDates = dailyBonusDates;
    dailyBonusDates[date] = true;
    addDragonXp(dragon, 5);
  }
  void persistDragon(currentDragonId, dragon);
  renderDragonManager();
}

function initializeDragonData() {
  if (!dragonsLoaded || !currentDragonLoaded || dragonInitializationStarted) return;
  dragonInitializationStarted = true;
  if (!dragons[currentDragonId]) {
    const firstDragonId = Object.keys(dragons)[0];
    if (firstDragonId) {
      currentDragonId = firstDragonId;
      void set(ref(database, "currentDragon"), firstDragonId).catch(error => {
        console.error("育成中のドラゴンを設定できませんでした。", error);
        setSyncStatus(`育成中のドラゴンを設定できませんでした: ${error.message}`, true);
      });
    } else {
      const id = typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const dragon = createDragon("たまご");
      dragons[id] = dragon;
      currentDragonId = id;
      void persistDragon(id, dragon);
      void set(ref(database, "currentDragon"), id).catch(error => {
        console.error("育成中のドラゴンを設定できませんでした。", error);
        setSyncStatus(`育成中のドラゴンを設定できませんでした: ${error.message}`, true);
      });
    }
  }
  renderDragonManager();
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
    const wasCompleted = task.completed === true;
    task.completed = cb.checked;
    if (!wasCompleted && task.completed) {
      awardDragonRewardsForCompletion(currentDate, task);
    }
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
    const wasCompleted = task.completed === true;
    task.completed = true;
    if (!wasCompleted) {
      awardDragonRewardsForCompletion(currentDate, task);
    }
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
  document.getElementById("addDateBtn").onclick = async () => {
    const selected = datePicker.value;
    if (!selected) return;
    const isNewDate = !data.days[selected];
    let canSelectDate = true;
    if (isNewDate) {
      const previousLogs = data.logs.slice();
      const tasks = getTasksFromPresets(selected);
      data.days[selected] = tasks;
      addOperationLog(
        `${formatLogDate(selected)}のタスクリストを作成しました。` +
        (tasks.length > 0 ? `（プリセットから${tasks.length}件追加）` : "")
      );
      setSyncStatus("Firebaseに保存中...");
      document.getElementById("addDateBtn").disabled = true;
      try {
        await pendingSave;
        const updates = {
          [`days/${selected}`]: tasks.length > 0 ? tasks : {},
          logs: data.logs
        };
        await update(sharedDataRef, updates);
        const snapshot = await get(sharedDataRef);
        const refreshedData = normalizeData(snapshot.val());
        if (!refreshedData.days[selected]) {
          throw new Error("保存後に日付を読み込めませんでした。");
        }
        data = refreshedData;
        setSyncStatus("Firebaseと同期済み");
      } catch (error) {
        console.error("新しい日付の保存に失敗しました。", error);
        delete data.days[selected];
        data.logs = previousLogs;
        canSelectDate = false;
        setSyncStatus(`新しい日付を保存できませんでした: ${error.message}`, true);
      } finally {
        document.getElementById("addDateBtn").disabled = false;
      }
    } else {
      ensureDay(selected);
    }
    if (canSelectDate) {
      currentDate = selected;
      document.getElementById("datePicker").value = selected;
    }
    renderDateList();
    renderTaskList();
  };
  document.getElementById("openPresetsBtn").onclick = () => {
    renderPresetList();
    document.getElementById("presetsOverlay").classList.remove("hidden");
    document.getElementById("presetName").focus();
  };
  document.getElementById("closePresetsBtn").onclick = () => {
    document.getElementById("presetsOverlay").classList.add("hidden");
    resetPresetForm();
  };
  document.getElementById("cancelPresetEditBtn").onclick = resetPresetForm;
  document.getElementById("presetsOverlay").onkeydown = event => {
    if (event.key === "Escape") {
      document.getElementById("presetsOverlay").classList.add("hidden");
      resetPresetForm();
    }
  };
  document.getElementById("presetForm").onsubmit = async event => {
    event.preventDefault();
    const name = document.getElementById("presetName").value.trim();
    const plannedMinutes = Number(document.getElementById("presetMinutes").value);
    const errorElement = document.getElementById("presetError");
    if (!name || !Number.isInteger(plannedMinutes) || plannedMinutes < 1) {
      errorElement.textContent = "タスク名と1分以上の所要時間を入力してください。";
      return;
    }

    const repeat = {};
    document.querySelectorAll('#presetForm input[name="presetDay"]').forEach(checkbox => {
      repeat[checkbox.value] = checkbox.checked;
    });
    const preset = { name, plannedMinutes, repeat };
    const editingId = event.currentTarget.dataset.editingId;
    const id = editingId || (
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}_${Math.random().toString(16).slice(2)}`
    );
    try {
      await set(ref(database, `studyTaskData/presets/${id}`), preset);
      data.presets[id] = preset;
      renderPresetList();
      resetPresetForm();
      setSyncStatus("Firebaseと同期済み");
    } catch (error) {
      console.error("プリセットの保存に失敗しました。", error);
      errorElement.textContent = `プリセットを保存できませんでした: ${error.message}`;
      setSyncStatus(`プリセットの保存に失敗しました: ${error.message}`, true);
    }
  };
  document.getElementById("dragonManagerBtn").onclick = () => {
    renderDragonManager();
    document.getElementById("dragonOverlay").classList.remove("hidden");
  };
  document.getElementById("closeDragonBtn").onclick = () => {
    document.getElementById("dragonOverlay").classList.add("hidden");
  };
  document.getElementById("dragonOverlay").onkeydown = event => {
    if (event.key === "Escape") {
      document.getElementById("dragonOverlay").classList.add("hidden");
    }
  };
  document.getElementById("saveDragonNameBtn").onclick = async () => {
    const dragon = dragons[currentDragonId];
    const nameInput = document.getElementById("dragonNameInput");
    const name = nameInput.value.trim();
    if (!dragon || !name || name.length > 10) {
      document.getElementById("dragonStatus").textContent =
        "ドラゴンの名前を1〜10文字で入力してください。";
      return;
    }
    dragon.name = name;
    document.getElementById("dragonStatus").textContent = "";
    await persistDragon(currentDragonId, dragon);
    renderDragonManager();
  };
  document.getElementById("dragonMemoriesBtn").onclick = () => {
    document.getElementById("dragonMemories").classList.toggle("hidden");
  };
  document.getElementById("newDragonForm").onsubmit = async event => {
    event.preventDefault();
    const name = document.getElementById("newDragonName").value.trim();
    if (!name || name.length > 10) {
      document.getElementById("dragonStatus").textContent =
        "新しい卵の名前を1〜10文字で入力してください。";
      return;
    }
    if (!Object.values(dragons).some(dragon => dragon.stage === "elder")) return;
    const id = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const dragon = createDragon(name);
    try {
      await update(ref(database), {
        [`dragons/${id}`]: dragon,
        currentDragon: id
      });
      dragons[id] = dragon;
      currentDragonId = id;
      document.getElementById("newDragonName").value = "たまご";
      document.getElementById("dragonStatus").textContent = "";
      renderDragonManager();
    } catch (error) {
      console.error("新しい卵の追加に失敗しました。", error);
      document.getElementById("dragonStatus").textContent =
        `新しい卵を追加できませんでした: ${error.message}`;
      setSyncStatus(`新しい卵の追加に失敗しました: ${error.message}`, true);
    }
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
  onValue(
    ref(database, "dragons"),
    snapshot => {
      const value = snapshot.val();
      dragons = value && typeof value === "object"
        ? Object.fromEntries(
          Object.entries(value).map(([id, dragon]) => [id, normalizeDragon(dragon)])
        )
        : {};
      dragonsLoaded = true;
      initializeDragonData();
      renderDragonManager();
    },
    error => {
      console.error("ドラゴン一覧を読み込めませんでした。", error);
      document.getElementById("dragonStatus").textContent =
        `ドラゴンを読み込めませんでした: ${error.message}`;
    }
  );
  onValue(
    ref(database, "currentDragon"),
    snapshot => {
      currentDragonId = typeof snapshot.val() === "string" ? snapshot.val() : null;
      currentDragonLoaded = true;
      initializeDragonData();
      renderDragonManager();
    },
    error => {
      console.error("育成中のドラゴンを読み込めませんでした。", error);
      document.getElementById("dragonStatus").textContent =
        `育成中のドラゴンを読み込めませんでした: ${error.message}`;
    }
  );
}

document.addEventListener("DOMContentLoaded", init);
