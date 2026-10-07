// Cálculo de comissões de vendas para CRMs. Valores em centavos internamente.

const toCents = (v) => Math.round(v * 100);
const fromCents = (c) => c / 100;
const inPeriod = (date, { from, to }) => date >= from && date <= to;
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

function validateRules(r) {
  if (!r.tiers?.length) throw new TypeError('Defina pelo menos uma faixa em tiers');
  let last = 0;
  r.tiers.forEach((t, i) => {
    if (!(t.percent >= 0)) throw new RangeError(`Faixa ${i + 1}: percent inválido`);
    const isLast = i === r.tiers.length - 1;
    if (!isLast && !(t.upTo > last)) throw new RangeError(`Faixa ${i + 1}: upTo deve ser crescente`);
    if (isLast && t.upTo !== undefined) throw new RangeError('A última faixa não deve ter upTo (vale para o restante)');
    if (!isLast) last = t.upTo;
  });
  if (r.split) {
    const { seller = 0, sdr = 0 } = r.split;
    if (seller + sdr !== 100) throw new RangeError('split.seller + split.sdr deve somar 100');
  }
  if (!['paid', 'closed'].includes(r.basis ?? 'paid')) throw new RangeError('basis deve ser "paid" ou "closed"');
  if (!['progressive', 'flat'].includes(r.mode ?? 'progressive')) throw new RangeError('mode deve ser "progressive" ou "flat"');
}

/**
 * Comissão sobre um volume (em centavos) pelas faixas.
 * - progressive: cada faixa incide só sobre a parte do volume dentro dela (como o IR)
 * - flat: o volume inteiro usa a taxa da faixa alcançada
 * Volume negativo (estornos maiores que vendas) usa a taxa da primeira faixa.
 */
export function tieredCommission(volumeCents, tiers, mode = 'progressive') {
  if (volumeCents <= 0) return Math.round((volumeCents * tiers[0].percent) / 100);
  if (mode === 'flat') {
    const tier = tiers.find((t) => t.upTo === undefined || volumeCents <= toCents(t.upTo));
    return Math.round((volumeCents * tier.percent) / 100);
  }
  let total = 0;
  let floor = 0;
  for (const t of tiers) {
    const ceil = t.upTo === undefined ? Infinity : toCents(t.upTo);
    if (volumeCents <= floor) break;
    total += ((Math.min(volumeCents, ceil) - floor) * t.percent) / 100;
    floor = ceil;
  }
  return Math.round(total);
}

/** Lançamentos de uma venda no período: pagamentos/fechamento (+) e estornos/cancelamento (−). */
function entriesFor(sale, rules, period) {
  const out = [];
  const add = (amount, date, kind) => out.push({ saleId: sale.id, amount: toCents(amount), date, kind });

  if ((rules.basis ?? 'paid') === 'paid') {
    for (const p of sale.payments ?? []) if (inPeriod(p.paidAt, period)) add(p.amount, p.paidAt, 'pagamento');
    for (const r of sale.refunds ?? []) if (inPeriod(r.at, period)) add(-r.amount, r.at, 'estorno');
  } else {
    if (inPeriod(sale.closedAt, period)) add(sale.amount, sale.closedAt, 'venda');
    const withinClawback = sale.canceledAt && daysBetween(sale.closedAt, sale.canceledAt) <= (rules.clawbackDays ?? Infinity);
    if (withinClawback && inPeriod(sale.canceledAt, period)) add(-sale.amount, sale.canceledAt, 'cancelamento');
  }
  return out;
}

/**
 * Calcula as comissões do período.
 *
 * @param {object[]} sales [{ id, sellerId, sdrId?, product?, amount, closedAt, canceledAt?, payments?: [{ paidAt, amount }], refunds?: [{ at, amount }] }]
 * @param {object} rules { tiers, mode?, basis?, products?, split?, goal?, clawbackDays? }
 * @param {{ from: string, to: string }} period datas YYYY-MM-DD (inclusive)
 */
