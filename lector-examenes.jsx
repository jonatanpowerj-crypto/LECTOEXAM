import React, { useState, useRef, useEffect } from "react";

/* ============================================================
   LECTOR DE EXÁMENES — OMR robusto para hojas tipo burbuja
   1) Clave  2) Calificar (foto, EN VIVO o manual)  3) Resultados
   Opciones por pregunta: A-B hasta A-F.

   NÚCLEO DE VISIÓN (v2):
   - Medición de relleno NORMALIZADA por celda (compensa
     iluminación/sombras locales).
   - Umbral GLOBAL por estadística de Otsu (sin umbrales fijos).
   - Decisión RELATIVA por pregunta + piso de contraste absoluto
     para no marcar ruido.
   - NIVEL DE CONFIANZA por respuesta y banderas de ambigüedad
     (en blanco / doble marca / baja confianza).
   ============================================================ */

const ALL_LETTERS = ["A", "B", "C", "D", "E", "F"];

const C = {
  paper: "#FAF9F4",
  ink: "#16201D",
  green: "#0E7C66",
  greenSoft: "#E2F0EB",
  red: "#C03221",
  redSoft: "#F9E5E2",
  amber: "#B97A14",
  amberSoft: "#FBF0DC",
  gray: "#6F6F68",
  line: "#D8D6CC",
};

/* ---------- Burbuja estilo hoja de respuestas ---------- */
function Bubble({ label, state, onClick, size = 38 }) {
  const styles = {
    off: { bg: "#fff", bd: C.ink, fg: C.ink },
    key: { bg: C.ink, bd: C.ink, fg: "#fff" },
    ok: { bg: C.green, bd: C.green, fg: "#fff" },
    bad: { bg: C.red, bd: C.red, fg: "#fff" },
  }[state] || { bg: "#fff", bd: C.ink, fg: C.ink };
  return (
    <button
      onClick={onClick}
      style={{
        width: size, height: size, borderRadius: "50%",
        border: `2px solid ${styles.bd}`, background: styles.bg, color: styles.fg,
        fontFamily: "ui-monospace, 'Courier New', monospace",
        fontWeight: 700, fontSize: size * 0.42, cursor: onClick ? "pointer" : "default",
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        transition: "all .12s ease", flexShrink: 0, padding: 0,
      }}
    >
      {label}
    </button>
  );
}

/* ---------- utilidades de malla (interpolación bilineal) ---------- */
const gridPoint = (corners, u, v) => {
  const [tl, tr, br, bl] = corners;
  const top = { x: tl.x + (tr.x - tl.x) * u, y: tl.y + (tr.y - tl.y) * u };
  const bot = { x: bl.x + (br.x - bl.x) * u, y: bl.y + (br.y - bl.y) * u };
  return { x: top.x + (bot.x - top.x) * v, y: top.y + (bot.y - top.y) * v };
};

/* ---------- Otsu: umbral óptimo entre dos poblaciones ----------
   Separa "burbujas vacías" de "burbujas rellenadas" maximizando
   la varianza entre clases. Es adaptativo: no depende de un valor
   fijo, sino de los datos reales de CADA hoja. */
function otsuThreshold(values) {
  const BINS = 64;
  const hist = new Array(BINS).fill(0);
  for (const v of values) {
    const b = Math.min(BINS - 1, Math.max(0, Math.floor(v * BINS)));
    hist[b]++;
  }
  const total = values.length || 1;
  let sumAll = 0;
  for (let i = 0; i < BINS; i++) sumAll += i * hist[i];
  let wB = 0, sumB = 0, best = -1, thrBin = Math.floor(BINS * 0.3);
  for (let i = 0; i < BINS; i++) {
    wB += hist[i];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thrBin = i; }
  }
  return thrBin / BINS;
}

const clamp01 = (x) => Math.max(0, Math.min(1, x));

/* ---------- Análisis de imagen (OMR v2) ----------
   Devuelve answers[] = { ans, flag, conf } y cells[] (para overlay),
   más métricas de calidad (umbral, confianza media, ambiguas). */
