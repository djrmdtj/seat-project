const teacherStatusText = document.getElementById("teacherStatusText");
const studentNameInput = document.getElementById("studentName");
const studentNumberInput = document.getElementById("studentNumber");
const addStudentBtn = document.getElementById("addStudentBtn");
const saveStudentsBtn = document.getElementById("saveStudentsBtn");
const clearDraftBtn = document.getElementById("clearDraftBtn");
const draftStudentList = document.getElementById("draftStudentList");
const startBtn = document.getElementById("startBtn");
const finishBtn = document.getElementById("finishBtn");
const resetBtn = document.getElementById("resetBtn");
const teacherSeatGrid = document.getElementById("teacherSeatGrid");
const resultList = document.getElementById("resultList");

const socket = io();

let serverState = {
  status: "waiting",
  students: [],
  seats: {}
};

let draftStudents = [];
let isDraftDirty = false;

async function fetchTeacherState() {
  const response = await fetch("/api/teacher/state");
  if (!response.ok) {
    throw new Error("교사 상태를 불러오지 못했습니다.");
  }
  return response.json();
}

function renderDraftStudents() {
  draftStudentList.innerHTML = "";

  if (draftStudents.length === 0) {
    const li = document.createElement("li");
    li.className = "student-item";
    li.innerHTML = `<span class="empty-text">아직 추가된 학생이 없습니다.</span>`;
    draftStudentList.appendChild(li);
    return;
  }

  draftStudents.forEach((student, index) => {
    const li = document.createElement("li");
    li.className = "student-item";
    li.innerHTML = `
      <div class="student-meta">
        <strong>${student.name}</strong>
        <small>학번: ${student.number}</small>
      </div>
      <button class="remove-btn" data-index="${index}">삭제</button>
    `;
    draftStudentList.appendChild(li);
  });

  document.querySelectorAll(".remove-btn").forEach((button) => {
    button.addEventListener("click", () => {
      const index = Number(button.dataset.index);
      draftStudents.splice(index, 1);
      isDraftDirty = true;
      renderDraftStudents();
    });
  });
}

function renderStatus() {
  teacherStatusText.textContent =
    serverState.status === "waiting"
      ? "대기 중"
      : serverState.status === "open"
      ? "진행 중"
      : "완료";

  teacherStatusText.className = `status ${serverState.status}`;
}

function renderSeats() {
  teacherSeatGrid.innerHTML = "";

  const rows = ["A", "B", "C", "D", "E", "F"];
  const columns = 5;

  for (const row of rows) {
    for (let col = 1; col <= columns; col += 1) {
      const seatCode = `${row}${col}`;
      const occupant = serverState.seats[seatCode];

      const button = document.createElement("button");
      button.type = "button";
      button.className = "seat-btn";
      button.disabled = true;

      if (occupant) {
        button.classList.add("taken");
        button.innerHTML = `
          <span class="seat-code">${seatCode}</span>
          <span class="seat-name">${occupant.name}</span>
        `;
      } else {
        button.classList.add("locked");
        button.innerHTML = `
          <span class="seat-code">${seatCode}</span>
          <span class="empty-text">빈자리</span>
        `;
      }

      teacherSeatGrid.appendChild(button);
    }
  }
}

function renderResults() {
  resultList.innerHTML = "";

  const assignedSeats = Object.entries(serverState.seats).filter(
    ([, occupant]) => occupant !== null
  );

  if (assignedSeats.length === 0) {
    const li = document.createElement("li");
    li.className = "result-item";
    li.innerHTML = `<span class="empty-text">아직 배정된 자리가 없습니다.</span>`;
    resultList.appendChild(li);
    return;
  }

  assignedSeats.forEach(([seatCode, occupant]) => {
    const li = document.createElement("li");
    li.className = "result-item";
    li.innerHTML = `
      <strong>${seatCode}</strong>
      <span>${occupant.name}</span>
    `;
    resultList.appendChild(li);
  });
}

function renderAll() {
  renderDraftStudents();
  renderStatus();
  renderSeats();
  renderResults();
}

async function refreshTeacherData() {
  try {
    const latestState = await fetchTeacherState();
    serverState = latestState;

    if (!isDraftDirty) {
      draftStudents = latestState.students.map((student) => ({
        name: student.name,
        number: student.number
      }));
    }

    renderAll();
  } catch (error) {
    console.error(error);
  }
}

addStudentBtn.addEventListener("click", () => {
  const name = studentNameInput.value.trim();
  const number = studentNumberInput.value.trim();

  if (!name || !number) {
    alert("이름과 학번을 모두 입력해 주세요.");
    return;
  }

  const duplicated = draftStudents.some(
    (student) => student.name === name || student.number === number
  );

  if (duplicated) {
    alert("중복된 이름 또는 학번이 있습니다.");
    return;
  }

  draftStudents.push({ name, number });
  isDraftDirty = true;

  studentNameInput.value = "";
  studentNumberInput.value = "";
  renderDraftStudents();
});

saveStudentsBtn.addEventListener("click", async () => {
  try {
    const response = await fetch("/api/teacher/students", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        students: draftStudents
      })
    });

    const data = await response.json();

    if (!response.ok) {
      alert(data.message || "학생 정보 저장에 실패했습니다.");
      return;
    }

    isDraftDirty = false;
    await refreshTeacherData();
    alert("학생 정보가 저장되었습니다.");
  } catch (error) {
    alert("학생 정보 저장 중 오류가 발생했습니다.");
  }
});

clearDraftBtn.addEventListener("click", () => {
  draftStudents = [];
  isDraftDirty = true;
  renderDraftStudents();
});

startBtn.addEventListener("click", async () => {
  try {
    const response = await fetch("/api/teacher/start", {
      method: "POST"
    });
    const data = await response.json();

    if (!response.ok) {
      alert(data.message || "시작 처리에 실패했습니다.");
      return;
    }

    await refreshTeacherData();
  } catch (error) {
    alert("시작 처리 중 오류가 발생했습니다.");
  }
});

finishBtn.addEventListener("click", async () => {
  try {
    const response = await fetch("/api/teacher/finish", {
      method: "POST"
    });
    const data = await response.json();

    if (!response.ok) {
      alert(data.message || "완료 처리에 실패했습니다.");
      return;
    }

    await refreshTeacherData();
  } catch (error) {
    alert("완료 처리 중 오류가 발생했습니다.");
  }
});

resetBtn.addEventListener("click", async () => {
  try {
    const response = await fetch("/api/teacher/reset", {
      method: "POST"
    });
    const data = await response.json();

    if (!response.ok) {
      alert(data.message || "초기화에 실패했습니다.");
      return;
    }

    isDraftDirty = false;
    await refreshTeacherData();
  } catch (error) {
    alert("초기화 중 오류가 발생했습니다.");
  }
});

socket.on("state-changed", async () => {
  await refreshTeacherData();
});

socket.on("connect", async () => {
  await refreshTeacherData();
});

refreshTeacherData();