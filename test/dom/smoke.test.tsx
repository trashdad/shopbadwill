import { render, screen } from '@testing-library/preact';
import { describe, expect, it } from 'vitest';

function Badge({ label }: { label: string }) {
  return <div role="status">{label}</div>;
}

// DOM-suite smoke test: Preact JSX renders in happy-dom via Testing Library.
describe('dom suite smoke', () => {
  it('renders a Preact component', () => {
    render(<Badge label="ShopBadwill ready" />);
    expect(screen.getByRole('status').textContent).toBe('ShopBadwill ready');
  });

  it('supports Shadow DOM', () => {
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.append(document.createTextNode('inside'));
    expect(host.shadowRoot?.textContent).toBe('inside');
  });
});
