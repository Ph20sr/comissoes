# comissoes

[![CI](https://github.com/Ph20sr/comissoes/actions/workflows/ci.yml/badge.svg)](https://github.com/Ph20sr/comissoes/actions/workflows/ci.yml)
![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)

**Cálculo de comissões de vendas** para CRMs e sistemas de gestão comercial: o fechamento do mês que costuma viver numa planilha cheia de fórmulas, agora com regras claras, extrato linha a linha e testes. Não tem dependências.

## Regras suportadas

| regra | exemplo |
| --- | --- |
| **faixas progressivas** | 5% até R$ 50 mil, 7% de 50 a 100 mil, 10% acima (cada faixa só na parte dentro dela, como o IR) |
| **faixas cheias** | bateu R$ 100 mil? 10% sobre **tudo** |
| **base de cálculo** | sobre o **recebido** no mês (`paid`) ou sobre as **vendas fechadas** (`closed`) |
| **estornos** | reembolso no mês entra negativo; cancelamento dentro do prazo (`clawbackDays`) também |
| **taxa por produto** | implantação a 3% fixo, fora das faixas |
| **divisão com SDR** | 80% vendedor, 20% pré-vendas, por venda |
| **bônus por meta** | bateu R$ 80 mil: +1% do volume ou valor fixo |

Os valores são calculados em **centavos inteiros**, e a soma das linhas fecha exatamente com a comissão das faixas: nenhum centavo sobra ou some no arredondamento.

## Uso

```js
import { calculate, toCsv } from 'comissoes';

const resultado = calculate(vendas, {
  tiers: [{ upTo: 50000, percent: 5 }, { upTo: 100000, percent: 7 }, { percent: 10 }],
  mode: 'progressive',               // ou 'flat'
  basis: 'paid',                     // comissão sobre o que foi pago no período
  products: { implantacao: { percent: 3 } },
  split: { seller: 80, sdr: 20 },
  goal: { amount: 80000, bonus: { type: 'percent', value: 1 } },
}, { from: '2026-10-01', to: '2026-10-31' });

// [
//   { personId: 'ana', volume: 85000, commission: 3870, bonus: 850, total: 4720, goalReached: true,
//     lines: [{ saleId: 's1', kind: 'pagamento', amount: 60000, rate: 5.67, role: 'vendedor', value: 2720 }, ...] },
//   { personId: 'carlos', ..., total: 1500 },
//   { personId: 'bia', ..., total: 680 },   // SDR
// ]

writeFileSync('comissoes-outubro.csv', toCsv(resultado));   // extrato que abre no Excel
```

Formato de cada venda:

```js
{
  id: 's1', sellerId: 'ana', sdrId: 'bia', product: 'site',
  amount: 60000, closedAt: '2026-09-28', canceledAt: null,
  payments: [{ paidAt: '2026-10-05', amount: 30000 }, { paidAt: '2026-11-05', amount: 30000 }],
  refunds: [],
}
```

Com `basis: 'paid'`, uma venda parcelada gera comissão **mês a mês, conforme o cliente paga**, o que evita pagar comissão de venda que não foi recebida.

## Como a taxa é aplicada em cada venda

As faixas olham o **volume total do vendedor** no período. A comissão resultante é distribuída pelas vendas com a taxa efetiva (ex.: R$ 4.250 sobre R$ 75 mil = 5,67%). É ela que aparece em cada linha do extrato e que é dividida com o SDR. Assim, o extrato explica cada centavo, e a soma bate com a regra.

## Desenvolvimento

```bash
npm test
```

Os testes usam um mês completo calculado à mão: faixas, SDR, produto com taxa fixa, estorno, meta, parcela fora do período e cancelamento dentro e fora do prazo.

## Licença

MIT