function analyzeSheet(ctx, W, H, corners, nQ, nOpts, sensitivity) {
  const t0 = (typeof performance !== "undefined" ? performance.now() : Date.now());
  const data = ctx.getImageData(0, 0, W, H).data;
  const lumAt = (x, y) => {
    const xi = Math.max(0, Math.min(W - 1, Math.round(x)));
    const yi = Math.max(0, Math.min(H - 1, Math.round(y)));
    const i = (yi * W + xi) * 4;
    return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  };
  const pt = (u, v) => gridPoint(corners, u, v);
  const cellW = Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y) / nOpts;
  const cellH = Math.hypot(corners[3].x - corners[0].x, corners[3].y - corners[0].y) / nQ;
  const cellMin = Math.min(cellW, cellH);
  const rInner = Math.max(2, cellMin * 0.30);   // disco interior (evita el aro impreso)
  const rPaper = cellMin * 0.55;                // anillo exterior = papel local

  // 1) Para cada burbuja: media de luminancia interior + papel local.
  //    fill normalizado = (papel_local - tinta_interior) / papel_local
  //    -> robusto ante sombras: cada celda se compara contra SU propio blanco.
  const cells = [];
  const fills = [];
  for (let r = 0; r < nQ; r++) {
    const row = [];
    for (let c = 0; c < nOpts; c++) {
      const center = pt((c + 0.5) / nOpts, (r + 0.5) / nQ);
      // tinta interior (promedio)
      let sumIn = 0, nIn = 0;
      const step = Math.max(1, Math.floor(rInner / 7));
      for (let dy = -rInner; dy <= rInner; dy += step) {
        for (let dx = -rInner; dx <= rInner; dx += step) {
          if (dx * dx + dy * dy > rInner * rInner) continue;
          sumIn += lumAt(center.x + dx, center.y + dy); nIn++;
        }
      }
      const meanIn = nIn ? sumIn / nIn : 255;
      // papel local: percentil alto (75) de un anillo exterior -> blanco real,
      // ignorando que algún punto caiga sobre tinta vecina.
      const ring = [];
      for (let a = 0; a < 12; a++) {
        const ang = (a / 12) * Math.PI * 2;
        ring.push(lumAt(center.x + Math.cos(ang) * rPaper, center.y + Math.sin(ang) * rPaper));
      }
      ring.sort((p, q) => p - q);
      const paper = Math.max(40, ring[Math.floor(ring.length * 0.75)]);
      const fill = clamp01((paper - meanIn) / paper);
      row.push({ center, radius: rInner, fill });
      fills.push(fill);
    }
    cells.push(row);
  }

  // 2) Umbral global por Otsu + estadística del grupo "vacío".
  const otsu = otsuThreshold(fills);
  const lowVals = fills.filter((f) => f < otsu);
  const lowMean = lowVals.length ? lowVals.reduce((a, b) => a + b, 0) / lowVals.length : 0;
  const lowStd = lowVals.length
    ? Math.sqrt(lowVals.reduce((a, b) => a + (b - lowMean) ** 2, 0) / lowVals.length) : 0.02;
  // Sensibilidad afina el umbral: >0.5 detecta marcas más tenues.
  const nudge = (sensitivity - 0.5) * 0.12;
  // piso absoluto: una marca debe destacar del nivel "vacío" para evitar ruido.
  const absFloor = lowMean + Math.max(0.10, 2.2 * lowStd);
  const T = clamp01(Math.max(otsu * 0.9, absFloor) - nudge);

  // 3) Decisión relativa por pregunta + confianza.
  let confSum = 0, ambig = 0;
  const answers = cells.map((row) => {
    const fs = row.map((c) => c.fill);
    const max = Math.max(...fs);
    const idx = fs.indexOf(max);
    const second = Math.max(...fs.filter((_, i) => i !== idx), 0);

    if (max < T) {
      const conf = clamp01((T - max) / Math.max(T, 0.01));
      confSum += conf; ambig++;
      return { ans: null, flag: "blank", conf };
    }
    if (second > T * 0.9 && second > max * 0.78) {
      const conf = clamp01((max - second) / Math.max(max, 0.01)); // baja
      confSum += conf; ambig++;
      return { ans: null, flag: "multi", conf };
    }
    const sepNorm = (max - second) / Math.max(max, 0.01);
    const marNorm = (max - T) / Math.max(T, 0.01);
    const conf = clamp01(0.5 * Math.min(sepNorm / 0.40, 1) + 0.5 * Math.min(marNorm / 0.60, 1));
    confSum += conf;
    if (conf < 0.40) { ambig++; return { ans: idx, flag: "low", conf }; }
    return { ans: idx, flag: null, conf };
  });

  const t1 = (typeof performance !== "undefined" ? performance.now() : Date.now());
  return {
    answers, cells,
    metrics: {
      threshold: T, otsu,
      avgConf: answers.length ? confSum / answers.length : 0,
      ambiguous: ambig,
      ms: Math.round(t1 - t0),
    },
  };
}

/* ---------- color de overlay según estado/confianza ---------- */
function ringColor(flag, isDet, correctVsKey, hasKey) {
  if (flag === "multi") return "rgba(185,122,20,.95)";       // ámbar
  if (!isDet) return null;
  if (flag === "low") return "rgba(185,122,20,.95)";         // ámbar (revisar)
  if (hasKey) return correctVsKey ? "rgba(14,124,102,.95)" : "rgba(192,50,33,.95)";
  return "rgba(14,124,102,.95)";                             // verde (marca detectada)
}

