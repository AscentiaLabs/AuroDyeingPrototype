/**
 * Rule 2 clubbing:
 * 1) Within same dyeing SO + fabric SO, by Product Code
 * 2) Across fabric SOs when Product Code + dyed-yarn requirement date match
 */
(function (global) {
  function clubKeyWithin(line) {
    return [line.saleOrderNo, line.fabricSO, line.productCode].join("||");
  }

  function clubKeyCross(line) {
    return [line.productCode, line.reqDate || ""].join("||");
  }

  /**
   * Build clubbing groups from enriched lines (must already have inputQty).
   * Prefer within-SO groups; merge across fabric SOs when same product+date
   * and groups are still separate.
   */
  function buildClubbingGroups(lines) {
    const within = new Map();
    for (const line of lines) {
      const key = clubKeyWithin(line);
      if (!within.has(key)) within.set(key, []);
      within.get(key).push(line);
    }

    // Seed groups from within-SO buckets
    let groups = [...within.values()].map((members, idx) => makeGroup(members, "within", idx));

    // Tier 2: merge groups that share productCode + reqDate across fabric SOs
    const byCross = new Map();
    for (const g of groups) {
      const sample = g.lines[0];
      const ck = clubKeyCross(sample);
      if (!byCross.has(ck)) byCross.set(ck, []);
      byCross.get(ck).push(g);
    }

    const merged = [];
    let mi = 0;
    for (const [, bucket] of byCross) {
      if (bucket.length === 1) {
        merged.push({ ...bucket[0], id: `G${++mi}` });
        continue;
      }
      // Only merge if fabric SOs differ (true cross-fabric clubbing)
      const fabricSOs = new Set(bucket.flatMap((g) => g.lines.map((l) => l.fabricSO)));
      if (fabricSOs.size <= 1) {
        for (const g of bucket) merged.push({ ...g, id: `G${++mi}` });
        continue;
      }
      const allLines = bucket.flatMap((g) => g.lines);
      merged.push(makeGroup(allLines, "cross-fabric", mi + 1));
      merged[merged.length - 1].id = `G${++mi}`;
    }

    return merged.map((g, i) => ({ ...g, id: g.id || `G${i + 1}` }));
  }

  function makeGroup(members, tier, idx) {
    const sorted = [...members].sort((a, b) => Number(b.lineNo) - Number(a.lineNo));
    const sample = sorted[0];
    const sumInput = sorted.reduce((s, l) => s + (l.inputQty || 0), 0);
    const coneWeight = sample.coneWeightEffective;
    const joinOk = sorted.every((l) => l.joinOk);
    const packages = coneWeight > 0 && joinOk ? sumInput / coneWeight : null;
    return {
      id: `G${idx}`,
      tier,
      productCode: sample.productCode,
      fabricSO: [...new Set(sorted.map((l) => l.fabricSO))].join(", "),
      saleOrderNo: [...new Set(sorted.map((l) => l.saleOrderNo))].join(", "),
      reqDate: sample.reqDate,
      warpWeft: sample.warpWeft,
      shade: sample.labRef || sample.shade,
      mixing: sample.mixing,
      lineNos: sorted.map((l) => l.lineNo),
      lines: sorted,
      clubbed: sorted.length > 1,
      sumInputQty: sumInput,
      coneWeight,
      packages,
      joinOk,
      joinFailures: sorted.filter((l) => !l.joinOk).map((l) => l.joinFailure),
    };
  }

  global.AuroClubbing = {
    clubKeyWithin,
    clubKeyCross,
    buildClubbingGroups,
  };
})(typeof window !== "undefined" ? window : globalThis);
