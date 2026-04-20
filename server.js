const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = Number.parseInt(process.env.PORT, 10) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "vaelkommen!";
const chatHistory = [];
const MAX_HISTORY = 500;
const HISTORY_FILE = path.join(__dirname, "chat-history.json");
const SETTINGS_FILE = path.join(__dirname, "seminar-settings.json");
const DEFAULT_RULES = {
  timeLimitSec: 0,
  maxChars: 0,
  visibilityDelaySec: 0,
  turnModeEnabled: false,
  turnMinSec: 10,
  turnMaxSec: 20,
  handoverEnabled: false,
  handoverSec: 12,
  noUndoEnabled: false,
  scoreboardEnabled: true
};
let globalRules = { ...DEFAULT_RULES };
let transformRules = [];
const users = new Map();
const stats = new Map();
const draftBySocket = new Map();
let turnState = {
  enabled: false,
  writerId: null,
  writerName: "",
  endsAt: null
};
let turnTimer = null;

app.use(express.static("public"));

const colors = [
  "#e57373","#64b5f6","#81c784","#ffb74d",
  "#ba68c8","#4db6ac","#f06292","#9575cd"
];

function loadHistory() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return;

    const content = fs.readFileSync(HISTORY_FILE, "utf8");
    const parsed = JSON.parse(content);

    if (Array.isArray(parsed)) {
      const trimmed = parsed.slice(-MAX_HISTORY);
      chatHistory.push(...trimmed);
    }
  } catch (error) {
    console.error("Konnte Chat-Verlauf nicht laden:", error.message);
  }
}

function saveHistory() {
  fs.writeFile(HISTORY_FILE, JSON.stringify(chatHistory, null, 2), (error) => {
    if (error) {
      console.error("Konnte Chat-Verlauf nicht speichern:", error.message);
    }
  });
}

loadHistory();

function loadSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return;
    const content = fs.readFileSync(SETTINGS_FILE, "utf8");
    const parsed = JSON.parse(content);

    if (parsed && typeof parsed === "object") {
      globalRules = sanitizeRules(parsed.globalRules || globalRules);
      transformRules = sanitizeTransformRules(parsed.transformRules || []);
    }
  } catch (error) {
    console.error("Konnte Einstellungen nicht laden:", error.message);
  }
}

function saveSettings() {
  const data = {
    globalRules,
    transformRules
  };

  fs.writeFile(SETTINGS_FILE, JSON.stringify(data, null, 2), (error) => {
    if (error) {
      console.error("Konnte Einstellungen nicht speichern:", error.message);
    }
  });
}

function toSafeNonNegativeInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function sanitizeRules(nextRules = {}) {
  const visibilityDelaySource = nextRules.visibilityDelaySec ?? nextRules.sendDelaySec;
  const turnMinSec = toSafeNonNegativeInt(nextRules.turnMinSec, globalRules.turnMinSec);
  const turnMaxRaw = toSafeNonNegativeInt(nextRules.turnMaxSec, globalRules.turnMaxSec);
  const turnMaxSec = Math.max(turnMinSec, turnMaxRaw);
  const handoverSec = Math.max(1, toSafeNonNegativeInt(nextRules.handoverSec, globalRules.handoverSec));

  return {
    timeLimitSec: toSafeNonNegativeInt(nextRules.timeLimitSec, globalRules.timeLimitSec),
    maxChars: toSafeNonNegativeInt(nextRules.maxChars, globalRules.maxChars),
    visibilityDelaySec: toSafeNonNegativeInt(
      visibilityDelaySource,
      globalRules.visibilityDelaySec
    ),
    turnModeEnabled: Boolean(nextRules.turnModeEnabled),
    turnMinSec,
    turnMaxSec,
    handoverEnabled: Boolean(nextRules.handoverEnabled),
    handoverSec,
    noUndoEnabled: Boolean(nextRules.noUndoEnabled),
    scoreboardEnabled: nextRules.scoreboardEnabled !== undefined
      ? Boolean(nextRules.scoreboardEnabled)
      : Boolean(globalRules.scoreboardEnabled)
  };
}

