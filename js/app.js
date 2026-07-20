import {
  auth, db, ref, get, onValue, set, update,
  watchAuthState, signUpParent, signInParent, signInParentWithGoogle,
  resolveGoogleRedirect, resetParentPassword, signOutParent,
  getMessagingIfSupported, getToken, onMessage, FCM_VAPID_KEY,
} from "./firebase-init.js";
import { icon } from "./icons.js";

// ─────────────────────────────────────────────────────────────────────────
// Constants / data-model note
// ─────────────────────────────────────────────────────────────────────────
// RTDB layout (parent-portal Firebase project):
//   schools/DAPRES/attendance/{yyyy-mm-dd}/{student_id} = {status,time,grade,section,student_name}
//   schools/DAPRES/link_codes/{CODE}                    = {student_id,student_name,grade,section,expires_at}
//   parents/{uid}/students/{student_id}                 = {student_name,grade,section,linked_at}
//   ^ {uid} is now a real parent account (email/password or Google), not a
//     per-device anonymous one — same account, same students, any device.
//   parents/{uid}/fcm_tokens/{token}                    = true
//   parents/{uid}/prefs                                 = {lateAlerts,dailySummary,announcements}
const SCHOOL_ID = "DAPRES";
const LATE_ALERT_LOOKBACK_DAYS = 45; // enough for stats + a month calendar

const DOW = ["S", "M", "T", "W", "T", "F", "S"];
const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];

// ─────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────
let uid = null;
let linkedStudents = {};     // student_id -> {student_name, grade, section, linked_at}
let attendance = {};         // date -> student_id -> record
let activeStudentId = null;
let calMonthOffset = 0;      // 0 = current month, -1 = previous, etc. (Attendance view nav)
let alertsCache = [];        // locally-derived alert feed, newest first

