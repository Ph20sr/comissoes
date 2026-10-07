import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculate, tieredCommission, toCsv } from '../src/index.js';

const TIERS = [{ upTo: 50000, percent: 5 }, { upTo: 100000, percent: 7 }, { percent: 10 }];
const OUT = { from: '2026-10-01', to: '2026-10-31' };

test('faixas progressivas (como o IR) e cheias', () => {
  // 50.000 × 5% + 50.000 × 7% + 20.000 × 10% = 2.500 + 3.500 + 2.000
  assert.equal(tieredCommission(12_000_000, TIERS, 'progressive'), 800_000);
  assert.equal(tieredCommission(12_000_000, TIERS, 'flat'), 1_200_000);
  assert.equal(tieredCommission(3_000_000, TIERS, 'flat'), 150_000);
  assert.equal(tieredCommission(0, TIERS), 0);
  assert.equal(tieredCommission(-1_000_000, TIERS), -50_000, 'estorno usa a primeira faixa');
});

/*
 * Cenário de outubro (base: valor recebido), calculado à mão:
 * Ana: s1 60.000 (com SDR Bia), s2 20.000, s3 10.000 de implantação (3% fixo),
 *      estorno de 5.000 de uma venda de setembro (s4)
 *   volume com faixas = 60.000 + 20.000 − 5.000 = 75.000 → 2.500 + 25.000 × 7% = 4.250
 *   taxa efetiva 5,6667%: s1 3.400 (Bia 20% = 680, Ana 2.720), s2 1.133,33, s4 −283,33
 *   s3: 10.000 × 3% = 300
 *   comissão da Ana = 2.720 + 1.133,33 − 283,33 + 300 = 3.870
 *   volume total 85.000 ≥ meta de 80.000 → bônus de 1% = 850 → total 4.720
 * Carlos: s5 30.000 → 1.500 (não bateu a meta)
 */
const sales = [
  { id: 's1', sellerId: 'ana', sdrId: 'bia', amount: 60000, closedAt: '2026-09-28', payments: [{ paidAt: '2026-10-05', amount: 60000 }] },
  { id: 's2', sellerId: 'ana', amount: 20000, closedAt: '2026-10-18', payments: [{ paidAt: '2026-10-20', amount: 20000 }] },
  { id: 's3', sellerId: 'ana', product: 'implantacao', amount: 10000, closedAt: '2026-10-08', payments: [{ paidAt: '2026-10-10', amount: 10000 }] },
  { id: 's4', sellerId: 'ana', amount: 5000, closedAt: '2026-09-10', payments: [{ paidAt: '2026-09-12', amount: 5000 }], refunds: [{ at: '2026-10-15', amount: 5000 }] },
  { id: 's5', sellerId: 'carlos', amount: 30000, closedAt: '2026-10-01', payments: [{ paidAt: '2026-10-03', amount: 30000 }] },
  { id: 's6', sellerId: 'carlos', amount: 9999, closedAt: '2026-10-30', payments: [{ paidAt: '2026-11-02', amount: 9999 }] },
];
const rules = {
  tiers: TIERS,
  basis: 'paid',
  products: { implantacao: { percent: 3 } },
  split: { seller: 80, sdr: 20 },
  goal: { amount: 80000, bonus: { type: 'percent', value: 1 } },
};

test('cenário completo de outubro', () => {
  const [ana, carlos, bia] = calculate(sales, rules, OUT);

  assert.deepEqual(
    { id: ana.personId, volume: ana.volume, commission: ana.commission, bonus: ana.bonus, total: ana.total, goal: ana.goalReached },
    { id: 'ana', volume: 85000, commission: 3870, bonus: 850, total: 4720, goal: true },
  );
  assert.deepEqual([carlos.personId, carlos.total, carlos.goalReached], ['carlos', 1500, false]);
  assert.deepEqual([bia.personId, bia.total], ['bia', 680]);

  const line = (id) => ana.lines.find((l) => l.saleId === id);
  assert.equal(line('s1').value, 2720);
  assert.equal(line('s2').value, 1133.33);
  assert.equal(line('s4').value, -283.33);
  assert.equal(line('s4').kind, 'estorno');
  assert.equal(line('s3').rate, 3);
  assert.equal(bia.lines[0].role, 'sdr');
  assert.equal(carlos.lines.some((l) => l.saleId === 's6'), false, 'pago só em novembro');
});

