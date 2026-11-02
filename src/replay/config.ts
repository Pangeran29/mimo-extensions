/** Replay controls exist only in a separately named research extension build. */
declare const LISTEN_REPLAY_LAB: boolean;
export const REPLAY_LAB =
  typeof LISTEN_REPLAY_LAB !== 'undefined' && LISTEN_REPLAY_LAB === true;

