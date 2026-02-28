const express = require("express");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");

function createSeatMap() {
  const seatMap = {};
  const columns = ["A", "B", "C", "D", "E"];
  const rows = 6;

  for (let row = 1; row <= rows; row += 1) {
    for (const col of columns) {
      const seatCode = `${col}${row}`;
      seatMap[seatCode] = null;
    }
  }

  return seatMap;
}

function getDefaultState() {
  return {
    status: "waiting", // waiting | open | closed
    students: [],
    seats: createSeatMap()
  };
}

function ensureStateFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(STATE_FILE)) {
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify(getDefaultState(), null, 2),
      "utf-8"
    );
  }
}

function readState() {
  ensureStateFile();

  try {
    const raw = fs.readFileSync(STATE_FILE, "utf-8");
    const parsed = JSON.parse(raw);

    if (!parsed.status) parsed.status = "waiting";
    if (!Array.isArray(parsed.students)) parsed.students = [];
    if (!parsed.seats) parsed.seats = createSeatMap();

    return parsed;
  } catch (error) {
    const fallback = getDefaultState();
    writeState(fallback);
    return fallback;
  }
}

function writeState(state) {
  ensureStateFile();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

function notifyStateChanged() {
  io.emit("state-changed");
}

function hasAnyAssignedSeat(seats) {
  return Object.values(seats).some((value) => value !== null);
}

function sanitizeStudents(inputStudents) {
  if (!Array.isArray(inputStudents)) {
    throw new Error("학생 목록 형식이 올바르지 않습니다.");
  }

  const cleaned = inputStudents.map((student) => ({
    name: String(student.name || "").trim(),
    number: String(student.number || "").trim()
  }));

  if (cleaned.some((student) => !student.name || !student.number)) {
    throw new Error("이름과 학번은 모두 필요합니다.");
  }

  const usedNames = new Set();
  const usedNumbers = new Set();

  for (const student of cleaned) {
    if (usedNames.has(student.name)) {
      throw new Error("중복된 이름이 있습니다.");
    }
    if (usedNumbers.has(student.number)) {
      throw new Error("중복된 학번이 있습니다.");
    }

    usedNames.add(student.name);
    usedNumbers.add(student.number);
  }

  return cleaned;
}

function findStudentByCredentials(state, name, number) {
  return state.students.find(
    (student) => student.name === name && student.number === number
  );
}

function findStudentSeat(state, name, number) {
  for (const [seatCode, occupant] of Object.entries(state.seats)) {
    if (
      occupant &&
      occupant.name === name &&
      occupant.number === number
    ) {
      return seatCode;
    }
  }
  return null;
}

function getPublicStudents(state) {
  return state.students.map((student) => ({
    name: student.name
  }));
}

function getPublicState(state) {
  return {
    status: state.status,
    seats: state.seats
  };
}

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

app.get("/healthz", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.status(200).json({ ok: true, db: "ok" });
  } catch(e) {
    res.status(500).json({ ok: true, db: "fail" });
  }
});

app.get("/", (req, res) => {
  res.redirect("/teacher");
});

app.get("/teacher", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "teacher.html"));
});

app.get("/student", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "student.html"));
});

/* ---------------------------
   Teacher API
--------------------------- */

app.get("/api/teacher/state", (req, res) => {
  const state = readState();
  res.json(state);
});

app.post("/api/teacher/students", (req, res) => {
  try {
    const state = readState();

    if (state.status !== "waiting" || hasAnyAssignedSeat(state.seats)) {
      return res.status(400).json({
        message: "학생 정보는 자리 배정 시작 전에만 저장할 수 있습니다."
      });
    }

    const students = sanitizeStudents(req.body.students);
    state.students = students;
    writeState(state);
    notifyStateChanged();

    res.json({
      message: "학생 정보가 저장되었습니다.",
      students: state.students
    });
  } catch (error) {
    res.status(400).json({
      message: error.message || "학생 정보 저장에 실패했습니다."
    });
  }
});

app.post("/api/teacher/start", (req, res) => {
  const state = readState();

  if (state.students.length === 0) {
    return res.status(400).json({
      message: "먼저 학생 정보를 저장해 주세요."
    });
  }

  state.status = "open";
  writeState(state);
  notifyStateChanged();

  res.json({
    message: "자리 선택이 시작되었습니다.",
    status: state.status
  });
});

app.post("/api/teacher/finish", (req, res) => {
  const state = readState();
  state.status = "closed";
  writeState(state);
  notifyStateChanged();

  res.json({
    message: "자리 배정이 완료되었습니다.",
    status: state.status
  });
});

