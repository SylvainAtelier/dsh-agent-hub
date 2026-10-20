/**
 * Renders nothing: hands the framework's session list and session statuses (hooks every slot
 * component gets) to the sidebar layer, which is not a React component.
 */

import { useEffect, type ReactNode } from 'react'
import type { ActivityInput, ActivityStore, SessionStatus } from './activity.ts'

type Select<S> = <T>(select: (snapshot: S) => T) => T

export interface ActivityProbeProps {
  activity: ActivityStore
  useSessions: Select<NonNullable<ActivityInput['sessions']>>
  useSessionStatus?: Select<ReadonlyMap<string, SessionStatus | undefined>>
}

const same = <T,>(value: T): T => value
const none = (_select: unknown): undefined => undefined

export function ActivityProbe(props: ActivityProbeProps): ReactNode {
  const sessions = props.useSessions(same)
  // Absent on a host without session statuses; the hook stays the same for the component's life.
  const statuses = (props.useSessionStatus ?? none)(same)
  useEffect(() => {
    props.activity.set({ sessions, ...(statuses === undefined ? {} : { statuses }) })
  }, [props.activity, sessions, statuses])
  return null
}