test('a soma das linhas fecha com a comissão das faixas (sem centavo perdido)', () => {
  const odd = [1, 2, 3].map((i) => ({ id: `v${i}`, sellerId: 'x', amount: 333.33, closedAt: '2026-10-01', payments: [{ paidAt: '2026-10-02', amount: 333.33 }] }));
  const [x] = calculate(odd, { tiers: [{ percent: 7 }] }, OUT);
  const sum = Math.round(x.lines.reduce((s, l) => s + l.value * 100, 0));
  assert.equal(sum, tieredCommission(99_999, [{ percent: 7 }]));
  assert.equal(x.commission, 70);
});

test('base "venda fechada" com estorno de cancelamento dentro do prazo', () => {
  const closed = [
    { id: 'a', sellerId: 'ana', amount: 10000, closedAt: '2026-08-01', canceledAt: '2026-10-10' }, // 70 dias: estorna
    { id: 'b', sellerId: 'ana', amount: 10000, closedAt: '2026-05-01', canceledAt: '2026-10-10' }, // 162 dias: não estorna
    { id: 'c', sellerId: 'ana', amount: 40000, closedAt: '2026-10-20' },
  ];
  const [ana] = calculate(closed, { tiers: TIERS, basis: 'closed', clawbackDays: 90 }, OUT);
  assert.equal(ana.volume, 30000);
  assert.equal(ana.commission, 1500);
  assert.deepEqual(ana.lines.map((l) => [l.saleId, l.kind]), [['a', 'cancelamento'], ['c', 'venda']]);
});

test('só estornos no mês: comissão negativa (desconta do próximo pagamento)', () => {
  const [ana] = calculate([{ id: 'z', sellerId: 'ana', amount: 1000, closedAt: '2026-09-01', refunds: [{ at: '2026-10-05', amount: 1000 }] }], rules, OUT);
  assert.equal(ana.commission, -50);
});

test('bônus fixo por meta', () => {
  const [carlos] = calculate(sales.filter((s) => s.sellerId === 'carlos'), { tiers: TIERS, goal: { amount: 30000, bonus: { type: 'fixed', value: 500 } } }, OUT);
  assert.deepEqual([carlos.bonus, carlos.total], [500, 2000]);
});

test('regras inválidas falham cedo', () => {
  assert.throws(() => calculate([], { tiers: [] }, OUT), /faixa/);
  assert.throws(() => calculate([], { tiers: [{ upTo: 100, percent: 5 }] }, OUT), /última faixa/);
  assert.throws(() => calculate([], { tiers: [{ upTo: 100, percent: 5 }, { upTo: 50, percent: 6 }, { percent: 7 }] }, OUT), /crescente/);
  assert.throws(() => calculate([], { tiers: TIERS, split: { seller: 70, sdr: 20 } }, OUT), /100/);
  assert.throws(() => calculate([], { tiers: TIERS, basis: 'outra' }, OUT), /basis/);
});

test('extrato em CSV para o Excel', () => {
  const csv = toCsv(calculate(sales, rules, OUT));
  assert.ok(csv.startsWith('﻿Pessoa;Papel;Venda;Data;Tipo;Base;Taxa %;Comissão'));
  assert.ok(csv.includes('ana;vendedor;s4;2026-10-15;estorno;-5000,00;5,67;-283,33'));
  assert.ok(csv.includes('ana;vendedor;;;bônus de meta;;;850,00'));
  assert.ok(csv.includes('bia;sdr;s1;2026-10-05;pagamento;60000,00;5,67;680,00'));
});
