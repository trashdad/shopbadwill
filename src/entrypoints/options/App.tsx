import type { VNode } from 'preact';
import { useEffect } from 'preact/hooks';

import type { MessagingClient } from '../../ports/messaging';
import type { SectionDef } from './registry';

/** The options shell: a skip link, a section nav, then every registered section in order. */
export function App(props: { client: MessagingClient; sections: readonly SectionDef[] }): VNode {
  // Honour `#health` (or `#section-health`): scroll to the section and focus its heading.
  useEffect(() => {
    const go = (): void => {
      const hash = window.location.hash.slice(1);
      if (hash === '') return;
      const id = hash.startsWith('section-') ? hash.slice('section-'.length) : hash;
      const heading = document.getElementById(`heading-${id}`);
      if (heading === null) return;
      heading.scrollIntoView();
      heading.focus();
    };
    go();
    window.addEventListener('hashchange', go);
    return () => {
      window.removeEventListener('hashchange', go);
    };
  }, []);
  return (
    <div class="sbw-options">
      <a class="sbw-skip" href="#sbw-main">
        Skip to content
      </a>
      <header>
        <h1>ShopBadwill options</h1>
        <nav aria-label="Options sections">
          <ul>
            {props.sections.map((s) => (
              <li key={s.id}>
                <a href={`#section-${s.id}`}>{s.title}</a>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main id="sbw-main" tabIndex={-1}>
        {props.sections.map((s) => (
          <section key={s.id} id={`section-${s.id}`} aria-labelledby={`heading-${s.id}`}>
            <h2 id={`heading-${s.id}`} tabIndex={-1}>{s.title}</h2>
            <s.Component client={props.client} />
          </section>
        ))}
      </main>
    </div>
  );
}
