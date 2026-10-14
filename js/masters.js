/**
 * Master1 / Master2 / Master3 lookup helpers.
 * Stage-2 uses weaving-segment capacities only.
 */
(function (global) {
  const UNDERLOAD_RATIO = 0.65;

  function parseCapacityBounds(label) {
    const s = String(label);
    if (/beam/i.test(s)) return [];
    if (s.includes("/")) {
      return s.split("/").map((p) => Number(p)).filter((n) => !Number.isNaN(n));
    }
    const n = Number(s);
    return Number.isNaN(n) ? [] : [n];
  }

  /** Bookable package capacities from Master1 weaving allocation. */
  function bookableCapacities(master1) {
    const caps = [];
    for (const row of master1) {
      if (!row.weaving || row.weaving <= 0) continue;
      for (const capacity of parseCapacityBounds(row.label)) {
        caps.push({
          capacity,
          category: row.label,
          weaving: row.weaving,
          outputDay: row.outputDay,
          capDay: row.capDay,
        });
      }
    }
    caps.sort((a, b) => a.capacity - b.capacity);
    return caps;
  }

  function lookupNorm(master2, mixing, warpWeft) {
    if (!mixing) {
      return { ok: false, reason: "Missing Mixing / article code", normPct: null, article: null };
    }
    const row = master2[mixing];
    if (!row) {
      return {
        ok: false,
        reason: `Mixing "${mixing}" not found in Master2`,
        normPct: null,
        article: mixing,
      };
    }
    const ww = String(warpWeft || "").toUpperCase();
    let key = "both";
    if (ww === "WARP") key = "warp";
    else if (ww === "WEFT") key = "weft";
    const normPct = row[key];
    if (normPct == null) {
      return {
        ok: false,
        reason: `Master2 has no ${key} norm for "${mixing}"`,
        normPct: null,
        article: mixing,
        masterRow: row,
      };
    }
    return { ok: true, reason: null, normPct, article: mixing, masterRow: row, sourceKey: key };
  }

  function lookupConeWeight(master3, mixing) {
    if (!mixing) {
      return { ok: false, reason: "Missing Mixing / article code", coneWeight: null };
    }
    if (!(mixing in master3)) {
      return {
        ok: false,
        reason: `Mixing "${mixing}" not found in Master3`,
        coneWeight: null,
      };
    }
    const coneWeight = master3[mixing];
    if (coneWeight == null) {
      return { ok: false, reason: `Master3 cone weight blank for "${mixing}"`, coneWeight: null };
    }
    return { ok: true, reason: null, coneWeight };
  }

  /**
   * Smallest weaving capacity ≥ packages.
   * Combined labels (28/35, 80/88, …) expose both bounds as bookable.
   */
  function selectVessel(packages, master1) {
    const caps = bookableCapacities(master1);
    if (!caps.length) {
      return { ok: false, reason: "No weaving vessels in Master1", vessel: null };
    }
    const match = caps.find((c) => c.capacity >= packages);
    if (!match) {
      const largest = caps[caps.length - 1];
      return {
        ok: false,
        reason: `Packages ${packages.toFixed(2)} exceed largest weaving capacity ${largest.capacity}`,
        vessel: largest.capacity,
        category: largest.category,
        fillRatio: packages / largest.capacity,
        underload: false,
        suggest: null,
      };
    }
    const fillRatio = packages / match.capacity;
    const smallerFits = [...caps]
      .reverse()
      .find((c) => c.capacity < match.capacity && c.capacity >= packages);
    const underload = fillRatio < UNDERLOAD_RATIO;
    let suggest = null;
    if (underload) {
      const nextDown = [...caps]
        .filter((c) => c.capacity < match.capacity)
        .sort((a, b) => b.capacity - a.capacity)[0];
      if (nextDown) suggest = nextDown.capacity;
    }
    return {
      ok: true,
      reason: null,
      vessel: match.capacity,
      category: match.category,
      fillRatio,
      underload,
      suggest: smallerFits ? smallerFits.capacity : suggest,
      capDay: match.capDay,
    };
  }

  function cloneMasters(data) {
    return {
      master1: JSON.parse(JSON.stringify(data.master1 || [])),
      master2: JSON.parse(JSON.stringify(data.master2 || {})),
      master3: JSON.parse(JSON.stringify(data.master3 || {})),
    };
  }

  function recomputeCapDay(row) {
    const weaving = Number(row.weaving) || 0;
    const outputDay = Number(row.outputDay) || 0;
    row.capDay = Math.round(weaving * outputDay * 1000) / 1000;
    return row;
  }

  function validateMaster1Row(row) {
    const errors = [];
    if (!String(row.label || "").trim()) errors.push("Label required");
    if (!(Number(row.weaving) >= 0)) errors.push("Weaving must be ≥ 0");
    if (!(Number(row.outputDay) >= 0)) errors.push("Output/day must be ≥ 0");
    return errors;
  }

  function upsertMaster2(master2, mixing, warp, weft, both) {
    const key = String(mixing || "").trim();
    if (!key) return { ok: false, reason: "Mixing required" };
    master2[key] = {
      warp: warp === "" || warp == null ? null : Number(warp),
      weft: weft === "" || weft == null ? null : Number(weft),
      both: both === "" || both == null ? null : Number(both),
    };
    return { ok: true, key };
  }

  function upsertMaster3(master3, mixing, coneKg) {
    const key = String(mixing || "").trim();
    if (!key) return { ok: false, reason: "Mixing required" };
    const n = Number(coneKg);
    if (!Number.isFinite(n) || n <= 0) return { ok: false, reason: "Cone kg must be > 0" };
    master3[key] = n;
    return { ok: true, key };
  }

  global.AuroMasters = {
    UNDERLOAD_RATIO,
    parseCapacityBounds,
    bookableCapacities,
    lookupNorm,
    lookupConeWeight,
    selectVessel,
    cloneMasters,
    recomputeCapDay,
    validateMaster1Row,
    upsertMaster2,
    upsertMaster3,
  };
})(typeof window !== "undefined" ? window : globalThis);