/* ---------- dibujo del overlay ---------- */
function drawOverlay(ctx, corners, nQ, nOpts, detection, detected, answerKey, dragIdx) {
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = "rgba(14,124,102,.45)";
  for (let r = 0; r <= nQ; r++) {
    const a = gridPoint(corners, 0, r / nQ), b = gridPoint(corners, 1, r / nQ);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  for (let c = 0; c <= nOpts; c++) {
    const a = gridPoint(corners, c / nOpts, 0), b = gridPoint(corners, c / nOpts, 1);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  if (detection) {
    const hasKey = Array.isArray(answerKey) && answerKey.some((k) => k != null);
    detection.cells.forEach((row, r) => {
      const det = detected ? detected[r] : detection.answers[r].ans;
      const flag = detection.answers[r].flag;
      row.forEach((cell, c) => {
        const isDet = det != null && det === c;
        const col = ringColor(flag, isDet, answerKey[r] === c, hasKey);
        if (!col) return;
        ctx.lineWidth = 4; ctx.strokeStyle = col;
        ctx.beginPath();
        ctx.arc(cell.center.x, cell.center.y, cell.radius * 1.55, 0, Math.PI * 2);
        ctx.stroke();
      });
    });
  }
  corners.forEach((p, i) => {
    ctx.fillStyle = dragIdx === i ? C.amber : C.green;
    ctx.beginPath(); ctx.arc(p.x, p.y, 14, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = "bold 13px ui-monospace, monospace";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(String(i + 1), p.x, p.y);
  });
}

/* ---------- arrastre de esquinas compartido ---------- */
function useCornerDrag(canvasRef, corners, setCorners) {
  const [dragIdx, setDragIdx] = useState(-1);
  const toCanvas = (e) => {
    const cv = canvasRef.current;
    const rect = cv.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * cv.width,
      y: ((e.clientY - rect.top) / rect.height) * cv.height,
    };
  };
  const onDown = (e) => {
    if (!corners) return;
    const p = toCanvas(e);
    const scale = canvasRef.current.width / canvasRef.current.getBoundingClientRect().width;
    let best = -1, bestD = (44 * scale) ** 2;
    corners.forEach((c, i) => {
      const d = (c.x - p.x) ** 2 + (c.y - p.y) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best >= 0) { setDragIdx(best); e.target.setPointerCapture(e.pointerId); }
  };
  const onMove = (e) => {
    if (dragIdx < 0) return;
    const p = toCanvas(e);
    setCorners((cs) => cs.map((c, i) => (i === dragIdx ? p : c)));
  };
  const onUp = () => setDragIdx(-1);
  return { dragIdx, onDown, onMove, onUp };
}

/* ---------- Lienzo para FOTO ---------- */
function ScanCanvas({ imgSrc, nQ, nOpts, corners, setCorners, detection, answerKey, detected }) {
  const canvasRef = useRef(null);
  const imgRef = useRef(null);
  const [dims, setDims] = useState({ w: 0, h: 0 });
  const drag = useCornerDrag(canvasRef, corners, setCorners);

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1600 / img.width);
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      imgRef.current = img;
      setDims({ w, h });
      if (!corners) {
        setCorners([
          { x: w * 0.18, y: h * 0.04 }, { x: w * 0.96, y: h * 0.04 },
          { x: w * 0.96, y: h * 0.96 }, { x: w * 0.18, y: h * 0.96 },
        ]);
      }
    };
    img.src = imgSrc;
  }, [imgSrc]); // eslint-disable-line

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !imgRef.current || !dims.w) return;
    cv.width = dims.w; cv.height = dims.h;
    const ctx = cv.getContext("2d");
    ctx.drawImage(imgRef.current, 0, 0, dims.w, dims.h);
    if (corners) drawOverlay(ctx, corners, nQ, nOpts, detection, detected, answerKey, drag.dragIdx);
  }, [dims, corners, nQ, nOpts, detection, detected, answerKey, drag.dragIdx]);

  return (
    <canvas
      ref={canvasRef}
      onPointerDown={drag.onDown} onPointerMove={drag.onMove} onPointerUp={drag.onUp}
      style={{ width: "100%", borderRadius: 10, border: `1.5px solid ${C.line}`, touchAction: "none", display: "block", cursor: "crosshair" }}
    />
  );
}

