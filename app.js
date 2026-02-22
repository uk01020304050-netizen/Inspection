/* Offline Inspection PWA (iPad-friendly)
   - Data stored locally in IndexedDB
   - Template stored locally; default loaded from template.json
   - Print/Save PDF via browser print dialog (works great on iPad Share → Print → Save PDF)
*/

const $ = (id) => document.getElementById(id);

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
  const ins = {
    id: uid("ins"),
    siteName: $("siteName").value.trim(),
    inspectorName: $("inspectorName").value.trim(),
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
    await buildPrintView(ins, template);
    window.print();
  };

  $("editor").showModal();
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

  host.innerHTML = `
    <div class="print-card">
      <div class="print-title">${escapeHTML(company)} — ${escapeHTML(title)}</div>
      <div class="print-meta">
        <div><strong>Site:</strong> ${escapeHTML(ins.siteName || "")}</div>
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
    secDiv.innerHTML = `<h3>${escapeHTML(sec.title)}</h3>`;
    for(const item of sec.items){
      const r = ins.responses[item.id] || {result:"", comment:"", photos:["","","",""]};
      const status = r.result || "—";
      const photos = (r.photos||[]).filter(Boolean);
      const itemHTML = document.createElement("div");
      itemHTML.className = "print-item";
      itemHTML.innerHTML = `
        <div><strong>${escapeHTML(item.text)}</strong></div>
        <div><span class="badge">${escapeHTML(status)}</span></div>
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
  await getTemplate();
  await refreshHistory();
})();
