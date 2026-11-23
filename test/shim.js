window.__xqLog=[]; window.__xqStore={xq:window.__xqSeed||{}};
window.chrome = window.chrome||{}; 
chrome.runtime = { sendMessage(msg, cb){ __xqLog.push(msg); let r={};
  if(msg.type==='isSyncTab') r={syncTab:!!window.__xqSyncTab};
  if(msg.type==='scheduledList'){ __xqStore.xq={scheduled:msg.times,syncedAt:Date.now()}; r={ok:true}; }
  if(msg.type==='sync') r={ok:true,state:__xqStore.xq};
  if(msg.type==='queued') r={ok:true};
  setTimeout(()=>cb(r),0);} };
chrome.storage = { local:{ get(k,cb){cb({xq:__xqStore.xq})}, set(){} }, onChanged:{addListener(){}} };