function sanitizeTransformRules(list = []) {
  if (!Array.isArray(list)) return [];

  return list
    .map((rule) => {
      if (!rule || typeof rule !== "object") return null;

      const from = String(rule.from || "").trim().toLowerCase();
      const to = Array.isArray(rule.to)
        ? rule.to.map((v) => String(v).trim()).filter(Boolean)
        : String(rule.to || "")
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean);
      const chanceRaw = typeof rule.chance === "number"
        ? rule.chance
        : Number.parseFloat(rule.chance);
      const chance = Number.isFinite(chanceRaw)
        ? Math.min(1, Math.max(0, chanceRaw > 1 ? chanceRaw / 100 : chanceRaw))
        : 0.7;

      if (!from || to.length === 0) return null;
      return { from, to, chance };
    })
    .filter(Boolean);
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function applyCase(original, replacement) {
  if (original === original.toUpperCase()) {
    return replacement.toUpperCase();
  }
  if (original[0] && original[0] === original[0].toUpperCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

function transformWord(word) {
  let transformed = word;

  transformRules.forEach((rule) => {
    if (transformed.toLowerCase() === rule.from && Math.random() < rule.chance) {
      transformed = applyCase(transformed, pick(rule.to));
    }
  });

  return transformed;
}

function transformMessageText(text) {
  if (!transformRules.length) return text;

  return text.replace(/([\p{L}\p{N}_'-]+)/gu, (word) => transformWord(word));
}

function getParticipants() {
  return Array.from(users.values()).map((u) => ({
    socketId: u.socketId,
    name: u.name,
    color: u.color,
    group: u.group
  }));
}

function getScoreboardRows() {
  return Array.from(stats.entries())
    .map(([socketId, s]) => {
      const user = users.get(socketId);
      if (!user || !user.name) return null;
      return {
        socketId,
        name: user.name,
        color: user.color,
        group: user.group,
        messages: s.messages,
        chars: s.chars
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.messages - a.messages || b.chars - a.chars);
}

function emitParticipants() {
  io.fetchSockets().then((sockets) => {
    const participants = getParticipants();
    sockets.forEach((socket) => {
      if (socket.data && socket.data.isAdmin) {
        socket.emit("participants", participants);
      }
    });
  }).catch(() => {});
}

function emitScoreboard() {
  io.emit("scoreboardUpdate", getScoreboardRows());
}

function replaceHistory(nextHistory = []) {
  chatHistory.length = 0;
  chatHistory.push(...nextHistory.slice(-MAX_HISTORY));
  saveHistory();
  io.emit("historyReplace", chatHistory);
}

function isValidAdminPassword(password) {
  return typeof password === "string" && password === ADMIN_PASSWORD;
}

function emitAdminData(socket) {
  if (!socket || !socket.data || !socket.data.isAdmin) return;

  socket.emit("adminData", {
    rules: globalRules,
    transformRules,
    participants: getParticipants(),
    scoreboard: getScoreboardRows(),
    turnState,
    history: chatHistory
  });
}

function requireAdmin(socket) {
  return Boolean(socket && socket.data && socket.data.isAdmin);
}

function clearTurnTimer() {
  if (turnTimer) {
    clearTimeout(turnTimer);
    turnTimer = null;
  }
}

function getEligibleWriterIds() {
  return Array.from(users.values())
    .filter((u) => Boolean(u.name))
    .map((u) => u.socketId);
}

function randomIntInclusive(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function emitTurnState() {
  io.emit("turnState", turnState);
}

function scheduleNextTurn() {
  clearTurnTimer();
  const previousWriterId = turnState.writerId;
  const previousWriter = previousWriterId ? users.get(previousWriterId) : null;
  const previousDraft = previousWriterId ? (draftBySocket.get(previousWriterId) || "") : "";

  if (!globalRules.turnModeEnabled) {
    turnState = { enabled: false, writerId: null, writerName: "", endsAt: null };
    emitTurnState();
    return;
  }

  const eligible = getEligibleWriterIds();
  if (eligible.length === 0) {
    turnState = { enabled: true, writerId: null, writerName: "", endsAt: null };
    emitTurnState();
    turnTimer = setTimeout(() => scheduleNextTurn(), 2000);
    return;
  }

  let writerPool = eligible;
  if (previousWriterId && eligible.length > 1) {
    writerPool = eligible.filter((id) => id !== previousWriterId);
    if (!writerPool.length) writerPool = eligible;
  }

  const writerId = writerPool[Math.floor(Math.random() * writerPool.length)];
  const writer = users.get(writerId);
  const durationSec = globalRules.handoverEnabled
    ? globalRules.handoverSec
    : randomIntInclusive(globalRules.turnMinSec, globalRules.turnMaxSec);
  const endsAt = Date.now() + (durationSec * 1000);

  turnState = {
    enabled: true,
    writerId,
    writerName: writer ? writer.name : "",
    endsAt
  };
  emitTurnState();

  if (
    globalRules.handoverEnabled &&
    previousWriterId &&
    previousDraft &&
    writerId &&
    writerId !== previousWriterId
  ) {
    io.to(writerId).emit("draftHandover", {
      text: previousDraft,
      fromName: previousWriter ? previousWriter.name : "Unbekannt"
    });
    io.to(previousWriterId).emit("draftTakenOver", {
      byName: writer ? writer.name : "Jemand"
    });
    draftBySocket.set(previousWriterId, "");
    draftBySocket.set(writerId, previousDraft);
  }

  turnTimer = setTimeout(() => scheduleNextTurn(), durationSec * 1000);
}

loadSettings();

io.on("connection", (socket) => {
  socket.data.isAdmin = false;
  users.set(socket.id, {
    socketId: socket.id,
    name: null,
    color: "#999999",
    group: "Gruppe A"
  });
  stats.set(socket.id, { messages: 0, chars: 0 });

  socket.on("join", (name) => {
    socket.username = name.toUpperCase();
    socket.color = colors[Math.floor(Math.random() * colors.length)];
    const user = users.get(socket.id);
    if (user) {
      user.name = socket.username;
      user.color = socket.color;
    }

    socket.emit("init", {
      socketId: socket.id,
      name: socket.username,
      color: socket.color,
      history: chatHistory,
      rules: globalRules
    });

    emitParticipants();
    emitScoreboard();
    if (globalRules.turnModeEnabled) {
      scheduleNextTurn();
    } else {
      emitTurnState();
    }
  });

  socket.on("adminLogin", (password) => {
    if (!isValidAdminPassword(password)) {
      socket.data.isAdmin = false;
      socket.emit("adminAuthResult", { ok: false });
      return;
    }

    socket.data.isAdmin = true;
    socket.emit("adminAuthResult", { ok: true });
    emitAdminData(socket);
  });

  socket.on("message", (msg) => {
    if (!socket.username) return;
    if (typeof msg !== "string") return;
    if (globalRules.turnModeEnabled && turnState.writerId !== socket.id) return;

    const cleaned = msg.trim();
    if (!cleaned) return;

    const limitedText = globalRules.maxChars > 0
      ? cleaned.slice(0, globalRules.maxChars)
      : cleaned;
    const finalText = transformMessageText(limitedText);
    draftBySocket.set(socket.id, "");
    const userStats = stats.get(socket.id);
    if (userStats) {
      userStats.messages += 1;
      userStats.chars += finalText.length;
      emitScoreboard();
    }

    const message = {
      id: crypto.randomUUID(),
      user: socket.username,
      text: finalText,
      color: socket.color,
      time: new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
      })
    };

    chatHistory.push(message);
    if (chatHistory.length > MAX_HISTORY) {
      chatHistory.shift();
    }
    saveHistory();

    if (globalRules.visibilityDelaySec > 0) {
      const visibleAt = Date.now() + (globalRules.visibilityDelaySec * 1000);

      io.emit("messagePending", {
        id: message.id,
        user: message.user,
        color: message.color,
        time: message.time,
        senderId: socket.id,
        visibleAt
      });

      setTimeout(() => {
        socket.broadcast.emit("messageReveal", {
          id: message.id,
          text: message.text
        });
      }, globalRules.visibilityDelaySec * 1000);
      return;
    }

    io.emit("message", message);
  });

  socket.on("updateRules", (nextRules) => {
    if (!requireAdmin(socket)) return;

    const beforeTurnEnabled = globalRules.turnModeEnabled;
    const beforeHandoverEnabled = globalRules.handoverEnabled;
    const beforeHandoverSec = globalRules.handoverSec;
    globalRules = sanitizeRules(nextRules);
    saveSettings();
    io.emit("rules", globalRules);

    const turnJustToggled = globalRules.turnModeEnabled !== beforeTurnEnabled;
    const handoverChanged =
      globalRules.handoverEnabled !== beforeHandoverEnabled ||
      globalRules.handoverSec !== beforeHandoverSec;

    if (turnJustToggled || (globalRules.turnModeEnabled && handoverChanged)) {
      scheduleNextTurn();
    }
  });

  socket.on("resetRules", () => {
    if (!requireAdmin(socket)) return;

    globalRules = { ...DEFAULT_RULES };
    transformRules = [];
    saveSettings();
    io.emit("rules", globalRules);
    if (!globalRules.turnModeEnabled) scheduleNextTurn();
    emitAdminData(socket);
  });

  socket.on("clearHistory", () => {
    if (!requireAdmin(socket)) return;

    replaceHistory([]);
    io.emit("historyClear");
  });

  socket.on("importHistory", (nextHistory) => {
    if (!requireAdmin(socket)) return;
    if (!Array.isArray(nextHistory)) return;

    const sanitized = nextHistory
      .map((item) => {
        if (!item || typeof item !== "object") return null;
        const user = String(item.user || "").trim();
        const text = String(item.text || "").trim();
        const color = String(item.color || "#666666").trim() || "#666666";
        const time = String(item.time || "").trim();
        if (!user || !text) return null;
        return {
          id: crypto.randomUUID(),
          user,
          text,
          color,
          time: time || new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        };
      })
      .filter(Boolean);

    replaceHistory(sanitized);
    socket.emit("historyImportDone", { count: sanitized.length });
  });

  socket.on("updateTransformRules", (nextTransformRules) => {
    if (!requireAdmin(socket)) return;

    transformRules = sanitizeTransformRules(nextTransformRules);
    saveSettings();
    socket.emit("adminTransformRulesUpdated", transformRules);
  });

  socket.on("updateUserGroup", (payload) => {
    if (!requireAdmin(socket)) return;

    const socketId = payload && payload.socketId;
    const nextGroup = String((payload && payload.group) || "").trim();
    if (!socketId || !nextGroup) return;

    const user = users.get(socketId);
    if (!user) return;
    user.group = nextGroup;
    emitParticipants();
    emitScoreboard();
    socket.emit("adminGroupsUpdated");
  });

  socket.on("draftUpdate", (draftText) => {
    if (typeof draftText !== "string") return;
    draftBySocket.set(socket.id, draftText.slice(0, 2000));
  });

  socket.on("disconnect", () => {
    users.delete(socket.id);
    stats.delete(socket.id);
    draftBySocket.delete(socket.id);
    emitParticipants();
    emitScoreboard();

    if (globalRules.turnModeEnabled) {
      if (turnState.writerId === socket.id) {
        scheduleNextTurn();
      } else if (getEligibleWriterIds().length === 0) {
        scheduleNextTurn();
      }
    }
  });

});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`läuft auf http://localhost:${PORT}`);
});