/* ---------- Lector EN VIVO (cámara) ---------- */
function LiveScanner({ nQ, nOpts, answerKey, sensitivity, onCapture }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const workRef = useRef(null);
  const [corners, setCorners] = useState(null);
  const [camError, setCamError] = useState(null);
  const [liveDet, setLiveDet] = useState(null);
  const [stable, setStable] = useState(0);
  const lastSigRef = useRef("");
  const drag = useCornerDrag(canvasRef, corners, setCorners);
  const stateRef = useRef({});
  stateRef.current = { ...stateRef.current, corners, nQ, nOpts, answerKey, sensitivity, dragIdx: drag.dragIdx };

  useEffect(() => {
    let stream = null, raf = null, timer = null, alive = true;
    const start = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false,
        });
        if (!alive) { stream.getTracks().forEach((t) => t.stop()); return; }
        const v = videoRef.current;
        v.srcObject = stream;
        await v.play();
        const W = v.videoWidth || 1280, H = v.videoHeight || 720;
        canvasRef.current.width = W; canvasRef.current.height = H;
        workRef.current = document.createElement("canvas");
        workRef.current.width = W; workRef.current.height = H;
        setCorners((c) => c || [
          { x: W * 0.22, y: H * 0.10 }, { x: W * 0.78, y: H * 0.10 },
          { x: W * 0.78, y: H * 0.90 }, { x: W * 0.22, y: H * 0.90 },
        ]);

        const draw = () => {
          if (!alive) return;
          const s = stateRef.current;
          const ctx = canvasRef.current.getContext("2d");
          ctx.drawImage(v, 0, 0, W, H);
          if (s.corners) drawOverlay(ctx, s.corners, s.nQ, s.nOpts, s.lastDet, null, s.answerKey, s.dragIdx);
          raf = requestAnimationFrame(draw);
        };
        draw();

        timer = setInterval(() => {
          const s = stateRef.current;
          if (!alive || !s.corners) return;
          const wctx = workRef.current.getContext("2d", { willReadFrequently: true });
          wctx.drawImage(v, 0, 0, W, H);
          const det = analyzeSheet(wctx, W, H, s.corners, s.nQ, s.nOpts, s.sensitivity);
          stateRef.current.lastDet = det;
          setLiveDet(det);
          const sig = det.answers.map((a) => (a.flag ? "?" : a.ans)).join(",");
          const clean = !det.answers.some((a) => a.flag);
          if (sig === lastSigRef.current && clean) setStable((n) => Math.min(n + 1, 6));
          else setStable(0);
          lastSigRef.current = sig;
        }, 550);
      } catch (err) {
        setCamError(err && err.name ? err.name : String(err));
      }
    };
    start();
    return () => {
      alive = false;
      if (raf) cancelAnimationFrame(raf);
      if (timer) clearInterval(timer);
      if (stream) stream.getTracks().forEach((t) => t.stop());
    };
  }, []); // eslint-disable-line

  if (camError) {
    return (
      <div style={{ padding: "16px", borderRadius: 10, background: C.amberSoft, color: C.ink, fontSize: 14, lineHeight: 1.5 }}>
        <b>No se pudo abrir la cámara</b> ({camError}).<br />
        Permite el acceso a la cámara en el navegador, abre la app en su propia pestaña con <b>https://</b>,
        o usa el modo <b>📷 Con foto</b>, que aplica exactamente el mismo análisis.
      </div>
    );
  }

  const liveScore = liveDet
    ? liveDet.answers.filter((a, i) => a.ans != null && a.ans === answerKey[i]).length
    : null;
  const flags = liveDet ? liveDet.answers.filter((a) => a.flag).length : 0;
  const resolved = liveDet ? liveDet.answers.filter((a) => a.ans != null).length : 0;
  const ready = stable >= 2 && flags === 0 && resolved === nQ;

  return (
    <div>
      <video ref={videoRef} playsInline muted style={{ display: "none" }} />
      <p style={{ fontSize: 13.5, color: C.gray, margin: "0 0 8px" }}>
        Apunta la cámara a la hoja y ajusta los puntos <b style={{ color: C.green }}>1·2·3·4</b> a las
        esquinas de la zona de burbujas <b>una sola vez</b>. La lectura se actualiza sola.
      </p>
      <canvas
        ref={canvasRef}
        onPointerDown={drag.onDown} onPointerMove={drag.onMove} onPointerUp={drag.onUp}
        style={{ width: "100%", borderRadius: 10, border: `2px solid ${ready ? C.green : C.line}`, touchAction: "none", display: "block", cursor: "crosshair" }}
      />
      <div style={{
        marginTop: 10, padding: "12px 16px", borderRadius: 10, display: "flex",
        alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10,
        background: ready ? C.greenSoft : "#F2F1EA",
      }}>
        <div>
          <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 22, fontWeight: 800, color: ready ? C.green : C.ink }}>
            {liveScore != null ? `${liveScore}/${nQ}` : "…"}
          </span>
          <span style={{ fontSize: 13, color: C.gray, marginLeft: 10 }}>
            {!liveDet ? "Buscando marcas…"
              : flags > 0 ? `⚠ ${flags} pregunta(s) por revisar · ${resolved}/${nQ} leídas`
              : ready ? `✓ Lectura estable · confianza ${(liveDet.metrics.avgConf * 100).toFixed(0)}%`
              : `Estabilizando… ${resolved}/${nQ}`}
          </span>
        </div>
        <button
          onClick={() => liveDet && onCapture(liveDet)}
          disabled={!liveDet}
          style={{
            padding: "12px 22px", borderRadius: 10, fontSize: 15, fontWeight: 700, border: "none",
            background: liveDet ? (ready ? C.green : C.ink) : "#C9C7BD",
            color: "#fff", cursor: liveDet ? "pointer" : "not-allowed",
          }}
        >
          📸 Capturar lectura
        </button>
      </div>
    </div>
  );
}

