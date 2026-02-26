/* Offline Inspection PWA (iPad-friendly)
   - Data stored locally in IndexedDB
   - Template stored locally; default loaded from template.json
   - Print/Save PDF via browser print dialog (works great on iPad Share → Print → Save PDF)
*/

const $ = (id) => document.getElementById(id);

// --- Branding (logo) ---
// Supports either:
// 1) template.brand.logoDataUrl = "data:image/...base64,..."
// 2) a file named logo.png placed in the site root
async function applyBranding(template){
  const img = $("logoImg");
  const fallback = $("logoFallback");
  if(!img || !fallback) return;

  const dataUrl = template?.brand?.logoDataUrl;
  if(typeof dataUrl === "string" && dataUrl.startsWith("data:image")){
    img.src = dataUrl;
    img.hidden = false;
    fallback.hidden = true;
    return;
  }

  try{
    const res = await fetch("./logo.png", {cache:"no-store"});
    if(res.ok){
      img.src = `./logo.png?v=${Date.now()}`;
      img.hidden = false;
      fallback.hidden = true;
      return;
    }
  }catch(_){/* ignore */}

  img.hidden = true;
  fallback.hidden = false;
}

const DB_NAME = "inspection_pwa_db";
const DB_VER = 1;
const STORE = "inspections";
const STORE_TEMPLATE = "template";

function uid(prefix="i"){
  return prefix + "_" + Math.random().toString(16).slice(2) + "_" + Date.now().toString(16);
}

function nowISO(){
  return new Date().toISOString();
}

function fmtDate(iso){
  try{
    const d = new Date(iso);
    return d.toLocaleString(undefined, {year:"numeric", month:"short", day:"2-digit", hour:"2-digit", minute:"2-digit"});
  }catch{ return iso; }
}

