"""
화학실험 데이터 분석 웹 앱 (Flask)

실행:  python web/app.py   →  브라우저에서 http://127.0.0.1:5050 접속
- 데이터 입력: CSV/엑셀 파일 업로드 또는 화면 표에서 직접 입력·수정
- 분석: src/analyzer.py 의 파이프라인을 그대로 사용 (API 키는 서버에만 있고 브라우저로 나가지 않음)
"""

import base64
import io
import sys
import uuid
from collections import OrderedDict
from pathlib import Path

import numpy as np
import pandas as pd
from flask import Flask, jsonify, render_template, request, send_file

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
import analyzer as az  # noqa: E402

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 5 * 1024 * 1024  # 업로드 최대 5MB
app.json.ensure_ascii = False

MAX_ROWS = 300
# 웹 화면 규칙: 빨강·노랑·파랑·보라·핑크·주황 사용 안 함 → 초록 + 회색 계열
WEB_PLOT_PALETTE = {"정상": "#2e8b61", "이상치": "#3a4440", "trend": "#2e8b61"}

# 엑셀 리포트를 잠시 메모리에 보관 (최근 20개)
REPORTS = OrderedDict()

# 업로드 파일의 한글/변형 컬럼명을 표준 컬럼명으로 매핑
COLUMN_ALIASES = {
    "Experiment_ID": ["experiment_id", "실험id", "실험번호", "실험 번호", "id"],
    "Temp_C": ["temp_c", "온도", "반응온도", "반응 온도", "temp", "temperature"],
    "Pressure_bar": ["pressure_bar", "압력", "반응압력", "반응 압력", "pressure"],
    "Catalyst_g": ["catalyst_g", "촉매", "촉매량", "촉매 투입량", "catalyst"],
    "Reaction_Time_min": ["reaction_time_min", "반응시간", "반응 시간", "time"],
    "Yield_pct": ["yield_pct", "수율", "yield"],
    "Purity_pct": ["purity_pct", "순도", "purity"],
    "Notes": ["notes", "특이사항", "비고", "메모", "note"],
}


def normalize_columns(df):
    lookup = {}
    for std, aliases in COLUMN_ALIASES.items():
        for a in [std.lower(), *aliases]:
            lookup[a.replace(" ", "").lower()] = std
    renamed = {}
    for col in df.columns:
        key = str(col).split("(")[0].strip().replace(" ", "").lower()
        if key in lookup:
            renamed[col] = lookup[key]
    return df.rename(columns=renamed)


def rows_to_frame(rows):
    df = pd.DataFrame(rows)
    for col in az.REQUIRED_COLS:
        if col not in df.columns:
            df[col] = None
    df = df[az.REQUIRED_COLS].replace({"": None})
    # 완전히 빈 행 제거
    df = df.dropna(how="all", subset=[c for c in az.REQUIRED_COLS if c != "Experiment_ID"])
    df["Experiment_ID"] = [
        str(v).strip() if v not in (None, "") and not pd.isna(v) else f"ROW_{i + 1:03d}"
        for i, v in enumerate(df["Experiment_ID"])
    ]
    return df.reset_index(drop=True)


def frame_to_rows(df):
    df = df.copy()
    for col in az.NUMERIC_COLS:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    return df.astype(object).where(df.notna(), None).to_dict(orient="records")


def clean_value(v):
    if isinstance(v, (np.floating, float)):
        return None if np.isnan(v) or np.isinf(v) else round(float(v), 3)
    if isinstance(v, np.integer):
        return int(v)
    if isinstance(v, np.bool_):
        return bool(v)
    return v


# ---------------------------------------------------------------------------
@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/sample")
def sample():
    raw = pd.read_csv(az.DATA_PATH, encoding="utf-8")
    return jsonify(rows=frame_to_rows(raw))


@app.get("/api/template")
def template():
    buf = io.BytesIO(("﻿" + ",".join(az.REQUIRED_COLS) + "\n").encode("utf-8"))
    return send_file(buf, mimetype="text/csv", as_attachment=True, download_name="experiment_template.csv")


@app.post("/api/parse")
def parse_file():
    file = request.files.get("file")
    if not file or not file.filename:
        return jsonify(error="파일이 선택되지 않았습니다."), 400

    name = file.filename.lower()
    data = file.read()
    try:
        if name.endswith((".xlsx", ".xls")):
            df = pd.read_excel(io.BytesIO(data))
        elif name.endswith(".csv"):
            for enc in ("utf-8-sig", "cp949"):  # 한글 엑셀에서 저장한 CSV(cp949) 대응
                try:
                    df = pd.read_csv(io.BytesIO(data), encoding=enc)
                    break
                except UnicodeDecodeError:
                    continue
            else:
                return jsonify(error="CSV 인코딩을 읽을 수 없습니다. UTF-8로 저장해 주세요."), 400
        else:
            return jsonify(error="CSV 또는 엑셀(.xlsx) 파일만 올릴 수 있습니다."), 400
    except Exception as e:
        return jsonify(error=f"파일을 읽지 못했습니다: {e}"), 400

    df = normalize_columns(df)
    missing = [c for c in az.REQUIRED_COLS if c not in df.columns and c != "Experiment_ID"]
    if missing:
        return jsonify(error=f"필수 컬럼이 없습니다: {', '.join(missing)}. 양식 파일을 확인해 주세요."), 400
    if "Experiment_ID" not in df.columns:
        df["Experiment_ID"] = None
    if len(df) > MAX_ROWS:
        return jsonify(error=f"최대 {MAX_ROWS}행까지 분석할 수 있습니다. (현재 {len(df)}행)"), 400

    return jsonify(rows=frame_to_rows(df[az.REQUIRED_COLS]))


