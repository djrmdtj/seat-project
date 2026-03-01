require("dotenv").config();

const express = require("express");
const path = require("node:path");
const http = require("node:http");
const { Server } = require("socket.io");
const { Pool } = require("pg");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");

if (!process.env.DATABASE_URL) {
  console.error("[BOOT] DATABASE_URL is missing");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

function createSeatCodes() {
  const codes = [];
  const columns = ["A", "B", "C", "D", "E"];
  const rows = 6;
  for (let r = 1; r <= rows; r += 1) {
    for (const c of columns) codes.push(`${c}${r}`);
  }
  return codes;
}

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS students (
      name TEXT PRIMARY KEY,
      number TEXT NOT NULL UNIQUE
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS seats (
      seat_code TEXT PRIMARY KEY,
      student_name TEXT NULL,
      student_number TEXT NULL
    );
  `);

  await pool.query(`
    INSERT INTO app_state (id, status)
    VALUES (1, 'waiting')
    ON CONFLICT (id) DO NOTHING;
  `);

  const seatCodes = createSeatCodes();
  for (const code of seatCodes) {
    await pool.query(
      `
      INSERT INTO seats (seat_code, student_name, student_number)
      VALUES ($1, NULL, NULL)
      ON CONFLICT (seat_code) DO NOTHING;
      `,
      [code]
    );
  }
}

async function getStatus() {
  const r = await pool.query(`SELECT status FROM app_state WHERE id=1;`);
  return r.rows[0]?.status || "waiting";
}

async function setStatus(next) {
  await pool.query(`UPDATE app_state SET status=$1 WHERE id=1;`, [next]);
}

async function getSeatsMap() {
  const r = await pool.query(
    `SELECT seat_code, student_name, student_number FROM seats ORDER BY seat_code ASC;`
  );
  const seats = {};
  for (const row of r.rows) {
    seats[row.seat_code] = row.student_name
      ? { name: row.student_name, number: row.student_number }
      : null;
  }
  return seats;
}

async function getStudentsAll() {
  const r = await pool.query(`SELECT name, number FROM students ORDER BY name ASC;`);
  return r.rows;
}

async function getStudentsPublic() {
  const r = await pool.query(`SELECT name FROM students ORDER BY name ASC;`);
  return r.rows;
}

async function findStudent(name, number) {
  const r = await pool.query(
    `SELECT 1 FROM students WHERE name=$1 AND number=$2;`,
    [name, number]
  );
  return r.rowCount > 0;
}

async function findMySeat(name, number) {
  const r = await pool.query(
    `SELECT seat_code FROM seats WHERE student_name=$1 AND student_number=$2 LIMIT 1;`,
    [name, number]
  );
  return r.rowCount ? r.rows[0].seat_code : null;
}

function notifyStateChanged() {
  io.emit("state-changed");
}

app.use(express.json());
app.use(express.static(PUBLIC_DIR));

app.get("/", (req, res) => res.redirect("/teacher"));
app.get("/teacher", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "teacher.html")));
app.get("/student", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "student.html")));

app.get("/healthz", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.status(200).json({ ok: true, db: "ok" });
  } catch (e) {
    res.status(500).json({ ok: false, db: "fail", error: e.message });
  }
});

app.get("/api/teacher/state", async (req, res) => {
  try {
    const [status, students, seats] = await Promise.all([
      getStatus(),
      getStudentsAll(),
      getSeatsMap()
    ]);
    res.json({ status, students, seats });
  } catch (e) {
    res.status(500).json({ message: "teacher state load failed" });
  }
});

app.post("/api/teacher/students", async (req, res) => {
  const input = req.body.students;

  try {
    if (!Array.isArray(input)) {
      return res.status(400).json({ message: "학생 목록 형식이 올바르지 않습니다." });
    }

    const cleaned = input.map((s) => ({
      name: String(s.name || "").trim(),
      number: String(s.number || "").trim()
    }));

    if (cleaned.some((s) => !s.name || !s.number)) {
      return res.status(400).json({ message: "이름과 학번은 모두 필요합니다." });
    }

    const nameSet = new Set();
    const numSet = new Set();
    for (const s of cleaned) {
      if (nameSet.has(s.name)) return res.status(400).json({ message: "중복된 이름이 있습니다." });
      if (numSet.has(s.number)) return res.status(400).json({ message: "중복된 학번이 있습니다." });
      nameSet.add(s.name);
      numSet.add(s.number);
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const st = await client.query(`SELECT status FROM app_state WHERE id=1 FOR UPDATE;`);
      const status = st.rows[0]?.status || "waiting";

      const taken = await client.query(`SELECT COUNT(*)::int AS cnt FROM seats WHERE student_name IS NOT NULL;`);
      const takenCnt = taken.rows[0].cnt;

      if (status !== "waiting" || takenCnt > 0) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "학생 정보는 자리 배정 시작 전에만 저장할 수 있습니다." });
      }

      await client.query(`TRUNCATE TABLE students;`);
      for (const s of cleaned) {
        await client.query(`INSERT INTO students (name, number) VALUES ($1, $2);`, [s.name, s.number]);
      }

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    notifyStateChanged();
    res.json({ message: "학생 정보가 저장되었습니다." });
  } catch (e) {
    res.status(400).json({ message: e.message || "학생 정보 저장 실패" });
  }
});

app.post("/api/teacher/start", async (req, res) => {
  try {
    const students = await getStudentsAll();
    if (students.length === 0) {
      return res.status(400).json({ message: "먼저 학생 정보를 저장해 주세요." });
    }
    await setStatus("open");
    notifyStateChanged();
    res.json({ message: "자리 선택이 시작되었습니다.", status: "open" });
  } catch (e) {
    res.status(500).json({ message: "시작 처리 실패" });
  }
});

app.post("/api/teacher/finish", async (req, res) => {
  try {
    await setStatus("closed");
    notifyStateChanged();
    res.json({ message: "자리 배정이 완료되었습니다.", status: "closed" });
  } catch (e) {
    res.status(500).json({ message: "완료 처리 실패" });
  }
});

app.post("/api/teacher/reset", async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`UPDATE app_state SET status='waiting' WHERE id=1;`);
      await client.query(`UPDATE seats SET student_name=NULL, student_number=NULL;`);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    notifyStateChanged();
    res.json({ message: "좌석 배정이 초기화되었습니다.", status: "waiting" });
  } catch (e) {
    res.status(500).json({ message: "초기화 실패" });
  }
});

app.get("/api/public/state", async (req, res) => {
  try {
    const [status, seats] = await Promise.all([getStatus(), getSeatsMap()]);
    res.json({ status, seats });
  } catch (e) {
    res.status(500).json({ message: "상태 조회 실패" });
  }
});

app.get("/api/public/students", async (req, res) => {
  try {
    res.json(await getStudentsPublic());
  } catch (e) {
    res.status(500).json({ message: "학생 목록 조회 실패" });
  }
});

app.post("/api/student/login", async (req, res) => {
  const name = String(req.body.name || "").trim();
  const number = String(req.body.number || "").trim();

  if (!name || !number) {
    return res.status(400).json({ message: "이름과 학번을 모두 입력해 주세요." });
  }

  try {
    const ok = await findStudent(name, number);
    if (!ok) {
      return res.status(401).json({ message: "이름 또는 학번이 일치하지 않습니다." });
    }
    res.json({ message: "본인 확인이 완료되었습니다.", student: { name, number } });
  } catch (e) {
    res.status(500).json({ message: "로그인 처리 실패" });
  }
});

app.post("/api/student/select-seat", async (req, res) => {
  const name = String(req.body.name || "").trim();
  const number = String(req.body.number || "").trim();
  const seatCode = String(req.body.seatCode || "").trim();

  if (!name || !number || !seatCode) {
    return res.status(400).json({ code: "INVALID_REQUEST", message: "필수 정보가 누락되었습니다." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const st = await client.query(`SELECT status FROM app_state WHERE id=1 FOR UPDATE;`);
    const status = st.rows[0]?.status || "waiting";
    if (status !== "open") {
      await client.query("ROLLBACK");
      return res.status(409).json({ code: "NOT_OPEN", message: "현재는 자리 선택 시간이 아닙니다." });
    }

    const sr = await client.query(`SELECT 1 FROM students WHERE name=$1 AND number=$2;`, [name, number]);
    if (sr.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(401).json({ code: "INVALID_STUDENT", message: "학생 확인에 실패했습니다." });
    }

    const my = await client.query(
      `SELECT seat_code FROM seats WHERE student_name=$1 AND student_number=$2 LIMIT 1;`,
      [name, number]
    );
    if (my.rowCount > 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        code: "ALREADY_ASSIGNED",
        message: "이미 자리가 배정되었습니다.",
        seatCode: my.rows[0].seat_code
      });
    }

    const seat = await client.query(`SELECT student_name FROM seats WHERE seat_code=$1 FOR UPDATE;`, [seatCode]);
    if (seat.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ code: "INVALID_SEAT", message: "존재하지 않는 자리입니다." });
    }
    if (seat.rows[0].student_name) {
      await client.query("ROLLBACK");
      return res.status(409).json({ code: "SEAT_TAKEN", message: "이미 선택된 자리입니다." });
    }

    await client.query(
      `UPDATE seats SET student_name=$1, student_number=$2 WHERE seat_code=$3;`,
      [name, number, seatCode]
    );

    await client.query("COMMIT");
    notifyStateChanged();
    res.json({ message: "자리가 배정되었습니다.", seatCode });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ message: "자리 선택 실패" });
  } finally {
    client.release();
  }
});

app.post("/api/student/cancel-seat", async (req, res) => {
  const name = String(req.body.name || "").trim();
  const number = String(req.body.number || "").trim();

  if (!name || !number) {
    return res.status(400).json({ code: "INVALID_REQUEST", message: "필수 정보가 누락되었습니다." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const st = await client.query(`SELECT status FROM app_state WHERE id=1 FOR UPDATE;`);
    const status = st.rows[0]?.status || "waiting";
    if (status !== "open") {
      await client.query("ROLLBACK");
      return res.status(409).json({ code: "NOT_OPEN", message: "현재는 자리 변경이 가능한 시간이 아닙니다." });
    }

    const sr = await client.query(`SELECT 1 FROM students WHERE name=$1 AND number=$2;`, [name, number]);
    if (sr.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(401).json({ code: "INVALID_STUDENT", message: "학생 확인에 실패했습니다." });
    }

    const my = await client.query(
      `SELECT seat_code FROM seats WHERE student_name=$1 AND student_number=$2 FOR UPDATE;`,
      [name, number]
    );

    if (my.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ code: "NO_ASSIGNED_SEAT", message: "현재 배정된 자리가 없습니다." });
    }

    await client.query(
      `UPDATE seats SET student_name=NULL, student_number=NULL WHERE seat_code=$1;`,
      [my.rows[0].seat_code]
    );

    await client.query("COMMIT");
    notifyStateChanged();
    res.json({ message: "자리 배정이 취소되었습니다.", seatCode: my.rows[0].seat_code });
  } catch (e) {
    await client.query("ROLLBACK");
    res.status(500).json({ message: "자리 취소 실패" });
  } finally {
    client.release();
  }
});

io.on("connection", (socket) => {
  console.log("socket connected:", socket.id);
  socket.on("disconnect", () => console.log("socket disconnected:", socket.id));
});

(async () => {
  try {
    console.log("[BOOT] starting...");
    console.log("[BOOT] DATABASE_URL exists?", !!process.env.DATABASE_URL);
    await initDb();
    console.log("[BOOT] db init done");
    server.listen(PORT, () => console.log(`[BOOT] listening on ${PORT}`));
  } catch (e) {
    console.error("[BOOT] failed:", e);
    process.exit(1);
  }
})();