function openDB(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if(!db.objectStoreNames.contains(STORE)){
        const os = db.createObjectStore(STORE, { keyPath: "id" });
        os.createIndex("createdAt", "createdAt");
      }
      if(!db.objectStoreNames.contains(STORE_TEMPLATE)){
        db.createObjectStore(STORE_TEMPLATE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(storeName, value){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function dbGet(storeName, key){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function dbDelete(storeName, key){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function dbGetAll(storeName){
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function loadDefaultTemplate(){
  const res = await fetch("./template.json", {cache:"no-store"});
  return await res.json();
}

async function getTemplate(){
  const saved = await dbGet(STORE_TEMPLATE, "current");
  if(saved?.data) return saved.data;
  const t = await loadDefaultTemplate();
  await dbPut(STORE_TEMPLATE, {id:"current", data:t, updatedAt: nowISO()});
  return t;
}

async function saveTemplate(t){
  await dbPut(STORE_TEMPLATE, {id:"current", data:t, updatedAt: nowISO()});
  // Update header branding immediately
  applyBranding(t);
}

function blankResponses(template){
  const resp = {};
  for(const sec of template.sections){
    for(const item of sec.items){
      resp[item.id] = { result: "", comment: "", photos: ["","","",""] };
    }
  }
  return resp;
}

function computeOverall(inspection, template){
  let pass=0, fail=0, na=0, empty=0;
  for(const sec of template.sections){
    for(const item of sec.items){
      const r = inspection.responses?.[item.id]?.result || "";
      if(r === "PASS") pass++;
      else if(r === "FAIL") fail++;
      else if(r === "NA") na++;
      else empty++;
    }
  }
  let overall = "IN PROGRESS";
  if(fail > 0) overall = "FAIL";
  else if(pass > 0 && empty === 0) overall = "PASS";
  return {overall, pass, fail, na, empty};
}

function badgeClass(status){
  if(status === "PASS") return "ok";
  if(status === "FAIL") return "fail";
  if(status === "NA") return "na";
  if(status === "IN PROGRESS") return "";
  return "";
}

function escapeHTML(str){
  return (str||"").replace(/[&<>"']/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
}

let deferredPrompt = null;

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  $("btnInstall").hidden = false;
});

$("btnInstall").addEventListener("click", async () => {
  if(!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  $("btnInstall").hidden = true;
});

async function refreshHistory(){
  const template = await getTemplate();
  const list = await dbGetAll(STORE);
  list.sort((a,b) => (b.createdAt||"").localeCompare(a.createdAt||""));
  $("historyList").innerHTML = "";
  $("historyEmpty").style.display = list.length ? "none" : "block";

  for(const ins of list){
    const s = computeOverall(ins, template);
    const div = document.createElement("div");
    div.className = "history-item";
    div.innerHTML = `
      <div>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <strong>${escapeHTML(ins.siteName || "Untitled site")}</strong>
          <span class="badge ${badgeClass(s.overall)}">${s.overall}</span>
          <span class="badge">${s.pass} pass • ${s.fail} fail • ${s.na} N/A</span>
        </div>
        <div class="muted small">${escapeHTML(ins.inspectorName || "")} • ${fmtDate(ins.createdAt)}</div>
      </div>
      <div class="row-gap">
        <button class="btn" data-open="${ins.id}">Open</button>
      </div>
    `;
    div.querySelector("[data-open]").addEventListener("click", () => openEditor(ins.id));
    $("historyList").appendChild(div);
  }
}

async function createInspection(){
  const template = await getTemplate();
  const siteName = $("siteName").value.trim();
  const inspectorName = $("inspectorName").value.trim();

  // Prevent blank headers in the PDF by requiring these fields.
  if(!siteName || !inspectorName){
    alert('Please enter both "Site / Branch name" and "Inspector name" then press Start.');
    return;
  }
  const ins = {
    id: uid("ins"),
    siteName,
    inspectorName,
    createdAt: nowISO(),
    updatedAt: nowISO(),
    generalNotes: "",
    responses: blankResponses(template)
  };
  await dbPut(STORE, ins);
  await refreshHistory();
  await openEditor(ins.id);
}

function renderPills(current){
  const mk = (label, value, cls) => `<div class="pill ${cls}" data-val="${value}" data-active="${current===value}">${label}</div>`;
  return mk("Pass","PASS","pass") + mk("Fail","FAIL","fail") + mk("N/A","NA","na");
}

function photoBoxHTML(idx, dataUrl){
  if(dataUrl){
    return `
      <div class="photo-box" data-idx="${idx}">
        <img alt="photo ${idx+1}" src="${dataUrl}">
        <div class="x" title="Remove" data-x="${idx}">✕</div>
      </div>
    `;
  }
  return `<div class="photo-box" data-idx="${idx}"><span class="muted">+ Photo</span></div>`;
}

async function openEditor(id){
  const template = await getTemplate();
  const ins = await dbGet(STORE, id);
  if(!ins) return;

  $("editTitle").textContent = template.brand?.reportTitle || "Inspection";
  $("editMeta").textContent = `Created: ${fmtDate(ins.createdAt)} • Last update: ${fmtDate(ins.updatedAt)}`;
  $("editSite").value = ins.siteName || "";
  $("editInspector").value = ins.inspectorName || "";
  $("editGeneralNotes").value = ins.generalNotes || "";

  const sectionsDiv = $("sections");
  sectionsDiv.innerHTML = "";

  for(const sec of template.sections){
    const secEl = document.createElement("div");
    secEl.className = "section";
    secEl.innerHTML = `
      <div class="section-title">
        <h3>${escapeHTML(sec.title)}</h3>
        <span class="badge">${escapeHTML(sec.id)}</span>
      </div>
      <div class="sec-items"></div>
    `;
    const itemsDiv = secEl.querySelector(".sec-items");

    for(const item of sec.items){
      const r = ins.responses[item.id] || {result:"", comment:"", photos:["","","",""]};
      const itemEl = document.createElement("div");
      itemEl.className = "item";
      itemEl.innerHTML = `
        <div class="q">${escapeHTML(item.text)}</div>
        <div class="pills" data-item="${item.id}">
          ${renderPills(r.result)}
        </div>
        <label class="field">
          <span>Notes</span>
          <textarea rows="2" data-comment="${item.id}" placeholder="Write notes (optional)">${escapeHTML(r.comment)}</textarea>
        </label>
        <div class="photos" data-photos="${item.id}">
          ${r.photos.map((p,idx)=>photoBoxHTML(idx,p)).join("")}
        </div>
        <input type="file" accept="image/*" capture="environment" class="hidden" data-file="${item.id}">
      `;
      itemsDiv.appendChild(itemEl);

      // pill click
      itemEl.querySelectorAll(`.pills[data-item="${item.id}"] .pill`).forEach(p => {
        p.addEventListener("click", async () => {
          const val = p.getAttribute("data-val");
          ins.responses[item.id].result = val;
          await persistFromEditor(ins, template, {silent:true});
          await openEditor(id); // rerender for active pill
        });
      });

      // comment
      itemEl.querySelector(`textarea[data-comment="${item.id}"]`).addEventListener("input", async (e) => {
        ins.responses[item.id].comment = e.target.value;
        await persistFromEditor(ins, template, {silent:true});
      });

      // photos
      const photosWrap = itemEl.querySelector(`[data-photos="${item.id}"]`);
      const fileInput = itemEl.querySelector(`[data-file="${item.id}"]`);

      photosWrap.addEventListener("click", (e) => {
        const x = e.target.getAttribute?.("data-x");
        if(x !== null && x !== undefined){
          const idx = parseInt(x, 10);
          ins.responses[item.id].photos[idx] = "";
          persistFromEditor(ins, template, {silent:true}).then(()=>openEditor(id));
          e.stopPropagation();
          return;
        }
        const box = e.target.closest(".photo-box");
        if(!box) return;
        const idx = parseInt(box.getAttribute("data-idx"),10);
        fileInput.dataset.photoIndex = String(idx);
        fileInput.click();
      });

      fileInput.addEventListener("change", async (e) => {
        const file = e.target.files?.[0];
        if(!file) return;
        const idx = parseInt(fileInput.dataset.photoIndex || "0", 10);
        const dataUrl = await fileToDataURL(file, 1400); // compress/resize
        ins.responses[item.id].photos[idx] = dataUrl;
        await persistFromEditor(ins, template, {silent:true});
        await openEditor(id);
        fileInput.value = "";
      });
    }

    sectionsDiv.appendChild(secEl);
  }

  $("btnDelete").onclick = async () => {
    if(confirm("Delete this inspection? This cannot be undone.")){
      await dbDelete(STORE, id);
      $("editor").close();
      await refreshHistory();
    }
  };

  $("btnSave").onclick = async () => {
    await persistFromEditor(ins, template, {silent:false});
    $("editor").close();
    await refreshHistory();
  };

  $("btnPrint").onclick = async () => {
    await persistFromEditor(ins, template, {silent:true});
    // iOS/Safari sometimes prints the dark modal overlay (first pages look grey)
    // if the editor dialog is open. Close it for printing and restore after.
    const dlg = $("editor");
    const wasOpen = !!dlg?.open;
    if(wasOpen) dlg.close();

    await buildPrintView(ins, template);

    const after = () => {
      window.removeEventListener("afterprint", after);
      const host = document.getElementById("printHost");
      if(host) host.remove();
      if(wasOpen) dlg.showModal();
    };
    window.addEventListener("afterprint", after);

    await new Promise(r => setTimeout(r, 50));
    window.print();
  };

  // Professional PDF (no page-splitting / no grey overlay)
  $("btnGenPdf").onclick = async () => {
    await persistFromEditor(ins, template, {silent:true});
    try {
      $("btnGenPdf").disabled = true;
      await generateProfessionalPdf(ins, template);
    } catch (e) {
      console.error(e);
      alert("PDF generate nahi hua. Please dobara try karein.");
    } finally {
      $("btnGenPdf").disabled = false;
    }
  };

  $("editor").showModal();
}

// --------------------------
// Professional PDF generator
// --------------------------

function pdfRgb(hex){
  const h = String(hex || "").replace("#", "");
  const r = parseInt(h.slice(0,2),16) || 0;
  const g = parseInt(h.slice(2,4),16) || 0;
  const b = parseInt(h.slice(4,6),16) || 0;
  return [r,g,b];
}

function safeText(v){
  return (v == null ? "" : String(v));
}

function splitLines(pdf, text, maxW){
  return pdf.splitTextToSize(safeText(text), maxW);
}

async function getLogoDataUrl(template){
  if(template?.brand?.logoDataUrl && String(template.brand.logoDataUrl).startsWith("data:")) return template.brand.logoDataUrl;
  const img = document.getElementById("logoImg");
  if(img?.src && String(img.src).startsWith("data:")) return img.src;
  try{
    const r = await fetch("logo.png", {cache:"no-cache"});
    if(!r.ok) return null;
    const blob = await r.blob();
    return await new Promise((resolve,reject)=>{
      const fr = new FileReader();
      fr.onload = ()=>resolve(String(fr.result));
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }catch{ return null; }
}

function drawStatusPills(pdf, xRight, y, status){
  const gap = 2.2;
  const pill = (label, selected, theme) => {
    const padX = 3.2;
    const font = 9.5;
    pdf.setFontSize(font);
    const w = pdf.getTextWidth(label) + padX*2;
    const h = 7.6;
    const r = h/2;
    const border = selected ? theme : "#9ca3af";
    const fill = selected ? theme : "#ffffff";
    const txt = selected ? "#ffffff" : "#111827";
    return {label,w,h,r,border,fill,txt};
  };
  const pPass = pill("Pass", status==="pass", "#16a34a");
  const pFail = pill("Fail", status==="fail", "#dc2626");
  const pNA   = pill("N/A",  status==="na",   "#6b7280");
  const total = pPass.w + pFail.w + pNA.w + gap*2;
  let x = xRight - total;

  const draw = (p) => {
    pdf.setDrawColor(...pdfRgb(p.border));
    pdf.setFillColor(...pdfRgb(p.fill));
    pdf.roundedRect(x, y, p.w, p.h, p.r, p.r, "FD");
    pdf.setTextColor(...pdfRgb(p.txt));
    pdf.setFont("helvetica","normal");
    pdf.setFontSize(9.5);
    pdf.text(p.label, x + 3.2, y + 5.6);
    x += p.w + gap;
  };
  draw(pPass); draw(pFail); draw(pNA);
}

function addFittedImage(pdf, dataUrl, x, y, w, h){
  // Keep aspect ratio, fit inside box
  try{
    const props = pdf.getImageProperties(dataUrl);
    const ratio = props.width / props.height;
    let dw = w;
    let dh = dw / ratio;
    if(dh > h){
      dh = h;
      dw = dh * ratio;
    }
    const cx = x + (w - dw)/2;
    const cy = y + (h - dh)/2;
    pdf.addImage(dataUrl, "JPEG", cx, cy, dw, dh);
  }catch(e){
    console.warn("Image render failed", e);
  }
}

async function generateProfessionalPdf(ins, template){
  if(!window.jspdf?.jsPDF){
    alert("PDF library load nahi hui. Please page refresh karein.");
    return;
  }
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({orientation:"p", unit:"mm", format:"a4"});
  const W = 210, H = 297, M = 12;
  const contentW = W - M*2;

  const brand = template?.brand?.name || "Small Town Roosters";
  const logo = await getLogoDataUrl(template);

  // counts
  // NOTE: the app stores the answer as `result` (pass/fail/na) and notes in `comment`.
  // Some older drafts used `status/notes` which caused PDFs to show blanks.
  let pass=0, fail=0, na=0;
  for(const sec of (template.sections||[])){
    for(const it of (sec.items||[])){
      const stRaw = ins.responses?.[it.id]?.result
        ?? ins.responses?.[it.id]?.status
        ?? ins.answers?.[it.id]?.status
        ?? "na";
      const st = (""+stRaw).toLowerCase();
      if(st==="pass") pass++; else if(st==="fail") fail++; else na++;
    }
  }

  // Cover
  const hy = 14;
  if(logo){ try{ pdf.addImage(logo, "PNG", M, hy-6, 18, 18);}catch{} }
  pdf.setFont("helvetica","bold");
  pdf.setFontSize(18);
  pdf.setTextColor(17,24,39);
  pdf.text(brand, M+22, hy+4);
  pdf.setFont("helvetica","normal");
  pdf.setFontSize(12);
  pdf.text("Area Manager Franchise Inspection Report", M+22, hy+12);
  pdf.setDrawColor(229,231,235);
  pdf.line(M, hy+18, W-M, hy+18);

  const infoY = hy+30;
  const colGap = 6;
  const colW = (contentW-colGap)/2;
  const created = ins.createdAt ? new Date(ins.createdAt).toLocaleString() : "";
  const updated = ins.updatedAt ? new Date(ins.updatedAt).toLocaleString() : "";

  pdf.setFontSize(11);
  pdf.setTextColor(107,114,128);
  pdf.text("Site / Branch", M, infoY);
  pdf.text("Inspector", M+colW+colGap, infoY);
  pdf.setTextColor(17,24,39);
  pdf.setFont("helvetica","bold");
  pdf.text(ins.siteName || "-", M, infoY+7);
  pdf.text(ins.inspectorName || "-", M+colW+colGap, infoY+7);

  pdf.setFont("helvetica","normal");
  pdf.setTextColor(107,114,128);
  pdf.text("Created", M, infoY+18);
  pdf.text("Last updated", M+colW+colGap, infoY+18);
  pdf.setTextColor(17,24,39);
  pdf.text(created || "-", M, infoY+25);
  pdf.text(updated || "-", M+colW+colGap, infoY+25);

  pdf.setTextColor(107,114,128);
  pdf.text("Summary", M, infoY+38);
  pdf.setTextColor(17,24,39);
  pdf.setFont("helvetica","bold");
  pdf.text(`Pass: ${pass}   Fail: ${fail}   N/A: ${na}`, M, infoY+46);
  pdf.setFont("helvetica","normal");

  // General notes
  const notes = safeText(ins.generalNotes||"").trim();
  if(notes){
    pdf.setFontSize(11);
    pdf.setTextColor(107,114,128);
    pdf.text("General notes", M, infoY+60);
    pdf.setTextColor(17,24,39);
    const lines = splitLines(pdf, notes, contentW);
    pdf.text(lines, M, infoY+68);
  }

  // Sections
  for(const sec of (template.sections||[])){
    pdf.addPage();
    let y = M;

    pdf.setFont("helvetica","bold");
    pdf.setFontSize(14);
    pdf.setTextColor(...pdfRgb("#dc2626"));
    pdf.text(sec.title || sec.id || "Section", M, y);
    y += 7;
    pdf.setDrawColor(229,231,235);
    pdf.line(M, y, W-M, y);
    y += 6;

    for(const item of (sec.items||[])){
      // Stored fields (new): result (pass/fail/na), comment (notes), photos (array)
      // Stored fields (older): status, notes
      const r = ins.responses?.[item.id] || ins.answers?.[item.id] || {result:"na", comment:"", photos:["","","",""]};
      const st = ((r.result ?? r.status ?? "na") + "").toLowerCase();
      const itemNotes = safeText((r.comment ?? r.notes) || "").trim();
      const noteLines = itemNotes ? splitLines(pdf, itemNotes, contentW-14) : ["-"];
      const noteH = Math.max(6, noteLines.length*4.2);

      const photos = (r.photos||[]).filter(Boolean);
      const chunk = photos.slice(0,4);
      const hasPhotos = chunk.length>0;
      const photoBoxH = 60;
      const photoGap = 6;
      const rows = chunk.length<=2 ? 1 : 2;
      const photosH = hasPhotos ? (rows*photoBoxH + (rows-1)*photoGap) : 0;

      const blockH = 8 + 10 + noteH + (hasPhotos ? (8 + photosH) : 0) + 8;
      if(y + blockH > H - M){
        pdf.addPage();
        y = M;
      }

      // Item title
      pdf.setFont("helvetica","bold");
      pdf.setFontSize(12);
      pdf.setTextColor(17,24,39);
      pdf.text(item.label || item.id, M, y);
      drawStatusPills(pdf, W-M, y-5.2, st);
      y += 8;

      // Notes
      pdf.setFont("helvetica","bold");
      pdf.setFontSize(10);
      pdf.setTextColor(107,114,128);
      pdf.text("Notes:", M, y);
      pdf.setFont("helvetica","normal");
      pdf.setTextColor(17,24,39);
      pdf.text(noteLines, M+14, y);
      y += noteH + 4;

      // Photos grid (max 4)
      if(hasPhotos){
        pdf.setFont("helvetica","bold");
        pdf.setFontSize(10);
        pdf.setTextColor(107,114,128);
        pdf.text("Photos:", M, y);
        y += 6;

        const boxW = (contentW - photoGap)/2;
        let ix = M;
        let iy = y;
        for(let i=0;i<chunk.length;i++){
          pdf.setDrawColor(229,231,235);
          pdf.roundedRect(ix, iy, boxW, photoBoxH, 4, 4, "S");
          addFittedImage(pdf, chunk[i], ix, iy, boxW, photoBoxH);
          if(i%2===0) ix = M + boxW + photoGap;
          else { ix = M; iy += photoBoxH + photoGap; }
        }

        y += photosH + 6;
      }

      // divider
      pdf.setDrawColor(243,244,246);
      pdf.line(M, y, W-M, y);
      y += 6;

      // If more than 4 photos, continuation pages
      if(photos.length > 4){
        const rest = photos.slice(4);
        for(let off=0; off<rest.length; off+=4){
          const more = rest.slice(off, off+4);
          pdf.addPage();
          let cy = M;
          pdf.setFont("helvetica","bold");
          pdf.setFontSize(12);
          pdf.setTextColor(17,24,39);
          pdf.text(item.label || item.id, M, cy);
          drawStatusPills(pdf, W-M, cy-5.2, st);
          cy += 8;
          pdf.setFont("helvetica","normal");
          pdf.setFontSize(10);
          pdf.setTextColor(107,114,128);
          pdf.text("Photos (continued)", M, cy);
          cy += 6;
          const boxW = (contentW - 6)/2;
          const boxH = 60;
          const gap = 6;
          let ix = M;
          let iy = cy;
          for(let i=0;i<more.length;i++){
            pdf.setDrawColor(229,231,235);
            pdf.roundedRect(ix, iy, boxW, boxH, 4, 4, "S");
            addFittedImage(pdf, more[i], ix, iy, boxW, boxH);
            if(i%2===0) ix = M + boxW + gap;
            else { ix = M; iy += boxH + gap; }
          }
        }
      }
    }
  }

  // Page numbers
  const pages = pdf.getNumberOfPages();
  for(let i=1;i<=pages;i++){
    pdf.setPage(i);
    pdf.setFontSize(9);
    pdf.setTextColor(156,163,175);
    pdf.text(`${i} / ${pages}`, W-M, H-10, {align:"right"});
  }

  const safeName = (ins.siteName || "Inspection").replace(/[^a-z0-9\-_\s]/gi, "").trim().slice(0,40) || "Inspection";
  pdf.save(`${safeName}_Inspection_Report.pdf`);
}

async function persistFromEditor(ins, template, {silent}){
  ins.siteName = $("editSite").value.trim();
  ins.inspectorName = $("editInspector").value.trim();
  ins.generalNotes = $("editGeneralNotes").value;
  ins.updatedAt = nowISO();
  await dbPut(STORE, ins);
  if(!silent) alert("Saved ✅");
}

async function fileToDataURL(file, maxDim){
  // Resize using canvas to keep storage small
  const img = await new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = URL.createObjectURL(file);
  });
  let {width, height} = img;
  const scale = Math.min(1, maxDim / Math.max(width, height));
  width = Math.round(width * scale);
  height = Math.round(height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, width, height);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
  URL.revokeObjectURL(img.src);
  return dataUrl;
}

async function buildPrintView(ins, template){
  // Create an invisible print DOM
  let host = document.getElementById("printHost");
  if(host) host.remove();

  host = document.createElement("div");
  host.id = "printHost";
  host.className = "print-only";
  const summary = computeOverall(ins, template);

  const company = template.brand?.companyName || "Company";
  const title = template.brand?.reportTitle || "Inspection Report";

  // Optional logo in PDF
  let logoSrc = "";
  const dataUrl = template?.brand?.logoDataUrl;
  if(typeof dataUrl === "string" && dataUrl.startsWith("data:image")){
    logoSrc = dataUrl;
  }else{
    try{
      const res = await fetch("./logo.png", {cache:"no-store"});
      if(res.ok) logoSrc = `./logo.png?v=${Date.now()}`;
    }catch(_){/* ignore */}
  }

  host.innerHTML = `
    <div class="print-card">
      <div class="print-brand">
        <div class="print-logo-wrap">
          ${logoSrc ? `<img src="${logoSrc}" alt="logo" class="print-logo"/>` : `<div class="print-logo-fallback">✓</div>`}
        </div>
        <div>
          <div class="print-company">${escapeHTML(company)}</div>
          <div class="print-report">${escapeHTML(title)}</div>
        </div>
      </div>
      <div class="print-meta">
        <div><strong>Site / Branch:</strong> ${escapeHTML(ins.siteName || "")}</div>
        <div><strong>Inspector:</strong> ${escapeHTML(ins.inspectorName || "")}</div>
        <div><strong>Created:</strong> ${fmtDate(ins.createdAt)} • <strong>Updated:</strong> ${fmtDate(ins.updatedAt)}</div>
        <div style="margin-top:6px;">
          <span class="badge">${summary.overall}</span>
          <span class="badge">${summary.pass} pass • ${summary.fail} fail • ${summary.na} N/A</span>
        </div>
      </div>
      ${ins.generalNotes ? `<div><strong>General notes:</strong><br>${escapeHTML(ins.generalNotes).replace(/\n/g,"<br>")}</div>` : ""}
    </div>
  `;

  for(const sec of template.sections){
    const secDiv = document.createElement("div");
    secDiv.className = "print-card print-sec";
    secDiv.innerHTML = `<h3 class="print-sec-title">${escapeHTML(sec.title)}</h3>`;
    for(const item of sec.items){
      const r = ins.responses[item.id] || {result:"", comment:"", photos:["","","",""]};
      const status = (r.result || "N/A").toString();
      const st = status.trim().toUpperCase();
      const photos = (r.photos||[]).filter(Boolean);
      const itemHTML = document.createElement("div");
      itemHTML.className = "print-item";
      itemHTML.innerHTML = `
        <div class="print-item-head">
          <div class="print-item-title"><strong>${escapeHTML(item.id)} — ${escapeHTML(item.text)}</strong></div>
          <div class="print-choices" aria-label="Result">
            <span class="p-pill ${st==='PASS'?'sel ok':''}">Pass</span>
            <span class="p-pill ${st==='FAIL'?'sel bad':''}">Fail</span>
            <span class="p-pill ${st==='N/A' || st==='NA' ?'sel na':''}">N/A</span>
          </div>
        </div>
        ${r.comment ? `<div><strong>Notes:</strong> ${escapeHTML(r.comment).replace(/\n/g,"<br>")}</div>` : ""}
        ${photos.length ? `<div class="print-photos">${photos.slice(0,6).map(p=>`<img src="${p}" alt="photo">`).join("")}</div>` : ""}
      `;
      secDiv.appendChild(itemHTML);
    }
    host.appendChild(secDiv);
  }

  document.body.appendChild(host);
}

$("btnNew").addEventListener("click", createInspection);

$("btnSettings").addEventListener("click", async () => {
  const t = await getTemplate();
  $("templateEditor").value = JSON.stringify(t, null, 2);
  $("tmplStatus").textContent = "";
  $("tmpl").showModal();
});

$("btnSaveTemplate").addEventListener("click", async () => {
  try{
    const t = JSON.parse($("templateEditor").value);
    if(!t.sections || !Array.isArray(t.sections)) throw new Error("Invalid template: missing sections[]");
    await saveTemplate(t);
    $("tmplStatus").textContent = "Saved ✅";
    setTimeout(()=> $("tmplStatus").textContent="", 1200);
  }catch(err){
    alert("Template error: " + err.message);
  }
});

$("btnResetTemplate").addEventListener("click", async () => {
  const t = await loadDefaultTemplate();
  await saveTemplate(t);
  $("templateEditor").value = JSON.stringify(t, null, 2);
  $("tmplStatus").textContent = "Reset ✅";
  setTimeout(()=> $("tmplStatus").textContent="", 1200);
});

$("btnExportAll").addEventListener("click", async () => {
  const template = await getTemplate();
  const list = await dbGetAll(STORE);
  const payload = { exportedAt: nowISO(), template, inspections: list };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {type:"application/json"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "inspection-backup.json";
  a.click();
  URL.revokeObjectURL(url);
});

$("importFile").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if(!file) return;
  try{
    const txt = await file.text();
    const data = JSON.parse(txt);
    if(data.template) await saveTemplate(data.template);
    if(Array.isArray(data.inspections)){
      for(const ins of data.inspections){
        if(ins?.id) await dbPut(STORE, ins);
      }
    }
    alert("Imported ✅");
    await refreshHistory();
  }catch(err){
    alert("Import failed: " + err.message);
  }finally{
    e.target.value = "";
  }
});

// Service worker
if("serviceWorker" in navigator){
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(()=>{});
  });
}

(async function init(){
  const t = await getTemplate();
  await applyBranding(t);
  await refreshHistory();
})();
