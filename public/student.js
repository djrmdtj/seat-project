const SESSION_KEY = "seat-project-current-student";

const studentSelect = document.getElementById("studentSelect");
const studentNumberInput = document.getElementById("studentNumberInput");
const loginBtn = document.getElementById("loginBtn");
const logoutBtn = document.getElementById("logoutBtn");
const currentUserText = document.getElementById("currentUserText");
const studentStatusText = document.getElementById("studentStatusText");
const studentGuideText = document.getElementById("studentGuideText");
const mySeatText = document.getElementById("mySeatText");
const cancelSeatBtn = document.getElementById("cancelSeatBtn");
const studentSeatGrid = document.getElementById("studentSeatGrid");
const studentResultList = document.getElementById("studentResultList");

const socket = io();

let publicState = {
  status: "waiting",
  seats: {}
};

let publicStudents = [];

function getCurrentStudent() {
  const raw = sessionStorage.getItem(SESSION_KEY);
  return raw ? JSON.parse(raw) : null;
}

function setCurrentStudent(student) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(student));
}

function clearCurrentStudent() {
  sessionStorage.removeItem(SESSION_KEY);
}

function findMySeat(seats, student) {
  if (!student) return null;

  for (const [seatCode, occupant] of Object.entries(seats)) {
    if (
      occupant &&
      occupant.name === student.name &&
      occupant.number === student.number
    ) {
      return seatCode;
    }
  }

  return null;
}

async function fetchPublicState() {
  const response = await fetch("/api/public/state");
  if (!response.ok) {
    throw new Error("공개 상태를 불러오지 못했습니다.");
  }
  return response.json();
}

async function fetchPublicStudents() {
  const response = await fetch("/api/public/students");
  if (!response.ok) {
    throw new Error("학생 목록을 불러오지 못했습니다.");
  }
  return response.json();
}

function renderStudentOptions() {
  const currentStudent = getCurrentStudent();
  const selectedName = currentStudent ? currentStudent.name : studentSelect.value;

  studentSelect.innerHTML = `<option value="">이름을 선택하세요</option>`;

  publicStudents.forEach((student) => {
    const option = document.createElement("option");
    option.value = student.name;
    option.textContent = student.name;

    if (student.name === selectedName) {
      option.selected = true;
    }

    studentSelect.appendChild(option);
  });
}

function renderStatus() {
  const currentStudent = getCurrentStudent();
  const mySeat = findMySeat(publicState.seats, currentStudent);

  studentStatusText.textContent =
    publicState.status === "waiting"
      ? "대기 중"
      : publicState.status === "open"
      ? "진행 중"
      : "완료";

  studentStatusText.className = `status ${publicState.status}`;

  if (!currentStudent) {
    currentUserText.textContent = "아직 확인되지 않음";
  } else {
    currentUserText.textContent = currentStudent.name;
  }

  if (!currentStudent) {
    mySeatText.textContent = "아직 배정되지 않음";
  } else if (mySeat) {
    mySeatText.textContent = mySeat;
  } else {
    mySeatText.textContent = "아직 배정되지 않음";
  }

  cancelSeatBtn.disabled = !(currentStudent && mySeat && publicState.status === "open");

  if (!currentStudent) {
    studentGuideText.textContent =
      "이름 선택 후 학번을 입력해 본인 확인을 해 주세요.";
    return;
  }

  if (publicState.status === "waiting") {
    studentGuideText.textContent =
      "교사가 시작 버튼을 누를 때까지 기다려 주세요.";
  } else if (publicState.status === "open") {
    if (mySeat) {
      studentGuideText.textContent =
        "이미 자리를 선택했습니다. 필요하면 내 자리 취소 후 다시 선택할 수 있습니다.";
    } else {
      studentGuideText.textContent = "원하는 자리를 클릭해 선택하세요.";
    }
  } else {
    studentGuideText.textContent =
      "자리 배정이 종료되었습니다. 아래에서 최종 결과를 확인하세요.";
  }
}

function renderSeats() {
  const currentStudent = getCurrentStudent();
  const mySeat = findMySeat(publicState.seats, currentStudent);

  studentSeatGrid.innerHTML = "";

  Object.entries(publicState.seats).forEach(([seatCode, occupant]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "seat-btn";
    button.dataset.seatCode = seatCode;

    const isMine =
      occupant &&
      currentStudent &&
      occupant.name === currentStudent.name &&
      occupant.number === currentStudent.number;

    if (occupant) {
      button.classList.add(isMine ? "mine" : "taken");
      button.disabled = true;
      button.innerHTML = `
        <span class="seat-code">${seatCode}</span>
        <span class="seat-name">${occupant.name}</span>
      `;
    } else {
      const canSelect =
        currentStudent &&
        publicState.status === "open" &&
        !mySeat;

      button.classList.add(canSelect ? "available" : "locked");
      button.disabled = !canSelect;
      button.innerHTML = `
        <span class="seat-code">${seatCode}</span>
        <span class="empty-text">선택 가능</span>
      `;

      if (canSelect) {
        button.addEventListener("click", () => {
          selectSeat(seatCode);
        });
      }
    }

    studentSeatGrid.appendChild(button);
  });
}

