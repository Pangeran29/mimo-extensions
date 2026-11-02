declare const LISTEN_BUILD_ID: string;
export const BUILD_ID = typeof LISTEN_BUILD_ID === 'undefined' ? 'development' : LISTEN_BUILD_ID;