export function calculate(sales, rules, period) {
  validateRules(rules);
  const mode = rules.mode ?? 'progressive';
  const people = new Map();
  const person = (id) => {
    if (!people.has(id)) people.set(id, { personId: id, volume: 0, commission: 0, bonus: 0, lines: [] });
    return people.get(id);
  };

  // 1) Lançamentos agrupados por vendedor (as faixas olham o volume de quem vendeu)
  const bySeller = new Map();
  for (const sale of sales) {
    for (const e of entriesFor(sale, rules, period)) {
      if (!bySeller.has(sale.sellerId)) bySeller.set(sale.sellerId, []);
      bySeller.get(sale.sellerId).push({ ...e, sale });
    }
  }

  for (const [sellerId, entries] of bySeller) {
    const seller = person(sellerId);
    const tiered = entries.filter((e) => !rules.products?.[e.sale.product]);
    const volume = tiered.reduce((s, e) => s + e.amount, 0);
    const total = tieredCommission(volume, rules.tiers, mode);
    const effectiveRate = volume !== 0 ? total / volume : rules.tiers[0].percent / 100;
    seller.volume += entries.reduce((s, e) => s + e.amount, 0);

    // 2) Comissão de cada lançamento: taxa efetiva das faixas, ou taxa fixa do produto
    let assigned = 0;
    const tieredLines = [];
    for (const e of entries) {
      const fixed = rules.products?.[e.sale.product];
      const rate = fixed ? fixed.percent / 100 : effectiveRate;
      const value = Math.round(e.amount * rate);
      if (!fixed) { assigned += value; tieredLines.push(e); }
      e.commission = value;
      e.rate = rate;
    }
    // Ajusta o arredondamento para a soma bater exatamente com a comissão das faixas
    if (tieredLines.length) tieredLines[tieredLines.length - 1].commission += total - assigned;

    // 3) Divisão com o SDR
    for (const e of entries) {
      const sdrShare = e.sale.sdrId && rules.split ? Math.round((e.commission * rules.split.sdr) / 100) : 0;
      const sellerShare = e.commission - sdrShare;
      const base = { saleId: e.saleId, kind: e.kind, date: e.date, amount: fromCents(e.amount), rate: Math.round(e.rate * 10000) / 100 };
      seller.commission += sellerShare;
      seller.lines.push({ ...base, role: 'vendedor', value: fromCents(sellerShare) });
      if (sdrShare) {
        const sdr = person(e.sale.sdrId);
        sdr.commission += sdrShare;
        sdr.lines.push({ ...base, role: 'sdr', value: fromCents(sdrShare) });
      }
    }

    // 4) Bônus por meta (sobre o volume do vendedor no período)
    if (rules.goal && seller.volume >= toCents(rules.goal.amount)) {
      const b = rules.goal.bonus;
      seller.bonus += b.type === 'percent' ? Math.round((seller.volume * b.value) / 100) : toCents(b.value);
    }
  }

  return [...people.values()]
    .map((p) => ({
      personId: p.personId,
      volume: fromCents(p.volume),
      commission: fromCents(p.commission),
      bonus: fromCents(p.bonus),
      total: fromCents(p.commission + p.bonus),
      goalReached: rules.goal ? p.volume >= toCents(rules.goal.amount) && p.lines.some((l) => l.role === 'vendedor') : null,
      lines: p.lines.sort((a, b) => a.date.localeCompare(b.date) || String(a.saleId).localeCompare(String(b.saleId))),
    }))
    .sort((a, b) => b.total - a.total);
}

/** Exporta o extrato em CSV (";" e BOM, para o Excel em pt-BR). */
export function toCsv(results) {
  const n = (v) => v.toFixed(2).replace('.', ',');
  const rows = [['Pessoa', 'Papel', 'Venda', 'Data', 'Tipo', 'Base', 'Taxa %', 'Comissão']];
  for (const r of results) {
    for (const l of r.lines) rows.push([r.personId, l.role, l.saleId, l.date, l.kind, n(l.amount), n(l.rate), n(l.value)]);
    if (r.bonus) rows.push([r.personId, 'vendedor', '', '', 'bônus de meta', '', '', n(r.bonus)]);
  }
  const cell = (v) => (/[";\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  return `﻿${rows.map((r) => r.map(cell).join(';')).join('\r\n')}`;
}
