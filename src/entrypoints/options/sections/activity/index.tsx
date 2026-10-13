import type { VNode } from 'preact';

import { Card } from '../../../../ui/components/Field';
import { ActivityList } from '../../../../ui/activity';
import type { SectionDef, SectionProps } from '../../registry';

export function ActivitySection(props: SectionProps): VNode {
  return (
    <Card>
      <p>What ShopBadwill did on your behalf. Some actions can be undone here.</p>
      <ActivityList client={props.client} />
    </Card>
  );
}

export const section: SectionDef = { id: 'activity', title: 'Activity', order: 40, Component: ActivitySection };