// ─────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────
function $(sel) { return document.querySelector(sel); }
function todayStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
function initials(name) {
  return (name || "?").trim().split(/\s+/).slice(0,2).map(w => w[0]?.toUpperCase() || "").join("");
}
function setLoadingStatus(text) {
  const el = $("#loading-status");
  if (el) el.textContent = text;
}
function hideLoadingScreen() {
  $("#loading-screen")?.classList.add("hidden");
}
function toast(msg) {
  const t = $("#toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 2600);
}
function timeAgo(ts) {
  const s = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return `${Math.round(d / 7)}w ago`;
}
function fmtTime12h(hhmmss) {
  if (!hhmmss) return "";
  const [h, m] = hhmmss.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2,"0")} ${period}`;
}
function statusLabel(status) {
  if (status === "late") return "Late";
  if (status === "absent") return "Absent";
  return "On time";
}
function statusClass(status) {
  if (status === "late") return "late";
  if (status === "absent") return "absent";
  return "ontime";
}
function localKey(suffix) { return `dapres_parent:${suffix}`; }

// ─────────────────────────────────────────────────────────────────────────
// Local persistence (device-local only — never a substitute for RTDB;
// used for "what did we last see" so Alerts can be derived client-side,
// and for remembering which student tab was open)
// ─────────────────────────────────────────────────────────────────────────
function loadLocal(key, fallback) {
  try {
    const raw = localStorage.getItem(localKey(key));
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}
function saveLocal(key, value) {
  try { localStorage.setItem(localKey(key), JSON.stringify(value)); } catch {}
}

// ─────────────────────────────────────────────────────────────────────────
// View: Home
// ─────────────────────────────────────────────────────────────────────────
function computeWeek(studentId) {
  const days = [];
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7)); // back up to this week's Monday
  for (let i = 0; i < 5; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const ds = todayStr(d);
    const rec = attendance[ds]?.[studentId];
    let dot = "upcoming";
    if (d > now && ds !== todayStr(now)) dot = "upcoming";
    else if (rec) dot = rec.status === "late" ? "late" : rec.status === "absent" ? "absent" : "ontime";
    else if (ds <= todayStr(now)) dot = "absent"; // school day passed, no scan on file
    days.push({ label: DOW_SHORT(d), dot });
  }
  return days;
}
function DOW_SHORT(d) { return ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d.getDay()]; }

function renderHome() {
  const el = $("#view-home");
  if (!activeStudentId) {
    el.innerHTML = emptyStateNoStudent();
    bindEmptyStateLink(el);
    return;
  }
  const student = linkedStudents[activeStudentId];
  const today = todayStr();
  const todayRec = attendance[today]?.[activeStudentId];
  const week = computeWeek(activeStudentId);
  const recentAlert = alertsCache[0];

  const dateLabel = new Date().toLocaleDateString(undefined, { month: "long", day: "numeric" });
  let ringClass = "pending", statusText = "No scan yet today", detailText = "Waiting for today's scan";
  if (todayRec) {
    ringClass = todayRec.status === "late" ? "late" : todayRec.status === "absent" ? "absent" : "";
    statusText = todayRec.status === "absent" ? "Absent today"
      : todayRec.status === "late" ? "Present, late" : "Present, on time";
    detailText = todayRec.status === "absent" ? "No scan recorded" : `Scanned in at ${fmtTime12h(todayRec.time)}`;
  }

  el.innerHTML = `
    <div class="grid-2">
      <div class="left-col">
        <div class="card accent student-row">
          <div>
            <div class="label">Student</div>
            <div class="name">${escapeHtml(student.student_name)}</div>
            <div class="meta">${escapeHtml(student.grade)} &middot; ${escapeHtml(student.section)}</div>
          </div>
          <div class="avatar">${initials(student.student_name)}</div>
        </div>

        <div class="card">
          <div class="week-label">This week</div>
          <div class="week-grid">
            ${week.map(d => `
              <div class="day-cell"><div class="day">${d.label}</div><div class="dot dot-${d.dot}"></div></div>
            `).join("")}
          </div>
          <div class="legend">
            <span><span class="sw dot-ontime"></span>On time</span>
            <span><span class="sw dot-late"></span>Late</span>
            <span><span class="sw dot-upcoming"></span>Upcoming</span>
          </div>
        </div>

        ${recentAlert ? `
        <div class="card">
          <div class="notif-row">
            <div class="icon-badge ${recentAlert.kind}">${alertIcon(recentAlert.kind)}</div>
            <div>
              <div class="title">${escapeHtml(recentAlert.title)}</div>
              <div class="sub">${escapeHtml(recentAlert.sub)}</div>
            </div>
          </div>
        </div>` : ""}
      </div>

      <div class="right-col">
        <div class="card status-card">
          <div class="date">Today, ${dateLabel}</div>
          <div class="status-ring ${ringClass}">${todayRec ? (todayRec.status === "absent" ? icon("x") : icon("check")) : icon("clock")}</div>
          <div class="status">${statusText}</div>
          <div class="detail">${detailText}</div>
        </div>
        <button class="btn" data-goto="attendance">View full attendance</button>
      </div>
    </div>
  `;
  el.querySelector("[data-goto]")?.addEventListener("click", (e) => showView(e.currentTarget.getAttribute("data-goto")));
}

function alertIcon(kind) {
  return icon({ late: "bell", ontime: "check", info: "info", absent: "warning" }[kind] || "info");
}

// ─────────────────────────────────────────────────────────────────────────
// View: Attendance
// ─────────────────────────────────────────────────────────────────────────
function renderAttendance() {
  const el = $("#view-attendance");
  if (!activeStudentId) {
    el.innerHTML = emptyStateNoStudent();
    bindEmptyStateLink(el);
    return;
  }
  const student = linkedStudents[activeStudentId];
  const now = new Date();
  now.setMonth(now.getMonth() + calMonthOffset);
  const year = now.getFullYear(), month = now.getMonth();
  const firstDow = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  let ontime = 0, late = 0, absent = 0;
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(`<div class="cal-cell blank"></div>`);
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(year, month, day);
    const ds = todayStr(d);
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;
    const rec = attendance[ds]?.[activeStudentId];
    let cls = isWeekend ? "weekend" : "";
    if (!isWeekend && rec) {
      cls = statusClass(rec.status);
      if (cls === "ontime") ontime++; else if (cls === "late") late++; else if (cls === "absent") absent++;
    } else if (!isWeekend && d < now && ds !== todayStr()) {
      // school day in the past, no record — count as absent for the stat row
      cls = "absent"; absent++;
    }
    cells.push(`<div class="cal-cell ${cls}">${day}</div>`);
  }

  const recentLogs = Object.keys(attendance)
    .filter(ds => attendance[ds]?.[activeStudentId])
    .sort((a,b) => b.localeCompare(a))
    .slice(0, 8)
    .map(ds => {
      const rec = attendance[ds][activeStudentId];
      const d = new Date(ds + "T00:00:00");
      const label = d.toLocaleDateString(undefined, { month: "short", day: "numeric", weekday: "short" });
      return `<div class="log-row"><div><div>${label}</div><div class="date">Scanned ${fmtTime12h(rec.time)}</div></div><span class="pill ${statusClass(rec.status)}">${statusLabel(rec.status)}</span></div>`;
    }).join("");

  el.innerHTML = `
    <div class="section-title">Attendance</div>
    <div class="section-sub">${escapeHtml(student.student_name)} &middot; ${escapeHtml(student.grade)} &middot; ${escapeHtml(student.section)}</div>

    <div class="stat-row">
      <div class="stat-box ontime"><div class="num">${ontime}</div><div class="lbl">On time</div></div>
      <div class="stat-box late"><div class="num">${late}</div><div class="lbl">Late</div></div>
      <div class="stat-box absent"><div class="num">${absent}</div><div class="lbl">Absent</div></div>
    </div>

    <div class="card">
      <div class="cal-header">
        <div class="cal-nav"><button data-cal="-1" aria-label="Previous month">${icon("chevronLeft")}</button></div>
        <div class="month">${MONTH_NAMES[month]} ${year}</div>
        <div class="cal-nav"><button data-cal="1" aria-label="Next month">${icon("chevronRight")}</button></div>
      </div>
      <div class="cal-grid">
        ${DOW.map(d => `<div class="dow">${d}</div>`).join("")}
        ${cells.join("")}
      </div>
      <div class="legend" style="margin-top:14px;">
        <span><span class="sw dot-ontime"></span>On time</span>
        <span><span class="sw dot-late"></span>Late</span>
        <span><span class="sw dot-absent"></span>Absent</span>
      </div>
    </div>

    <div class="card">
      ${recentLogs || `<div class="empty-state" style="padding:10px 0;">No scans recorded yet.</div>`}
    </div>
  `;
  el.querySelectorAll("[data-cal]").forEach(btn => btn.addEventListener("click", () => {
    calMonthOffset += parseInt(btn.getAttribute("data-cal"), 10);
    renderAttendance();
  }));
}

// ─────────────────────────────────────────────────────────────────────────
// View: Alerts
// ─────────────────────────────────────────────────────────────────────────
function renderAlerts() {
  const el = $("#view-alerts");
  const student = activeStudentId ? linkedStudents[activeStudentId] : null;
  const items = alertsCache.filter(a => !activeStudentId || a.studentId === activeStudentId);

  el.innerHTML = `
    <div class="section-title">Alerts</div>
    <div class="section-sub">${student ? `Notifications about ${escapeHtml(student.student_name)}'s day` : "Link a student to see alerts"}</div>
    <div class="card">
      ${items.length ? items.map(a => `
        <div class="notif-row">
          <div class="icon-badge ${a.kind}">${alertIcon(a.kind)}</div>
          <div><div class="title">${escapeHtml(a.title)}</div><div class="sub">${escapeHtml(a.sub)}</div></div>
          <div class="when">${timeAgo(a.ts)}</div>
        </div>`).join("") : `<div class="empty-state"><div class="big">${icon("bellOutlineBig")}</div>No alerts yet.</div>`}
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────────
// View: Settings
// ─────────────────────────────────────────────────────────────────────────
async function renderSettings() {
  const el = $("#view-settings");
  const prefs = loadLocal("prefs", { lateAlerts: true, dailySummary: false, announcements: true });
  const profile = loadLocal("profile", { name: "", phone: "" });
  const students = Object.entries(linkedStudents);

  el.innerHTML = `
    <div class="section-title">Settings</div>
    <div class="section-sub">${auth.currentUser?.email ? escapeHtml(auth.currentUser.email) : "Signed in with Google"}</div>

    <div class="card">
      <div class="week-label" style="margin-bottom:4px;">Linked students</div>
      ${students.length ? students.map(([sid, s]) => `
        <div class="child-row">
          <div class="avatar">${initials(s.student_name)}</div>
          <div><div class="name">${escapeHtml(s.student_name)}</div><div class="meta">${escapeHtml(s.grade)} &middot; ${escapeHtml(s.section)}</div></div>
        </div>`).join("") : `<div class="empty-state" style="padding:14px 0;">No students linked yet.</div>`}
    </div>
    <button class="btn secondary" id="link-another-btn">Link another student</button>

    <div class="card" style="margin-top:14px;">
      <div class="week-label" style="margin-bottom:4px;">Notifications</div>
      <div class="settings-row">
        <div><div class="lbl">Late arrival alerts</div><div class="sub">Ping when a scan is past the cutoff</div></div>
        <div class="toggle ${prefs.lateAlerts ? "on" : ""}" data-pref="lateAlerts"></div>
      </div>
      <div class="settings-row">
        <div><div class="lbl">Daily summary</div><div class="sub">One recap each evening</div></div>
        <div class="toggle ${prefs.dailySummary ? "on" : ""}" data-pref="dailySummary"></div>
      </div>
      <div class="settings-row">
        <div><div class="lbl">School announcements</div><div class="sub">News from the office</div></div>
        <div class="toggle ${prefs.announcements ? "on" : ""}" data-pref="announcements"></div>
      </div>
    </div>

    <div class="card" style="margin-top:14px;">
      <div class="settings-row"><div class="lbl">Parent name</div><input type="text" id="profile-name" value="${escapeAttr(profile.name)}" placeholder="Your name"></div>
      <div class="settings-row"><div class="lbl">Phone number</div><input type="text" id="profile-phone" value="${escapeAttr(profile.phone)}" placeholder="+63 9XX XXX XXXX"></div>
    </div>

    <button class="btn secondary" id="logout-btn" style="margin-top:14px; color:#c0392b; border-color:#c0392b;">Log out</button>

    <div class="made-by-footer">
      <img src="assets/athstudios-logo.png" alt="ATHStudios">
      <span>DAPRES Parent Portal &middot; Built by ATHStudios</span>
    </div>
  `;

  el.querySelector("#link-another-btn")?.addEventListener("click", openLinkModal);
  el.querySelectorAll("[data-pref]").forEach(t => t.addEventListener("click", async () => {
    t.classList.toggle("on");
    const key = t.getAttribute("data-pref");
    const next = { ...loadLocal("prefs", prefs), [key]: t.classList.contains("on") };
    saveLocal("prefs", next);
    if (key === "lateAlerts" && next.lateAlerts) await ensureNotificationPermissionAndToken();
  }));
  el.querySelector("#profile-name")?.addEventListener("change", (e) => {
    saveLocal("profile", { ...loadLocal("profile", profile), name: e.target.value });
  });
  el.querySelector("#profile-phone")?.addEventListener("change", (e) => {
    saveLocal("profile", { ...loadLocal("profile", profile), phone: e.target.value });
  });
  el.querySelector("#logout-btn")?.addEventListener("click", handleLogout);
}

