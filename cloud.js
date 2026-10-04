/*
  SOIKAT PERSONAL OS — Shared Cloud Layer
  ---------------------------------------
  One shared Supabase layer for every Personal OS page.
  Existing localStorage remains the local source/cache; Supabase is the
  cross-device cloud source once an account is signed in.
*/
(function(){
  'use strict';

  const SUPABASE_URL = 'https://lgdowkspwlhvnxmbedai.supabase.co';
  const SUPABASE_KEY = 'sb_publishable_O9IgHEmFubo4Vjfvq64xnA_BFD_2f3d';
  const TABLE = 'soikat_app_data';

  // Add future apps here. Their existing localStorage keys do not need to change.
  const APPS = {
    'soikat_1l_goal_entries_v4': 'soikat_100k_goal',
    'soikat_200d_plan_v2': 'soikat_200d_plan'
  };

  // One-time cleanup for the earlier 100K cloud app id. The old row is
  // merged into the canonical soikat_100k_goal row before it is removed.
  const LEGACY_APPS = {
    'soikat_100k_goal': ['100k_goal']
  };

  const state = {
    client: null,
    session: null,
    ready: false,
    booting: false,
    channel: null,
    realtimeGeneration: 0,
    reconnectTimer: null,
    realtimeHealthTimer: null,
    pending: Object.create(null),
    lastCloudWrite: Object.create(null),
    lastObservedLocal: Object.create(null),
    saveTimers: Object.create(null),
    localWatcher: null,
    suppressQueue: Object.create(null),
    syncHealthy: true
  };

  function basename(){
    const p = location.pathname.split('/').pop() || 'index.html';
    return p.toLowerCase();
  }

  function isIndex(){
    const b = basename();
    return b === '' || b === 'index.html' || b === 'index.htm';
  }

  function meaningful(value){
    if(value === null || value === undefined) return false;
    if(typeof value !== 'object') return true;
    if(Array.isArray(value)) return value.length > 0;
    return Object.keys(value).length > 0;
  }

  function clone(v){
    try{return JSON.parse(JSON.stringify(v));}catch(e){return v;}
  }

  // Cloud wins on direct conflicts; local-only records are preserved.
  // Arrays are unioned by their JSON representation, which avoids losing
  // future TODO/notes style list items during first migration.
  function mergeData(local, cloud){
    if(!meaningful(local)) return clone(cloud);
    if(!meaningful(cloud)) return clone(local);
    if(Array.isArray(local) && Array.isArray(cloud)){
      const out = cloud.map(clone);
      const seen = new Set(out.map(v=>stable(v)));
      local.forEach(v=>{
        const k=stable(v);
        if(!seen.has(k)){seen.add(k);out.push(clone(v));}
      });
      return out;
    }
    if(local && cloud && typeof local==='object' && typeof cloud==='object' &&
       !Array.isArray(local) && !Array.isArray(cloud)){
      const out={};
      const keys=new Set([...Object.keys(local),...Object.keys(cloud)]);
      keys.forEach(k=>{
        if(Object.prototype.hasOwnProperty.call(cloud,k) && Object.prototype.hasOwnProperty.call(local,k)){
          out[k]=mergeData(local[k],cloud[k]);
        }else if(Object.prototype.hasOwnProperty.call(cloud,k)) out[k]=clone(cloud[k]);
        else out[k]=clone(local[k]);
      });
      return out;
    }
    // For conflicting scalar values, the already-cloud value is authoritative.
    return clone(cloud);
  }

  function stable(v){
    try{return JSON.stringify(v, Object.keys(v||{}).sort());}catch(e){return String(v);}
  }

  function readLocal(key){
    try{
      const raw=localStorage.getItem(key);
      if(raw===null) return null;
      return JSON.parse(raw);
    }catch(e){return null;}
  }

  function writeLocal(key,value){
    try{
      state.suppressQueue[key]=true;
      state.pending[key]=false;
      localStorage.setItem(key,JSON.stringify(value));
      return true;
    }catch(e){
      state.suppressQueue[key]=false;
      return false;
    }
  }

  function setStatus(text,kind){
    const el=document.getElementById('soikatCloudStatus');
    if(!el) return;
    el.textContent=text;
    el.dataset.kind=kind||'';
  }

  function showAuthMessage(msg,error){
    const el=document.getElementById('soikatAuthMessage');
    if(!el) return;
    el.textContent=msg||'';
    el.dataset.error=error?'1':'0';
  }

  function ensureAuthUI(){
    if(!isIndex() || document.getElementById('soikatCloudAccount')) return;

    const style=document.createElement('style');
    style.id='soikat-cloud-style';
    style.textContent=`
      #soikatCloudAccount{position:fixed;top:18px;right:18px;z-index:99999;font-family:Arial,Helvetica,sans-serif}
      #soikatCloudBtn{border:1px solid #2a3747;background:#10161e;color:#dfe7f2;border-radius:9px;padding:9px 13px;font-size:12px;font-weight:700;cursor:pointer;box-shadow:0 8px 25px #0005}
      #soikatCloudBtn:hover{border-color:#52657c;background:#151d27}
      #soikatAuthModal{position:fixed;inset:0;background:#000a;display:none;align-items:center;justify-content:center;padding:18px;z-index:100000}
      #soikatAuthModal.open{display:flex}
      #soikatAuthBox{width:min(390px,100%);background:#10151c;border:1px solid #2a3747;border-radius:14px;padding:20px;color:#f5f7fb;box-shadow:0 25px 80px #0009}
      #soikatAuthBox h2{margin:0 0 5px;font-size:18px}
      #soikatAuthBox p{margin:0 0 16px;color:#7f8ea2;font-size:11px}
      #soikatAuthBox label{display:block;color:#8291a5;font-size:10px;margin:11px 0 6px;text-transform:uppercase;letter-spacing:.1em}
      #soikatAuthBox input{width:100%;box-sizing:border-box;background:#080d13;border:1px solid #293646;border-radius:8px;padding:11px;color:#fff;outline:none}
      #soikatAuthBox input:focus{border-color:#4d79a8}
      #soikatAuthActions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:14px}
      #soikatAuthActions button,#soikatLogoutBtn{border:1px solid #314257;background:#172334;color:#fff;border-radius:8px;padding:10px;font-weight:700;cursor:pointer}
      #soikatAuthActions button:first-child{background:#245f9d;border-color:#377fc4}
      #soikatLogoutBtn{width:100%;margin-top:8px;background:#171d25}
      #soikatAuthClose{float:right;border:0;background:transparent;color:#8493a7;font-size:20px;cursor:pointer;padding:0}
      #soikatAuthMessage{min-height:16px;margin-top:12px;color:#79dca8;font-size:11px;line-height:1.45}
      #soikatAuthMessage[data-error="1"]{color:#ff8790}
      #soikatCloudStatus{display:block;margin-top:8px;color:#6e7f94;font-size:10px}
      @media(max-width:700px){#soikatCloudAccount{top:10px;right:10px}#soikatCloudBtn{padding:8px 10px;font-size:11px}}
    `;
    document.head.appendChild(style);

    const wrap=document.createElement('div');
    wrap.id='soikatCloudAccount';
    wrap.innerHTML=`
      <button id="soikatCloudBtn" type="button">CLOUD</button>
      <span id="soikatCloudStatus">Offline</span>
      <div id="soikatAuthModal">
        <div id="soikatAuthBox">
          <button id="soikatAuthClose" type="button">×</button>
          <h2>SOIKAT CLOUD</h2>
          <p>One account for the whole Personal OS.</p>
          <div id="soikatSignedOut">
            <label>Email</label>
            <input id="soikatAuthEmail" type="email" autocomplete="email" placeholder="you@example.com">
            <label>Password</label>
            <input id="soikatAuthPassword" type="password" autocomplete="current-password" placeholder="Password">
            <div id="soikatAuthActions">
              <button id="soikatLoginBtn" type="button">LOGIN</button>
              <button id="soikatSignupBtn" type="button">SIGN UP</button>
            </div>
          </div>
          <div id="soikatSignedIn" style="display:none">
            <div id="soikatAuthEmailView" style="font-size:12px;color:#b9c7d8;word-break:break-all"></div>
            <button id="soikatLogoutBtn" type="button">LOGOUT</button>
          </div>
          <div id="soikatAuthMessage"></div>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    const modal=document.getElementById('soikatAuthModal');
    document.getElementById('soikatCloudBtn').onclick=()=>{
      modal.classList.add('open');
      refreshAuthUI();
    };
    document.getElementById('soikatAuthClose').onclick=()=>modal.classList.remove('open');
    modal.addEventListener('click',e=>{if(e.target===modal)modal.classList.remove('open')});
    document.getElementById('soikatLoginBtn').onclick=login;
    document.getElementById('soikatSignupBtn').onclick=signup;
    document.getElementById('soikatLogoutBtn').onclick=logout;
  }

  function refreshAuthUI(){
    const signedIn=!!state.session;
    const out=document.getElementById('soikatSignedOut');
    const inside=document.getElementById('soikatSignedIn');
    const email=document.getElementById('soikatAuthEmailView');
    const btn=document.getElementById('soikatCloudBtn');
    if(out)out.style.display=signedIn?'none':'block';
    if(inside)inside.style.display=signedIn?'block':'none';
    if(email)email.textContent=state.session?.user?.email||'';
    if(btn)btn.textContent=signedIn?'CLOUD · ON':'CLOUD';
    if(!signedIn)setStatus('Local only','offline');
    else if(state.ready && state.syncHealthy && !state.reconnectTimer){
      const hasError=Object.keys(state.pending).some(k=>state.pending[k]);
      if(!hasError) setStatus('Cloud synced','online');
    }
  }

  function redirectUrl(){
    const u=new URL(location.href);
    u.hash='';
    u.search='';
    return u.href;
  }

  async function login(){
    if(!state.client)return;
    const email=document.getElementById('soikatAuthEmail')?.value.trim();
    const password=document.getElementById('soikatAuthPassword')?.value;
    if(!email||!password){showAuthMessage('Email and password are required.',true);return;}
    showAuthMessage('Signing in…');
    const {error}=await state.client.auth.signInWithPassword({email,password});
    if(error){showAuthMessage(error.message,true);return;}
    showAuthMessage('Signed in. Syncing your data…');
  }

  async function signup(){
    if(!state.client)return;
    const email=document.getElementById('soikatAuthEmail')?.value.trim();
    const password=document.getElementById('soikatAuthPassword')?.value;
    if(!email||!password){showAuthMessage('Email and password are required.',true);return;}
    if(password.length<6){showAuthMessage('Password must be at least 6 characters.',true);return;}
    showAuthMessage('Creating account…');
    const {data,error}=await state.client.auth.signUp({
      email,password,
      options:{emailRedirectTo:redirectUrl()}
    });
    if(error){showAuthMessage(error.message,true);return;}
    if(data.session)showAuthMessage('Account created. Syncing…');
    else showAuthMessage('Account created. Check your email to confirm, then return here.');
  }

  async function logout(){
    if(!state.client)return;
    showAuthMessage('Signing out…');
    const {error}=await state.client.auth.signOut();
    if(error){showAuthMessage(error.message,true);return;}
    showAuthMessage('Signed out. Your local data remains on this device.');
  }

  function injectScript(src){
    return new Promise((resolve,reject)=>{
      if(window.supabase)return resolve();
      const s=document.createElement('script');
      s.src=src;s.async=true;
      s.onload=resolve;s.onerror=()=>reject(new Error('Could not load Supabase client.'));
      document.head.appendChild(s);
    });
  }

  async function fetchCloud(key,app){
    const user=state.session?.user;
    if(!user)return {row:null,error:null};
    return await state.client.from(TABLE).select('user_id,app,data,updated_at')
      .eq('user_id',user.id).eq('app',app).maybeSingle();
  }

  const META_PREFIX='soikat_cloud_meta_v3:';
  const OUTBOX_PREFIX='soikat_cloud_outbox_v3:';

  function metaKey(key){return META_PREFIX+key;}
  function outboxKey(key){return OUTBOX_PREFIX+key;}

  function readJsonKey(key,fallback=null){
    try{
      const raw=localStorage.getItem(key);
      return raw===null?fallback:JSON.parse(raw);
    }catch(e){return fallback;}
  }

  function writeJsonKey(key,value){
    try{localStorage.setItem(key,JSON.stringify(value));return true;}catch(e){return false;}
  }

  function readMeta(key){return readJsonKey(metaKey(key),{});}
  function saveMeta(key,meta){writeJsonKey(metaKey(key),meta||{});}
  function readOutbox(key){return readJsonKey(outboxKey(key),null);}
  function clearOutbox(key){try{localStorage.removeItem(outboxKey(key));}catch(e){}}

  function saveSafetyCopy(key,payload,reason){
    const stamp=new Date().toISOString().replace(/[:.]/g,'-');
    const safeKey=`soikat_cloud_safety:${key}:${stamp}`;
    writeJsonKey(safeKey,{savedAt:new Date().toISOString(),reason,payload:clone(payload)});
    console.warn('[Soikat Cloud] SAFETY COPY SAVED',safeKey,reason);
    return safeKey;
  }

  function markSynced(key,app,payload,remoteUpdatedAt){
    const hash=stable(payload===null||payload===undefined?{}:payload);
    const now=new Date().toISOString();
    saveMeta(key,{
      app,
      lastSyncedHash:hash,
      lastSyncedAt:remoteUpdatedAt||now,
      lastConfirmedAt:now
    });
    clearOutbox(key);
    state.lastCloudWrite[app]=hash;
    state.lastObservedLocal[key]=hash;
  }

  async function pushCloud(key,app,payload,opts={}){
    const user=state.session?.user;
    if(!user||!state.client)return false;
    if(payload===null || payload===undefined) payload={};

    const snapshot=clone(payload);
    const stamp=opts.updatedAt || new Date().toISOString();

    for(let attempt=1;attempt<=4;attempt++){
      try{
        // Do not blindly overwrite a newer cloud revision. This protects against
        // two devices saving at nearly the same time.
        const current=await state.client.from(TABLE)
          .select('data,updated_at')
          .eq('user_id',user.id)
          .eq('app',app)
          .maybeSingle();
        if(current.error){
          console.error('[Soikat Cloud] PREFLIGHT READ FAILED',app,current.error);
          if(attempt<4) await new Promise(r=>setTimeout(r,700*attempt));
          continue;
        }
        if(current.data?.updated_at && opts.baseUpdatedAt){
          const remoteAt=Date.parse(current.data.updated_at)||0;
          const baseAt=Date.parse(opts.baseUpdatedAt)||0;
          if(remoteAt>baseAt && stable(current.data.data??{})!==stable(snapshot)){
            saveSafetyCopy(key,snapshot,'newer cloud revision detected before write');
            console.warn('[Soikat Cloud] WRITE BLOCKED — newer cloud revision exists',app);
            return false;
          }
        }

        const result=await state.client.from(TABLE).upsert({
          user_id:user.id,
          app:app,
          data:snapshot,
          updated_at:stamp
        },{onConflict:'user_id,app'});

        if(result.error){
          console.error(`[Soikat Cloud] WRITE FAILED ${app} attempt ${attempt}/4`,result.error);
          if(attempt<4) await new Promise(r=>setTimeout(r,700*attempt));
          continue;
        }

        const verify=await state.client.from(TABLE)
          .select('data,updated_at')
          .eq('user_id',user.id)
          .eq('app',app)
          .maybeSingle();

        if(verify.error){
          console.error(`[Soikat Cloud] VERIFY FAILED ${app} attempt ${attempt}/4`,verify.error);
          if(attempt<4) await new Promise(r=>setTimeout(r,700*attempt));
          continue;
        }

        const remote=verify.data?.data ?? {};
        if(stable(remote)!==stable(snapshot)){
          console.error('[Soikat Cloud] VERIFY MISMATCH',{app,sent:snapshot,remote});
          if(attempt<4) await new Promise(r=>setTimeout(r,700*attempt));
          continue;
        }

        markSynced(key,app,snapshot,verify.data?.updated_at||stamp);
        console.log('[Soikat Cloud] WRITE VERIFIED',app);
        return true;
      }catch(err){
        console.error(`[Soikat Cloud] WRITE EXCEPTION ${app} attempt ${attempt}/4`,err);
        if(attempt<4) await new Promise(r=>setTimeout(r,700*attempt));
      }
    }

    setStatus(`CLOUD SYNC ERROR · ${app}`,'error');
    return false;
  }

  async function flushOutbox(key,app){
    if(!state.session||!state.client)return false;
    const box=readOutbox(key);
    if(!box || !Object.prototype.hasOwnProperty.call(box,'payload'))return false;

    const local=readLocal(key);
    const localHash=stable(local===null?{}:local);
    // Never upload an obsolete queued snapshot after the user has changed data again.
    if(box.hash!==localHash){
      const fresh={payload:local===null?{}:clone(local),hash:localHash,updatedAt:new Date().toISOString()};
      writeJsonKey(outboxKey(key),fresh);
      return await flushOutbox(key,app);
    }

    const meta=readMeta(key);
    const ok=await pushCloud(key,app,box.payload,{updatedAt:box.updatedAt,baseUpdatedAt:meta.lastSyncedAt||null});
    if(!ok) setStatus('CLOUD SYNC ERROR · RETRYING','error');
    return ok;
  }

  async function migrateLegacyRows(app,canonicalData){
    const legacyNames=LEGACY_APPS[app]||[];
    if(!legacyNames.length || !state.session) return canonicalData;

    let merged=clone(canonicalData);
    for(const legacyApp of legacyNames){
      const result=await state.client.from(TABLE)
        .select('user_id,app,data,updated_at')
        .eq('user_id',state.session.user.id)
        .eq('app',legacyApp)
        .maybeSingle();

      if(result.error){
        console.warn('[Soikat Cloud] legacy lookup failed',legacyApp,result.error);
        continue;
      }

      if(!result.data) continue;
      const legacyData=result.data.data;
      if(meaningful(legacyData)){
        merged=mergeData(legacyData,merged); // canonical values win conflicts
      }

      // Remove the legacy row only after the canonical row has been safely
      // written below by the caller. Deletion itself is intentionally done
      // there, after successful upsert.
    }
    return merged;
  }

  async function deleteLegacyRows(app){
    const legacyNames=LEGACY_APPS[app]||[];
    if(!legacyNames.length || !state.session) return;
    for(const legacyApp of legacyNames){
      const {error}=await state.client.from(TABLE)
        .delete()
        .eq('user_id',state.session.user.id)
        .eq('app',legacyApp);
      if(error) console.warn('[Soikat Cloud] legacy delete failed',legacyApp,error);
    }
  }

  async function syncApp(key,app){
    if(!state.session||!state.client)return;

    const local=readLocal(key);
    const localState=local===null?{}:local;
    const localHash=stable(localState);
    const meta=readMeta(key);
    const outbox=readOutbox(key);
    const result=await fetchCloud(key,app);

    if(result.error){
      console.error('[Soikat Cloud] READ FAILED',app,result.error);
      // Keep local data and preserve a pending outbox. Never overwrite local on a read error.
      if(local!==null && !outbox){
        writeJsonKey(outboxKey(key),{payload:clone(localState),hash:localHash,updatedAt:new Date().toISOString()});
      }
      setStatus('CLOUD READ ERROR · LOCAL SAFE','error');
      return false;
    }

    let cloud=result.row ? clone(result.row.data || {}) : null;

    if(app==='soikat_100k_goal') cloud=await migrateLegacyRows(app,cloud);

    // REMOTE-ONLY UPDATE: if this device has no unsynced local change and
    // its local state is exactly the last cloud-synced baseline, the cloud
    // version is authoritative. Accept it instead of treating it as a conflict.
    if(result.row && !outbox && meta.lastSyncedHash && localHash===meta.lastSyncedHash){
      const cloudHash=stable(cloud||{});
      if(cloudHash!==localHash){
        writeLocal(key,cloud||{});
        markSynced(key,app,cloud||{},result.row.updated_at);
        console.log('[Soikat Cloud] REMOTE UPDATE APPLIED',app);
        refreshPageFromCloud(app);
      }else{
        markSynced(key,app,cloud||{},result.row.updated_at);
      }
      return true;
    }

    // A queued local change is authoritative for this device until it is either
    // confirmed in the cloud or superseded by a newer remote change. Never erase it silently.
    if(outbox || (meta.lastSyncedHash && localHash!==meta.lastSyncedHash)){
      if(!result.row){
        const ok=await pushCloud(key,app,localState,{updatedAt:outbox?.updatedAt||new Date().toISOString()});
        if(ok && app==='soikat_100k_goal') await deleteLegacyRows(app);
        return ok;
      }

      const cloudHash=stable(cloud||{});
      if(cloudHash===localHash){
        writeLocal(key,cloud||{});
        markSynced(key,app,cloud||{},result.row.updated_at);
        return true;
      }

      const lastSyncedAt=meta.lastSyncedAt?Date.parse(meta.lastSyncedAt):0;
      const remoteAt=result.row.updated_at?Date.parse(result.row.updated_at):0;
      const localAt=outbox?.updatedAt?Date.parse(outbox.updatedAt):Date.now();

      if(remoteAt && lastSyncedAt && remoteAt>lastSyncedAt && remoteAt>=localAt){
        // Another device changed the cloud after this device's last confirmed sync.
        // Preserve the local unsynced version before accepting the newer remote state.
        saveSafetyCopy(key,localState,'remote changed while this device had unsynced local changes');
        writeLocal(key,cloud||{});
        markSynced(key,app,cloud||{},result.row.updated_at);
        console.warn('[Soikat Cloud] REMOTE NEWER — LOCAL SAFETY COPY KEPT',app);
        return true;
      }

      // Local change is newer (or timestamps are unavailable): upload it and verify.
      const ok=await pushCloud(key,app,localState,{updatedAt:outbox?.updatedAt||new Date().toISOString()});
      if(ok && app==='soikat_100k_goal') await deleteLegacyRows(app);
      return ok;
    }

    // First run with no sync history.
    if(result.row){
      // If local already exactly matches cloud, simply establish the baseline.
      if(localHash===stable(cloud||{})){
        writeLocal(key,cloud||{});
        markSynced(key,app,cloud||{},result.row.updated_at);
        return true;
      }

      // No baseline exists and both sides contain different data. Do NOT
      // silently choose one: preserve the local copy and surface a conflict.
      // A fresh/empty device can safely restore from cloud.
      if(local!==null && meaningful(localState)){
        saveSafetyCopy(key,localState,'first sync conflict: local and cloud both contain data');
        saveSafetyCopy(key,cloud||{},'first sync conflict: cloud version preserved');
        setStatus(`SYNC CONFLICT · ${app} · LOCAL SAFE`,'error');
        console.warn('[Soikat Cloud] FIRST SYNC CONFLICT — NO OVERWRITE',app);
        return false;
      }
      writeLocal(key,cloud||{});
      markSynced(key,app,cloud||{},result.row.updated_at);
      return true;
    }

    // No cloud row: current local state becomes the initial cloud state.
    const initial=local===null?{}:localState;
    const ok=await pushCloud(key,app,initial,{updatedAt:new Date().toISOString()});
    if(!ok){
      writeJsonKey(outboxKey(key),{payload:clone(initial),hash:stable(initial),updatedAt:new Date().toISOString()});
      setStatus('CLOUD WRITE ERROR · LOCAL SAFE','error');
      return false;
    }
    return true;
  }

  function refreshPageFromCloud(app){
    try{
      // 100K GOAL reads localStorage inside render(), so direct render is enough.
      if(app==='soikat_100k_goal' && typeof window.render==='function'){
        window.render();
        return;
      }
      // 200D keeps working state in memory; notify the page instead of reloading it.
      if(app==='soikat_200d_plan'){
        window.dispatchEvent(new CustomEvent('soikat-200d-cloud-updated'));
        return;
      }
      if(typeof window.render==='function') window.render();
    }catch(e){}
  }

  async function syncAll(){
    if(!state.session||!state.client)return;
    state.ready=false;
    state.syncHealthy=true;
    setStatus('Syncing…','syncing');

    let allOk=true;
    for(const [key,app] of Object.entries(APPS)){
      const ok=await syncApp(key,app);
      if(ok===false)allOk=false;
      if(ok===false)state.syncHealthy=false;
    }

    state.ready=true;
    installLocalWatcher();

    for(const [key,app] of Object.entries(APPS)){
      state.lastObservedLocal[key]=stable(readLocal(key)===null?{}:readLocal(key));
      if(readOutbox(key)){
        // A failed write survives reload and is retried as soon as the session is ready.
        setTimeout(()=>flushOutbox(key,app),200);
      }
    }

    state.syncHealthy=allOk;
    setStatus(allOk?'Cloud synced':'CLOUD SYNC ERROR · LOCAL SAFE',allOk?'online':'error');
    refreshAuthUI();
    window.dispatchEvent(new CustomEvent('soikat-cloud-synced'));
  }

  function queueLocalCloudSave(key,app,payload){
    const snapshot=clone(payload===null||payload===undefined?{}:payload);
    const hash=stable(snapshot);
    const existing=readOutbox(key);

    // Store the outbox BEFORE waiting for auth/realtime. This is the key safety layer.
    const updatedAt=new Date().toISOString();
    writeJsonKey(outboxKey(key),{payload:snapshot,hash,updatedAt});
    state.lastObservedLocal[key]=hash;

    clearTimeout(state.saveTimers[key]);
    state.saveTimers[key]=setTimeout(async()=>{
      state.saveTimers[key]=null;
      if(!state.session||!state.client||!state.ready){
        setStatus('CLOUD WAITING · LOCAL SAFE','syncing');
        return;
      }
      await flushOutbox(key,app);
    },350);
  }

  function installStorageBridge(){
    if(Storage.prototype.__soikatCloudWrappedV30)return;

    const originalSet=Storage.prototype.setItem;
    const originalRemove=Storage.prototype.removeItem;

    function wrappedSet(key,value){
      originalSet.call(this,key,value);
      if(this!==window.localStorage)return;
      const app=APPS[key];
      if(!app)return;
      if(state.suppressQueue[key]){state.suppressQueue[key]=false;return;}
      let payload;
      try{payload=JSON.parse(value);}catch(e){
        console.error('[Soikat Cloud] Invalid JSON for',key,e);
        return;
      }
      queueLocalCloudSave(key,app,payload);
    }

    function wrappedRemove(key){
      originalRemove.call(this,key);
      if(this!==window.localStorage)return;
      const app=APPS[key];
      if(!app)return;
      if(state.suppressQueue[key]){state.suppressQueue[key]=false;return;}
      queueLocalCloudSave(key,app,{});
    }

    Storage.prototype.setItem=wrappedSet;
    Storage.prototype.removeItem=wrappedRemove;
    Storage.prototype.__soikatCloudWrappedV30=true;
  }

  function installLocalWatcher(){
    if(state.localWatcher)return;
    state.localWatcher=setInterval(()=>{
      for(const [key,app] of Object.entries(APPS)){
        const local=readLocal(key);
        const hash=stable(local===null?{}:local);
        if(state.lastObservedLocal[key]===undefined){
          state.lastObservedLocal[key]=hash;
          continue;
        }
        if(hash!==state.lastObservedLocal[key]){
          console.log('[Soikat Cloud] LOCAL CHANGE DETECTED',app);
          queueLocalCloudSave(key,app,local===null?{}:local);
        }
      }
    },1000);
  }

  function scheduleRealtimeReconnect(reason,delay=1500){
    if(!state.client||!state.session)return;
    if(state.reconnectTimer)return;

    console.warn('[Soikat Realtime] Reconnect scheduled:',reason);
    setStatus('Realtime reconnecting…','syncing');

    state.reconnectTimer=setTimeout(async()=>{
      state.reconnectTimer=null;
      if(!state.client||!state.session)return;
      try{
        await installRealtime(true);
        if(state.session && state.ready){
          // Reconcile cloud changes after reconnect. syncApp protects pending local changes.
          await syncAll();
        }
      }catch(e){
        console.error('[Soikat Realtime] reconnect failed',e);
        scheduleRealtimeReconnect('retry after failure',3000);
      }
    },delay);
  }

  async function installRealtime(isReconnect=false){
    if(!state.client||!state.session)return;

    const myGeneration=++state.realtimeGeneration;

    try{
      await state.client.realtime.setAuth(state.session.access_token);
      console.log('[Soikat Realtime] Auth token set');
    }catch(e){
      console.error('[Soikat Realtime] setAuth failed',e);
      scheduleRealtimeReconnect('setAuth failed',2000);
      return;
    }

    if(state.channel){
      try{ await state.client.removeChannel(state.channel); }catch(e){}
      state.channel=null;
    }

    const userId=state.session.user.id;
    const topic='soikat-cloud:'+userId;
    console.log('[Soikat Realtime] USER ID:',userId);
    console.log('[Soikat Realtime] TOPIC:',topic,isReconnect?'(reconnect)':'');

    const channel=state.client.channel(topic,{config:{private:true}});

    const handleBroadcast=(message)=>{
      console.log('[Soikat Realtime] BROADCAST EVENT',message);

      const p=message?.payload||{};
      let row=p.record || p.new_record || p.new || p.data?.record || p.payload?.record;
      if(typeof row==='string'){
        try{row=JSON.parse(row)}catch(e){}
      }
      if(!row && p.app && p.user_id) row=p;

      console.log('[Soikat Realtime] EVENT ROW',row);
      if(!row){
        console.warn('[Soikat Realtime] No row found in broadcast');
        return;
      }

      if(!row.app||!Object.values(APPS).includes(row.app)){
        console.warn('[Soikat Realtime] Unknown app in event:',row.app);
        return;
      }
      if(row.data===null || row.data===undefined) row.data={};

      const key=Object.keys(APPS).find(k=>APPS[k]===row.app);
      if(!key){
        console.warn('[Soikat Realtime] No localStorage key for app:',row.app);
        return;
      }

      const current=readLocal(key);
      const incoming=stable(row.data);
      const existing=stable(current);

      console.log('[Soikat Realtime] APPLY CHECK',{
        app:row.app,
        key,
        same:existing===incoming,
        current,
        incoming:row.data
      });

      if(existing===incoming){
        console.log('[Soikat Realtime] EVENT already in localStorage — refreshing page state');
        if(row.app==='soikat_200d_plan'){
          window.dispatchEvent(new CustomEvent('soikat-200d-cloud-updated'));
        }else if(row.app==='soikat_100k_goal'){
          if(typeof window.render==='function') window.render();
        }
        return;
      }

      state.lastCloudWrite[row.app]=incoming;

      try{
        writeLocal(key,row.data);
        console.log('[Soikat Realtime] LOCAL STORAGE UPDATED',key);
      }catch(e){
        console.error('[Soikat Realtime] Failed to write incoming cloud data',e);
        return;
      }

      window.dispatchEvent(new CustomEvent('soikat-cloud-updated',{
        detail:{app:row.app,key}
      }));

      if(row.app==='soikat_100k_goal'){
        console.log('[Soikat Realtime] NEW 100K CLOUD DATA APPLIED — RENDERING');
        if(typeof window.render==='function') window.render();
      }else if(row.app==='soikat_200d_plan'){
        console.log('[Soikat Realtime] NEW 200D CLOUD DATA APPLIED — REFRESH EVENT');
        window.dispatchEvent(new CustomEvent('soikat-200d-cloud-updated'));
      }else{
        refreshPageFromCloud(row.app);
      }
    };

    channel
      .on('broadcast',{event:'*'},handleBroadcast)
      .subscribe((status,err)=>{
        // Ignore callbacks from a channel that has already been replaced.
        if(myGeneration!==state.realtimeGeneration)return;

        console.log('[Soikat Realtime]',status,err||'');
        if(status==='SUBSCRIBED'){
          setStatus('Realtime on','online');
          console.log('[Soikat Realtime] CONNECTED');
        }else if(status==='CHANNEL_ERROR' || status==='TIMED_OUT' || status==='CLOSED'){
          setStatus('Realtime error','error');
          console.error('[Soikat Realtime] CONNECTION LOST',status,err||'');
          scheduleRealtimeReconnect(status,1500);
        }
      });

    state.channel=channel;

    // One lightweight health check prevents a silently dead channel from
    // staying in the UI as if realtime were still connected.
    if(!state.realtimeHealthTimer){
      state.realtimeHealthTimer=setInterval(()=>{
        if(!state.client||!state.session||!state.ready)return;
        const ch=state.channel;
        if(!ch)return;
        const st=ch.state;
        if(st && st!=='joined' && !state.reconnectTimer){
          console.warn('[Soikat Realtime] HEALTH CHECK: channel state =',st);
          scheduleRealtimeReconnect('health check: '+st,1000);
        }
      },30000);
    }
  }

  async function boot(){
    if(state.booting)return;
    state.booting=true;
    ensureAuthUI();
    installStorageBridge();
    try{
      await injectScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2');
      state.client=window.supabase.createClient(SUPABASE_URL,SUPABASE_KEY,{
        auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}
      });

      const {data}=await state.client.auth.getSession();
      state.session=data.session;
      refreshAuthUI();
      if(state.session){
        await syncAll();
        installRealtime();
      }

      state.client.auth.onAuthStateChange((_event,session)=>{
        console.log('[Soikat Auth] EVENT:',_event);
        state.session=session;
        refreshAuthUI();
        if(session){
          // A refreshed access token must also be applied to the Realtime
          // connection. Rebuild the channel so an expired JWT cannot leave
          // the page stuck at "Realtime error".
          if(_event==='TOKEN_REFRESHED' || _event==='SIGNED_IN' || _event==='INITIAL_SESSION'){
            setTimeout(async()=>{
              try{
                await syncAll();
                await installRealtime(_event==='TOKEN_REFRESHED');
              }catch(e){
                console.error('[Soikat Auth] resync/realtime failed',e);
                scheduleRealtimeReconnect('auth event failure',2000);
              }
            },0);
          }
        }else{
          state.realtimeGeneration++;
          if(state.reconnectTimer){clearTimeout(state.reconnectTimer);state.reconnectTimer=null;}
          if(state.channel){state.client.removeChannel(state.channel);state.channel=null;}
          state.ready=false;
          setStatus('Cloud signed out','offline');
        }
      });
    }catch(err){
      console.error('[Soikat Cloud]',err);
      setStatus('Cloud unavailable','error');
      const msg=document.getElementById('soikatAuthMessage');
      if(msg)msg.textContent='Cloud connection could not be loaded. Local data still works.';
    }
  }

  function publicQueueSave(storageKey,appId,payload){
    if(storageKey&&appId&&!APPS[storageKey])APPS[storageKey]=appId;
    if(storageKey&&appId)queueLocalCloudSave(storageKey,appId,payload===undefined?readLocal(storageKey):payload);
  }

  window.SoikatCloud={
    version:'3.0.0',
    registerApp:function(storageKey,appId){
      if(storageKey&&appId)APPS[storageKey]=appId;
      if(state.session)syncApp(storageKey,appId).catch(()=>{});
    },
    queueSave:publicQueueSave,
    getSession:function(){return state.session},
    getApps:function(){return {...APPS}},
    syncApp:function(storageKey,appId){
      if(!storageKey||!appId||!state.session||!state.client)return Promise.resolve(false);
      return syncApp(storageKey,appId);
    },
    sync:function(){return syncAll()}
  };

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});
  else boot();
})();
