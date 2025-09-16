function pickIssuePayload(b) {
  const numOrNull = (x) => (x === "" || x === undefined || x === null ? null : Number(x));
  const geo = b.geo && Number.isFinite(Number(b.geo.lat)) && Number.isFinite(Number(b.geo.lng))
    ? { lat: Number(b.geo.lat), lng: Number(b.geo.lng) }
    : null;

  const out = {
    farmId: String(b.farmId || ""),
    plotId: String(b.plotId || ""),
    crop: b.crop ? String(b.crop) : null,
    batch: b.batch ? String(b.batch) : null,
    category: String(b.category || ""),
    severity: numOrNull(b.severity) ?? 1,
    description: String(b.description || ""),
    actionPlan: b.actionPlan ? String(b.actionPlan) : null,
    productUsed: b.productUsed ? String(b.productUsed) : null,
    dose: b.dose ? String(b.dose) : null,
    phiDays: numOrNull(b.phiDays),
    geo,
    consent: !!b.consent
  };

  if (!out.farmId || !out.plotId || !out.category || !out.description || !out.consent) {
    throw new Error("Missing required fields");
  }
  if (out.severity < 1 || out.severity > 5) throw new Error("severity must be 1..5");
  if (!/^(WEED|PEST|DISEASE|NUTRIENT|OTHER)$/.test(out.category)) throw new Error("invalid category");
  return out;
}

module.exports = { pickIssuePayload };
