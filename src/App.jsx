import { useState, useEffect, useCallback } from "react";

const SHEET_ID   = "1FkEZ5OgkfCiJyyCkpiiGI2IWz6-5cOKVX47H1g0IJRk";
const EXPORT_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`;
const GVIZ_URL   = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json`;

// ลอง fetch ตรง → ถ้าไม่ได้ (CORS) ใช้ proxy สำรอง
const PROXIES = [
  "",                                        // ตรง (ใช้ได้เมื่อ deploy บน Vercel)
  "https://corsproxy.io/?",                  // proxy 1
  "https://api.allorigins.win/raw?url=",     // proxy 2
];

async function fetchWithProxy(url) {
  for (const proxy of PROXIES) {
    try {
      const fullUrl = proxy ? proxy + encodeURIComponent(url) : url;
      const res = await fetch(fullUrl, { signal: AbortSignal.timeout(8000) });
      if (res.ok) return await res.text();
    } catch { continue; }
  }
  throw new Error("โหลดไม่ได้ ตรวจสอบว่า Sheet แชร์เป็น Anyone with link");
}

// ── โครงสร้าง CSV จริง (index นับจาก 0) ──────────────────────────────────────
// row 0  → ",DAILY SCHEDULE,..."
// row 1  → "สัปดาห์ของวันที่, 27-Apr-2026, ..."
// row 2  → "วันที่/เวลานัด, 27-Apr, 28-Apr, ..."   ← dateCells
// row 3  → ", MONDAY, TUESDAY, ..."                 ← dayCells
// row 4  → "ทันตแพทย์, หมอ..., ..."
// row 5  → (ว่าง)
// row 6  → (ว่าง)
// row 7+ → "09:00, ชื่อคนไข้, ..."                 ← slot rows
const ROW_DATE  = 2;
const ROW_DAY   = 3;
const ROW_START = 7;   // เริ่ม slot เวลา

const MONTH_TH = {
  Jan:"ม.ค.",Feb:"ก.พ.",Mar:"มี.ค.",Apr:"เม.ย.",May:"พ.ค.",Jun:"มิ.ย.",
  Jul:"ก.ค.",Aug:"ส.ค.",Sep:"ก.ย.",Oct:"ต.ค.",Nov:"พ.ย.",Dec:"ธ.ค."
};
const DAY_TH = {
  MONDAY:"จันทร์", TUESDAY:"อังคาร", WEDNESDAY:"พุธ",
  THURSDAY:"พฤหัส", FRIDAY:"ศุกร์", SATURDAY:"เสาร์", SUNDAY:"อาทิตย์"
};

// แปลง "27-Apr" หรือ "27-Apr-2026" → วัตถุ Date
function parseSheetDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  // รูปแบบ "27-Apr-2026" หรือ "27-Apr"
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})(?:-(\d{4}))?$/);
  if (m) {
    const year = m[3] ? parseInt(m[3]) : new Date().getFullYear();
    const d = new Date(`${m[2]} ${m[1]} ${year}`);
    return isNaN(d) ? null : d;
  }
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

function fmtDate(d) {
  if (!d) return "";
  const dt = d instanceof Date ? d : parseSheetDate(d);
  if (!dt) return String(d);
  const mon = dt.toLocaleString("en",{month:"short"});
  return `${dt.getDate()} ${MONTH_TH[mon] || mon}`;
}

function parseTime(s) {
  const m = String(s).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1]) * 60 + parseInt(m[2]);
}

function inRange(t, sTime = "09:00", eTime = "17:00") {
  const tv = parseTime(t), sv = parseTime(sTime), ev = parseTime(eTime);
  return tv !== null && sv !== null && ev !== null && tv >= sv && tv <= ev;
}