@app.post("/api/analyze")
def analyze():
    payload = request.get_json(silent=True) or {}
    rows = payload.get("rows") or []
    use_ai = bool(payload.get("use_ai", True))

    if not rows:
        return jsonify(error="분석할 데이터가 없습니다. 파일을 올리거나 표에 입력해 주세요."), 400
    if len(rows) > MAX_ROWS:
        return jsonify(error=f"최대 {MAX_ROWS}행까지 분석할 수 있습니다."), 400

    raw = rows_to_frame(rows)
    if raw.empty:
        return jsonify(error="값이 입력된 행이 없습니다."), 400
    if raw["Experiment_ID"].duplicated().any():
        dup = raw.loc[raw["Experiment_ID"].duplicated(), "Experiment_ID"].iloc[0]
        return jsonify(error=f"실험 번호가 중복됩니다: {dup}"), 400
    raw[az.NUMERIC_COLS] = raw[az.NUMERIC_COLS].apply(pd.to_numeric, errors="coerce")
    if raw["Yield_pct"].notna().sum() == 0:
        return jsonify(error="수율(Yield_pct) 값이 하나 이상 있어야 분석할 수 있습니다."), 400

    try:
        raw, df, missing_report = az.clean_data(raw)
        summary = az.summarize(df)

        plot_buf = io.BytesIO()
        az.make_plot(df, plot_buf, palette=WEB_PLOT_PALETTE)
        plot_b64 = base64.b64encode(plot_buf.getvalue()).decode()

        api_key = az.load_api_key() if use_ai else None
        df = az.apply_ai_analysis(df, api_key)

        excel_buf = io.BytesIO()
        az.save_excel(df, raw, summary, missing_report, excel_buf)
    except Exception as e:
        return jsonify(error=f"분석 중 오류가 발생했습니다: {e}"), 500

    report_id = uuid.uuid4().hex
    REPORTS[report_id] = excel_buf.getvalue()
    while len(REPORTS) > 20:
        REPORTS.popitem(last=False)

    result_cols = ["Experiment_ID", *az.NUMERIC_COLS, "Notes", "AI_Category", "AI_Cause_Summary",
                   "AI_Verified", "Verify_Note", "Rule_Category", "Is_Outlier", "Range_Violation",
                   "Data_Flag", "Use_For_Analysis"]
    result_rows = [{k: clean_value(v) for k, v in r.items()} for r in df[result_cols].to_dict(orient="records")]

    summary_rows = [
        {"variable": var, "mean": clean_value(r["mean"]), "std": clean_value(r["std"]),
         "min": clean_value(r["min"]), "max": clean_value(r["max"]),
         "mean_excl": clean_value(r["mean_excl_outlier"]), "corr": clean_value(r["corr_with_yield(정상군)"])}
        for var, r in summary.iterrows()
    ]
    cats = [
        {"category": r["AI_Category"], "count": clean_value(r["건수"]),
         "yield": clean_value(r["평균수율"]), "purity": clean_value(r["평균순도"])}
        for _, r in az.category_summary(df).iterrows()
    ]
    missing = [{"column": c, "count": int(r["Missing_Count"]), "pct": clean_value(r["Missing_Pct"])}
               for c, r in missing_report.iterrows() if r["Missing_Count"] > 0]

    return jsonify(
        source=df["AI_Source"].iloc[0],
        ai_requested=use_ai,
        kpi={
            "total": len(df),
            "outliers": int(df["Is_Outlier"].sum()),
            "unverified": int((~df["AI_Verified"]).sum()),
            "excluded": int((~df["Use_For_Analysis"]).sum()),
            "missing_cells": int(sum(m["count"] for m in missing)),
        },
        missing=missing,
        summary=summary_rows,
        categories=cats,
        rows=result_rows,
        plot=f"data:image/png;base64,{plot_b64}",
        report_id=report_id,
    )


@app.get("/api/download/<report_id>")
def download(report_id):
    data = REPORTS.get(report_id)
    if data is None:
        return "리포트가 만료되었습니다. 다시 분석해 주세요.", 404
    return send_file(io.BytesIO(data), as_attachment=True, download_name="analysis_result.xlsx",
                     mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


if __name__ == "__main__":
    # 127.0.0.1 → 내 컴퓨터에서만 접속 가능 (외부 공개 안 됨)
    app.run(host="127.0.0.1", port=5050, debug=False)
