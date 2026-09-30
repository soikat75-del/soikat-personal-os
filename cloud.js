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
    'soikat_1l_goal_entries_v4': '100k_goal',
    'soikat_200d_plan_v2': '200d_plan'
  };

  const state = {
    client: null,
    session: null,
    ready: false,
    booting: false,
    channel: null,
    pending: Object.create(null),
    lastCloudWrite: Object.create(null)
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
      state.pending[key]=false;
      localStorage.setItem(key,JSON.stringify(value));
      return true;
    }catch(e){return false;}
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
    if(signedIn)setStatus('Cloud synced','online');
    else setStatus('Local only','offline');
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

  async function pushCloud(key,app,payload){
    const user=state.session?.user;
    if(!user||!state.client)return false;
    if(!meaningful(payload))return false; // Never replace cloud data with empty local data.
    const stamp=new Date().toISOString();
    const {error}=await state.client.from(TABLE).upsert({
      user_id:user.id,
      app:app,
      data:payload,
      updated_at:stamp
    },{onConflict:'user_id,app'});
    if(!error)state.lastCloudWrite[app]=stable(payload);
    return !error;
  }

  async function syncApp(key,app){
    if(!state.session||!state.client)return;
    const local=readLocal(key);
    const result=await fetchCloud(key,app);
    if(result.error){console.warn('[Soikat Cloud]',app,result.error);return;}
    const cloud=result.row?.data;

    if(meaningful(cloud)){
      const merged=mergeData(local,cloud);
      writeLocal(key,merged);
      // If local had useful data too, merge it into cloud so first migration is non-destructive.
      if(meaningful(local) && stable(merged)!==stable(cloud)) await pushCloud(key,app,merged);
      state.lastCloudWrite[app]=stable(merged);
    }else if(meaningful(local)){
      await pushCloud(key,app,local);
    }
  }

  function refreshPageFromCloud(app){
    try{
      // 100K GOAL reads localStorage inside render(), so direct render is enough.
      if(app==='100k_goal' && typeof window.render==='function'){
        window.render();
        return;
      }
      // 200D PLAN keeps its working data object in memory; reload only when
      // a cloud change needs to enter that existing in-memory state.
      if(app==='200d_plan' && document.readyState==='complete'){
        window.location.reload();
        return;
      }
      if(typeof window.render==='function') window.render();
    }catch(e){}
  }

  async function syncAll(){
    if(!state.session||!state.client)return;
    state.ready=false;
    setStatus('Syncing…','syncing');
    for(const [key,app] of Object.entries(APPS)) await syncApp(key,app);
    state.ready=true;
    setStatus('Cloud synced','online');
    refreshAuthUI();
    // Let the existing page redraw from its now-synced localStorage without changing its code.
    window.dispatchEvent(new CustomEvent('soikat-cloud-synced'));
    // The original apps do not listen for this event, so refresh their visible state.
    if(basename()==='goal.html' || basename()==='study.html') refreshPageFromCloud(null);
  }

  function installStorageBridge(){
    const original=Storage.prototype.setItem;
    if(original.__soikatCloudWrapped)return;
    function wrapped(key,value){
      original.call(this,key,value);
      if(this!==window.localStorage)return;
      const app=APPS[key];
      if(!app||!state.session)return;
      state.pending[key]=true;
      if(!state.ready)return;
      let payload=null;
      try{payload=JSON.parse(value);}catch(e){return;}
      pushCloud(key,app,payload).catch(()=>{});
    }
    wrapped.__soikatCloudWrapped=true;
    Storage.prototype.setItem=wrapped;
  }

  function installRealtime(){
    if(!state.client||!state.session)return;
    if(state.channel)state.client.removeChannel(state.channel);
    const userId=state.session.user.id;
    state.channel=state.client.channel('soikat-cloud-'+userId)
      .on('postgres_changes',{
        event:'*',schema:'public',table:TABLE,
        filter:'user_id=eq.'+userId
      },payload=>{
        if(payload.eventType==='DELETE')return; // Never delete local data from a remote delete.
        const row=payload.new;
        if(!row||!row.app||!Object.prototype.hasOwnProperty.call(APPS,row.app))return;
        const key=Object.keys(APPS).find(k=>APPS[k]===row.app);
        if(!key||!meaningful(row.data))return;
        const incoming=stable(row.data);
        if(state.lastCloudWrite[row.app]===incoming)return;
        state.lastCloudWrite[row.app]=incoming;
        writeLocal(key,row.data);
        window.dispatchEvent(new CustomEvent('soikat-cloud-updated',{detail:{app:row.app,key}}));
        refreshPageFromCloud(row.app);
      })
      .subscribe();
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
        state.session=session;
        refreshAuthUI();
        if(session){
          setTimeout(async()=>{await syncAll();installRealtime();},0);
        }else{
          if(state.channel){state.client.removeChannel(state.channel);state.channel=null;}
          state.ready=false;
        }
      });
    }catch(err){
      console.error('[Soikat Cloud]',err);
      setStatus('Cloud unavailable','error');
      const msg=document.getElementById('soikatAuthMessage');
      if(msg)msg.textContent='Cloud connection could not be loaded. Local data still works.';
    }
  }

  window.SoikatCloud={
    version:'1.0.0',
    registerApp:function(storageKey,appId){
      if(storageKey&&appId)APPS[storageKey]=appId;
      if(state.session)syncApp(storageKey,appId).catch(()=>{});
    },
    getSession:function(){return state.session},
    getApps:function(){return {...APPS}},
    sync:function(){return syncAll()}
  };

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});
  else boot();
})();
