import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/ui/money';

describe('Money component', () => {
  it('renders formatted dollars as text', () => {
    const v = Money({ cents: 129950 });
    expect(v.type).toBe('span');
    expect(v.props.children).toBe('$1,299.50');
  });
  it('renders a placeholder for unknown amounts', () => {
    expect(Money({ cents: null }).props.children).toBe('—');
  });
});
