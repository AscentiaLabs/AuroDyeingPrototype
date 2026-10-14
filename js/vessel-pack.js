/**
 * Vessel packer for Stage 2.
 * Classic path (default): one lot per Rule-2 group via selectVessel — preserves example2.
 * Auto-plan path: split overflow / optimize multi-bin fill under Master1 capacities.
 */
(function (global) {
  const { selectVessel, bookableCapacities, UNDERLOAD_RATIO } = global.AuroMasters;

  function round(n, d = 6) {
    if (n == null || Number.isNaN(n)) return n;
    const f = 10 ** d;
    return Math.round(n * f) / f;
  }

  function linePackages(line) {
    if (!line.joinOk || line.inputQty == null) return null;
    const cone = line.coneWeightEffective;
    if (!(cone > 0)) return null;
    return line.inputQty / cone;
  }

  /** Exact 0/1 pack: maximize packages packed under capacity. */
  function exactPack(items, capacity) {
    const n = items.length;
    if (n === 0) return { indices: [], packed: 0 };
    if (n > 20) return null; // signal caller to use greedy
    // DP on scaled integers (3 decimals)
    const scale = 1000;
    const C = Math.floor(capacity * scale + 1e-9);
    const weights = items.map((it) => Math.max(0, Math.round(it.packages * scale)));
    const values = weights.slice();
    const dp = new Array(C + 1).fill(0);
    const take = Array.from({ length: n }, () => new Array(C + 1).fill(false));
    for (let i = 0; i < n; i++) {
      const w = weights[i];
      const v = values[i];
      for (let c = C; c >= w; c--) {
        const cand = dp[c - w] + v;
        if (cand > dp[c]) {
          dp[c] = cand;
          take[i][c] = true;
        }
      }
    }
    let c = C;
    const indices = [];
    for (let i = n - 1; i >= 0; i--) {
      if (take[i][c]) {
        indices.push(i);
        c -= weights[i];
      }
    }
    indices.reverse();
    const packed = indices.reduce((s, i) => s + items[i].packages, 0);
    return { indices, packed };
  }

  /** First-fit decreasing: pack items into bins of `capacity`. */
  function firstFitDecreasing(items, capacity) {
    const sorted = items
      .map((it, idx) => ({ ...it, _idx: idx }))
      .sort((a, b) => b.packages - a.packages);
    const bins = [];
    for (const it of sorted) {
      let placed = false;
      for (const bin of bins) {
        const used = bin.reduce((s, x) => s + x.packages, 0);
        if (used + it.packages <= capacity + 1e-9) {
          bin.push(it);
          placed = true;
          break;
        }
      }
      if (!placed) bins.push([it]);
    }
    return bins;
  }

  /**
   * Split a single oversized line into chunks ≤ largest capacity (weft-style).
   * Returns synthetic items with proportional inputQty.
   */
  function splitOversizedLine(line, largest) {
    const pkg = linePackages(line);
    if (pkg == null) return [];
    if (pkg <= largest + 1e-9) {
      return [{ line, packages: pkg, split: false, fraction: 1 }];
    }
    const chunks = [];
    let remaining = pkg;
    const cone = line.coneWeightEffective;
    while (remaining > 1e-9) {
      const take = Math.min(remaining, largest);
      const fraction = take / pkg;
      chunks.push({
        line: {
          ...line,
          orderQty: round(line.orderQty * fraction, 6),
          inputQty: round(line.inputQty * fraction, 6),
          creelwiseQty: round((line.creelwiseQty || line.orderQty) * fraction, 6),
          _splitNote: "split for capacity",
        },
        packages: take,
        split: true,
        fraction,
      });
      remaining = round(remaining - take, 6);
    }
    return chunks;
  }

  function itemsFromGroup(group, largest) {
    const items = [];
    for (const line of group.lines) {
      const pkg = linePackages(line);
      if (pkg == null) continue;
      // Atomic unless packages > largest (MoM: do not break creel count for v1 except overflow)
      if (pkg > largest + 1e-9) {
        items.push(...splitOversizedLine(line, largest));
      } else {
        items.push({ line, packages: pkg, split: false, fraction: 1 });
      }
    }
    return items;
  }

  function makeLotFromItems(baseGroup, items, vesselSel, lotIndex) {
    const lines = items.map((it) => it.line);
    const sorted = [...lines].sort((a, b) => Number(b.lineNo) - Number(a.lineNo));
    const sumInput = sorted.reduce((s, l) => s + (l.inputQty || 0), 0);
    const packages = items.reduce((s, it) => s + it.packages, 0);
    const splitFlag = items.some((it) => it.split);
    return {
      ...baseGroup,
      id: `${baseGroup.id}-L${lotIndex}`,
      lotIndex,
      lines: sorted,
      lineNos: sorted.map((l) => l.lineNo),
      clubbed: sorted.length > 1 || baseGroup.clubbed,
      sumInputQty: round(sumInput, 6),
      packages: round(packages, 6),
      coneWeight: baseGroup.coneWeight,
      joinOk: sorted.every((l) => l.joinOk),
      joinFailures: sorted.filter((l) => !l.joinOk).map((l) => l.joinFailure),
      vessel: vesselSel.vessel,
      vesselCategory: vesselSel.category || null,
      fillRatio: vesselSel.fillRatio != null ? round(vesselSel.fillRatio, 4) : null,
      underload: !!vesselSel.underload,
      suggest: vesselSel.suggest || null,
      vesselOk: vesselSel.ok,
      vesselReason: vesselSel.reason,
      vesselManual: false,
      packMode: "auto",
      splitForCapacity: splitFlag,
      fabricSO: [...new Set(sorted.map((l) => l.fabricSO))].join(", "),
      saleOrderNo: [...new Set(sorted.map((l) => l.saleOrderNo))].join(", "),
    };
  }

  function packItemsIntoBins(items, capacity) {
    if (!items.length) return [];
    if (items.length <= 20) {
      const bins = [];
      let rest = items.slice();
      while (rest.length) {
        const result = exactPack(rest, capacity);
        if (!result || !result.indices.length) {
          // fallback: take largest single that fits, else force first
          const fitIdx = rest.findIndex((it) => it.packages <= capacity + 1e-9);
          const idx = fitIdx >= 0 ? fitIdx : 0;
          bins.push([rest[idx]]);
          rest = rest.filter((_, i) => i !== idx);
          continue;
        }
        const chosen = new Set(result.indices);
        bins.push(result.indices.map((i) => rest[i]));
        rest = rest.filter((_, i) => !chosen.has(i));
      }
      return bins;
    }
    return firstFitDecreasing(items, capacity);
  }

  /**
   * Pack Rule-2 groups into vessel lots.
   * @param {object[]} groups - from buildClubbingGroups
   * @param {object[]} master1
   * @param {{ autoPlan?: boolean, optimizeFill?: boolean }} options
   */
  function packGroups(groups, master1, options = {}) {
    const autoPlan = !!options.autoPlan;
    const caps = bookableCapacities(master1);
    const largest = caps.length ? caps[caps.length - 1].capacity : 0;

    const out = [];
    for (const g of groups) {
      if (!g.joinOk || g.packages == null) {
        out.push({
          ...g,
          vessel: null,
          vesselCategory: null,
          fillRatio: null,
          underload: false,
          suggest: null,
          vesselOk: false,
          vesselReason: g.joinFailures?.length
            ? g.joinFailures.join("; ")
            : "Cannot compute packages",
          vesselManual: false,
          packMode: autoPlan ? "auto" : "classic",
        });
        continue;
      }

      const P = g.packages;
      const needsSplit = largest > 0 && P > largest + 1e-9;

      if (!autoPlan || !needsSplit) {
        // Classic / single-bin: smallest ≥ P (also max fill among feasible)
        const sel = selectVessel(P, master1);
        out.push({
          ...g,
          packages: round(P, 6),
          sumInputQty: round(g.sumInputQty, 6),
          vessel: sel.vessel,
          vesselCategory: sel.category || null,
          fillRatio: sel.fillRatio != null ? round(sel.fillRatio, 4) : null,
          underload: !!sel.underload,
          suggest: sel.suggest || null,
          vesselOk: sel.ok,
          vesselReason: sel.reason,
          vesselManual: false,
          packMode: autoPlan ? "auto" : "classic",
        });
        continue;
      }

      // Overflow: split into multiple lots under largest (or best fitting) vessel
      const items = itemsFromGroup(g, largest);
      if (!items.length) {
        out.push({
          ...g,
          vessel: null,
          vesselOk: false,
          vesselReason: "No packable line packages",
          packMode: "auto",
        });
        continue;
      }

      // Choose bin capacity: largest bookable (fill objective under capacity constraint)
      const binCap = largest;
      const bins = packItemsIntoBins(items, binCap);
      let lotIndex = 1;
      for (const bin of bins) {
        const binPkg = bin.reduce((s, it) => s + it.packages, 0);
        const sel = selectVessel(binPkg, master1);
        out.push(makeLotFromItems(g, bin, sel, lotIndex++));
      }
    }
    return out;
  }

  /**
   * Apply manual vessel overrides after packing (same shape as planner.applyVesselSelection).
   */
  function applyVesselOverride(g, master1, vesselOverride) {
    if (vesselOverride == null || vesselOverride === "") return g;
    if (!g.joinOk || g.packages == null) return g;
    const packages = round(g.packages, 6);
    const caps = bookableCapacities(master1);
    const capacity = Number(vesselOverride);
    const match = caps.find((c) => c.capacity === capacity);
    const fillRatio = capacity > 0 ? packages / capacity : null;
    return {
      ...g,
      packages,
      vessel: capacity,
      vesselCategory: match ? match.category : String(capacity),
      fillRatio: fillRatio != null ? round(fillRatio, 4) : null,
      underload: fillRatio != null && fillRatio < UNDERLOAD_RATIO,
      suggest: null,
      vesselOk: match != null && capacity >= packages,
      vesselReason:
        match == null
          ? `Vessel ${capacity} not in Master1 weaving list`
          : capacity < packages
            ? `Packages ${packages.toFixed(2)} exceed vessel ${capacity}`
            : null,
      vesselManual: true,
    };
  }

  global.AuroVesselPack = {
    packGroups,
    applyVesselOverride,
    exactPack,
    firstFitDecreasing,
    linePackages,
    UNDERLOAD_RATIO,
  };
})(typeof window !== "undefined" ? window : globalThis);