// ─────────────────────────────────────────────────────────────────────────
// Empty state (no student linked yet)
// ─────────────────────────────────────────────────────────────────────────
function emptyStateNoStudent() {
  return `
    <div class="card">
      <div class="empty-state">
        <div class="big">${icon("user")}</div>
        No student linked yet.<br>Ask the school office for a link code.
      </div>
    </div>
    <button class="btn" id="empty-link-btn">Link a student</button>
  `;
}
function bindEmptyStateLink(container) {
  container.querySelector("#empty-link-btn")?.addEventListener("click", openLinkModal);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

// ─────────────────────────────────────────────────────────────────────────
// Student switcher (only shown with 2+ linked students)
// ─────────────────────────────────────────────────────────────────────────
function renderSwitcher() {
  const wrap = $("#student-switcher");
  const ids = Object.keys(linkedStudents);
  if (ids.length < 2) { wrap.classList.add("hidden"); wrap.innerHTML = ""; return; }
  wrap.classList.remove("hidden");
  wrap.innerHTML = ids.map(sid => {
    const s = linkedStudents[sid];
    return `<div class="student-chip ${sid === activeStudentId ? "active" : ""}" data-sid="${sid}">
      <span class="chip-avatar">${initials(s.student_name)}</span>${escapeHtml(s.student_name.split(" ")[0])}
    </div>`;
  }).join("");
  wrap.querySelectorAll("[data-sid]").forEach(chip => chip.addEventListener("click", () => {
    activeStudentId = chip.getAttribute("data-sid");
    saveLocal("activeStudentId", activeStudentId);
    renderAll();
  }));
}

function renderAll() {
  renderSwitcher();
  renderHome();
  renderAttendance();
  renderAlerts();
  renderSettings();
}

// ─────────────────────────────────────────────────────────────────────────
// Tab / view navigation (same interaction model as the mockup)
// ─────────────────────────────────────────────────────────────────────────
function moveSidebarIndicator(btn) {
  const indicator = $("#sidebar-indicator");
  if (!indicator || !btn) return;
  indicator.style.top = btn.offsetTop + "px";
}
function moveTabIndicator(btn) {
  const indicator = $("#tab-indicator");
  if (!indicator || !btn) return;
  indicator.style.left = btn.offsetLeft + "px";
  indicator.style.width = btn.offsetWidth + "px";
}
const VIEW_ORDER = ["home", "attendance", "alerts", "settings"];
function showView(name) {
  const target = document.getElementById("view-" + name);
  const current = document.querySelector(".view.active");
  if (target === current) return;
  const fromIdx = current ? VIEW_ORDER.indexOf(current.id.replace("view-", "")) : -1;
  const toIdx = VIEW_ORDER.indexOf(name);
  const dir = toIdx >= fromIdx ? "enter-fwd" : "enter-back";
  document.querySelectorAll(".view").forEach(v => {
    v.classList.remove("active", "enter-fwd", "enter-back");
  });
  target.classList.add("active", dir);
  document.querySelectorAll(".tab, .nav-btn").forEach(b => {
    const isActive = b.getAttribute("data-view") === name;
    b.classList.toggle("active", isActive);
    if (isActive) {
      if (b.classList.contains("tab")) moveTabIndicator(b);
      if (b.classList.contains("nav-btn")) moveSidebarIndicator(b);
    }
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function wireNav() {
  document.querySelectorAll(".tab, .nav-btn").forEach(b => {
    b.addEventListener("click", () => showView(b.getAttribute("data-view")));
  });
  window.addEventListener("resize", () => {
    moveTabIndicator(document.querySelector(".tab.active"));
    moveSidebarIndicator(document.querySelector(".nav-btn.active"));
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Link-code modal + redemption
// ─────────────────────────────────────────────────────────────────────────
function openLinkModal() {
  const modal = $("#link-modal");
  $("#link-code-input").value = "";
  $("#link-code-error").textContent = "";
  modal.classList.add("active");
  setTimeout(() => $("#link-code-input")?.focus(), 150);
}
function closeLinkModal() { $("#link-modal").classList.remove("active"); }

async function redeemCode(rawCode, { inputEl, errEl, submitBtn, onSuccess }) {
  const code = rawCode.trim().replace(/\D/g, ""); // digits only
  if (code.length !== 8) { errEl.textContent = "Enter the full 8-digit code."; return; }

  submitBtn.disabled = true;
  try {
    const snap = await get(ref(db, `schools/${SCHOOL_ID}/link_codes/${code}`));
    if (!snap.exists()) { errEl.textContent = "That code wasn't recognized."; return; }
    const entry = snap.val();
    if (entry.expires_at && entry.expires_at < Date.now() / 1000) {
      errEl.textContent = "That code has expired — ask the office for a new one.";
      return;
    }
    await set(ref(db, `parents/${uid}/students/${entry.student_id}`), {
      student_name: entry.student_name,
      grade: entry.grade,
      section: entry.section,
      linked_at: Date.now(),
    });
    saveLocal("activeStudentId", entry.student_id);
    errEl.textContent = "";
    inputEl.value = "";
    onSuccess?.(entry);
  } catch (e) {
    console.error(e);
    errEl.textContent = "Couldn't reach the server — check your connection and try again.";
  } finally {
    submitBtn.disabled = false;
  }
}

function wireLinkModal() {
  $("#link-cancel-btn").addEventListener("click", closeLinkModal);
  const submit = () => redeemCode($("#link-code-input").value, {
    inputEl: $("#link-code-input"),
    errEl: $("#link-code-error"),
    submitBtn: $("#link-submit-btn"),
    onSuccess: (entry) => { closeLinkModal(); toast(`${entry.student_name} linked!`); },
  });
  $("#link-submit-btn").addEventListener("click", submit);
  $("#link-code-input").addEventListener("input", (e) => { e.target.value = e.target.value.replace(/\D/g, "").slice(0, 8); });
  $("#link-code-input").addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  $("#link-modal").addEventListener("click", (e) => { if (e.target.id === "link-modal") closeLinkModal(); });
}

// ─────────────────────────────────────────────────────────────────────────
// Auth gate — shown before anything else (even the onboarding intro) when
// there's no signed-in parent account. A parent creates an account once
// (email/password or Google) and from then on just logs into that same
// account on any device to see their linked students; the link-code step
// that follows (onboarding gate, below) is only about attaching a *new*
// student to whichever account is currently signed in.
// ─────────────────────────────────────────────────────────────────────────
function showAuthScreen() {
  $("#onboarding-screen")?.classList.add("hidden"); // never show both gates at once
  $("#auth-screen")?.classList.remove("hidden");
  $(".app")?.style.setProperty("display", "none");
  $(".tabbar")?.style.setProperty("display", "none");
}
function hideAuthScreen() {
  $("#auth-screen")?.classList.add("hidden");
}

function authErrorMessage(e) {
  const messages = {
    "auth/email-already-in-use": "That email already has an account — try logging in instead.",
    "auth/invalid-email": "That doesn't look like a valid email address.",
    "auth/weak-password": "Password must be at least 6 characters.",
    "auth/missing-password": "Enter a password.",
    "auth/user-not-found": "No account found with that email.",
    "auth/wrong-password": "Incorrect password.",
    "auth/invalid-credential": "Incorrect email or password.",
    "auth/too-many-requests": "Too many attempts — please wait a bit and try again.",
    "auth/popup-closed-by-user": "Sign-in was closed before finishing — try again.",
    "auth/network-request-failed": "Network error — check your connection and try again.",
    "auth/admin-restricted-operation": "This sign-in method isn't enabled for this school yet.",
  };
  return messages[e?.code] || e?.message || "Something went wrong — please try again.";
}

function wireAuthScreen() {
  const tabs = Array.from(document.querySelectorAll("#auth-screen .auth-tab"));
  const submitBtn = $("#auth-submit-btn");
  const forgotBtn = $("#auth-forgot-btn");
  const errEl = $("#auth-error");
  const emailEl = $("#auth-email-input");
  const passEl = $("#auth-password-input");
  const googleBtn = $("#auth-google-btn");
  let mode = "signup";

  function setMode(next) {
    mode = next;
    tabs.forEach(t => t.classList.toggle("active", t.dataset.mode === mode));
    submitBtn.textContent = mode === "signup" ? "Create account" : "Log in";
    passEl.setAttribute("autocomplete", mode === "signup" ? "new-password" : "current-password");
    forgotBtn.classList.toggle("hidden", mode !== "login");
    errEl.textContent = "";
  }
  tabs.forEach(t => t.addEventListener("click", () => setMode(t.getAttribute("data-mode"))));

  async function submit() {
    const email = emailEl.value.trim();
    const password = passEl.value;
    errEl.textContent = "";
    if (!email || !password) { errEl.textContent = "Enter your email and password."; return; }
    if (mode === "signup" && password.length < 6) { errEl.textContent = "Password must be at least 6 characters."; return; }

    submitBtn.disabled = true;
    googleBtn.disabled = true;
    const prevLabel = submitBtn.textContent;
    submitBtn.textContent = mode === "signup" ? "Creating account…" : "Signing in…";
    try {
      if (mode === "signup") await signUpParent(email, password);
      else await signInParent(email, password);
      // watchAuthState() in init() picks up the resulting signed-in user
      // from here — nothing else to do on success.
    } catch (e) {
      errEl.textContent = authErrorMessage(e);
      submitBtn.disabled = false;
      googleBtn.disabled = false;
      submitBtn.textContent = prevLabel;
    }
  }
  submitBtn.addEventListener("click", submit);
  passEl.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  emailEl.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });

  forgotBtn.addEventListener("click", async () => {
    const email = emailEl.value.trim();
    errEl.textContent = "";
    if (!email) { errEl.textContent = "Enter your email above first, then tap this again."; return; }
    try {
      await resetParentPassword(email);
      toast("Password reset email sent.");
    } catch (e) {
      errEl.textContent = authErrorMessage(e);
    }
  });

  googleBtn.addEventListener("click", async () => {
    errEl.textContent = "";
    submitBtn.disabled = true;
    googleBtn.disabled = true;
    try {
      await signInParentWithGoogle(); // may redirect the page (standalone PWA / popup-blocked); resumes via resolveGoogleRedirect() in init()
    } catch (e) {
      errEl.textContent = authErrorMessage(e);
    } finally {
      submitBtn.disabled = false;
      googleBtn.disabled = false;
    }
  });

  setMode("signup");
}

// ─────────────────────────────────────────────────────────────────────────

// see any part of the app before a code is entered; this replaces the old
// "browse around with an empty state" behavior. Uses the same redeemCode()
// as the modal above.
// ─────────────────────────────────────────────────────────────────────────
function showOnboardingGate() {
  $("#onboarding-screen")?.classList.remove("hidden");
  $(".app")?.style.setProperty("display", "none");
  $(".tabbar")?.style.setProperty("display", "none");
}
function hideOnboardingGate() {
  $("#onboarding-screen")?.classList.add("hidden");
  $(".app")?.style.removeProperty("display");
  $(".tabbar")?.style.removeProperty("display");
  showInstallPrompt(); // no-op if already shown/consumed, or nothing pending
}
function wireOnboardingGate() {
  const track = $("#onboard-track");
  const dots = Array.from(document.querySelectorAll("#onboard-dots .dot"));
  const controls = $(".onboard-controls");
  const CODE_SLIDE = dots.length - 1; // last slide is always the mandatory code step
  let slide = 0;

  function render() {
    track.style.transform = `translateX(-${slide * 100}%)`;
    dots.forEach((d, i) => d.classList.toggle("active", i === slide));
    controls.classList.toggle("hidden", slide === CODE_SLIDE);
    if (slide === CODE_SLIDE) setTimeout(() => $("#onboard-code-input")?.focus(), 350);
  }
  function goTo(i) { slide = Math.max(0, Math.min(CODE_SLIDE, i)); render(); }

  $("#onboard-next-btn").addEventListener("click", () => goTo(slide + 1));
  $("#onboard-skip-btn").addEventListener("click", () => goTo(CODE_SLIDE));
  dots.forEach((d, i) => d.addEventListener("click", () => { if (i <= CODE_SLIDE) goTo(i); }));

  // Swipe support — phone-first. Ignored on the code slide so it doesn't
  // fight with typing/tapping the input.
  const viewport = $(".onboard-viewport");
  let touchStartX = null;
  viewport.addEventListener("touchstart", (e) => {
    if (slide === CODE_SLIDE) return;
    touchStartX = e.touches[0].clientX;
  }, { passive: true });
  viewport.addEventListener("touchend", (e) => {
    if (touchStartX === null || slide === CODE_SLIDE) return;
    const dx = e.changedTouches[0].clientX - touchStartX;
    touchStartX = null;
    if (Math.abs(dx) < 40) return;
    goTo(dx < 0 ? slide + 1 : slide - 1);
  }, { passive: true });

  render(); // resets to slide 0 + correct control visibility on load

  const submit = () => redeemCode($("#onboard-code-input").value, {
    inputEl: $("#onboard-code-input"),
    errEl: $("#onboard-code-error"),
    submitBtn: $("#onboard-submit-btn"),
    onSuccess: (entry) => { hideOnboardingGate(); toast(`${entry.student_name} linked!`); },
  });
  $("#onboard-submit-btn").addEventListener("click", submit);
  $("#onboard-code-input").addEventListener("input", (e) => { e.target.value = e.target.value.replace(/\D/g, "").slice(0, 8); });
  $("#onboard-code-input").addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
}

// ─────────────────────────────────────────────────────────────────────────
// Log out — signs out of the parent account on this device. Unlike the old
// anonymous-auth model, this does NOT delete linked students; they stay on
// the account in the cloud, so logging back in here (or on any other
// device, with the same email/password or Google account) brings them
// right back.
// ─────────────────────────────────────────────────────────────────────────
async function handleLogout() {
  if (!confirm("Log out of your parent account on this device?")) return;
  try {
    await signOutParent();
  } catch (e) { console.warn("Sign-out failed:", e); }
  Object.keys(localStorage).filter(k => k.startsWith("dapres_parent:")).forEach(k => localStorage.removeItem(k));
  location.reload();
}

// ─────────────────────────────────────────────────────────────────────────
// Alert derivation — diff each incoming attendance snapshot against what
// this device last saw, and turn new late/absent/on-time entries for a
// linked student into an alert row. Persisted locally so Alerts survive
// a reload. This is a client-side substitute for a push pipeline; see
// functions/index.js for the server-side (FCM) version of the same idea.
// ─────────────────────────────────────────────────────────────────────────
function deriveAlertsFromSnapshot() {
  const seen = loadLocal("seenRecords", {}); // `${date}:${studentId}` -> true
  const newAlerts = [];
  for (const [date, byStudent] of Object.entries(attendance)) {
    for (const [sid, rec] of Object.entries(byStudent)) {
      if (!linkedStudents[sid]) continue;
      const seenKey = `${date}:${sid}`;
      if (seen[seenKey]) continue;
      seen[seenKey] = true;
      const name = linkedStudents[sid].student_name;
      if (rec.status === "late") {
        newAlerts.push({ studentId: sid, kind: "late", ts: Date.now(),
          title: `${name} scanned in at ${fmtTime12h(rec.time)}`, sub: "Past the late cutoff" });
      } else if (rec.status === "absent") {
        newAlerts.push({ studentId: sid, kind: "absent", ts: Date.now(),
          title: `No scan recorded for ${name}`, sub: `Marked absent on ${date}` });
      } else {
        newAlerts.push({ studentId: sid, kind: "ontime", ts: Date.now(),
          title: `${name} scanned in at ${fmtTime12h(rec.time)}`, sub: "Right on time" });
      }
    }
  }
  if (newAlerts.length) {
    alertsCache = [...newAlerts.reverse(), ...alertsCache].slice(0, 100);
    saveLocal("alerts", alertsCache);
    saveLocal("seenRecords", seen);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// FCM — request permission + register token under this parent's uid.
// Actually *sending* a push on a late/absent event needs server-side code
// (a client can't push to itself while backgrounded) — see
// functions/index.js for a ready-to-deploy Cloud Function that does that
// part. This just does the client-side half: permission + token storage.
// ─────────────────────────────────────────────────────────────────────────
async function ensureNotificationPermissionAndToken() {
  if (!("Notification" in window)) return;
  if (!FCM_VAPID_KEY) {
    console.warn("[fcm] FCM_VAPID_KEY not set in js/firebase-init.js — skipping token registration.");
    return;
  }
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return;
    const messaging = await getMessagingIfSupported();
    if (!messaging) return;
    const reg = await navigator.serviceWorker.getRegistration("firebase-messaging-sw.js");
    const token = await getToken(messaging, { vapidKey: FCM_VAPID_KEY, serviceWorkerRegistration: reg });
    if (token && uid) {
      await update(ref(db, `parents/${uid}/fcm_tokens`), { [token]: true });
    }
  } catch (e) {
    console.warn("[fcm] token registration failed (non-fatal):", e);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Data listeners
// ─────────────────────────────────────────────────────────────────────────
function watchLinkedStudents() {
  onValue(ref(db, `parents/${uid}/students`), (snap) => {
    linkedStudents = snap.val() || {};
    const ids = Object.keys(linkedStudents);
    if (!ids.length) {
      showOnboardingGate();
      return;
    }
    hideOnboardingGate();
    if (!activeStudentId || !linkedStudents[activeStudentId]) {
      activeStudentId = loadLocal("activeStudentId", null);
      if (!activeStudentId || !linkedStudents[activeStudentId]) activeStudentId = ids[0] || null;
    }
    renderAll();
  });
}

function watchAttendance() {
  onValue(ref(db, `schools/${SCHOOL_ID}/attendance`), (snap) => {
    attendance = snap.val() || {};
    deriveAlertsFromSnapshot();
    renderAll();
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Install prompt — shown at most ONCE, ever, per device. Chrome/Edge/
// Android fire `beforeinstallprompt`, which we intercept and hold onto so
// we can trigger it from our own styled banner instead of the browser's
// generic mini-infobar. iOS Safari never fires that event (Apple doesn't
// support it), so there it's a one-time instructional card pointing at
// Share → Add to Home Screen instead. Whichever variant shows — or if the
// user dismisses it, or it's already running standalone — we set the same
// "seen" flag so it never appears again after this one time.
// ─────────────────────────────────────────────────────────────────────────
let deferredInstallPrompt = null;

function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}
function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
}
function installPromptAlreadyShown() {
  return loadLocal("installPromptShown", false);
}
function markInstallPromptShown() {
  saveLocal("installPromptShown", true);
}

function showInstallPrompt() {
  if (isStandalone() || installPromptAlreadyShown()) return;
  if (!$("#onboarding-screen")?.classList.contains("hidden")) return; // wait until past the gate
  if (!$("#auth-screen")?.classList.contains("hidden")) return; // ...and past the sign-in gate
  const banner = $("#install-prompt");
  if (!banner) return;

  if (isIOS()) {
    $("#install-prompt-title").textContent = "Add to your home screen";
    $("#install-prompt-sub").textContent = "Tap the Share icon, then \u201cAdd to Home Screen\u201d.";
    $("#install-btn").style.display = "none"; // no native trigger on iOS — instructional only
  } else if (!deferredInstallPrompt) {
    return; // no native prompt available and not iOS — nothing to show
  }

  banner.classList.add("show");
  markInstallPromptShown(); // "shown" the moment it appears — dismiss vs. install doesn't matter, it's a one-timer either way
}
function hideInstallPrompt() {
  $("#install-prompt")?.classList.remove("show");
}

function wireInstallPrompt() {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    if (!installPromptAlreadyShown()) showInstallPrompt();
  });
  window.addEventListener("appinstalled", () => {
    markInstallPromptShown();
    hideInstallPrompt();
  });
  $("#install-btn")?.addEventListener("click", async () => {
    hideInstallPrompt();
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
  });
  $("#install-dismiss-btn")?.addEventListener("click", hideInstallPrompt);

  // iOS never fires beforeinstallprompt, so give it its own path in after
  // the app has settled — still gated by the same one-time flag.
  if (isIOS() && !isStandalone() && !installPromptAlreadyShown()) {
    setTimeout(showInstallPrompt, 2500);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────────────────
async function init() {
  wireNav();
  wireLinkModal();
  wireOnboardingGate();
  wireAuthScreen();
  wireInstallPrompt();
  alertsCache = loadLocal("alerts", []);

  if ("serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("sw.js");
      await navigator.serviceWorker.register("firebase-messaging-sw.js");
    } catch (e) {
      console.warn("Service worker registration failed:", e);
    }
  }

  setLoadingStatus("Signing in…");

  // Pick up the result of a Google signInWithRedirect() (used inside
  // standalone PWAs and as a popup-blocked fallback) before wiring the
  // ongoing auth-state watcher below. No-op if there was no redirect.
  try {
    await resolveGoogleRedirect();
  } catch (e) {
    console.error("Google sign-in redirect failed:", e);
  }

  let appStarted = false;
  watchAuthState((user) => {
    if (!user) {
      hideLoadingScreen();
      showAuthScreen();
      return;
    }

    uid = user.uid;
    hideAuthScreen();
    if (appStarted) return; // already loading data — just a token refresh, ignore
    appStarted = true;

    setLoadingStatus("Loading students…");
    watchLinkedStudents();

    setLoadingStatus("Loading attendance…");
    watchAttendance();

    // Don't hold the loading screen hostage to a slow/offline first RTDB
    // read — show the app after a short grace period either way; the
    // realtime listeners above will backfill the UI the moment data arrives.
    setTimeout(hideLoadingScreen, 900);
  });
}

init();