function groupTimes(times) {
  if (!times.length) return [];
  const mins = times.map(parseTime).filter(v => v !== null).sort((a,b)=>a-b);
  const hhmm = v => `${String(Math.floor(v/60)).padStart(2,"0")}:${String(v%60).padStart(2,"0")}`;
  const out = []; let s = mins[0], p = mins[0];
  for (let i = 1; i < mins.length; i++) {
    if (mins[i] - p <= 30) { p = mins[i]; }
    else { out.push(s===p ? hhmm(s) : `${hhmm(s)}-${hhmm(p)}`); s=p=mins[i]; }
  }
  out.push(s===p ? hhmm(s) : `${hhmm(s)}-${hhmm(p)}`);
  return out;
}

// ── CSV parser รองรับ multiline ใน quoted cell ────────────────────────────────
function parseCSV(text) {
  const rows = []; let cur = "", inQ = false, row = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (inQ && text[i+1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (c === ',' && !inQ) { row.push(cur); cur = ""; }
    else if ((c === '\n' || c === '\r') && !inQ) {
      if (c === '\r' && text[i+1] === '\n') i++;
      row.push(cur); rows.push(row); row = []; cur = "";
    } else cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

async function fetchSheetCSV(sheetName) {
  const url = `${EXPORT_URL}&sheet=${encodeURIComponent(sheetName)}`;
  return parseCSV(await fetchWithProxy(url));
}

async function loadSheetNames() {
  try {
    const raw = await fetchWithProxy(GVIZ_URL);
    const match = raw.match(/"name":"([^"]+)"/g) || [];
    const names = match.map(m => m.replace(/^"name":"/, "").replace(/"$/, ""));
    if (names.length) return names;
  } catch {}
  return Array.from({length:16},(_,i)=>`Sheet${i+1}`);
}

// ── inject CSS once ───────────────────────────────────────────────────────────
if (typeof document !== "undefined" && !document.getElementById("dq-styles")) {
  const s = document.createElement("style");
  s.id = "dq-styles";
  s.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700;800&display=swap');
    @keyframes pulse  { 0%,100%{box-shadow:0 0 0 0 #0D937366} 50%{box-shadow:0 0 0 7px #0D937300} }
    @keyframes spin   { to{transform:rotate(360deg)} }
    @keyframes fadeUp { from{opacity:0;transform:translateY(14px)} to{opacity:1;transform:none} }
    @keyframes bounce { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-8px)} }
    *{box-sizing:border-box} body{margin:0}
  `;
  document.head.appendChild(s);
}

const C = {
  bg:"#F5F7FF",      // พื้นหลังฟ้าอ่อนมาก
  surface:"#FFFFFF",
  card:"#FFFFFF",
  border:"#DDE1F5",
  accent:"#5B5BD6",  // indigo เข้ม
  green:"#0D9373",   // teal เข้ม
  red:"#C8302A",     // แดงเข้ม
  text:"#1A1A3E",    // navy เข้ม อ่านง่าย
  muted:"#6366A0",
  pill:"#EEF0FF",    // pill พื้นฟ้าอ่อน
  pillTxt:"#3D3D9F", // pill ตัวอักษร navy
  dayBg:"#EEF0FF",
};

// ── Main App ──────────────────────────────────────────────────────────────────
export default function App() {
  const [weeks, setWeeks]     = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [lastUpdate, setLast] = useState(null);
  const [filter, setFilter]   = useState("all");
  const [debug, setDebug]     = useState(null); // debug info

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      let names;
      try { names = await loadSheetNames(); }
      catch { names = Array.from({length:16},(_,i)=>`Sheet${i+1}`); }

      const allWeeks = [];
      let first = null, cutoff = null;
      let debugInfo = { sheetsTried: 0, sheetsOk: 0, firstRows: null };

      for (const name of names) {
        debugInfo.sheetsTried++;
        try {
          const rows = await fetchSheetCSV(name);
          if (rows.length < ROW_START + 1) continue;

          // เก็บ debug rows แรก
          if (!debugInfo.firstRows) debugInfo.firstRows = rows.slice(0,10).map(r=>r.slice(0,4));

          const dateCells = rows[ROW_DATE]?.slice(1) || [];  // col B–H
          const dayCells  = rows[ROW_DAY]?.slice(1)  || [];  // col B–H
          const slotRows  = rows.slice(ROW_START);

          // หาวันที่เริ่มสัปดาห์
          const sd = parseSheetDate(dateCells[0]);
          if (!sd) continue;

          // จำกัด 2.5 เดือน = 75 วัน
          if (!first) {
            first  = sd;
            cutoff = new Date(sd);
            cutoff.setDate(cutoff.getDate() + 75);
          }
          if (sd > cutoff) break;
          debugInfo.sheetsOk++;

          const days = [];
          for (let col = 0; col < 7; col++) {
            const dateVal = dateCells[col];
            const dayVal  = dayCells[col];
            if (!dateVal && !dayVal) continue;

            const avail = [];
            for (const row of slotRows) {
              const slotLabel = String(row[0]||"").trim();
              if (!inRange(slotLabel)) continue;          // เฉพาะ 09:00–17:00
              const cell = String(row[col+1]||"").trim(); // col+1 เพราะ col A = label
              if (cell === "" || cell === "-") avail.push(slotLabel); // ว่าง = ไม่มีชื่อ
            }

            days.push({
              dayKey: String(dayVal||"").toUpperCase().trim(),
              dateVal,
              times: groupTimes(avail),
            });
          }
          allWeeks.push({
            start: dateCells[0],
            end:   dateCells[6] || dateCells.filter(Boolean).at(-1),
            days,
          });
        } catch { continue; }
      }

      setDebug(debugInfo);
      setWeeks(allWeeks);
      setLast(new Date().toLocaleTimeString("th-TH"));
    } catch(e) { setError(e.message); }
    finally    { setLoading(false); }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load]);

  const displayed = filter === "available"
    ? weeks.filter(w => w.days.some(d => d.times.length))
    : weeks;

  return (
    <div style={sx.root}>
      <div style={sx.bgDots}/>

      {/* ── Header ── */}
      <header style={sx.header}>
        <div style={sx.hLeft}>
          <span style={{fontSize:26}}>🦷</span>
          <div>
            <h1 style={sx.title}>คิวว่างนัดหมาย</h1>
            <p style={sx.sub}>อัปเดตทุก 60 วิ · 2.5 เดือนข้างหน้า</p>
          </div>
        </div>
        <div style={sx.hRight}>
          <div style={sx.liveDot}>
            <span style={sx.livePulse}/>
            <span style={sx.liveTxt}>LIVE</span>
          </div>
          <FBtn active={filter==="all"}       color={C.accent} onClick={()=>setFilter("all")}>ทั้งหมด</FBtn>
          <FBtn active={filter==="available"} color={C.green}  onClick={()=>setFilter("available")}>ว่างเท่านั้น</FBtn>
          <button style={sx.iconBtn} onClick={load} disabled={loading}>
            <span style={loading?{display:"inline-block",animation:"spin 1s linear infinite"}:{}}> ↻</span>
          </button>
        </div>
      </header>

      {lastUpdate && !loading && (
        <div style={sx.statusBar}>
          ✦ อัปเดตล่าสุด {lastUpdate}
          <span style={{color:C.accent}}> · {displayed.length} สัปดาห์</span>
          {debug && <span style={{color:C.muted}}> · โหลดสำเร็จ {debug.sheetsOk}/{debug.sheetsTried} sheets</span>}
        </div>
      )}

      {loading && !weeks.length && (
        <Ctr>
          <div style={{fontSize:44,animation:"bounce 1s ease infinite"}}>🦷</div>
          <p style={{color:C.muted,margin:0}}>กำลังโหลดตารางนัด...</p>
        </Ctr>
      )}

      {error && (
        <Ctr>
          <p style={{fontSize:36,margin:0}}>⚠️</p>
          <p style={{color:C.red,fontWeight:700,margin:4}}>โหลดไม่สำเร็จ</p>
          <p style={{color:C.muted,fontSize:12,margin:0}}>{error}</p>
          <button style={sx.retryBtn} onClick={load}>ลองใหม่</button>
        </Ctr>
      )}

      {!loading && !error && (
        <main style={sx.list}>
          {displayed.length === 0
            ? <Ctr>
                <p style={{fontSize:44,margin:0}}>🎉</p>
                <p style={{color:C.muted}}>ไม่พบคิวว่างในขณะนี้</p>
                {debug && (
                  <div style={{marginTop:16,padding:12,background:C.surface,borderRadius:10,textAlign:"left",fontSize:11,color:C.muted,maxWidth:400}}>
                    <b style={{color:C.accent}}>Debug info</b><br/>
                    Sheets tried: {debug.sheetsTried} / OK: {debug.sheetsOk}<br/>
                    {debug.firstRows && <>
                      Row {ROW_DATE} (dates): {JSON.stringify(debug.firstRows[ROW_DATE])}<br/>
                      Row {ROW_DAY} (days):  {JSON.stringify(debug.firstRows[ROW_DAY])}<br/>
                    </>}
                  </div>
                )}
              </Ctr>
            : displayed.map((wk, i) => <WeekCard key={i} wk={wk} idx={i}/>)
          }
        </main>
      )}
    </div>
  );
}

function FBtn({ children, active, color, onClick }) {
  return (
    <button onClick={onClick} style={{
      padding:"5px 13px", borderRadius:20, fontSize:13, cursor:"pointer",
      fontFamily:"inherit", transition:"all .2s",
      border:`1px solid ${active?color:C.border}`,
      background:active?color:"transparent",
      color:active?"#fff":C.muted,
    }}>{children}</button>
  );
}
function Ctr({ children }) { return <div style={sx.center}>{children}</div>; }

function WeekCard({ wk, idx }) {
  const hasAny  = wk.days.some(d => d.times.length > 0);
  const visible = wk.days.filter(d => d.times.length > 0);
  const [open, setOpen] = useState(true);

  return (
    <div style={{...sx.card, animationDelay:`${idx*30}ms`}}>
      <div
        style={{...sx.cardHdr, background: hasAny
          ? `linear-gradient(90deg,#EEF0FF,#FFFFFF)`
          : `linear-gradient(90deg,#FFF0F0,#FFFFFF)`}}
        onClick={()=>setOpen(o=>!o)}
      >
        <div style={{width:4,background:hasAny?C.accent:C.red,flexShrink:0}}/>
        <div style={sx.cardHdrInner}>
          <span style={sx.dateRange}>{fmtDate(wk.start)} – {fmtDate(wk.end)}</span>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <span style={{...sx.badge,...(hasAny?sx.badgeOpen:sx.badgeFull)}}>
              {hasAny?"ว่าง":"เต็ม"}
            </span>
            <span style={{color:C.muted,fontSize:10}}>{open?"▲":"▼"}</span>
          </div>
        </div>
      </div>

      {open && (
        <div style={sx.cardBody}>
          {!hasAny
            ? <p style={{color:C.muted,fontSize:13,textAlign:"center",margin:"12px 0"}}>ไม่มีคิวว่างในสัปดาห์นี้</p>
            : visible.map((day,di) => <DayRow key={di} day={day} isLast={di===visible.length-1}/>)
          }
        </div>
      )}
    </div>
  );
}

