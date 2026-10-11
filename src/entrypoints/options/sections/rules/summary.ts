// Plain-English summaries of rules, for the list and the live editor.
import { formatMoney } from '../../../../domain/money';
import type { Condition, Rule } from '../../../../domain/rules/schema';

const quote = (s: string): string => `"${s}"`;

function orList(items: string[]): string {
  return items.length <= 2 ? items.join(' or ') : `${items.slice(0, -1).join(', ')}, or ${items[items.length - 1] ?? ''}`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/** 90 -> "1 hour 30 minutes", 120 -> "2 hours", 45 -> "45 minutes". */
export function formatMinutes(minutes: number): string {
  if (minutes < 60) return plural(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes - hours * 60);
  if (hours >= 48 && rest === 0 && hours % 24 === 0) return plural(hours / 24, 'day');
  return rest === 0 ? plural(hours, 'hour') : `${plural(hours, 'hour')} ${plural(rest, 'minute')}`;
}

function money(label: string, min: number | undefined, max: number | undefined): string {
  if (min !== undefined && max !== undefined) return `${label} is between ${formatMoney(min)} and ${formatMoney(max)}`;
  if (min !== undefined) return `${label} is at least ${formatMoney(min)}`;
  if (max !== undefined) return `${label} is at most ${formatMoney(max)}`;
  return `${label} is anything`;
}

export function summarizeCondition(c: Condition): string {
  switch (c.kind) {
    case 'keyword': {
      const places = orList(c.fields);
      const terms = c.terms.map(quote).join(', ');
      const style = `${c.regex ? ' (as regular expressions)' : ''}${c.wholeWord ? ' (whole words only)' : ''}`;
      if (c.terms.length === 0) return `${places} has no terms yet`;
      if (c.mode === 'none') return `${places} contains none of ${terms}${style}`;
      if (c.terms.length === 1) return `${places} contains ${terms}${style}`;
      return `${places} contains ${c.mode === 'all' ? 'all' : 'any'} of ${terms}${style}`;
    }
    case 'price':
      return money('the price', c.min, c.max);
    case 'landedCost':
      return money('the estimated total with shipping and handling', c.min, c.max);
    case 'seller': {
      const who = [...c.sellerNames.map(quote), ...c.sellerIds.map((id) => `#${String(id)}`)].join(', ');
      return c.mode === 'include' ? `the seller is one of ${who}` : `the seller is not one of ${who}`;
    }
    case 'location':
      return c.mode === 'include'
        ? `the seller is located in ${orList(c.states)}`
        : `the seller is not located in ${orList(c.states)}`;
    case 'category':
      return `the category is ${orList(c.categoryIds.map((id) => `#${String(id)}`))}${c.includeChildren ? ' (or a subcategory)' : ''}`;
    case 'endsWithin': {
      const { minMinutes: lo, maxMinutes: hi } = c;
      if (lo !== undefined && hi !== undefined) {
        return `it ends between ${formatMinutes(lo)} and ${formatMinutes(hi)} from now`;
      }
      if (hi !== undefined) return `it ends within ${formatMinutes(hi)}`;
      if (lo !== undefined) return `it ends no sooner than ${formatMinutes(lo)} from now`;
      return 'it ends at any time';
    }
    case 'bidCount': {
      const { min: lo, max: hi } = c;
      if (hi === 0 && (lo === undefined || lo === 0)) return 'it has no bids';
      if (lo !== undefined && hi !== undefined) return `it has between ${String(lo)} and ${plural(hi, 'bid')}`;
      if (hi !== undefined) return `it has at most ${plural(hi, 'bid')}`;
      if (lo !== undefined) return `it has at least ${plural(lo, 'bid')}`;
      return 'it has any number of bids';
    }
    case 'pickupOnly':
      return c.value ? 'it is pickup only' : 'it can be shipped (not pickup only)';
  }
}

const ACTION_TEXT: Record<Rule['action'], string> = { hide: 'Hide', highlight: 'Highlight', watch: 'Watch' };

/** e.g. `Hide listings when title contains any of "pyrex", "fire king" and the price is at most $20.00.` */
export function summarizeRule(rule: Rule): string {
  const verb = ACTION_TEXT[rule.action] + (rule.action === 'highlight' && rule.tone !== undefined ? ` in ${rule.tone}` : '');
  const all = rule.all.map(summarizeCondition);
  const any = (rule.any ?? []).map(summarizeCondition);
  const parts: string[] = [];
  if (all.length > 0) parts.push(all.join(' and '));
  if (any.length > 0) parts.push(`at least one of these is true: ${any.join('; ')}`);
  if (parts.length === 0) return `${verb} listings (no conditions set yet).`;
  return `${verb} listings when ${parts.join(', and ')}.`;
}
