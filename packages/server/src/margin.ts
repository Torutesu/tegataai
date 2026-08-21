import type { Credits, MicroUsd } from '@tegata/core';
import { toIso } from '@tegata/core';
import type { Store } from '@tegata/store';

export interface SubjectMargin {
  subject_id: string;
  revenue_micro_usd: MicroUsd;
  cost_micro_usd: MicroUsd;
  margin_micro_usd: MicroUsd;
  negative: boolean;
  balance: Credits;
}

export interface MarginReport {
  window: { days: number; from: string; to: string };
  summary: {
    subjects: number;
    negative_count: number;
    /** Thousandths — a share without a float. */
    negative_share_milli: number;
    negative_cost_share_milli: number;
    revenue_micro_usd: MicroUsd;
    cost_micro_usd: MicroUsd;
    margin_micro_usd: MicroUsd;
  };
  subjects: SubjectMargin[];
}

const DAY_MS = 86_400_000;

/**
 * The definitions are the ones in the PRD §11.2 and in the free diagnostic tool, to
 * the word: subscriptions prorated daily across their period, top-ups recognised as
 * consumed (approximated straight-line over 30 days), promotional grants at zero.
 * A tenant who compares the tool's number with the product's must see the same number.
 */
export function marginReport(store: Store, tenantId: string, windowDays: number): MarginReport {
  const to = store.nowMs();
  const from = to - windowDays * DAY_MS;
  const fromIso = toIso(from);
  const toIsoStr = toIso(to);

  const costs = store.costBySubject(tenantId, fromIso, toIsoStr);
  const revenue = new Map<string, MicroUsd>();

  for (const ev of store.revenueEvents(tenantId)) {
    const start = Date.parse(ev.period_start);
    const end = Date.parse(ev.period_end);
    if (!(end > start)) continue;
    const overlap = Math.min(end, to) - Math.max(start, from);
    if (overlap <= 0) continue;
    // Integer arithmetic: multiply before dividing so a short overlap does not round to zero.
    const share = Math.floor((ev.amount_micro_usd * overlap) / (end - start));
    revenue.set(ev.subject_id, (revenue.get(ev.subject_id) ?? 0) + share);
  }

  const ids = new Set<string>([...costs.keys(), ...revenue.keys()]);
  const subjects: SubjectMargin[] = [];
  let totalRevenue = 0, totalCost = 0, negativeCost = 0, negativeCount = 0;

  for (const id of [...ids].sort()) {
    const cost = costs.get(id) ?? 0;
    const rev = revenue.get(id) ?? 0;
    const margin = rev - cost;
    const negative = margin < 0;
    subjects.push({
      subject_id: id, revenue_micro_usd: rev, cost_micro_usd: cost,
      margin_micro_usd: margin, negative, balance: store.balances(tenantId, id).balance,
    });
    totalRevenue += rev;
    totalCost += cost;
    if (negative) { negativeCount++; negativeCost += cost; }
  }

  subjects.sort((a, b) => a.margin_micro_usd - b.margin_micro_usd);

  return {
    window: { days: windowDays, from: fromIso, to: toIsoStr },
    summary: {
      subjects: subjects.length,
      negative_count: negativeCount,
      negative_share_milli: subjects.length === 0 ? 0 : Math.round((negativeCount * 1000) / subjects.length),
      negative_cost_share_milli: totalCost === 0 ? 0 : Math.round((negativeCost * 1000) / totalCost),
      revenue_micro_usd: totalRevenue,
      cost_micro_usd: totalCost,
      margin_micro_usd: totalRevenue - totalCost,
    },
    subjects,
  };
}
