/**
 * Stage-2 planner: input qty → packages → vessel → heat map → summary.
 * Matches example2 arithmetic (fractional packages, no CEIL).
 */
(function (global) {
  const { lookupNorm, lookupConeWeight, selectVessel, bookableCapacities } = global.AuroMasters;
  const { buildClubbingGroups } = global.AuroClubbing;
  const { packGroups, applyVesselOverride } = global.AuroVesselPack;

  function round(n, d = 6) {
    if (n == null || Number.isNaN(n)) return n;
    const f = 10 ** d;
    return Math.round(n * f) / f;
  }

  function inputQuantity(orderQty, normPct) {
    return orderQty * (1 + normPct / 100);
  }

  /**
   * Enrich each order line with master join + editable overrides.
   * overrides: { [lineId]: { normPct?, coneWeight?, useMasterNorm? } }
   */
  function enrichLines(orders, data, overrides = {}) {
    return orders.map((o) => {
      const ov = overrides[o.id] || {};
      const normLookup = lookupNorm(data.master2, o.mixing, o.warpWeft);
      const coneLookup = lookupConeWeight(data.master3, o.mixing);

      const useMasterNorm = ov.useMasterNorm === true;
      let normPct;
      let normSource;
      if (ov.normPct != null && ov.normPct !== "") {
        normPct = Number(ov.normPct);
        normSource = "override";
      } else if (useMasterNorm && normLookup.ok) {
        normPct = normLookup.normPct;
        normSource = `Master2.${normLookup.sourceKey}`;
      } else {
        // Seed uses example2 shade-specific norms (acceptance baseline)
        normPct = o.normPct;
        normSource = o.source === "example2" ? "example2 seed" : "order";
      }

      let coneWeight;
      let coneSource;
      if (ov.coneWeight != null && ov.coneWeight !== "") {
        coneWeight = Number(ov.coneWeight);
        coneSource = "override";
      } else if (coneLookup.ok) {
        coneWeight = coneLookup.coneWeight;
        coneSource = "Master3";
      } else {
        coneWeight = o.coneWeight;
        coneSource = "order fallback";
      }

      const joinFailures = [];
      if (!normLookup.ok && useMasterNorm) joinFailures.push(normLookup.reason);
      if (!coneLookup.ok) joinFailures.push(coneLookup.reason);

      // Surface mismatch when Mixing missing from masters (even if seed norm used)
      const masterMissing = !normLookup.ok || !coneLookup.ok;
      const joinOk = Number.isFinite(normPct) && Number.isFinite(coneWeight) && coneWeight > 0;
      const inputQty = joinOk ? inputQuantity(o.orderQty, normPct) : null;

      return {
        ...o,
        normPct,
        normSource,
        masterNorm: normLookup.ok ? normLookup.normPct : null,
        coneWeightEffective: coneWeight,
        coneSource,
        inputQty,
        joinOk,
        joinFailure: joinFailures.length ? joinFailures.join("; ") : null,
        masterMissing,
        masterNormOk: normLookup.ok,
        masterConeOk: coneLookup.ok,
      };
    });
  }

  function applyVesselSelection(g, master1, vesselOverride) {
    if (!g.joinOk || g.packages == null) {
      return {
        ...g,
        vessel: null,
        vesselCategory: null,
        fillRatio: null,
        underload: false,
        suggest: null,
        vesselOk: false,
        vesselReason: g.joinFailures.length
          ? g.joinFailures.join("; ")
          : "Cannot compute packages",
        vesselManual: false,
      };
    }

    const packages = round(g.packages, 6);
    const caps = bookableCapacities(master1);
    let sel;

    if (vesselOverride != null && vesselOverride !== "") {
      const capacity = Number(vesselOverride);
      const match = caps.find((c) => c.capacity === capacity);
      const fillRatio = capacity > 0 ? packages / capacity : null;
      sel = {
        ok: match != null && capacity >= packages,
        reason:
          match == null
            ? `Vessel ${capacity} not in Master1 weaving list`
            : capacity < packages
              ? `Packages ${packages.toFixed(2)} exceed vessel ${capacity}`
              : null,
        vessel: capacity,
        category: match ? match.category : String(capacity),
        fillRatio,
        underload: fillRatio != null && fillRatio < global.AuroMasters.UNDERLOAD_RATIO,
        suggest: null,
        capDay: match ? match.capDay : null,
      };
    } else {
      sel = selectVessel(packages, master1);
    }

    return {
      ...g,
      packages,
      sumInputQty: round(g.sumInputQty, 6),
      vessel: sel.vessel,
      vesselCategory: sel.category || null,
      fillRatio: sel.fillRatio != null ? round(sel.fillRatio, 4) : null,
      underload: !!sel.underload,
      suggest: sel.suggest || null,
      vesselOk: sel.ok,
      vesselReason: sel.reason,
      vesselManual: vesselOverride != null && vesselOverride !== "",
    };
  }

  /**
   * @param {object[]} orders
   * @param {object} data — must include master1/2/3 (user-mutated or seed)
   * @param {object} overrides line norm/cone overrides
   * @param {object} vesselOverrides { [groupStableKey]: capacity }
   * @param {{ autoPlan?: boolean, optimizeFill?: boolean }} planOptions
   */
  function plan(orders, data, overrides = {}, vesselOverrides = {}, planOptions = {}) {
    const lines = enrichLines(orders, data, overrides);
    const clubbed = buildClubbingGroups(lines);
    const useAutoPlan = !!planOptions.autoPlan;

    let groups;
    if (useAutoPlan) {
      groups = packGroups(clubbed, data.master1, planOptions).map((g) => {
        const key = groupKey(g);
        return applyVesselOverride(g, data.master1, vesselOverrides[key]);
      });
    } else {
      // Classic path — preserves example2 selectVessel lots (26/26 verify)
      groups = clubbed.map((g) => {
        const key = groupKey(g);
        return applyVesselSelection(g, data.master1, vesselOverrides[key]);
      });
    }

    groups.sort((a, b) => (b.packages || 0) - (a.packages || 0));

    const summary = groups
      .filter((g) => g.vessel != null)
      .map((g) => ({
        commitmentStart: g.reqDate,
        commitmentComplete: null,
        segment: g.lines[0].segment,
        subSegment: g.lines[0].subSegment,
        customer: g.lines[0].customer,
        fabricSO: g.fabricSO,
        fabricSOLine: g.lines[0].fabricSOLine,
        fabricProductCode: g.lines[0].fabricProductCode,
        weavingPO: g.lines[0].weavingPO,
        saleOrderNo: g.saleOrderNo,
        lineNos: g.lineNos.join("+"),
        dyeingVessel: g.vessel,
        vesselCategory: g.vesselCategory,
        inputDate: g.reqDate,
        packages: g.packages,
        packageWeight: g.coneWeight,
        clubbed: g.clubbed ? "Clubbed" : "Non Clubbed",
        underload: g.underload,
        fillPct: g.fillRatio != null ? round(g.fillRatio * 100, 1) : null,
        groupKey: groupKey(g),
        packMode: g.packMode || (useAutoPlan ? "auto" : "classic"),
        splitForCapacity: !!g.splitForCapacity,
      }));

    const heat = buildHeatMap(groups, data.master1);
    const capacityWarns = capacityWarnings(groups, data.master1);

    return { lines, groups, summary, heat, capacityWarns, planOptions };
  }

  /** Stable key for vessel overrides across replans (id from clubbing can renumber). */
  function groupKey(g) {
    const lot = g.lotIndex != null ? `lot${g.lotIndex}` : "lot0";
    return [
      g.saleOrderNo,
      g.fabricSO,
      g.productCode,
      g.reqDate || "",
      g.lineNos.join("+"),
      lot,
    ].join("||");
  }

  /** Soft warn when bookings exceed Master1 cap/day for a vessel category × date. */
  function capacityWarnings(groups, master1) {
    const byKey = new Map();
    for (const g of groups) {
      if (g.vessel == null || !g.reqDate || !g.vesselCategory) continue;
      const k = `${g.vesselCategory}||${g.reqDate}`;
      byKey.set(k, (byKey.get(k) || 0) + 1);
    }
    const warns = [];
    for (const [k, booked] of byKey) {
      const [category, date] = k.split("||");
      const row = master1.find((v) => v.label === category);
      const cap = row?.capDay || 0;
      if (cap > 0 && booked > cap) {
        warns.push({
          category,
          date,
          booked,
          cap,
          message: `V${category} on ${date}: ${booked} lots booked > cap/day ${cap}`,
        });
      }
    }
    return warns;
  }

  function buildHeatMap(groups, master1) {
    const dates = [...new Set(groups.map((g) => g.reqDate).filter(Boolean))].sort();
    // Ensure a short window around bookings for summary2-style view
    if (dates.length) {
      const base = new Date(dates[0] + "T00:00:00");
      for (let i = -3; i <= 4; i++) {
        const d = new Date(base);
        d.setDate(base.getDate() + i);
        const iso = d.toISOString().slice(0, 10);
        if (!dates.includes(iso)) dates.push(iso);
      }
      dates.sort();
    }

    const rows = master1
      .filter((v) => v.weaving > 0 && !/beam/i.test(v.label))
      .map((v) => {
        const cells = {};
        for (const d of dates) {
          const booked = groups.filter(
            (g) => g.reqDate === d && g.vesselCategory === v.label && g.vessel != null
          ).length;
          const cap = v.capDay || 0;
          const pct = cap > 0 ? (booked / cap) * 100 : booked > 0 ? 100 : 0;
          cells[d] = { booked, cap, pct: round(pct, 1) };
        }
        return { label: v.label, weaving: v.weaving, capDay: v.capDay, cells };
      });

    return { dates, rows };
  }

  function nearlyEqual(a, b, tol = 0.001) {
    if (a == null || b == null) return a === b;
    return Math.abs(a - b) <= tol;
  }

  /** Master2 + Master3 join coverage for the data-health strip. */
  function joinCoverage(lines) {
    const total = lines.length;
    let withBoth = 0;
    const unmatchedMap = new Map();
    const untrusted = [];
    for (const l of lines) {
      const m2 = !!l.masterNormOk;
      const m3 = !!l.masterConeOk;
      if (m2 && m3) withBoth++;
      if (!m2 || !m3) {
        const mix = l.mixing || "(missing Mixing)";
        if (!unmatchedMap.has(mix)) {
          unmatchedMap.set(mix, {
            mixing: mix,
            missingMaster2: !m2,
            missingMaster3: !m3,
            lineNos: [],
          });
        }
        unmatchedMap.get(mix).lineNos.push(l.lineNo);
      }
      if (!l.joinOk || l.masterMissing) {
        untrusted.push({
          id: l.id,
          lineNo: l.lineNo,
          mixing: l.mixing,
          joinOk: l.joinOk,
          masterMissing: l.masterMissing,
          reason: l.joinFailure || (l.masterMissing ? "Mixing not in Master2/3" : null),
        });
      }
    }
    return {
      total,
      withBoth,
      pct: total ? round((withBoth / total) * 100, 1) : 100,
      unmatchedMixings: [...unmatchedMap.values()],
      untrusted,
    };
  }

  /** Normalize normSource labels for UI chips: example2 | Master2 | override. */
  function normSourceBadge(normSource) {
    const s = String(normSource || "");
    if (s === "override") return "override";
    if (s.startsWith("Master2")) return "Master2";
    if (s.includes("example2")) return "example2";
    return s || "order";
  }

  /** Lots booked on a vessel category × date (heat cell drill-down). */
  function lotsForHeatCell(groups, vesselCategory, date) {
    return (groups || []).filter(
      (g) => g.reqDate === date && g.vesselCategory === vesselCategory && g.vessel != null
    );
  }

  /** Summary 1 CSV (workbook-style handoff columns). */
  function summaryToCsv(summary, groups = []) {
    const shadeByKey = new Map();
    for (const g of groups) {
      const shades = [...new Set(g.lines.map((l) => l.labRef || l.shade || "").filter(Boolean))];
      shadeByKey.set(groupKey(g), shades.join(" | "));
    }
    const headers = [
      "Dyeing Vessel",
      "Vessel Category",
      "Packages",
      "Fill %",
      "Input Date",
      "Clubbed",
      "Fabric SO",
      "Dyeing SO",
      "Line Nos",
      "Product Code",
      "Customer",
      "Shades",
    ];
    const escapeCell = (v) => {
      const s = String(v ?? "");
      if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const rows = (summary || []).map((r) =>
      [
        r.dyeingVessel,
        r.vesselCategory,
        r.packages,
        r.fillPct,
        r.inputDate,
        r.clubbed,
        r.fabricSO,
        r.saleOrderNo,
        r.lineNos,
        r.fabricProductCode || "",
        r.customer,
        shadeByKey.get(r.groupKey) || "",
      ]
        .map(escapeCell)
        .join(",")
    );
    return [headers.join(","), ...rows].join("\n");
  }

  /** Compare plan against example2 acceptance expectations. */
  function runAcceptance(planResult, acceptance) {
    const checks = [];
    let pass = 0;
    let fail = 0;

    for (const exp of acceptance.groups) {
      const group = planResult.groups.find((g) => g.productCode === exp.productCode);
      const row = {
        productCode: exp.productCode,
        lineNos: exp.lineNos.join("+"),
        tests: [],
      };

      if (!group) {
        row.tests.push({ name: "group exists", pass: false, expected: "present", actual: "missing" });
        fail++;
        checks.push(row);
        continue;
      }

      // Per-line input qtys
      for (let i = 0; i < exp.lineNos.length; i++) {
        const ln = exp.lineNos[i];
        const line = group.lines.find((l) => l.lineNo === ln);
        const expected = exp.inputQtys[i];
        const actual = line ? round(line.inputQty, 6) : null;
        const ok = nearlyEqual(actual, expected, 0.0001);
        row.tests.push({
          name: `input qty L${ln}`,
          pass: ok,
          expected,
          actual,
        });
        ok ? pass++ : fail++;
      }

      const pkgOk = nearlyEqual(group.packages, exp.packages, 0.001);
      row.tests.push({
        name: "packages",
        pass: pkgOk,
        expected: exp.packages,
        actual: group.packages,
      });
      pkgOk ? pass++ : fail++;

      const vesOk = Number(group.vessel) === Number(exp.vessel);
      row.tests.push({
        name: "vessel",
        pass: vesOk,
        expected: exp.vessel,
        actual: group.vessel,
      });
      vesOk ? pass++ : fail++;

      const clubOk = (exp.lineNos.length > 1) === group.clubbed;
      row.tests.push({
        name: "clubbed flag",
        pass: clubOk,
        expected: exp.lineNos.length > 1,
        actual: group.clubbed,
      });
      clubOk ? pass++ : fail++;

      checks.push(row);
    }

    return {
      name: acceptance.name,
      pass,
      fail,
      total: pass + fail,
      allPass: fail === 0,
      checks,
    };
  }

  global.AuroPlanner = {
    inputQuantity,
    enrichLines,
    plan,
    groupKey,
    buildHeatMap,
    capacityWarnings,
    joinCoverage,
    normSourceBadge,
    lotsForHeatCell,
    summaryToCsv,
    runAcceptance,
    bookableCapacities,
    round,
  };
})(typeof window !== "undefined" ? window : globalThis);