app.post("/api/teacher/reset", (req, res) => {
  const state = readState();
  state.status = "waiting";
  state.seats = createSeatMap();
  writeState(state);
  notifyStateChanged();

  res.json({
    message: "좌석 배정이 초기화되었습니다.",
    status: state.status,
    seats: state.seats
  });
});

/* ---------------------------
   Public / Student API
--------------------------- */

app.get("/api/public/state", (req, res) => {
  const state = readState();
  res.json(getPublicState(state));
});

app.get("/api/public/students", (req, res) => {
  const state = readState();
  res.json(getPublicStudents(state));
});

app.post("/api/student/login", (req, res) => {
  const state = readState();
  const name = String(req.body.name || "").trim();
  const number = String(req.body.number || "").trim();

  if (!name || !number) {
    return res.status(400).json({
      message: "이름과 학번을 모두 입력해 주세요."
    });
  }

  const matchedStudent = findStudentByCredentials(state, name, number);

  if (!matchedStudent) {
    return res.status(401).json({
      message: "이름 또는 학번이 일치하지 않습니다."
    });
  }

  res.json({
    message: "본인 확인이 완료되었습니다.",
    student: {
      name: matchedStudent.name,
      number: matchedStudent.number
    }
  });
});

app.post("/api/student/select-seat", (req, res) => {
  const state = readState();
  const name = String(req.body.name || "").trim();
  const number = String(req.body.number || "").trim();
  const seatCode = String(req.body.seatCode || "").trim();

  if (!name || !number || !seatCode) {
    return res.status(400).json({
      code: "INVALID_REQUEST",
      message: "필수 정보가 누락되었습니다."
    });
  }

  const matchedStudent = findStudentByCredentials(state, name, number);

  if (!matchedStudent) {
    return res.status(401).json({
      code: "INVALID_STUDENT",
      message: "학생 확인에 실패했습니다."
    });
  }

  if (state.status !== "open") {
    return res.status(409).json({
      code: "NOT_OPEN",
      message: "현재는 자리 선택 시간이 아닙니다."
    });
  }

  if (!Object.prototype.hasOwnProperty.call(state.seats, seatCode)) {
    return res.status(400).json({
      code: "INVALID_SEAT",
      message: "존재하지 않는 자리입니다."
    });
  }

  const mySeat = findStudentSeat(state, name, number);
  if (mySeat) {
    return res.status(409).json({
      code: "ALREADY_ASSIGNED",
      message: "이미 자리가 배정되었습니다.",
      seatCode: mySeat
    });
  }

  if (state.seats[seatCode] !== null) {
    return res.status(409).json({
      code: "SEAT_TAKEN",
      message: "이미 선택된 자리입니다."
    });
  }

  state.seats[seatCode] = {
    name: matchedStudent.name,
    number: matchedStudent.number
  };

  writeState(state);
  notifyStateChanged();

  res.json({
    message: "자리가 배정되었습니다.",
    seatCode,
    seats: state.seats
  });
});

app.post("/api/student/cancel-seat", (req, res) => {
  const state = readState();
  const name = String(req.body.name || "").trim();
  const number = String(req.body.number || "").trim();

  if (!name || !number) {
    return res.status(400).json({
      code: "INVALID_REQUEST",
      message: "필수 정보가 누락되었습니다."
    });
  }

  const matchedStudent = findStudentByCredentials(state, name, number);

  if (!matchedStudent) {
    return res.status(401).json({
      code: "INVALID_STUDENT",
      message: "학생 확인에 실패했습니다."
    });
  }

  if (state.status !== "open") {
    return res.status(409).json({
      code: "NOT_OPEN",
      message: "현재는 자리 변경이 가능한 시간이 아닙니다."
    });
  }

  const mySeat = findStudentSeat(state, name, number);

  if (!mySeat) {
    return res.status(409).json({
      code: "NO_ASSIGNED_SEAT",
      message: "현재 배정된 자리가 없습니다."
    });
  }

  state.seats[mySeat] = null;
  writeState(state);
  notifyStateChanged();

  res.json({
    message: "자리 배정이 취소되었습니다.",
    seatCode: mySeat,
    seats: state.seats
  });
});

io.on("connection", (socket) => {
  console.log("socket connected:", socket.id);

  socket.on("disconnect", () => {
    console.log("socket disconnected:", socket.id);
  });
});

ensureStateFile();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is running on port ${PORT}`);
});