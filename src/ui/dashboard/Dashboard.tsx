import type { VNode } from 'preact';

import type { MessagingClient } from '../../ports/messaging';
import type { SectionDef } from './registry';

export interface DashboardProps {
  client: MessagingClient;
  sections: readonly SectionDef[];
  userTz: string;
  openOptions: (section?: string) => void;
}

/** The dashboard shell: a skip link, a section nav, then every registered section in order. */
export function Dashboard(props: DashboardProps): VNode {
  return (
    <div class="sbw-dash">
      <a class="sbw-skip" href="#sbw-main">
        Skip to content
      </a>
      <header>
        <h1>ShopBadwill</h1>
        <nav aria-label="Dashboard sections">
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
            <h2 id={`heading-${s.id}`}>{s.title}</h2>
            <s.Component client={props.client} userTz={props.userTz} openOptions={props.openOptions} />
          </section>
        ))}
      </main>
    </div>
  );
}
