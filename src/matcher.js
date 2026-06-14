function valueToText(value) {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(valueToText).filter(Boolean).join(' ');
  if (typeof value === 'object') {
    return String(
      value.text ??
        value.name ??
        value.en_name ??
        value.full_name ??
        value.email ??
        value.value ??
        value.link ??
        ''
    );
  }
  return String(value);
}

function valueToNumber(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = valueToText(value).replace(/[$,%\s,]/g, '');
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeProject(value) {
  return valueToText(value)
    .trim()
    .toLowerCase()
    .replace(/^[\s\d]+/, '')
    .replace(/[（）]/g, (m) => (m === '（' ? '(' : ')'))
    .replace(/\s+/g, '');
}

function cleanCode(value) {
  return valueToText(value)
    .trim()
    .toLowerCase()
    .replace(/ｃｏｄｅ/g, 'code')
    .replace(/\s+/g, '')
    .replace(/\.0$/, '');
}

function strongCode(value) {
  let text = cleanCode(value).replace(/code/g, '');
  if (/^\d+$/.test(text)) text = String(Number(text));
  return text;
}

function normalizeName(value) {
  return valueToText(value)
    .trim()
    .toLowerCase()
    .replace(/[（）]/g, (m) => (m === '（' ? '(' : ')'))
    .replace(/\s+/g, '');
}

function kpiText(value) {
  const parsed = valueToNumber(value);
  return parsed == null ? valueToText(value).trim() : String(parsed);
}

function normalizeCommon(row) {
  row.projectNorm = normalizeProject(row.project);
  row.codeClean = cleanCode(row.code);
  row.codeStrong = strongCode(row.code);
  row.shooterNorm = normalizeName(row.shooter);
  row.countryNorm = normalizeName(row.country);
  row.kpiNorm = kpiText(row.kpi);
  return row;
}

function key(row, parts) {
  const map = {
    project: row.projectNorm,
    codeClean: row.codeClean,
    codeStrong: row.codeStrong,
    country: row.countryNorm,
    kpi: row.kpiNorm,
    shooter: row.shooterNorm,
  };
  return parts.map((part) => map[part] ?? '').join('\u0001');
}

function strategies() {
  return [
    ['project+exact_code+country+kpi', ['project', 'codeClean', 'country', 'kpi']],
    ['project+exact_code+country', ['project', 'codeClean', 'country']],
    ['project+strong_code+country+kpi', ['project', 'codeStrong', 'country', 'kpi']],
    ['project+strong_code+country', ['project', 'codeStrong', 'country']],
    ['project+strong_code', ['project', 'codeStrong']],
    ['project+shooter+country+kpi', ['project', 'shooter', 'country', 'kpi']],
  ];
}

function buildIndexes(rows) {
  return strategies().map(([label, parts]) => {
    const map = new Map();
    for (const row of rows) {
      const rowKey = key(row, parts);
      if (!map.has(rowKey)) map.set(rowKey, []);
      map.get(rowKey).push(row);
    }
    return { label, parts, map };
  });
}

function findMatch(row, indexes) {
  let duplicate = null;
  for (const index of indexes) {
    const candidates = index.map.get(key(row, index.parts)) || [];
    if (candidates.length === 1) return { strategy: index.label, row: candidates[0] };
    if (candidates.length > 1 && !duplicate) {
      duplicate = { strategy: `${index.label}:duplicate`, candidates };
    }
  }
  return duplicate;
}

function matchAdsToRecords(adsRows, records) {
  const indexes = buildIndexes(records);
  const matches = [];
  const unmatched = [];
  const review = [];

  for (const ad of adsRows) {
    const hit = findMatch(ad, indexes);
    if (!hit || !hit.row) {
      unmatched.push({ ad, reason: hit ? hit.strategy : 'no_candidate' });
      review.push({
        type: '未匹配',
        ad,
        record: null,
        strategy: hit ? hit.strategy : 'no_candidate',
      });
      continue;
    }

    const record = hit.row;
    const shooterDiff = ad.shooterNorm && record.shooterNorm && ad.shooterNorm !== record.shooterNorm;
    const strongCodeOnly = hit.strategy.includes('strong_code');
    const zeroConflict =
      ((ad.metrics.spend === 0 && (record.currentMetrics.spend || 0) > 0) ||
        (ad.metrics.impressions === 0 && (record.currentMetrics.impressions || 0) > 0) ||
        (ad.metrics.clicks === 0 && (record.currentMetrics.clicks || 0) > 0));

    if (shooterDiff || strongCodeOnly || zeroConflict) {
      review.push({
        type: zeroConflict ? '0值冲突' : shooterDiff ? '投手不一致' : '强清洗匹配',
        ad,
        record,
        strategy: hit.strategy,
        shooterDiff,
        strongCodeOnly,
        zeroConflict,
      });
    }

    matches.push({
      ad,
      record,
      strategy: hit.strategy,
      shooterDiff,
      strongCodeOnly,
      zeroConflict,
    });
  }

  return { matches, unmatched, review };
}

module.exports = {
  valueToText,
  valueToNumber,
  normalizeCommon,
  matchAdsToRecords,
};
