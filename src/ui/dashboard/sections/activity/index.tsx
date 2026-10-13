import type { VNode } from 'preact';

import { ActivityList } from '../../../activity';
import type { SectionDef, SectionProps } from '../../registry';

/** Mounts T-58's list; this section owns no activity logic (I-11). */
export function ActivitySection(props: SectionProps): VNode {
  return <ActivityList client={props.client} pageSize={20} userTz={props.userTz} />;
}

export const section: SectionDef = { id: 'activity', title: 'Activity', order: 40, Component: ActivitySection };
