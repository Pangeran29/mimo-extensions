import type { Session, Phase } from '../types';
import type { EndMeetingJob } from './types';

export function canReadEndJob(
  sessionId: string,
  activeSession: string | undefined,
  phase: Phase,
  selectedSession?: string,
): boolean {
  if (['starting', 'recording', 'stopping'].includes(phase)) return false;
  if (selectedSession) return sessionId === selectedSession;
  return !activeSession || sessionId === activeSession;
}

export function unsavedEndJobs(jobs: EndMeetingJob[], currentSession?: string): EndMeetingJob[] {
  return jobs.filter((job) => job.sessionId !== currentSession &&
    (Object.values(job.files).some((file) => file.phase !== 'saved') || !!job.cleanupError));
}

export function isUnclaimedBundle(session: Session, jobIds: ReadonlySet<string>): boolean {
  return session.exportKind === 'meeting-bundle-v1' && !jobIds.has(session.id);
}