/* ============================================================ */
function LectorExamenes() {
  const [tab, setTab] = useState("clave");
  const [nQ, setNQ] = useState(10);
  const [nOpts, setNOpts] = useState(4);
  const [answerKey, setAnswerKey] = useState(Array(10).fill(null));
  const [results, setResults] = useState([]);

  const [mode, setMode] = useState("foto"); // foto | vivo | manual
  const [imgSrc, setImgSrc] = useState(null);
  const [corners, setCorners] = useState(null);
  const [detection, setDetection] = useState(null);
  const [detected, setDetected] = useState(Array(10).fill(null));
  const [student, setStudent] = useState("");
  const [sensitivity, setSensitivity] = useState(0.5);
  const fileRef = useRef(null);
  const hiddenCanvasRef = useRef(null);

  const OPTS = ALL_LETTERS.slice(0, nOpts);
  const keyComplete = answerKey.slice(0, nQ).every((a) => a != null);

  const changeNQ = (n) => {
    n = Math.max(1, Math.min(50, n));
    setNQ(n);
    setAnswerKey((k) => { const nk = k.slice(0, n); while (nk.length < n) nk.push(null); return nk; });
    setDetected((d) => { const nd = d.slice(0, n); while (nd.length < n) nd.push(null); return nd; });
    setDetection(null);
  };
  const changeNOpts = (n) => {
    setNOpts(n);
    setAnswerKey((k) => k.map((a) => (a != null && a >= n ? null : a)));
    setDetected((d) => d.map((a) => (a != null && a >= n ? null : a)));
    setDetection(null);
  };

  const loadFile = (file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      setImgSrc(e.target.result);
      setCorners(null);
      setDetection(null);
      setDetected(Array(nQ).fill(null));
    };
    reader.readAsDataURL(file);
  };

  const runAnalysis = () => {
    if (!imgSrc || !corners) return;
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1600 / img.width);
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const cv = hiddenCanvasRef.current;
      cv.width = w; cv.height = h;
      const ctx = cv.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, w, h);
      const det = analyzeSheet(ctx, w, h, corners, nQ, nOpts, sensitivity);
      setDetection(det);
      setDetected(det.answers.map((a) => a.ans));
    };
    img.src = imgSrc;
  };

  const captureLive = (det) => {
    setDetection(det);
    setDetected(det.answers.map((a) => a.ans));
  };

  const score = detected.slice(0, nQ).filter((a, i) => a != null && a === answerKey[i]).length;
  const allMarked = detected.slice(0, nQ).every((a) => a != null);

  const saveResult = () => {
    setResults((r) => [
      ...r,
      {
        name: student.trim() || `Alumno ${r.length + 1}`,
        answers: detected.slice(0, nQ),
        score, total: nQ,
        avgConf: detection ? detection.metrics.avgConf : null,
        ambiguous: detection ? detection.metrics.ambiguous : null,
        date: new Date().toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" }),
      },
    ]);
    setStudent("");
    setDetected(Array(nQ).fill(null));
    setDetection(null);
    setImgSrc(null);
    setTab("resultados");
  };

  const exportCSV = () => {
    const head = ["Alumno", "Aciertos", "Total", "Calificación", "Confianza%", "Ambiguas", "Fecha",
      ...Array.from({ length: nQ }, (_, i) => `P${i + 1}`)];
    const rows = results.map((r) => [
      r.name, r.score, r.total, ((r.score / r.total) * 10).toFixed(1),
      r.avgConf != null ? (r.avgConf * 100).toFixed(0) : "-",
      r.ambiguous != null ? r.ambiguous : "-", r.date,
      ...r.answers.map((a) => (a == null ? "-" : ALL_LETTERS[a])),
    ]);
    const csv = [head, ...rows].map((row) => row.map((v) => `"${v}"`).join(",")).join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "calificaciones.csv";
    a.click();
  };

  const itemStats = Array.from({ length: nQ }, (_, i) => {
    if (!results.length) return 0;
    const wrong = results.filter((r) => r.answers[i] !== answerKey[i]).length;
    return wrong / results.length;
  });

  const S = {
    app: { minHeight: "100vh", background: C.paper, color: C.ink,
      fontFamily: "'Avenir Next', 'Segoe UI', system-ui, sans-serif", padding: "0 0 60px" },
    wrap: { maxWidth: 760, margin: "0 auto", padding: "0 16px" },
    card: { background: "#fff", border: `1.5px solid ${C.line}`, borderRadius: 14, padding: 20, marginTop: 16 },
    btn: (primary = true, disabled = false) => ({
      padding: "12px 22px", borderRadius: 10, fontSize: 15, fontWeight: 700,
      border: primary ? "none" : `1.5px solid ${C.ink}`,
      background: disabled ? "#C9C7BD" : primary ? C.green : "transparent",
      color: primary ? "#fff" : C.ink, cursor: disabled ? "not-allowed" : "pointer",
    }),
    mono: { fontFamily: "ui-monospace, 'Courier New', monospace" },
  };

  const bubbleSize = nOpts >= 5 ? 32 : 38;
  const bubbleGap = nOpts >= 5 ? 8 : 12;

  const StepTab = ({ id, num, label }) => (
    <button onClick={() => setTab(id)} style={{
      flex: 1, padding: "12px 6px", border: "none", cursor: "pointer",
      background: tab === id ? C.ink : "transparent", color: tab === id ? "#fff" : C.gray,
      fontWeight: 700, fontSize: 14, borderRadius: 10,
      display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
    }}>
      <span style={{ ...S.mono, width: 22, height: 22, borderRadius: "50%", fontSize: 12,
        border: `2px solid ${tab === id ? "#fff" : C.gray}`,
        display: "inline-flex", alignItems: "center", justifyContent: "center" }}>{num}</span>
      {label}
    </button>
  );

  const confColor = (c) => (c == null ? C.gray : c >= 0.6 ? C.green : c >= 0.4 ? C.amber : C.red);

  return (
    <div style={S.app}>
      <canvas ref={hiddenCanvasRef} style={{ display: "none" }} />
      <div style={{ background: C.ink, color: "#fff", padding: "26px 16px 22px" }}>
        <div style={{ maxWidth: 760, margin: "0 auto", display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ display: "flex", gap: 5 }}>
            {OPTS.map((o, i) => (
              <span key={o} style={{ ...S.mono, width: 26, height: 26, borderRadius: "50%",
                border: "2px solid #fff", background: i === 1 ? "#fff" : "transparent",
                color: i === 1 ? C.ink : "#fff", fontSize: 12, fontWeight: 700,
                display: "inline-flex", alignItems: "center", justifyContent: "center" }}>{o}</span>
            ))}
          </div>
          <div>
            <div style={{ fontSize: 21, fontWeight: 800, letterSpacing: ".5px" }}>Lector de Exámenes</div>
            <div style={{ fontSize: 13, opacity: 0.75 }}>OMR con umbral adaptativo y nivel de confianza</div>
          </div>
        </div>
      </div>

      <div style={S.wrap}>
        <div style={{ display: "flex", gap: 6, marginTop: 16, background: "#fff", border: `1.5px solid ${C.line}`, borderRadius: 12, padding: 5 }}>
          <StepTab id="clave" num="1" label="Clave" />
          <StepTab id="calificar" num="2" label="Calificar" />
          <StepTab id="resultados" num="3" label={`Resultados${results.length ? ` (${results.length})` : ""}`} />
        </div>

        {/* ====== PASO 1: CLAVE ====== */}
        {tab === "clave" && (
          <div style={S.card}>
            <h2 style={{ margin: 0, fontSize: 17 }}>Configuración del examen</h2>
            <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginTop: 12, alignItems: "flex-end" }}>
              <label style={{ fontSize: 13.5, color: C.gray }}>
                Número de preguntas
                <input type="number" min={1} max={50} value={nQ}
                  onChange={(e) => changeNQ(parseInt(e.target.value) || 1)}
                  style={{ ...S.mono, display: "block", marginTop: 5, width: 90, padding: "9px 10px", borderRadius: 8, border: `1.5px solid ${C.line}`, fontSize: 15 }} />
              </label>
              <div style={{ fontSize: 13.5, color: C.gray }}>
                Opciones por pregunta
                <div style={{ display: "flex", gap: 6, marginTop: 5 }}>
                  {[2, 3, 4, 5, 6].map((n) => (
                    <button key={n} onClick={() => changeNOpts(n)} style={{
                      ...S.mono, width: 42, height: 40, borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: "pointer",
                      border: `1.5px solid ${nOpts === n ? C.green : C.line}`,
                      background: nOpts === n ? C.green : "#fff", color: nOpts === n ? "#fff" : C.ink }}>
                      A-{ALL_LETTERS[n - 1]}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <h3 style={{ fontSize: 15, margin: "20px 0 4px" }}>Respuestas correctas</h3>
            <p style={{ fontSize: 13.5, color: C.gray, margin: "0 0 8px" }}>
              Toca la burbuja correcta de cada pregunta, igual que en la hoja del alumno.
            </p>
            <div>
              {Array.from({ length: nQ }, (_, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 14, padding: "8px 10px",
                  background: i % 2 ? "#F2F1EA" : "transparent", borderRadius: 8 }}>
                  <span style={{ ...S.mono, width: 26, fontWeight: 800, fontSize: 16, textAlign: "right" }}>{i + 1}</span>
                  <div style={{ display: "flex", gap: bubbleGap }}>
                    {OPTS.map((o, c) => (
                      <Bubble key={o} label={o} size={bubbleSize}
                        state={answerKey[i] === c ? "key" : "off"}
                        onClick={() => setAnswerKey((k) => k.map((v, j) => (j === i ? c : v)))} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 18, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
              <span style={{ fontSize: 13.5, color: keyComplete ? C.green : C.amber, fontWeight: 700 }}>
                {keyComplete ? "✓ Clave completa" : `Faltan ${answerKey.slice(0, nQ).filter((a) => a == null).length} respuestas`}
              </span>
              <button style={S.btn(true, !keyComplete)} disabled={!keyComplete} onClick={() => setTab("calificar")}>
                Continuar a calificar →
              </button>
            </div>
          </div>
        )}

        {/* ====== PASO 2: CALIFICAR ====== */}
        {tab === "calificar" && (
          <>
            {!keyComplete && (
              <div style={{ ...S.card, background: C.amberSoft, borderColor: C.amber }}>
                <strong>Primero captura la clave.</strong>{" "}
                <button onClick={() => setTab("clave")} style={{ ...S.btn(false), padding: "6px 14px", fontSize: 13 }}>Ir a la clave</button>
              </div>
            )}
            <div style={S.card}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {[["foto", "📷 Con foto"], ["vivo", "📹 En vivo"], ["manual", "✏️ Manual"]].map(([m, lbl]) => (
                  <button key={m} onClick={() => { setMode(m); setDetection(null); }} style={{
                    flex: 1, minWidth: 100, padding: "10px", borderRadius: 9, fontWeight: 700, fontSize: 14, cursor: "pointer",
                    border: `1.5px solid ${mode === m ? C.green : C.line}`,
                    background: mode === m ? C.greenSoft : "#fff", color: mode === m ? C.green : C.gray }}>{lbl}</button>
                ))}
              </div>

              <input style={{ width: "100%", boxSizing: "border-box", marginTop: 14, padding: "12px 14px",
                borderRadius: 10, border: `1.5px solid ${C.line}`, fontSize: 15 }}
                placeholder="Nombre del alumno" value={student} onChange={(e) => setStudent(e.target.value)} />

              {mode === "foto" && (
                <div style={{ marginTop: 14 }}>
                  {!imgSrc ? (
                    <button onClick={() => fileRef.current.click()} style={{
                      width: "100%", padding: "38px 16px", borderRadius: 12, cursor: "pointer",
                      border: `2px dashed ${C.green}`, background: C.greenSoft, color: C.green, fontSize: 15, fontWeight: 700 }}>
                      📷 Tomar foto o subir imagen de la hoja
                      <div style={{ fontWeight: 400, fontSize: 13, marginTop: 6, color: C.gray }}>
                        Consejo: buena luz pareja, hoja plana y la foto lo más recta posible
                      </div>
                    </button>
                  ) : (
                    <>
                      <p style={{ fontSize: 13.5, color: C.gray, margin: "0 0 8px" }}>
                        Arrastra los puntos <b style={{ color: C.green }}>1·2·3·4</b> a las esquinas de la zona de burbujas
                        (sin incluir los números). Luego presiona <b>Leer respuestas</b>.
                      </p>
                      <ScanCanvas imgSrc={imgSrc} nQ={nQ} nOpts={nOpts}
                        corners={corners} setCorners={setCorners}
                        detection={detection} answerKey={answerKey} detected={detected} />
                      <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
                        <button style={S.btn(true)} onClick={runAnalysis}>🔍 Leer respuestas</button>
                        <button style={S.btn(false)} onClick={() => fileRef.current.click()}>Cambiar foto</button>
                        <label style={{ fontSize: 13, color: C.gray, display: "flex", alignItems: "center", gap: 8, marginLeft: "auto" }}>
                          Sensibilidad
                          <input type="range" min={0} max={1} step={0.05} value={sensitivity}
                            onChange={(e) => setSensitivity(parseFloat(e.target.value))} />
                        </label>
                      </div>
                      {detection && (
                        <div style={{ marginTop: 10, fontSize: 12.5, color: C.gray }}>
                          Umbral auto: {(detection.metrics.threshold * 100).toFixed(0)}% ·
                          confianza media: {(detection.metrics.avgConf * 100).toFixed(0)}% ·
                          {detection.metrics.ms} ms
                        </div>
                      )}
                      {detection && detection.answers.some((a) => a.flag) && (
                        <div style={{ marginTop: 8, padding: "10px 14px", borderRadius: 10, background: C.amberSoft, color: C.amber, fontSize: 13.5, fontWeight: 600 }}>
                          ⚠ Revisar: {detection.answers.map((a, i) => a.flag
                            ? `P${i + 1} (${a.flag === "blank" ? "sin marca" : a.flag === "multi" ? "doble" : "baja confianza"})` : null)
                            .filter(Boolean).join(", ")}. Corrígelas abajo o ajusta la sensibilidad y vuelve a leer.
                        </div>
                      )}
                    </>
                  )}
                  <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden
                    onChange={(e) => loadFile(e.target.files[0])} />
                </div>
              )}

              {mode === "vivo" && (
                <div style={{ marginTop: 14 }}>
                  <LiveScanner nQ={nQ} nOpts={nOpts} answerKey={answerKey}
                    sensitivity={sensitivity} onCapture={captureLive} />
                  <label style={{ fontSize: 13, color: C.gray, display: "flex", alignItems: "center", gap: 8, marginTop: 10, justifyContent: "flex-end" }}>
                    Sensibilidad
                    <input type="range" min={0} max={1} step={0.05} value={sensitivity}
                      onChange={(e) => setSensitivity(parseFloat(e.target.value))} />
                  </label>
                </div>
              )}

              {(mode === "manual" || detection) && (
                <div style={{ marginTop: 16 }}>
                  <h3 style={{ fontSize: 15, margin: "0 0 4px" }}>
                    {mode === "manual" ? "Marca las respuestas del alumno" : "Respuestas detectadas — toca para corregir"}
                  </h3>
                  {Array.from({ length: nQ }, (_, i) => {
                    const a = detected[i];
                    const isOk = a != null && a === answerKey[i];
                    const conf = detection && detection.answers[i] ? detection.answers[i].conf : null;
                    const flag = detection && detection.answers[i] ? detection.answers[i].flag : null;
                    return (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: 14, padding: "7px 10px",
                        background: flag ? C.amberSoft : i % 2 ? "#F2F1EA" : "transparent", borderRadius: 8 }}>
                        <span style={{ ...S.mono, width: 26, fontWeight: 800, fontSize: 16, textAlign: "right" }}>{i + 1}</span>
                        <div style={{ display: "flex", gap: bubbleGap }}>
                          {OPTS.map((o, c) => (
                            <Bubble key={o} label={o} size={bubbleSize - 4}
                              state={a === c ? (isOk ? "ok" : "bad") : "off"}
                              onClick={() => setDetected((d) => d.map((v, j) => (j === i ? (v === c ? null : c) : v)))} />
                          ))}
                        </div>
                        {detection && (
                          <span title="Confianza" style={{ ...S.mono, fontSize: 11, fontWeight: 700, color: confColor(conf),
                            minWidth: 34, textAlign: "right" }}>
                            {conf != null ? `${(conf * 100).toFixed(0)}%` : ""}
                          </span>
                        )}
                        <span style={{ ...S.mono, marginLeft: detection ? 4 : "auto", fontSize: 13, fontWeight: 700,
                          color: a == null ? C.gray : isOk ? C.green : C.red, minWidth: 44, textAlign: "right" }}>
                          {a == null ? "—" : isOk ? "✓" : `✗ (${ALL_LETTERS[answerKey[i]]})`}
                        </span>
                      </div>
                    );
                  })}

                  <div style={{ marginTop: 16, padding: 16, borderRadius: 12, display: "flex",
                    alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12,
                    background: C.ink, color: "#fff" }}>
                    <div>
                      <div style={{ ...S.mono, fontSize: 30, fontWeight: 800 }}>
                        {score}/{nQ}
                        <span style={{ fontSize: 16, opacity: 0.7, marginLeft: 10 }}>= {((score / nQ) * 10).toFixed(1)}</span>
                      </div>
                      <div style={{ fontSize: 12.5, opacity: 0.7 }}>
                        {allMarked ? "Todas las preguntas registradas" : "Hay preguntas sin respuesta (cuentan como error)"}
                      </div>
                    </div>
                    <button style={{ ...S.btn(true), background: "#fff", color: C.ink }} onClick={saveResult} disabled={!keyComplete}>
                      💾 Guardar calificación
                    </button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {/* ====== PASO 3: RESULTADOS ====== */}
        {tab === "resultados" && (
          <div style={S.card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
              <h2 style={{ margin: 0, fontSize: 17 }}>Resultados del grupo</h2>
              {results.length > 0 && <button style={S.btn(false)} onClick={exportCSV}>⬇ Exportar CSV</button>}
            </div>

            {results.length === 0 ? (
              <p style={{ color: C.gray, fontSize: 14.5, marginTop: 14 }}>
                Aún no hay exámenes calificados. Ve a <b>Calificar</b> para registrar el primero.
              </p>
            ) : (
              <>
                <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
                  {[
                    ["Exámenes", results.length],
                    ["Promedio", ((results.reduce((s, r) => s + r.score / r.total, 0) / results.length) * 10).toFixed(1)],
                    ["Aprobados ≥6", results.filter((r) => (r.score / r.total) * 10 >= 6).length],
                  ].map(([l, v]) => (
                    <div key={l} style={{ flex: 1, minWidth: 110, padding: "12px 14px", borderRadius: 10, background: "#F2F1EA", textAlign: "center" }}>
                      <div style={{ ...S.mono, fontSize: 24, fontWeight: 800 }}>{v}</div>
                      <div style={{ fontSize: 12.5, color: C.gray }}>{l}</div>
                    </div>
                  ))}
                </div>

                <div style={{ marginTop: 16, overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                    <thead>
                      <tr style={{ textAlign: "left", color: C.gray, fontSize: 12.5 }}>
                        <th style={{ padding: "6px 8px" }}>Alumno</th>
                        <th style={{ padding: "6px 8px" }}>Aciertos</th>
                        <th style={{ padding: "6px 8px" }}>Calif.</th>
                        <th style={{ padding: "6px 8px" }}>Conf.</th>
                        <th style={{ padding: "6px 8px" }}>Fecha</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {results.map((r, i) => {
                        const calif = (r.score / r.total) * 10;
                        return (
                          <tr key={i} style={{ borderTop: `1px solid ${C.line}` }}>
                            <td style={{ padding: "9px 8px", fontWeight: 600 }}>{r.name}</td>
                            <td style={{ ...S.mono, padding: "9px 8px" }}>{r.score}/{r.total}</td>
                            <td style={{ padding: "9px 8px" }}>
                              <span style={{ ...S.mono, padding: "3px 9px", borderRadius: 20, fontWeight: 800, fontSize: 13,
                                background: calif >= 6 ? C.greenSoft : C.redSoft, color: calif >= 6 ? C.green : C.red }}>
                                {calif.toFixed(1)}
                              </span>
                            </td>
                            <td style={{ ...S.mono, padding: "9px 8px", fontSize: 12.5, color: confColor(r.avgConf) }}>
                              {r.avgConf != null ? `${(r.avgConf * 100).toFixed(0)}%` : "—"}
                              {r.ambiguous ? ` ⚠${r.ambiguous}` : ""}
                            </td>
                            <td style={{ padding: "9px 8px", color: C.gray, fontSize: 12.5 }}>{r.date}</td>
                            <td style={{ padding: "9px 4px" }}>
                              <button onClick={() => setResults((rs) => rs.filter((_, j) => j !== i))}
                                style={{ border: "none", background: "none", color: C.gray, cursor: "pointer", fontSize: 15 }} title="Eliminar">✕</button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                <h3 style={{ fontSize: 15, margin: "20px 0 8px" }}>Preguntas con más errores</h3>
                <div style={{ display: "flex", gap: 4, alignItems: "flex-end", height: 90 }}>
                  {itemStats.map((p, i) => (
                    <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                      <div style={{ width: "100%", borderRadius: "4px 4px 0 0", height: `${Math.max(4, p * 70)}px`,
                        background: p > 0.5 ? C.red : p > 0.25 ? C.amber : C.green }} />
                      <span style={{ ...S.mono, fontSize: 11, color: C.gray }}>{i + 1}</span>
                    </div>
                  ))}
                </div>
                <p style={{ fontSize: 12.5, color: C.gray, marginTop: 6 }}>
                  Barra alta = muchos alumnos la fallaron. Útil para detectar temas a repasar.
                </p>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default LectorExamenes;
