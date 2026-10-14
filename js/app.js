/**
 * Auro Stage-2 interactive planner UI.
 * Data health → clubbing → vessels → capacity → Summary 1 CSV.
 */
(function () {
  const STORAGE_KEY = "auroPrototype.s2.v1";
  const seedData = window.AURO_DATA;
  const {
    plan,
    runAcceptance,
    inputQuantity,
    groupKey,
    bookableCapacities,
    joinCoverage,
    normSourceBadge,
    lotsForHeatCell,
    summaryToCsv,
  } = window.AuroPlanner;
  const {
    lookupNorm,
    lookupConeWeight,
    cloneMasters,
    recomputeCapDay,
    upsertMaster2,
    upsertMaster3,
  } = window.AuroMasters;
  const dateFmt = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const numFmt = (d = 2) =>
    new Intl.NumberFormat(undefined, { maximumFractionDigits: d, minimumFractionDigits: 0 });

  const VIEWS = {
    stage2: {
      crumb: "Stage 2 · Yarn dyeing",
      title: "Yarn dyeing planner",
      desc: "Add dyeing lines, Auto-Plan vessels, hand off Summary 1.",
    },
    masters: {
      crumb: "Masters",
      title: "Planning masters",
      desc: "Edit vessel capacities, input norms, and cone weights — saved with your session.",
    },
    settings: {
      crumb: "Settings",
      title: "Demo & session",
      desc: "Load example2 demo data, reset the session, or run an engineering verify.",
    },
  };

  const state = {
    view: "stage2",
    orders: [],
    masters: cloneMasters(seedData),
    overrides: {},
    vesselOverrides: {},
    selectedId: null,
    plan: null,
    history: [],
    editingId: null,
    linesMode: "workspace",
    heatSelection: null,
    healthExpanded: false,
    autoPlanMode: false,
  };

  let toastTimer = null;

  function cloneOrders(orders) {
    return JSON.parse(JSON.stringify(orders));
  }

  function snapshot() {
    return {
      orders: cloneOrders(state.orders),
      masters: cloneMasters(state.masters),
      overrides: { ...state.overrides },
      vesselOverrides: { ...state.vesselOverrides },
      autoPlanMode: state.autoPlanMode,
    };
  }

  function pushHistory() {
    state.history.push(snapshot());
    if (state.history.length > 40) state.history.shift();
  }

  function undo() {
    const prev = state.history.pop();
    if (!prev) {
      toast("Nothing to undo");
      return;
    }
    state.orders = prev.orders;
    state.masters = prev.masters || cloneMasters(seedData);
    state.overrides = prev.overrides;
    state.vesselOverrides = prev.vesselOverrides;
    state.autoPlanMode = !!prev.autoPlanMode;
    persist();
    replan();
    toast("Undone");
  }

  function planData() {
    return {
      ...seedData,
      master1: state.masters.master1,
      master2: state.masters.master2,
      master3: state.masters.master3,
    };
  }

  function persist() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          orders: state.orders,
          masters: state.masters,
          overrides: state.overrides,
          vesselOverrides: state.vesselOverrides,
          selectedId: state.selectedId,
          autoPlanMode: state.autoPlanMode,
        })
      );
    } catch (_) {
      /* ignore quota */
    }
  }

  function loadSession() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const saved = JSON.parse(raw);
      if (saved.masters?.master1 && saved.masters?.master2 && saved.masters?.master3) {
        state.masters = {
          master1: saved.masters.master1,
          master2: saved.masters.master2,
          master3: saved.masters.master3,
        };
      }
      if (!Array.isArray(saved.orders) || !saved.orders.length) {
        return !!(saved.masters?.master1);
      }
      state.orders = saved.orders;
      state.overrides = saved.overrides || {};
      state.vesselOverrides = saved.vesselOverrides || {};
      state.selectedId = saved.selectedId || state.orders[0]?.id || null;
      state.autoPlanMode = !!(saved.autoPlanMode ?? saved.knapsackMode);
      return true;
    } catch (_) {
      return false;
    }
  }

  function seedDemo(opts = {}) {
    state.orders = cloneOrders(seedData.orders);
    state.overrides = {};
    state.vesselOverrides = {};
    state.selectedId = state.orders[0]?.id || null;
    state.autoPlanMode = false;
    if (opts.resetMasters !== false) {
      state.masters = cloneMasters(seedData);
    }
  }

  function resetMastersToSeed() {
    const ok = window.confirm("Reset Master1 / Master2 / Master3 to seed values? Your edited masters will be lost.");
    if (!ok) return;
    pushHistory();
    state.masters = cloneMasters(seedData);
    persist();
    replan();
    toast("Masters reset to seed");
  }

  function toast(msg) {
    const el = document.getElementById("toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, 2400);
  }

  function deriveMixing(productCode) {
    if (!productCode) return "";
    const parts = String(productCode).split("-").filter(Boolean);
    let core = parts;
    const huydIdx = parts.findIndex((p) => /^HUYD/i.test(p));
    if (huydIdx >= 0 && parts.length > huydIdx + 2) {
      core = parts.slice(0, huydIdx + 2);
    } else if (parts.length > 1) {
      core = parts.slice(0, -1);
    }
    return core.join("").replace(/\s+/g, "");
  }

  function nextLineId() {
    return `line-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  function blankLineDefaults() {
    const sample = state.orders[0] || seedData.orders[0] || {};
    return {
      fabricSO: sample.fabricSO || "",
      fabricSOLine: sample.fabricSOLine || "100",
      saleOrderNo: sample.saleOrderNo || "",
      lineNo: String((state.orders.length + 1) * 10),
      productCode: "",
      mixing: "",
      warpWeft: "WEFT",
      orderQty: "",
      labRef: "",
      reqDate: sample.reqDate || new Date().toISOString().slice(0, 10),
      noOfCreels: 1,
      customer: sample.customer || "",
      segment: sample.segment || "BN",
      normPct: "",
      coneWeight: "",
    };
  }

  function setView(view) {
    if (!VIEWS[view]) view = "stage2";
    state.view = view;
    document.querySelectorAll(".view").forEach((el) => {
      el.hidden = el.dataset.view !== view;
    });
    document.querySelectorAll(".nav-btn[data-view]").forEach((btn) => {
      btn.setAttribute("aria-selected", btn.dataset.view === view ? "true" : "false");
    });
    const meta = VIEWS[view] || VIEWS.stage2;
    document.getElementById("view-crumb").textContent = meta.crumb;
    document.getElementById("view-title").textContent = meta.title;
    document.getElementById("view-desc").textContent = meta.desc;
  }

  function setLinesMode(mode) {
    state.linesMode = mode === "all" ? "all" : "workspace";
    document.getElementById("lines-workspace-wrap").hidden = state.linesMode !== "workspace";
    document.getElementById("lines-all-wrap").hidden = state.linesMode !== "all";
    document.querySelectorAll("[data-lines-mode]").forEach((btn) => {
      btn.setAttribute("aria-selected", btn.dataset.linesMode === state.linesMode ? "true" : "false");
    });
  }

  function replan() {
    const opts = state.autoPlanMode ? { autoPlan: true, optimizeFill: true } : {};
    state.plan = plan(state.orders, planData(), state.overrides, state.vesselOverrides, opts);
    if (state.heatSelection) {
      const still = lotsForHeatCell(
        state.plan.groups,
        state.heatSelection.category,
        state.heatSelection.date
      );
      if (!still.length) state.heatSelection = null;
    }
    renderAll();
  }

  function autoPlan() {
    pushHistory();
    state.vesselOverrides = {};
    state.autoPlanMode = true;
    persist();
    replan();
    const lots = (state.plan?.groups || []).filter((g) => g.vessel != null).length;
    toast(`Auto-Plan Vessels — ${lots} lot${lots === 1 ? "" : "s"}`);
    document.getElementById("summary-panel")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function csvPayload() {
    return summaryToCsv(state.plan?.summary || [], state.plan?.groups || []);
  }

  function updateCsvButtons() {
    const has = (state.plan?.summary || []).length > 0;
    ["btn-copy-plan", "btn-copy-csv", "btn-download-csv"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.disabled = !has;
    });
  }

  async function copyVesselPlan() {
    const csv = csvPayload();
    if (!csv || !(state.plan?.summary || []).length) {
      toast("No vessel plan to copy");
      return;
    }
    try {
      await navigator.clipboard.writeText(csv);
      toast("Summary 1 CSV copied");
    } catch (_) {
      const ta = document.createElement("textarea");
      ta.value = csv;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      toast("Summary 1 CSV copied");
    }
  }

  function downloadVesselPlan() {
    const csv = csvPayload();
    if (!csv || !(state.plan?.summary || []).length) {
      toast("No vessel plan to download");
      return;
    }
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `auro-summary1-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast("Summary 1 CSV downloaded");
  }

  /* —— Render —— */
  function renderAll() {
    renderHealth();
    renderCapWarn();
    renderEmptyCta();
    renderChips();
    renderLinesTable();
    renderOrdersFull();
    renderKpis();
    renderClubs();
    renderVessels();
    renderHeat();
    renderLotPanel();
    renderSummary();
    renderMasters();
    renderSessionHint();
    updateCsvButtons();
    setLinesMode(state.linesMode);
  }

  function renderEmptyCta() {
    const el = document.getElementById("empty-cta");
    if (!el) return;
    el.hidden = state.orders.length > 0;
  }

  function renderCapWarn() {
    const el = document.getElementById("cap-warn");
    if (!el) return;
    const warns = state.plan?.capacityWarns || [];
    if (!warns.length) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.innerHTML = `<strong>Capacity warning</strong> — ${warns.map((w) => esc(w.message)).join(" · ")}`;
  }

  function renderHealth() {
    const el = document.getElementById("health-strip");
    if (!el) return;
    const lines = state.plan?.lines || [];
    if (!lines.length) {
      el.className = "health-strip";
      el.innerHTML = `<div class="health-row"><div class="health-metric"><span class="label">Master join</span><span class="value">—</span></div><span class="hint">New Line → Auto-Plan Vessels.</span></div>`;
      return;
    }
    const cov = joinCoverage(lines);
    const level = cov.pct >= 95 ? "ok" : cov.pct >= 70 ? "warn" : "bad";
    el.className = `health-strip ${level}`;
    const unmatched = cov.unmatchedMixings;
    const open = state.healthExpanded ? " open" : "";
    const details =
      unmatched.length || cov.untrusted.length
        ? `<details${open} id="health-details">
            <summary>${unmatched.length} unmatched Mixing code${unmatched.length === 1 ? "" : "s"} · ${cov.untrusted.length} line${cov.untrusted.length === 1 ? "" : "s"} need attention</summary>
            <ul>
              ${unmatched
                .map((m) => {
                  const miss = [
                    m.missingMaster2 ? "not in Master2" : null,
                    m.missingMaster3 ? "not in Master3" : null,
                  ]
                    .filter(Boolean)
                    .join(", ");
                  return `<li><span class="hint-u" translate="no">${esc(m.mixing)}</span> — ${esc(miss)}. Check trailing <span class="hint-u">U</span> drift on Mixing vs article key. Lines: ${esc(m.lineNos.join(", "))}</li>`;
                })
                .join("")}
              ${cov.untrusted
                .filter((u) => u.joinOk === false)
                .map(
                  (u) =>
                    `<li class="bad-line">L${esc(u.lineNo)} blocked — set norm/cone override before lot is trusted${u.reason ? ` (${esc(u.reason)})` : ""}.</li>`
                )
                .join("")}
            </ul>
          </details>`
        : `<p class="hint" style="margin:6px 0 0">All lines join Master2 + Master3.</p>`;

    el.innerHTML = `
      <div class="health-row">
        <div class="health-metric">
          <span class="label">Master join coverage</span>
          <span class="value">${fmt(cov.pct, 1)}%</span>
        </div>
        <div class="health-metric">
          <span class="label">With Master2 + Master3</span>
          <span class="value">${cov.withBoth}/${cov.total}</span>
        </div>
        <div class="health-metric">
          <span class="label">Unmatched Mixing</span>
          <span class="value">${unmatched.length}</span>
        </div>
        ${level !== "ok" ? '<span class="tag warn">Override norm/cone on flagged rows</span>' : '<span class="tag ok">Ready</span>'}
      </div>
      ${details}`;

    const det = el.querySelector("#health-details");
    det?.addEventListener("toggle", () => {
      state.healthExpanded = det.open;
    });
  }

  function renderChips() {
    const bar = document.getElementById("chips-bar");
    if (!state.orders.length) {
      bar.innerHTML = `<div class="empty" style="padding:10px 14px;width:100%"><strong>No lines yet</strong> New Line → Auto-Plan Vessels, or Load Example2 Demo.</div>`;
      return;
    }

    // Group by Fabric SO · Dyeing SO
    const groups = new Map();
    for (const o of state.orders) {
      const key = `${o.fabricSO}||${o.saleOrderNo}`;
      if (!groups.has(key)) {
        groups.set(key, {
          fabricSO: o.fabricSO,
          saleOrderNo: o.saleOrderNo,
          lines: [],
          qty: 0,
          joinFail: false,
        });
      }
      const g = groups.get(key);
      g.lines.push(o);
      g.qty += Number(o.orderQty) || 0;
      const line = state.plan?.lines?.find((l) => l.id === o.id);
      if (line && (!line.joinOk || line.masterMissing)) g.joinFail = true;
    }

    bar.innerHTML = [...groups.values()]
      .map((g) => {
        const ids = g.lines.map((l) => l.id);
        const sel = ids.includes(state.selectedId) ? ' aria-selected="true"' : "";
        const warn = g.joinFail ? '<span class="tag bad">join</span>' : "";
        const shortFab = shortId(g.fabricSO);
        const shortDye = shortId(g.saleOrderNo);
        return `<button type="button" class="chip" data-ids="${esc(ids.join(","))}"${sel}>
          <span class="chip-group">
            <span class="chip-so" title="${esc(g.fabricSO)} / ${esc(g.saleOrderNo)}">${esc(shortFab)} · ${esc(shortDye)}</span>
            <span class="chip-meta">${g.lines.length} line${g.lines.length === 1 ? "" : "s"} · ${fmt(g.qty)} kg</span>
          </span>
          ${warn}
        </button>`;
      })
      .join("");

    bar.querySelectorAll(".chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        const ids = (btn.dataset.ids || "").split(",").filter(Boolean);
        state.selectedId = ids[0] || null;
        persist();
        renderAll();
        setView("stage2");
      });
    });
  }

  function shortId(s) {
    const t = String(s || "");
    if (t.length <= 18) return t;
    return t.slice(0, 8) + "…" + t.slice(-6);
  }

  function shortShade(o) {
    return (o.labRef || o.shade || o.productCode || "").slice(0, 28);
  }

  function formatDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso + "T00:00:00");
    if (Number.isNaN(d.getTime())) return iso;
    return dateFmt.format(d);
  }

  function formatDateShort(iso) {
    if (!iso) return "";
    const d = new Date(iso + "T00:00:00");
    if (Number.isNaN(d.getTime())) return iso.slice(5);
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(d);
  }

  function renderLinesTable() {
    const tbody = document.querySelector("#tbl-lines tbody");
    if (!state.orders.length) {
      tbody.innerHTML = `<tr><td colspan="13"><div class="empty"><strong>No dyeing lines</strong>New Line, then Auto-Plan Vessels.</div></td></tr>`;
      return;
    }
    const byId = new Map((state.plan?.lines || []).map((l) => [l.id, l]));
    tbody.innerHTML = state.orders
      .map((o) => {
        const L = byId.get(o.id) || o;
        const ov = state.overrides[o.id] || {};
        const normVal = ov.normPct != null && ov.normPct !== "" ? ov.normPct : L.normPct ?? "";
        const coneVal =
          ov.coneWeight != null && ov.coneWeight !== "" ? ov.coneWeight : L.coneWeightEffective ?? L.coneWeight ?? "";
        const sel = o.id === state.selectedId ? " selected" : "";
        const joinFail = L.joinOk === false || L.masterMissing;
        const joinCls = joinFail ? " join-fail" : "";
        const badge = normSourceBadge(L.normSource);
        const join = joinFail ? '<span class="tag bad" title="Join / trust issue">!</span>' : "";
        return `<tr class="${sel}${joinCls}" data-id="${esc(o.id)}">
          <td class="mono truncate" title="${esc(o.fabricSO)}">${esc(shortId(o.fabricSO))}</td>
          <td class="mono truncate" title="${esc(o.saleOrderNo)}">${esc(shortId(o.saleOrderNo))}</td>
          <td class="mono">L${esc(o.lineNo)} ${join}</td>
          <td class="mono truncate" translate="no" title="${esc(o.productCode)}">${esc(o.productCode)}</td>
          <td class="mono truncate" translate="no" title="${esc(o.mixing)}">${esc(o.mixing)}</td>
          <td>${esc(o.warpWeft)}</td>
          <td class="mono">${fmt(o.orderQty)}</td>
          <td>
            <div class="norm-cell">
              <input class="cell norm" type="number" step="any" value="${esc(normVal)}" aria-label="Norm percent L${esc(o.lineNo)}">
              <span class="tag norm-${esc(badge)}">${esc(badge)}</span>
            </div>
          </td>
          <td><input class="cell cone" type="number" step="any" value="${esc(coneVal)}" aria-label="Cone kg L${esc(o.lineNo)}"></td>
          <td class="mono">${L.inputQty != null ? fmt(L.inputQty, 3) : "—"}</td>
          <td class="truncate" title="${esc(o.labRef || "")}">${esc(shortShade(o))}</td>
          <td class="mono" title="${esc(o.reqDate || "")}">${esc(formatDateShort(o.reqDate))}</td>
          <td>
            <button type="button" class="btn sm ghost edit" aria-label="Edit line ${esc(o.lineNo)}">Edit</button>
            <button type="button" class="btn sm ghost danger del" aria-label="Delete line ${esc(o.lineNo)}">Del</button>
          </td>
        </tr>`;
      })
      .join("");

    tbody.querySelectorAll("tr").forEach((tr) => {
      const id = tr.dataset.id;
      tr.addEventListener("click", (e) => {
        if (e.target.closest("button, input")) return;
        state.selectedId = id;
        persist();
        renderChips();
        tbody.querySelectorAll("tr").forEach((r) => r.classList.toggle("selected", r.dataset.id === id));
      });
      const norm = tr.querySelector(".norm");
      const cone = tr.querySelector(".cone");
      norm?.addEventListener("change", () => {
        pushHistory();
        state.overrides[id] = { ...state.overrides[id], normPct: norm.value };
        persist();
        replan();
      });
      cone?.addEventListener("change", () => {
        pushHistory();
        state.overrides[id] = { ...state.overrides[id], coneWeight: cone.value };
        persist();
        replan();
      });
      tr.querySelector(".edit")?.addEventListener("click", (e) => {
        e.stopPropagation();
        openLineDialog(id);
      });
      tr.querySelector(".del")?.addEventListener("click", (e) => {
        e.stopPropagation();
        deleteLine(id);
      });
    });
  }

  function renderOrdersFull() {
    const tbody = document.querySelector("#tbl-orders-full tbody");
    if (!tbody) return;
    if (!state.orders.length) {
      tbody.innerHTML = `<tr><td colspan="11"><div class="empty"><strong>Empty order set</strong>New Line → Auto-Plan Vessels.</div></td></tr>`;
      return;
    }
    tbody.innerHTML = state.orders
      .map((o) => {
        const sel = o.id === state.selectedId ? " selected" : "";
        return `<tr class="${sel}" data-id="${esc(o.id)}">
          <td class="mono truncate" title="${esc(o.fabricSO)}">${esc(o.fabricSO)}</td>
          <td class="mono truncate" title="${esc(o.saleOrderNo)}">${esc(o.saleOrderNo)}</td>
          <td class="mono">${esc(o.lineNo)}</td>
          <td class="mono truncate" translate="no" title="${esc(o.productCode)}">${esc(o.productCode)}</td>
          <td class="mono truncate" translate="no" title="${esc(o.mixing)}">${esc(o.mixing)}</td>
          <td>${esc(o.warpWeft)}</td>
          <td class="mono">${fmt(o.orderQty)}</td>
          <td class="truncate">${esc(o.labRef || "")}</td>
          <td class="mono" title="${esc(o.reqDate || "")}">${esc(formatDate(o.reqDate))}</td>
          <td>${esc(o.noOfCreels ?? 1)}</td>
          <td>
            <button type="button" class="btn sm ghost edit" aria-label="Edit line ${esc(o.lineNo)}">Edit</button>
            <button type="button" class="btn sm ghost danger del" aria-label="Delete line ${esc(o.lineNo)}">Del</button>
          </td>
        </tr>`;
      })
      .join("");
    tbody.querySelectorAll("tr").forEach((tr) => {
      const id = tr.dataset.id;
      tr.querySelector(".edit")?.addEventListener("click", () => openLineDialog(id));
      tr.querySelector(".del")?.addEventListener("click", () => deleteLine(id));
      tr.addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        state.selectedId = id;
        persist();
        renderAll();
      });
    });
  }

  function renderKpis() {
    const el = document.getElementById("kpi-strip");
    const g = state.plan?.groups || [];
    const lots = g.filter((x) => x.vessel != null).length;
    const fills = g.filter((x) => x.fillRatio != null).map((x) => x.fillRatio);
    const avg = fills.length ? (fills.reduce((a, b) => a + b, 0) / fills.length) * 100 : 0;
    const under = g.filter((x) => x.underload).length;
    const clubbed = g.filter((x) => x.clubbed).length;
    const bad = g.filter((x) => !x.vesselOk).length;
    el.innerHTML = `
      <div class="kpi"><div class="k">Vessel lots</div><div class="v">${lots}</div></div>
      <div class="kpi"><div class="k">Avg fill</div><div class="v">${fills.length ? Math.round(avg) + "%" : "—"}</div></div>
      <div class="kpi"><div class="k">Underload</div><div class="v ${under ? "warn" : ""}">${under}</div></div>
      <div class="kpi"><div class="k">Clubbed</div><div class="v">${clubbed}</div></div>
      <div class="kpi"><div class="k">Unassigned</div><div class="v ${bad ? "bad" : ""}">${bad}</div></div>`;
  }

  function vesselOptions(selected) {
    const caps = bookableCapacities(state.masters.master1);
    return caps
      .map(
        (c) =>
          `<option value="${c.capacity}" ${Number(selected) === c.capacity ? "selected" : ""}>${c.capacity} (${esc(c.category)} · bookable ${c.capacity})</option>`
      )
      .join("");
  }

  function allShades(g) {
    return [...new Set(g.lines.map((l) => l.labRef || l.shade || "").filter(Boolean))];
  }

  function renderVessels() {
    const grid = document.getElementById("vessel-grid");
    const groups = state.plan?.groups || [];
    const modeTag = document.getElementById("pack-mode-tag");
    if (modeTag) {
      modeTag.textContent = state.autoPlanMode ? "Auto" : "Classic";
      modeTag.className = state.autoPlanMode ? "tag ok" : "tag";
    }
    if (!groups.length) {
      grid.innerHTML = `<div class="empty"><strong>No vessel plan yet</strong>New Line → Auto-Plan Vessels.</div>`;
      return;
    }
    grid.innerHTML = groups
      .map((g) => {
        const key = groupKey(g);
        const pct = g.fillRatio != null ? Math.min(g.fillRatio * 100, 100) : 0;
        const over = g.fillRatio != null && g.fillRatio > 1;
        const cls = !g.vesselOk ? "bad" : g.underload ? "under" : "";
        const minTop = (1 - 0.65) * 100;
        const shades = allShades(g);
        const parts = g.lines.map((l) => `L${l.lineNo} ${fmt(l.orderQty)}kg`).join(" · ");
        const suggestBtn =
          g.suggest != null
            ? `<button type="button" class="btn sm suggest apply-suggest">Apply Suggested Smaller Vessel · V${esc(g.suggest)}</button>`
            : "";
        const catNote = g.vesselCategory
          ? `<div class="cap-note">Category ${esc(g.vesselCategory)} · bookable ${esc(g.vessel)}</div>`
          : "";
        return `<article class="vessel-card ${cls}" data-key="${esc(key)}">
          <div class="vc-top">
            <div>
              <div class="vc-title">${g.clubbed ? "Clubbed lot" : "Single lot"} · V${g.vessel ?? "—"}${g.lotIndex != null && g.lotIndex > 1 ? ` · part ${g.lotIndex}` : ""}</div>
              <div class="vc-sub">${esc(g.warpWeft)} · ${esc(formatDate(g.reqDate))}</div>
              <div class="shades" title="${esc(shades.join(" | "))}">${esc(shades.join(" · ") || "—")}</div>
            </div>
            ${g.underload ? '<span class="tag warn">Underload</span>' : ""}
            ${g.splitForCapacity ? '<span class="tag warn">Split</span>' : ""}
            ${g.vesselManual ? '<span class="tag">Manual</span>' : ""}
            ${!g.vesselOk ? '<span class="tag bad">Issue</span>' : ""}
          </div>
          <div class="tank">
            <div class="tank-fill ${over ? "over" : ""}" style="height:${pct}%"></div>
            <div class="tank-min" style="top:${minTop}%"></div>
            <div class="tank-label">${g.fillRatio != null ? Math.round(g.fillRatio * 100) + "%" : "—"}</div>
          </div>
          <div class="club-meta">
            <span><strong>${fmt(g.packages, 2)}</strong> pkg</span>
            <span>cone ${fmt(g.coneWeight, 2)} kg</span>
          </div>
          ${catNote}
          <select class="vessel-select" aria-label="Vessel capacity" ${g.packages == null ? "disabled" : ""}>
            ${vesselOptions(g.vessel)}
          </select>
          ${suggestBtn}
          <div class="parts">${esc(parts)}</div>
        </article>`;
      })
      .join("");

    grid.querySelectorAll(".vessel-card").forEach((card) => {
      const key = card.dataset.key;
      card.querySelector(".vessel-select")?.addEventListener("change", (e) => {
        pushHistory();
        state.vesselOverrides[key] = e.target.value;
        persist();
        replan();
        toast(`Vessel set to ${e.target.value}`);
      });
      card.querySelector(".apply-suggest")?.addEventListener("click", () => {
        const g = groups.find((x) => groupKey(x) === key);
        if (!g || g.suggest == null) return;
        pushHistory();
        state.vesselOverrides[key] = String(g.suggest);
        persist();
        replan();
        toast(`Applied suggested vessel V${g.suggest}`);
      });
    });
  }

  function clubReason(g) {
    if (!g.clubbed) {
      return "Single line — no clubbing (unique Product Code in this SO scope).";
    }
    if (g.tier === "cross-fabric") {
      return "Same Product Code · cross-fabric SO (shared dyed-yarn requirement date).";
    }
    return "Same Product Code · within dyeing SO + fabric SO.";
  }

  function renderClubs() {
    const list = document.getElementById("club-list");
    const groups = state.plan?.groups || [];
    if (!groups.length) {
      list.innerHTML = `<div class="empty">Clubbing appears after lines are planned.</div>`;
      return;
    }
    list.innerHTML = groups
      .map((g) => {
        const members = g.lines
          .map((l) => {
            const shade = l.labRef || l.shade || "—";
            return `<li>
              <span>L${esc(l.lineNo)} · ${esc(shade)}</span>
              <span class="mono">${l.inputQty != null ? fmt(l.inputQty, 3) : "—"} kg</span>
            </li>`;
          })
          .join("");
        const parts = g.lines
          .map((l) => (l.inputQty != null ? fmt(l.inputQty, 3) : "?"))
          .join(" + ");
        const formula =
          g.packages != null
            ? `(${parts}) ÷ ${fmt(g.coneWeight, 3)} = ${fmt(g.packages, 3)} packages`
            : "Packages unavailable — fix join / cone first.";
        return `<div class="club-card">
          <header>
            <span class="pc" translate="no">${esc(g.productCode)}</span>
            ${g.clubbed ? '<span class="tag club">Clubbed</span>' : '<span class="tag">Solo</span>'}
          </header>
          <div class="club-reason">${esc(clubReason(g))}</div>
          <ul class="club-members">${members}</ul>
          <div class="club-formula">${esc(formula)}</div>
          <div class="club-meta">
            <span>Vessel ${g.vessel ?? "—"}</span>
            <span>${esc(formatDate(g.reqDate))}</span>
          </div>
        </div>`;
      })
      .join("");
  }

  function renderHeat() {
    const wrap = document.getElementById("heat-wrap");
    const layout = wrap.closest(".heat-layout");
    const heat = state.plan?.heat;
    if (!heat || !heat.dates.length) {
      wrap.innerHTML = `<div class="empty">Capacity grid fills when lots have requirement dates.</div>`;
      layout?.classList.toggle("has-panel", false);
      return;
    }
    const head = heat.dates.map((d) => `<th>${esc(formatDateShort(d))}</th>`).join("");
    const sel = state.heatSelection;
    const rows = heat.rows
      .filter((r) => heat.dates.some((d) => (r.cells[d]?.booked || 0) > 0) || r.weaving > 0)
      .map((r) => {
        const cells = heat.dates
          .map((d) => {
            const c = r.cells[d] || { booked: 0, pct: 0, cap: 0 };
            const band =
              c.pct <= 0 ? "p0" : c.pct < 40 ? "p1" : c.pct < 70 ? "p2" : c.pct < 95 ? "p3" : "p4";
            const pressed =
              sel && sel.category === r.label && sel.date === d ? ' aria-pressed="true"' : ' aria-pressed="false"';
            const label = `Lots on V${r.label} · ${formatDate(d)}: ${c.booked} booked of ${c.cap}`;
            return `<td class="cell ${band}">
              <button type="button" class="cell-btn" data-cat="${esc(r.label)}" data-date="${esc(d)}"${pressed} aria-label="${esc(label)}" title="${c.booked}/${c.cap}">
                ${c.booked ? Math.round(c.pct) + "%" : ""}
              </button>
            </td>`;
          })
          .join("");
        return `<tr><td class="row-label">${esc(r.label)}</td>${cells}</tr>`;
      })
      .join("");
    wrap.innerHTML = `<table class="heat"><thead><tr><th class="row-label">Vessel</th>${head}</tr></thead><tbody>${rows}</tbody></table>
      <p class="footnote">Provision: bookings use requirement date as input date (Rule 5). Full Rule-8 date-block editor is not in this prototype.</p>`;

    wrap.querySelectorAll(".cell-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const category = btn.dataset.cat;
        const date = btn.dataset.date;
        if (sel && sel.category === category && sel.date === date) {
          state.heatSelection = null;
        } else {
          state.heatSelection = { category, date };
        }
        renderHeat();
        renderLotPanel();
      });
    });
  }

  function renderLotPanel() {
    const panel = document.getElementById("lot-panel");
    const layout = document.querySelector(".heat-layout");
    if (!panel || !layout) return;
    const sel = state.heatSelection;
    if (!sel) {
      panel.hidden = true;
      layout.classList.remove("has-panel");
      return;
    }
    const lots = lotsForHeatCell(state.plan?.groups || [], sel.category, sel.date);
    panel.hidden = false;
    layout.classList.add("has-panel");
    document.getElementById("lot-panel-title").textContent = `Lots on V${sel.category} · ${formatDate(sel.date)}`;
    const body = document.getElementById("lot-panel-body");
    if (!lots.length) {
      body.innerHTML = `<div class="empty" style="padding:16px"><strong>No lots</strong>This cell has no bookings.</div>`;
      return;
    }
    body.innerHTML = `<ul class="lot-list">${lots
      .map((g) => {
        const shades = allShades(g).join(" · ") || "—";
        return `<li>
          <strong>V${esc(g.vessel)}</strong> · ${fmt(g.packages, 2)} pkg · ${g.clubbed ? "Clubbed" : "Solo"}
          <div class="mono" translate="no">${esc(g.productCode)}</div>
          <div>Lines ${esc(g.lineNos.join(" + "))}</div>
          <div>${esc(shades)}</div>
        </li>`;
      })
      .join("")}</ul>`;
  }

  function renderSummary() {
    const tbody = document.querySelector("#tbl-summary tbody");
    const panel = document.getElementById("summary-panel");
    const rows = state.plan?.summary || [];
    const groupsByKey = new Map((state.plan?.groups || []).map((g) => [groupKey(g), g]));
    panel?.classList.add("reveal");
    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="9"><div class="empty">Summary 1 rows appear after a successful plan.</div></td></tr>`;
      return;
    }
    tbody.innerHTML = rows
      .map((r) => {
        const g = groupsByKey.get(r.groupKey);
        const shades = g ? allShades(g).join(" · ") : "";
        return `<tr>
        <td class="mono"><strong>${esc(r.dyeingVessel)}</strong> <span class="tag">${esc(r.vesselCategory || "")}</span></td>
        <td class="mono">${fmt(r.packages, 3)}</td>
        <td>${r.fillPct != null ? r.fillPct + "%" : "—"}${r.underload ? ' <span class="tag warn">low</span>' : ""}</td>
        <td class="mono" title="${esc(r.inputDate || "")}">${esc(formatDate(r.inputDate))}</td>
        <td class="mono">${esc(r.lineNos)}</td>
        <td>${esc(r.clubbed)}</td>
        <td class="mono truncate" translate="no" title="${esc(r.fabricProductCode || "")}">${esc((r.fabricProductCode || "").slice(0, 24))}</td>
        <td class="truncate">${esc(r.customer || "")}</td>
        <td class="truncate" title="${esc(shades)}">${esc(shades.slice(0, 36))}</td>
      </tr>`;
      })
      .join("");
  }

  function renderMasters() {
    const m1 = document.querySelector("#tbl-m1 tbody");
    if (!m1) return;
    const rows = state.masters.master1;
    m1.innerHTML = rows
      .map((v, i) => {
        const cap = (Number(v.weaving) || 0) * (Number(v.outputDay) || 0);
        return `<tr data-idx="${i}">
          <td><input class="cell m1-label" type="text" spellcheck="false" autocomplete="off" value="${esc(v.label)}" aria-label="Vessel label"></td>
          <td><input class="cell m1-weaving" type="number" step="any" min="0" value="${esc(v.weaving)}" aria-label="Weaving count"></td>
          <td><input class="cell m1-output" type="number" step="any" min="0" value="${esc(v.outputDay)}" aria-label="Output per day"></td>
          <td class="mono m1-cap">${fmt(cap, 2)}</td>
          <td><button type="button" class="btn sm ghost danger m1-del" aria-label="Delete vessel row">Del</button></td>
        </tr>`;
      })
      .join("");

    m1.querySelectorAll("tr").forEach((tr) => {
      const recompute = () => {
        const w = Number(tr.querySelector(".m1-weaving").value) || 0;
        const o = Number(tr.querySelector(".m1-output").value) || 0;
        tr.querySelector(".m1-cap").textContent = fmt(w * o, 2);
      };
      tr.querySelector(".m1-weaving")?.addEventListener("input", recompute);
      tr.querySelector(".m1-output")?.addEventListener("input", recompute);
      tr.querySelector(".m1-del")?.addEventListener("click", () => {
        const idx = Number(tr.dataset.idx);
        pushHistory();
        state.masters.master1.splice(idx, 1);
        persist();
        replan();
        toast("Vessel row removed");
      });
    });

    const m2entries = Object.entries(state.masters.master2).sort(([a], [b]) => a.localeCompare(b));
    const m2 = document.querySelector("#tbl-m2 tbody");
    m2.innerHTML = m2entries
      .map(
        ([k, v], i) =>
          `<tr data-key="${esc(k)}" data-idx="${i}">
            <td><input class="cell m2-mixing" type="text" spellcheck="false" autocomplete="off" translate="no" value="${esc(k)}" aria-label="Mixing"></td>
            <td><input class="cell m2-warp" type="number" step="any" value="${v.warp ?? ""}" aria-label="Warp norm"></td>
            <td><input class="cell m2-weft" type="number" step="any" value="${v.weft ?? ""}" aria-label="Weft norm"></td>
            <td><input class="cell m2-both" type="number" step="any" value="${v.both ?? ""}" aria-label="Both norm"></td>
            <td><button type="button" class="btn sm ghost danger m2-del">Del</button></td>
          </tr>`
      )
      .join("");
    m2.querySelectorAll(".m2-del").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.closest("tr").dataset.key;
        pushHistory();
        delete state.masters.master2[key];
        persist();
        replan();
        toast("Master2 row removed");
      });
    });

    const m3entries = Object.entries(state.masters.master3).sort(([a], [b]) => a.localeCompare(b));
    const m3 = document.querySelector("#tbl-m3 tbody");
    m3.innerHTML = m3entries
      .map(
        ([k, v]) =>
          `<tr data-key="${esc(k)}">
            <td><input class="cell m3-mixing" type="text" spellcheck="false" autocomplete="off" translate="no" value="${esc(k)}" aria-label="Mixing"></td>
            <td><input class="cell m3-cone" type="number" step="any" min="0" value="${esc(v)}" aria-label="Cone kg"></td>
            <td><button type="button" class="btn sm ghost danger m3-del">Del</button></td>
          </tr>`
      )
      .join("");
    m3.querySelectorAll(".m3-del").forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.closest("tr").dataset.key;
        pushHistory();
        delete state.masters.master3[key];
        persist();
        replan();
        toast("Master3 row removed");
      });
    });
  }

  function saveMaster1FromTable() {
    const tbody = document.querySelector("#tbl-m1 tbody");
    if (!tbody) return;
    pushHistory();
    const next = [];
    tbody.querySelectorAll("tr").forEach((tr) => {
      const label = tr.querySelector(".m1-label").value.trim();
      const weaving = Number(tr.querySelector(".m1-weaving").value);
      const outputDay = Number(tr.querySelector(".m1-output").value);
      if (!label) return;
      next.push(
        recomputeCapDay({
          label,
          total: weaving,
          yardage: 0,
          market: 0,
          weaving: Number.isFinite(weaving) ? weaving : 0,
          outputDay: Number.isFinite(outputDay) ? outputDay : 0,
          capDay: 0,
        })
      );
    });
    state.masters.master1 = next;
    persist();
    replan();
    toast("Master1 saved");
  }

  function saveMaster2FromTable() {
    const tbody = document.querySelector("#tbl-m2 tbody");
    if (!tbody) return;
    pushHistory();
    const next = {};
    tbody.querySelectorAll("tr").forEach((tr) => {
      const mixing = tr.querySelector(".m2-mixing").value.trim();
      if (!mixing) return;
      upsertMaster2(
        next,
        mixing,
        tr.querySelector(".m2-warp").value,
        tr.querySelector(".m2-weft").value,
        tr.querySelector(".m2-both").value
      );
    });
    state.masters.master2 = next;
    persist();
    replan();
    toast("Master2 saved");
  }

  function saveMaster3FromTable() {
    const tbody = document.querySelector("#tbl-m3 tbody");
    if (!tbody) return;
    pushHistory();
    const next = {};
    tbody.querySelectorAll("tr").forEach((tr) => {
      const mixing = tr.querySelector(".m3-mixing").value.trim();
      const cone = tr.querySelector(".m3-cone").value;
      if (!mixing) return;
      upsertMaster3(next, mixing, cone);
    });
    state.masters.master3 = next;
    persist();
    replan();
    toast("Master3 saved");
  }

  function addMaster1Row() {
    pushHistory();
    state.masters.master1.push(
      recomputeCapDay({ label: "", total: 1, yardage: 0, market: 0, weaving: 1, outputDay: 1.8, capDay: 0 })
    );
    persist();
    renderMasters();
  }

  function addMaster2Row() {
    pushHistory();
    const key = `NEW_MIXING_${Object.keys(state.masters.master2).length + 1}`;
    state.masters.master2[key] = { warp: 2, weft: 2, both: 2 };
    persist();
    renderMasters();
  }

  function addMaster3Row() {
    pushHistory();
    const key = `NEW_MIXING_${Object.keys(state.masters.master3).length + 1}`;
    state.masters.master3[key] = 1.2;
    persist();
    renderMasters();
  }

  function renderSessionHint() {
    const el = document.getElementById("session-hint");
    if (!el) return;
    const m1n = state.masters.master1.length;
    const m2n = Object.keys(state.masters.master2).length;
    const m3n = Object.keys(state.masters.master3).length;
    el.textContent = `${state.orders.length} line(s) · M1 ${m1n} / M2 ${m2n} / M3 ${m3n} · ${STORAGE_KEY}${state.autoPlanMode ? " · auto-plan on" : ""}`;
  }

  /* —— CRUD —— */
  function deleteLine(id) {
    pushHistory();
    state.orders = state.orders.filter((o) => o.id !== id);
    delete state.overrides[id];
    if (state.selectedId === id) state.selectedId = state.orders[0]?.id || null;
    persist();
    replan();
    toast("Line removed");
  }

  function clearOrders() {
    if (!state.orders.length) return;
    const ok = window.confirm(
      `Clear all ${state.orders.length} dyeing line${state.orders.length === 1 ? "" : "s"}? You can Undo after.`
    );
    if (!ok) return;
    pushHistory();
    state.orders = [];
    state.overrides = {};
    state.vesselOverrides = {};
    state.selectedId = null;
    state.heatSelection = null;
    persist();
    replan();
    toast("All lines cleared");
  }

  function openLineDialog(editId) {
    const dlg = document.getElementById("dlg-line");
    const form = document.getElementById("form-line");
    state.editingId = editId || null;
    document.getElementById("dlg-title").textContent = editId ? "Edit dyeing line" : "New dyeing line";
    document.getElementById("dlg-save").textContent = editId ? "Save Dyeing Line" : "Save Dyeing Line";
    const defaults = editId
      ? state.orders.find((o) => o.id === editId)
      : blankLineDefaults();
    if (!defaults) return;
    const ov = editId ? state.overrides[editId] || {} : {};
    form.fabricSO.value = defaults.fabricSO || "";
    form.fabricSOLine.value = defaults.fabricSOLine || "";
    form.saleOrderNo.value = defaults.saleOrderNo || "";
    form.lineNo.value = defaults.lineNo || "";
    form.productCode.value = defaults.productCode || "";
    form.mixing.value = defaults.mixing || "";
    form.warpWeft.value = defaults.warpWeft || "WEFT";
    form.orderQty.value = defaults.orderQty ?? "";
    form.labRef.value = defaults.labRef || "";
    form.reqDate.value = defaults.reqDate || "";
    form.noOfCreels.value = defaults.noOfCreels ?? 1;
    form.customer.value = defaults.customer || "";
    form.segment.value = defaults.segment || "BN";
    form.normPct.value = ov.normPct ?? (editId ? "" : defaults.normPct || "");
    form.coneWeight.value = ov.coneWeight ?? (editId ? "" : defaults.coneWeight || "");
    updateLinePreview();
    dlg.showModal();
  }

  function updateLinePreview() {
    const form = document.getElementById("form-line");
    const box = document.getElementById("line-preview");
    const qty = Number(form.orderQty.value);
    const mixing = form.mixing.value.trim();
    const ww = form.warpWeft.value;
    let norm = form.normPct.value !== "" ? Number(form.normPct.value) : null;
    let cone = form.coneWeight.value !== "" ? Number(form.coneWeight.value) : null;
    if (norm == null || Number.isNaN(norm)) {
      const n = lookupNorm(state.masters.master2, mixing, ww);
      norm = n.ok ? n.normPct : 2;
    }
    if (cone == null || Number.isNaN(cone)) {
      const c = lookupConeWeight(state.masters.master3, mixing);
      cone = c.ok ? c.coneWeight : 1.2;
    }
    if (!qty || !cone) {
      box.hidden = true;
      return;
    }
    const inputQty = inputQuantity(qty, norm);
    const packages = inputQty / cone;
    const sel = window.AuroMasters.selectVessel(packages, state.masters.master1);
    box.hidden = false;
    box.innerHTML = `<strong>Preview</strong> — input <span class="mono">${fmt(inputQty, 3)} kg</span> · packages <span class="mono">${fmt(packages, 3)}</span> · suggested vessel <span class="mono">V${sel.vessel ?? "—"}</span> (norm ${fmt(norm, 2)}%, cone ${fmt(cone, 2)} kg)`;
  }

  function saveLineFromForm(e) {
    e.preventDefault();
    const form = document.getElementById("form-line");
    const payload = {
      fabricSO: form.fabricSO.value.trim(),
      fabricSOLine: form.fabricSOLine.value.trim(),
      saleOrderNo: form.saleOrderNo.value.trim(),
      lineNo: String(form.lineNo.value).trim(),
      productCode: form.productCode.value.trim(),
      mixing: form.mixing.value.trim(),
      warpWeft: form.warpWeft.value,
      orderQty: Number(form.orderQty.value),
      labRef: form.labRef.value.trim(),
      shade: form.labRef.value.trim(),
      reqDate: form.reqDate.value,
      noOfCreels: Number(form.noOfCreels.value) || 1,
      customer: form.customer.value.trim(),
      segment: form.segment.value.trim() || "BN",
      subSegment: form.customer.value.trim(),
      reqNo: form.saleOrderNo.value.trim(),
      weavingPO: "",
      fabricProductCode: "",
      lenPerCone: 0,
      creelwiseQty: Number(form.orderQty.value),
      source: "user",
    };

    pushHistory();
    if (state.editingId) {
      const idx = state.orders.findIndex((o) => o.id === state.editingId);
      if (idx >= 0) {
        state.orders[idx] = { ...state.orders[idx], ...payload };
      }
      const id = state.editingId;
      if (form.normPct.value !== "") {
        state.overrides[id] = { ...state.overrides[id], normPct: form.normPct.value };
      }
      if (form.coneWeight.value !== "") {
        state.overrides[id] = { ...state.overrides[id], coneWeight: form.coneWeight.value };
      }
      state.selectedId = id;
      toast("Line updated");
    } else {
      const id = nextLineId();
      const row = {
        ...payload,
        id,
        normPct: form.normPct.value !== "" ? Number(form.normPct.value) : 2,
        coneWeight: form.coneWeight.value !== "" ? Number(form.coneWeight.value) : 1.2,
      };
      const n = lookupNorm(state.masters.master2, row.mixing, row.warpWeft);
      const c = lookupConeWeight(state.masters.master3, row.mixing);
      if (form.normPct.value === "" && n.ok) row.normPct = n.normPct;
      if (form.coneWeight.value === "" && c.ok) row.coneWeight = c.coneWeight;
      state.orders.push(row);
      if (form.normPct.value !== "") {
        state.overrides[id] = { ...state.overrides[id], normPct: form.normPct.value };
      }
      if (form.coneWeight.value !== "") {
        state.overrides[id] = { ...state.overrides[id], coneWeight: form.coneWeight.value };
      }
      state.selectedId = id;
      toast("Line added");
    }
    state.editingId = null;
    document.getElementById("dlg-line").close();
    persist();
    replan();
    setView("stage2");
  }

  function useMaster2Norms() {
    pushHistory();
    for (const o of state.orders) {
      state.overrides[o.id] = { ...state.overrides[o.id], useMasterNorm: true, normPct: "" };
    }
    for (const id of Object.keys(state.overrides)) {
      const ov = state.overrides[id];
      delete ov.normPct;
      ov.useMasterNorm = true;
    }
    persist();
    replan();
    toast("Using Master2 norms where Mixing matches");
  }

  function verifySeed() {
    // Always classic path + seed masters/orders (regression, not session auto-plan)
    const demoPlan = plan(cloneOrders(seedData.orders), seedData, {}, {}, {});
    const result = runAcceptance(demoPlan, seedData.acceptance);
    const box = document.getElementById("verify-result");
    box.className = "verify-box " + (result.allPass ? "pass" : "fail");
    const lines = result.checks
      .map((c) => {
        const fails = c.tests.filter((t) => !t.pass);
        if (!fails.length) return `✓ ${c.productCode.slice(0, 40)}… (${c.lineNos})`;
        return `✗ ${c.productCode.slice(0, 40)}…\n  ${fails.map((t) => `${t.name}: expected ${t.expected}, got ${t.actual}`).join("\n  ")}`;
      })
      .join("\n");
    box.textContent = `${result.allPass ? "PASS" : "FAIL"} — ${result.pass}/${result.total}\n${lines}`;
    toast(result.allPass ? `Verify PASS ${result.pass}/${result.total}` : `Verify FAIL ${result.fail} issues`);
  }

  /* —— helpers —— */
  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmt(n, d = 2) {
    if (n == null || n === "" || Number.isNaN(Number(n))) return "—";
    return numFmt(d).format(Number(n));
  }

  /* —— wire UI —— */
  function bind() {
    document.querySelectorAll(".nav-btn[data-view]").forEach((btn) => {
      btn.addEventListener("click", () => setView(btn.dataset.view));
    });

    document.getElementById("btn-plan").addEventListener("click", () => {
      replan();
      setView("stage2");
      toast("Stage 2 plan refreshed");
    });
    document.getElementById("btn-auto-plan").addEventListener("click", autoPlan);
    document.getElementById("btn-auto-plan-inline")?.addEventListener("click", autoPlan);
    document.getElementById("btn-undo").addEventListener("click", undo);
    document.getElementById("btn-new-line").addEventListener("click", () => openLineDialog(null));
    document.getElementById("btn-new-line-2").addEventListener("click", () => openLineDialog(null));
    document.getElementById("btn-load-demo-inline").addEventListener("click", () => {
      pushHistory();
      seedDemo({ resetMasters: true });
      persist();
      replan();
      toast("Loaded example2 demo");
    });
    document.getElementById("btn-load-demo").addEventListener("click", () => {
      pushHistory();
      seedDemo({ resetMasters: true });
      persist();
      replan();
      toast("Loaded example2 demo");
    });
    document.getElementById("btn-reset-session").addEventListener("click", () => {
      pushHistory();
      localStorage.removeItem(STORAGE_KEY);
      seedDemo({ resetMasters: true });
      persist();
      replan();
      toast("Session reset to demo");
    });
    document.getElementById("btn-clear-orders").addEventListener("click", clearOrders);
    document.getElementById("btn-use-master2").addEventListener("click", useMaster2Norms);
    document.getElementById("btn-verify").addEventListener("click", verifySeed);
    document.getElementById("btn-copy-plan").addEventListener("click", copyVesselPlan);
    document.getElementById("btn-copy-csv").addEventListener("click", copyVesselPlan);
    document.getElementById("btn-download-csv").addEventListener("click", downloadVesselPlan);
    document.getElementById("lot-panel-close").addEventListener("click", () => {
      state.heatSelection = null;
      renderHeat();
      renderLotPanel();
    });

    document.getElementById("btn-m1-save")?.addEventListener("click", saveMaster1FromTable);
    document.getElementById("btn-m2-save")?.addEventListener("click", saveMaster2FromTable);
    document.getElementById("btn-m3-save")?.addEventListener("click", saveMaster3FromTable);
    document.getElementById("btn-m1-add")?.addEventListener("click", addMaster1Row);
    document.getElementById("btn-m2-add")?.addEventListener("click", addMaster2Row);
    document.getElementById("btn-m3-add")?.addEventListener("click", addMaster3Row);
    document.getElementById("btn-reset-masters")?.addEventListener("click", resetMastersToSeed);
    document.getElementById("btn-reset-masters-settings")?.addEventListener("click", resetMastersToSeed);

    document.querySelectorAll("[data-lines-mode]").forEach((btn) => {
      btn.addEventListener("click", () => setLinesMode(btn.dataset.linesMode));
    });

    const form = document.getElementById("form-line");
    form.addEventListener("submit", saveLineFromForm);
    document.getElementById("dlg-cancel").addEventListener("click", () => {
      document.getElementById("dlg-line").close();
    });
    form.productCode.addEventListener("input", () => {
      if (!state.editingId || !form.mixing.value) {
        form.mixing.value = deriveMixing(form.productCode.value);
      }
      updateLinePreview();
    });
    ["orderQty", "mixing", "warpWeft", "normPct", "coneWeight"].forEach((name) => {
      form[name].addEventListener("input", updateLinePreview);
    });

    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.target.matches("input, textarea, select")) {
        e.preventDefault();
        undo();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "n") {
        e.preventDefault();
        openLineDialog(null);
      }
    });
  }

  function boot() {
    if (!loadSession()) seedDemo({ resetMasters: true });
    if (!state.masters?.master1) state.masters = cloneMasters(seedData);
    bind();
    replan();
    setView("stage2");
  }

  boot();
})();