function DayRow({ day, isLast }) {
  const dayTH = DAY_TH[day.dayKey] || day.dayKey;
  return (
    <>
      <div style={sx.dayRow}>
        <div style={sx.dayBox}>
          <span style={sx.dayName}>{dayTH}</span>
          <span style={sx.dayDate}>{fmtDate(day.dateVal)}</span>
        </div>
        <div style={sx.pills}>
          {day.times.map((t,i) => <span key={i} style={sx.pill}>{t}</span>)}
        </div>
      </div>
      {!isLast && <div style={{height:1,background:C.border,margin:"2px 0"}}/>}
    </>
  );
}

const sx = {
  root:{ minHeight:"100vh", background:C.bg, color:C.text,
    fontFamily:"'Sarabun','Noto Sans Thai',sans-serif", position:"relative" },
  bgDots:{ position:"fixed", inset:0, zIndex:0, pointerEvents:"none",
    backgroundImage:`radial-gradient(circle,#C8CCE8 1px,transparent 1px)`,
    backgroundSize:"28px 28px", opacity:0.4 },
  header:{ position:"sticky", top:0, zIndex:20,
    display:"flex", alignItems:"center", justifyContent:"space-between",
    flexWrap:"wrap", gap:10, padding:"14px 16px",
    borderBottom:`1px solid ${C.border}`,
    background:`${C.bg}f8`, backdropFilter:"blur(10px)", boxShadow:"0 1px 16px #5B5BD611" },
  hLeft:{ display:"flex", alignItems:"center", gap:12 },
  hRight:{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" },
  title:{ margin:0, fontSize:19, fontWeight:800, letterSpacing:"-0.5px",
    background:`linear-gradient(135deg,${C.text},${C.accent})`,
    WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" },
  sub:{ margin:0, fontSize:11, color:C.muted, marginTop:2 },
  liveDot:{ display:"flex", alignItems:"center", gap:5 },
  livePulse:{ width:7, height:7, borderRadius:"50%", background:C.green,
    display:"inline-block", animation:"pulse 2s infinite", flexShrink:0 },
  liveTxt:{ fontSize:11, fontWeight:700, color:C.green, letterSpacing:1 },
  iconBtn:{ width:34, height:34, borderRadius:17,
    border:`1px solid ${C.border}`, background:"transparent",
    color:C.muted, fontSize:17, cursor:"pointer",
    display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"inherit" },
  statusBar:{ position:"relative", zIndex:10, padding:"7px 16px", fontSize:12, color:C.muted },
  list:{ position:"relative", zIndex:10, maxWidth:620, margin:"0 auto",
    padding:"14px 12px 40px", display:"flex", flexDirection:"column", gap:10 },
  card:{ background:C.card, borderRadius:14, border:`1px solid ${C.border}`,
    overflow:"hidden", boxShadow:"0 2px 16px #5B5BD618", animation:"fadeUp .35s ease both" },
  cardHdr:{ display:"flex", alignItems:"stretch", cursor:"pointer", userSelect:"none" },
  cardHdrInner:{ flex:1, display:"flex", alignItems:"center", justifyContent:"space-between",
    padding:"11px 14px" },
  dateRange:{ fontSize:15, fontWeight:700, color:C.text },
  badge:{ fontSize:11, fontWeight:700, padding:"3px 10px", borderRadius:12, letterSpacing:.5 },
  badgeOpen:{ background:"#D4F5EE", color:C.green, border:"1px solid #0D937344" },
  badgeFull:{ background:"#FFE5E5",   color:C.red,   border:"1px solid #C8302A44" },
  cardBody:{ padding:"8px 14px 12px" },
  dayRow:{ display:"flex", alignItems:"center", gap:12, padding:"8px 0" },
  dayBox:{ minWidth:80, display:"flex", flexDirection:"column",
    alignItems:"center", padding:"6px 8px", borderRadius:10,
    background:C.dayBg, flexShrink:0 },
  dayName:{ fontSize:13, fontWeight:700, color:C.accent },
  dayDate:{ fontSize:12, color:C.muted, marginTop:2 },
  pills:{ display:"flex", flexWrap:"wrap", gap:6, flex:1 },
  pill:{ fontSize:12, fontWeight:600, padding:"5px 11px", borderRadius:20,
    background:C.pill, color:C.pillTxt, border:`1px solid ${C.border}`, whiteSpace:"nowrap" },
  center:{ position:"relative", zIndex:10, display:"flex", flexDirection:"column",
    alignItems:"center", justifyContent:"center", padding:60, gap:8, textAlign:"center" },
  retryBtn:{ marginTop:8, padding:"8px 24px", borderRadius:20,
    background:C.accent, color:"#fff", border:"none",
    cursor:"pointer", fontSize:14, fontFamily:"inherit" },
};
