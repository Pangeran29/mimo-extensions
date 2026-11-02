import 'fake-indexeddb/auto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as db from '../src/db';
import type { Session } from '../src/types';
let listener: (delta: unknown) => void;
let message: (msg: unknown, sender: unknown, respond: (r: any) => void) => void;
let items: any[];
let offscreen: boolean;
let send: ReturnType<typeof vi.fn>;
const session: Session = {
  id:'save-test',createdAt:1,sourceTitle:'Test',tabId:1,filename:'test.webm',
  status:'ready',bytes:3,chunks:1,durationMs:1000,partial:false,
  downloadId:42,sources:['mixed','microphone','tab'],downloadingSource:'mixed',
};
beforeEach(async () => {
  items=[];offscreen=false;
  send=vi.fn(async () => ({ok:true,value:{phase:'idle',retained:[]}}));
  vi.stubGlobal('chrome', {
    runtime:{id:'test',ContextType:{OFFSCREEN_DOCUMENT:'offscreen'},
      getContexts:vi.fn(async()=>offscreen?[{}]:[]),sendMessage:send,
      onMessage:{addListener:(fn:typeof message)=>{message=fn;}},
      onInstalled:{addListener:vi.fn()},onStartup:{addListener:vi.fn()}},
    downloads:{search:vi.fn(async()=>items),onChanged:{addListener:(fn:typeof listener)=>{listener=fn;}},download:vi.fn()},
    offscreen:{createDocument:vi.fn(async()=>{offscreen=true;}),closeDocument:vi.fn(async()=>{offscreen=false;})},
    action:{setBadgeText:vi.fn(),setBadgeBackgroundColor:vi.fn()},
  });
  vi.resetModules();
  await import('../src/worker');
  await db.putSession(session);
});
afterEach(async()=>{
  for(const row of await db.sessions()) await db.deleteSession(row.id);
  vi.unstubAllGlobals();
});
const status = () => new Promise<any>(resolve=>message({target:'worker',type:'STATUS'},{id:'test'},resolve));
it('handles cancellation when the state delta omits the error',async()=>{
  items=[{id:42,state:'interrupted',error:'USER_CANCELED'}];
  listener({id:42,state:{current:'interrupted'}});
  await vi.waitFor(async()=>expect(await db.getSession(session.id)).toBeUndefined());
  expect((await status()).value).toEqual({phase:'idle',retained:[]});
});
it('recovers a completed cancellation after a worker restart',async()=>{
  items=[{id:42,state:'interrupted',error:'USER_CANCELED'}];
  expect((await status()).value.retained).toEqual([]);
  expect(await db.getSession(session.id)).toBeUndefined();
});
it('retains audio on a real filesystem failure',async()=>{
  items=[{id:42,state:'interrupted',error:'FILE_ACCESS_DENIED'}];
  await status();
  const row=await db.getSession(session.id);
  expect(row?.downloadId).toBeUndefined();expect(row?.bytes).toBe(3);
  expect(row?.error).toContain('Retry Save');
});
it('passes cancellation to the owning recorder for URL cleanup',async()=>{
  offscreen=true;items=[{id:42,state:'interrupted',error:'USER_CANCELED'}];
  send.mockImplementation(async (msg:any)=>{
    if(msg.type==='DOWNLOAD_DONE') await db.deleteSession(msg.id);
    return {ok:true,value:{phase:'idle',retained:[]}};
  });
  await status();
  expect(send).toHaveBeenCalledWith(expect.objectContaining({type:'DOWNLOAD_DONE',id:session.id,cancelled:true,success:false}));
  expect(chrome.offscreen.closeDocument).toHaveBeenCalledTimes(1);
});
it('handles file picker cancellation before Chrome returns a download ID',async()=>{
  await db.updateSession(session.id,{downloadId:undefined});
  offscreen=true;
  let phase='saving';
  send.mockImplementation(async (msg:any)=>{
    if(msg.type==='EXPORT') return {ok:true,value:{url:'blob:test',session}};
    if(msg.type==='DOWNLOAD_DONE') {await db.deleteSession(msg.id);phase='idle';}
    return {ok:true,value:{phase,session:phase==='saving'?session:undefined,retained:[]}};
  });
  vi.mocked(chrome.downloads.download).mockRejectedValue(Error('Download canceled'));
  const response=await new Promise<any>(resolve=>message({target:'worker',type:'RETRY',id:session.id},{id:'test'},resolve));
  expect(response.ok).toBe(true);expect(response.value.phase).toBe('idle');
  expect(await db.getSession(session.id)).toBeUndefined();
  expect(chrome.offscreen.closeDocument).toHaveBeenCalledTimes(1);
});
