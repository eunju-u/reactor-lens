// 반응기 실험 데이터 분석 - 프론트엔드
const COLS = [
  { key: "Experiment_ID", type: "text", cls: "id-input", ph: "EXP_001" },
  { key: "Temp_C", type: "number", ph: "180" },
  { key: "Pressure_bar", type: "number", ph: "2.0" },
  { key: "Catalyst_g", type: "number", ph: "1.0" },
  { key: "Reaction_Time_min", type: "number", ph: "90" },
  { key: "Yield_pct", type: "number", ph: "82.5" },
  { key: "Purity_pct", type: "number", ph: "96.2" },
  { key: "Notes", type: "text", cls: "notes-input", ph: "정상 진행 / [이상치] 원인 메모" },
];

const state = { rows: [], result: null, filter: "all" };
const $ = (sel) => document.querySelector(sel);

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? "–" : Number(v).toLocaleString("ko-KR", { maximumFractionDigits: d }));

function setMsg(el, text, kind = "") {
  el.textContent = text;
  el.className = "msg" + (kind ? " " + kind : "");
}

/* ---------------- ① 입력 ---------------- */
function loadRows(rows, message) {
  state.rows = rows.map((r) => {
    const o = {};
    COLS.forEach((c) => (o[c.key] = r[c.key] ?? ""));
    return o;
  });
  renderEditor();
  $("#editorCard").hidden = false;
  setMsg($("#inputMsg"), message, "ok");
  $("#editorCard").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function uploadFile(file) {
  if (!file) return;
  setMsg($("#inputMsg"), `"${file.name}" 읽는 중...`);
  const fd = new FormData();
  fd.append("file", file);
  try {
    const res = await fetch("/api/parse", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "파일을 읽지 못했습니다.");
    loadRows(data.rows, `"${file.name}"에서 ${data.rows.length}행을 불러왔습니다. 아래 표에서 확인 후 분석을 실행하세요.`);
  } catch (e) {
    setMsg($("#inputMsg"), e.message, "error");
  }
}

$("#fileInput").addEventListener("change", (e) => {
  uploadFile(e.target.files[0]);
  e.target.value = "";
});
const dz = $("#dropzone");
["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
dz.addEventListener("drop", (e) => uploadFile(e.dataTransfer.files[0]));

$("#btnSample").addEventListener("click", async () => {
  const res = await fetch("/api/sample");
  const data = await res.json();
  loadRows(data.rows, `샘플 데이터 ${data.rows.length}행을 불러왔습니다. (가상 데이터)`);
});

$("#btnBlank").addEventListener("click", () => {
  const blank = Array.from({ length: 5 }, (_, i) => ({ Experiment_ID: `EXP_${String(i + 1).padStart(3, "0")}` }));
  loadRows(blank, "빈 표 5행을 만들었습니다. 값을 입력하고, 필요하면 행을 추가하세요.");
});

/* ---------------- ② 편집 표 ---------------- */
function renderEditor() {
  const tbody = $("#editorTable tbody");
  tbody.innerHTML = state.rows
    .map((row, i) => {
      const cells = COLS.map((c) => {
        const v = row[c.key];
        const empty = v === "" || v === null ? " empty" : "";
        return `<td><input type="${c.type}" ${c.type === "number" ? 'step="any" inputmode="decimal"' : ""}
          class="${c.cls || ""}${empty}" data-i="${i}" data-k="${c.key}" value="${esc(v)}"
          placeholder="${c.type === "number" ? "비어 있음" : esc(c.ph)}" aria-label="${c.key} ${i + 1}행"></td>`;
      }).join("");
      return `<tr>${cells}<td><button class="del" data-del="${i}" title="이 행 삭제" aria-label="${i + 1}행 삭제">✕</button></td></tr>`;
    })
    .join("");
  $("#rowCount").textContent = `${state.rows.length}행`;
}

$("#editorTable").addEventListener("input", (e) => {
  const t = e.target;
  if (t.dataset.k === undefined) return;
  state.rows[+t.dataset.i][t.dataset.k] = t.value;
  t.classList.toggle("empty", t.value === "");
});
$("#editorTable").addEventListener("click", (e) => {
  const i = e.target.dataset.del;
  if (i === undefined) return;
  state.rows.splice(+i, 1);
  renderEditor();
});

$("#btnAddRow").addEventListener("click", () => {
  const n = state.rows.length + 1;
  state.rows.push(Object.fromEntries(COLS.map((c) => [c.key, c.key === "Experiment_ID" ? `EXP_${String(n).padStart(3, "0")}` : ""])));
  renderEditor();
  const inputs = $("#editorTable tbody").lastElementChild.querySelectorAll("input");
  inputs[1]?.focus();
});

$("#btnClear").addEventListener("click", () => {
  if (state.rows.length && !confirm("표의 데이터를 모두 지울까요?")) return;
  state.rows = [];
  renderEditor();
});

/* ---------------- 분석 실행 ---------------- */
$("#btnRun").addEventListener("click", async () => {
  const btn = $("#btnRun");
  const useAi = $("#useAi").checked;
  const rows = state.rows.map((r) => {
    const o = {};
    COLS.forEach((c) => (o[c.key] = r[c.key] === "" ? null : c.type === "number" ? Number(r[c.key]) : r[c.key]));
    return o;
  });

  btn.disabled = true;
  btn.classList.add("loading");
  btn.querySelector(".label").textContent = "분석 중...";
  setMsg($("#runMsg"), useAi ? "Gemini가 특이사항을 분류하고 있습니다. 10~30초 정도 걸릴 수 있습니다." : "분석 중입니다...");

  try {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows, use_ai: useAi }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "분석에 실패했습니다.");
    state.result = data;
    state.filter = "all";
    renderResults();
    setMsg($("#runMsg"), "분석이 끝났습니다. 아래에서 결과를 확인하세요.", "ok");
    $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    setMsg($("#runMsg"), e.message, "error");
  } finally {
    btn.disabled = false;
    btn.classList.remove("loading");
    btn.querySelector(".label").textContent = "분석 실행";
  }
});