function renderResults() {
  studentResultList.innerHTML = "";

  if (publicState.status !== "closed") {
    const li = document.createElement("li");
    li.className = "result-item";
    li.innerHTML = `<span class="empty-text">완료 후 최종 배정 결과가 표시됩니다.</span>`;
    studentResultList.appendChild(li);
    return;
  }

  const assignedSeats = Object.entries(publicState.seats).filter(
    ([, occupant]) => occupant !== null
  );

  if (assignedSeats.length === 0) {
    const li = document.createElement("li");
    li.className = "result-item";
    li.innerHTML = `<span class="empty-text">아직 배정된 자리가 없습니다.</span>`;
    studentResultList.appendChild(li);
    return;
  }

  assignedSeats.forEach(([seatCode, occupant]) => {
    const li = document.createElement("li");
    li.className = "result-item";
    li.innerHTML = `
      <strong>${seatCode}</strong>
      <span>${occupant.name}</span>
    `;
    studentResultList.appendChild(li);
  });
}

function renderAll() {
  renderStudentOptions();
  renderStatus();
  renderSeats();
  renderResults();
}

async function refreshStudentData() {
  try {
    const [latestState, latestStudents] = await Promise.all([
      fetchPublicState(),
      fetchPublicStudents()
    ]);

    publicState = latestState;
    publicStudents = latestStudents;
    renderAll();
  } catch (error) {
    console.error(error);
  }
}

function autoLogoutOnLeave() {
  const currentStudent = getCurrentStudent();
  if (!currentStudent) return;

  const payload = JSON.stringify({ number: currentStudent.number });

  if (navigator.sendBeacon) {
    const blob = new Blob([payload], { type: "application/json" });
    navigator.sendBeacon("/api/student/logout", blob);
    return;
  }

  try {
    fetch("/api/student/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      keepalive: true
    });
  } catch (e) {
  }
}

loginBtn.addEventListener("click", async () => {
  const selectedName = studentSelect.value;
  const inputNumber = studentNumberInput.value.trim();

  if (!selectedName || !inputNumber) {
    alert("이름과 학번을 모두 확인해 주세요.");
    return;
  }

  try {
    const response = await fetch("/api/student/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        name: selectedName,
        number: inputNumber
      })
    });

    const data = await response.json();

    if (!response.ok) {
      if (response.status === 409) {
        alert("이미 로그인된 학생입니다. 다시 이름을 선택해 주세요.");
        studentSelect.value = "";
        studentNumberInput.value = "";
        renderAll();
        return;
      }

      alert(data.message || "본인 확인에 실패했습니다.");
      return;
    }

    setCurrentStudent(data.student);
    studentNumberInput.value = "";
    renderAll();
  } catch (error) {
    alert("본인 확인 중 오류가 발생했습니다.");
  }
});

logoutBtn.addEventListener("click", async () => {
  const currentStudent = getCurrentStudent();

  if (currentStudent) {
    try {
      await fetch("/api/student/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: currentStudent.name,
          number: currentStudent.number
        })
      });
    } catch (e) {
    }
  }

  clearCurrentStudent();
  studentNumberInput.value = "";
  renderAll();
});

async function selectSeat(seatCode) {
  const currentStudent = getCurrentStudent();

  if (!currentStudent) {
    return;
  }

  try {
    const response = await fetch("/api/student/select-seat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        name: currentStudent.name,
        number: currentStudent.number,
        seatCode
      })
    });

    const data = await response.json();

    if (!response.ok) {
      if (
        data.code === "SEAT_TAKEN" ||
        data.code === "ALREADY_ASSIGNED" ||
        data.code === "NOT_OPEN"
      ) {
        await refreshStudentData();
        return;
      }

      alert(data.message || "자리 선택에 실패했습니다.");
      await refreshStudentData();
      return;
    }

    await refreshStudentData();
  } catch (error) {
    await refreshStudentData();
  }
}

async function cancelSeat() {
  const currentStudent = getCurrentStudent();

  if (!currentStudent) {
    return;
  }

  try {
    const response = await fetch("/api/student/cancel-seat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        name: currentStudent.name,
        number: currentStudent.number
      })
    });

    await response.json();
    await refreshStudentData();
  } catch (error) {
    await refreshStudentData();
  }
}

cancelSeatBtn.addEventListener("click", async () => {
  await cancelSeat();
});

socket.on("state-changed", async () => {
  await refreshStudentData();
});

socket.on("connect", async () => {
  await refreshStudentData();
});

refreshStudentData();

window.addEventListener("pagehide", autoLogoutOnLeave);
window.addEventListener("beforeunload", autoLogoutOnLeave);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    autoLogoutOnLeave();
  }
});