/* ---------------- ③ 결과 ---------------- */
function renderResults() {
  const r = state.result;
  $("#results").hidden = false;

  const aiUsed = r.source.startsWith("Gemini");
  $("#sourceLine").textContent = aiUsed
    ? `분류 방식: ${r.source} · 결과는 규칙·원본 수치와 자동 대조했습니다`
    : r.ai_requested
      ? "분류 방식: 키워드 규칙 (API 키가 없거나 Gemini 호출에 실패해 규칙 기반으로 대체했습니다)"
      : "분류 방식: 키워드 규칙 (AI 분류 꺼짐)";
  $("#btnDownload").href = `/api/download/${r.report_id}`;

  const k = r.kpi;
  const kpis = [
    { label: "전체 실험", value: k.total, unit: "건", desc: `결측 칸 ${k.missing_cells}개 보정` },
    { label: "이상치", value: k.outliers, unit: "건", desc: "운전범위 · 수율 IQR · [이상치] 표기", icon: "✕" },
    { label: "AI 검토 필요", value: k.unverified, unit: "건", desc: "원본과 맞지 않아 사람이 확인할 행", icon: "⚑" },
    { label: "분석 제외", value: k.excluded, unit: "건", desc: "수율 값이 없어 통계에서 제외" },
  ];
  $("#kpis").innerHTML = kpis
    .map((x) => `<div class="kpi"><div class="k-label">${x.icon ? `<span aria-hidden="true">${x.icon}</span>` : ""}${x.label}</div>
      <div class="k-value">${x.value}<small>${x.unit}</small></div><div class="k-desc">${x.desc}</div></div>`)
    .join("");

  $("#plot").src = r.plot;

  renderCategories(r.categories);
  renderMissing(r.missing);
  renderChips();
  renderResultTable();
  renderStats(r.summary);
}

function renderCategories(cats) {
  const rows = cats
    .map((c) => {
      const w = Math.max(0, Math.min(100, c.yield ?? 0));
      return `<div class="bar-row">
        <span class="b-label">${esc(c.category)}<small>${c.count}건</small></span>
        <div class="bar-track" data-tip="${esc(`${c.category}\n건수: ${c.count}건\n평균 수율: ${fmt(c.yield)}%\n평균 순도: ${fmt(c.purity)}%`)}">
          <div class="bar-fill" style="width:${w}%"></div>
        </div>
        <span class="b-value">${fmt(c.yield)}%</span>
      </div>`;
    })
    .join("");
  $("#catChart").innerHTML = rows + `<div class="bar-axis"><span></span><span><span>0%</span><span>50%</span><span>100%</span></span><span></span></div>`;
}

const KO = { Experiment_ID: "실험 번호", Temp_C: "반응온도", Pressure_bar: "압력", Catalyst_g: "촉매량", Reaction_Time_min: "반응시간", Yield_pct: "수율", Purity_pct: "순도", Notes: "특이사항" };

function renderMissing(missing) {
  $("#missingBox").innerHTML = missing.length
    ? `<ul class="missing-list">${missing.map((m) => `<li><span>${KO[m.column] || esc(m.column)} <span class="muted">${esc(m.column)}</span></span><span>${m.count}개 · ${fmt(m.pct)}%</span></li>`).join("")}</ul>`
    : `<p class="empty-note">✓ 결측치가 없습니다.</p>`;
}

function renderChips() {
  const rows = state.result.rows;
  const chips = [
    { id: "all", label: "전체", n: rows.length },
    { id: "outlier", label: "이상치", n: rows.filter((x) => x.Is_Outlier).length },
    { id: "review", label: "검토 필요", n: rows.filter((x) => !x.AI_Verified).length },
  ];
  $("#filterChips").innerHTML = chips
    .map((c) => `<button class="chip" role="tab" data-f="${c.id}" aria-selected="${state.filter === c.id}">${c.label} ${c.n}</button>`)
    .join("");
}

$("#filterChips").addEventListener("click", (e) => {
  const f = e.target.dataset.f;
  if (!f) return;
  state.filter = f;
  renderChips();
  renderResultTable();
});

function renderResultTable() {
  let rows = state.result.rows;
  if (state.filter === "outlier") rows = rows.filter((x) => x.Is_Outlier);
  if (state.filter === "review") rows = rows.filter((x) => !x.AI_Verified);

  $("#resultTable tbody").innerHTML = rows.length
    ? rows
        .map((x) => {
          const badges = [];
          if (x.Is_Outlier) badges.push(`<span class="badge out">✕ 이상치</span>`);
          if (!x.AI_Verified) badges.push(`<span class="badge review">⚑ 검토 필요</span>`);
          if (!x.Use_For_Analysis) badges.push(`<span class="badge excl">분석 제외</span>`);
          if (!badges.length) badges.push(`<span class="badge ok">정상</span>`);
          const flags = [x.Range_Violation && `운전범위 이탈: ${x.Range_Violation}`, x.Data_Flag].filter(Boolean);
          return `<tr class="${x.Is_Outlier ? "is-outlier" : ""} ${!x.AI_Verified ? "needs-review" : ""}">
            <td><strong>${esc(x.Experiment_ID)}</strong></td>
            <td><div class="status-cell">${badges.join("")}</div></td>
            <td class="num">${fmt(x.Temp_C)}</td>
            <td class="num">${fmt(x.Pressure_bar, 2)}</td>
            <td class="num">${fmt(x.Catalyst_g, 2)}</td>
            <td class="num">${fmt(x.Yield_pct)}</td>
            <td class="num">${fmt(x.Purity_pct)}</td>
            <td>${esc(x.Notes)}${flags.map((f) => `<span class="flag-note">${esc(f)}</span>`).join("")}</td>
            <td><span class="cat">${esc(x.AI_Category)}</span></td>
            <td>${esc(x.AI_Cause_Summary)}</td>
            <td>${x.AI_Verified ? `<span class="verify-ok">원본 대조 일치</span>` : `<span class="verify-bad">${esc(x.Verify_Note)}</span>`}</td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="11" class="muted" style="text-align:center;padding:20px">해당하는 실험이 없습니다.</td></tr>`;
}

function renderStats(summary) {
  const names = { Temp_C: "반응온도 °C", Pressure_bar: "압력 bar", Catalyst_g: "촉매 g", Reaction_Time_min: "반응시간 min", Yield_pct: "수율 %", Purity_pct: "순도 %" };
  $("#statsTable tbody").innerHTML = summary
    .map((s) => `<tr><td>${names[s.variable] || esc(s.variable)}</td>
      <td class="num">${fmt(s.mean, 2)}</td><td class="num">${fmt(s.std, 2)}</td>
      <td class="num">${fmt(s.min, 2)}</td><td class="num">${fmt(s.max, 2)}</td>
      <td class="num">${fmt(s.mean_excl, 2)}</td><td class="num">${s.variable === "Yield_pct" ? "–" : fmt(s.corr, 3)}</td></tr>`)
    .join("");
}

/* ---------------- 툴팁 ---------------- */
const tip = $("#tooltip");
document.addEventListener("mousemove", (e) => {
  const t = e.target.closest("[data-tip]");
  if (!t) { tip.hidden = true; return; }
  tip.innerHTML = esc(t.dataset.tip).replace(/\n/g, "<br>");
  tip.hidden = false;
  const x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
  tip.style.left = `${x}px`;
  tip.style.top = `${e.clientY + 14}px`;
});
