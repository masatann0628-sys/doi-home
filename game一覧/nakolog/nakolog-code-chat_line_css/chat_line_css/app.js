(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const config = window.APP_CONFIG || {};
  const configured = !!(window.supabase && config.SUPABASE_URL && config.SUPABASE_URL.startsWith("https://") && !config.SUPABASE_URL.includes("YOUR_PROJECT") && config.SUPABASE_ANON_KEY && !config.SUPABASE_ANON_KEY.includes("YOUR_SUPABASE"));
  // 同じブラウザではタブ間・再読み込み後も同じ匿名ユーザーを復元する。
  // localStorage により Supabase セッションを共有し、毎回別 UUID が作られるのを防ぐ。
  const authStorageKey = "nakolog-auth-v3";
  const authStorage = window.localStorage;
  const sb = configured ? window.supabase.createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY, {
    auth: {
      storage: authStorage,
      storageKey: authStorageKey,
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false
    }
  }) : null;
  const registerScreen = $("#registerScreen"), appShell = $("#appShell"), registerForm = $("#registerForm");
  const registerName = $("#registerName"), registerButton = $("#registerButton"), registerStatus = $("#registerStatus");
  const connectionStatus = $("#connectionStatus"), headerTitle = $("#headerTitle");
  const aiMessages = $("#aiMessages"), aiForm = $("#aiChatForm"), aiInput = $("#aiMessageInput"), aiSendBtn = $("#aiSendBtn"), voiceStatus = $("#voiceStatus");
  const talkList = $("#talkList"), peopleResults = $("#peopleResults"), directPanel = $("#directChatPanel"), directMessages = $("#directMessages"), directStatus = $("#directStatus");
  const stampGrid = $("#stampGrid");
  const historyKey = "nakolog-ai-history-tab-v3";
  let currentUser = null, displayName = "", aiBusy = false, talkBusy = false, recognition = null, listening = false;
  let activeView = "homeView", activePeer = null, directHistory = [], realtimeChannel = null, requestChannel = null, searchBusy = false, globalChannel = null, globalBusy = false;
  let history = [];
  try { history = JSON.parse(localStorage.getItem(historyKey) || "[]"); if (!Array.isArray(history)) history = []; } catch { history = []; }
  const nowISO = () => new Date().toISOString();
  const timeNow = (value = new Date()) => new Date(value).toLocaleTimeString("ja-JP", {hour:"2-digit",minute:"2-digit"});
  const safe = (v) => String(v ?? "");
  function setStatus(el, text) { if (el) el.textContent = text || ""; }
  function persistLocal() { try { sessionStorage.setItem(historyKey, JSON.stringify(history.slice(-150))); } catch {} }
  function scrollBottom(el) { if (el) el.scrollTop = el.scrollHeight; }
  const IMAGE_PREFIX = "[[NAKOLOG_IMAGE]]";
  function imageDataFromContent(content) {
    const s=String(content||"");
    if(!s.startsWith(IMAGE_PREFIX)) return null;
    const data=s.slice(IMAGE_PREFIX.length);
    return /^data:image\/(png|jpeg|webp|gif);base64,/i.test(data)?data:null;
  }
  function renderMessageContent(container, content, className="chat-image") {
    const data=imageDataFromContent(content);
    if(data){const img=document.createElement("img");img.src=data;img.alt="送信された画像";img.className=className;img.loading="lazy";img.addEventListener("click",()=>{const w=window.open();if(w){w.document.write(`<img src="${data}" style="max-width:100%;height:auto">`);}});container.append(img);return true;}
    container.textContent=String(content||"");return false;
  }
  function applyProfileIcon(dataUrl) {
    if(!dataUrl)return;
    document.querySelectorAll(".hero-avatar,.header-avatar,.mini-avatar").forEach(img=>{img.src=dataUrl;});
    try{if(currentUser)localStorage.setItem("nakolog-profile-icon-"+currentUser.id,dataUrl);}catch(e){console.warn("アイコンを保存できません",e);}
  }
  function loadProfileIcon() {
    try{const value=currentUser&&localStorage.getItem("nakolog-profile-icon-"+currentUser.id);if(value)applyProfileIcon(value);}catch{}
  }
  function readCompressedImage(file) {
    return new Promise((resolve,reject)=>{
      if(!file||!file.type.startsWith("image/")){reject(new Error("画像ファイルを選んでください"));return;}
      const reader=new FileReader();
      reader.onerror=()=>reject(new Error("画像を読み込めませんでした"));
      reader.onload=()=>{
        const img=new Image();img.onerror=()=>reject(new Error("画像を開けませんでした"));
        img.onload=()=>{
          const scale=Math.min(1,1000/Math.max(img.width,img.height));
          const canvas=document.createElement("canvas");canvas.width=Math.max(1,Math.round(img.width*scale));canvas.height=Math.max(1,Math.round(img.height*scale));
          const ctx=canvas.getContext("2d");ctx.drawImage(img,0,0,canvas.width,canvas.height);
          resolve(canvas.toDataURL("image/jpeg",0.72));
        };
        img.src=reader.result;
      };reader.readAsDataURL(file);
    });
  }
  async function chooseAndSendImage(target,file){
    try{
      setStatus(target==="ai"?voiceStatus:target==="global"?$("#globalStatus"):directStatus,"画像を準備しています…");
      const dataUrl=await readCompressedImage(file);
      if(target==="ai") await sendAIImage(dataUrl);
      else if(target==="global") await sendGlobalMessage(IMAGE_PREFIX+dataUrl);
      else await sendDirectMessage(IMAGE_PREFIX+dataUrl);
    }catch(e){setStatus(target==="ai"?voiceStatus:target==="global"?$("#globalStatus"):directStatus,"画像を送れません："+(e.message||String(e)));}
  }
  document.querySelectorAll(".image-pick-btn").forEach(b=>b.addEventListener("click",()=>$("#"+b.dataset.imageTarget+"ImageInput").click()));
  ["ai","global","direct"].forEach(target=>$("#"+target+"ImageInput").addEventListener("change",async e=>{
    const file=e.target.files?.[0];if(file)await chooseAndSendImage(target,file);e.target.value="";
  }));
  $("#profileIconInput").addEventListener("change",async e=>{
    const file=e.target.files?.[0];if(!file)return;
    try{const data=await readCompressedImage(file);applyProfileIcon(data);setStatus($("#settingsStatus"),"ホームのアイコンを変更しました。");}
    catch(err){setStatus($("#settingsStatus"),"変更できません："+err.message);}
    e.target.value="";
  });
  function showApp() { registerScreen.classList.add("hidden"); appShell.classList.remove("hidden"); }
  function setView(view) {
    if (!document.getElementById(view)) return;
    activeView = view;
    document.querySelectorAll(".app-view").forEach(v => v.classList.toggle("active-view", v.id === view));
    document.querySelectorAll(".nav-item").forEach(b => {
      const active = b.dataset.view === view; b.classList.toggle("active", active);
      if (active) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
    });
    headerTitle.textContent = ({homeView:"ホーム",aiView:"AIチャット",talkView:"トーク",stampsView:"スタンプ"})[view] || "nakolog";
    if (view === "aiView") scrollBottom(aiMessages);
    if (view === "talkView" && activePeer) scrollBottom(directMessages);
    if (view === "talkView" && !activePeer) showTalkHome();
  }
  document.querySelectorAll(".nav-item").forEach(b => b.addEventListener("click", () => setView(b.dataset.view)));
  document.querySelectorAll("[data-go]").forEach(b => b.addEventListener("click", () => setView(b.dataset.go)));

  async function upsertProfile(name) {
    if (!sb || !currentUser) return;
    const { error } = await sb.from("profiles").upsert({id: currentUser.id, display_name: name, updated_at: nowISO()}, {onConflict:"id"});
    if (error) throw error;
  }
  async function enterApp(user, name) {
    currentUser = user;
    displayName = name || user?.user_metadata?.display_name || "nakologユーザー";
    $("#homeUserName").textContent = displayName;
    $("#settingsName").value = displayName;
    loadProfileIcon();
    showApp();
    if (sb && currentUser) {
      try {
        await upsertProfile(displayName);
        connectionStatus.textContent = "";
      } catch (e) {
        connectionStatus.textContent = "一部機能の設定が必要です";
        console.error("プロフィール保存エラー", e);
      }
      await loadRemoteAI();
      await loadTalkList();
      await loadRequests();
      await loadGlobalMessages();
      subscribeDirectMessages();
      subscribeDirectChatRequests();
      subscribeGlobalMessages();
    } else {
      connectionStatus.textContent = "オフラインモード";
      renderAIHistory();
    }
  }

  registerForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = registerName.value.trim();
    if (!name) { setStatus(registerStatus, "名前を入力してください。"); return; }
    if (!sb) { setStatus(registerStatus, "未設定です。config.jsのURLとキーを確認してください。"); return; }
    registerButton.disabled = true;
    setStatus(registerStatus, "登録しています…");
    try {
      const { data: sessionData, error: sessionError } = await sb.auth.getSession();
      if (sessionError) throw sessionError;
      let user = sessionData.session?.user;
      // セッションが既にある場合はそのユーザーの名前を上書きしない。
      // 名前未登録の既存セッションだけを利用し、それ以外は明示的に新規登録できるようにする。
      if (user && !user.user_metadata?.display_name) {
        const { data, error } = await sb.auth.updateUser({data:{display_name:name}});
        if (error) throw error;
        user = data.user;
      } else if (!user) {
        const { data, error } = await sb.auth.signInAnonymously({options:{data:{display_name:name}}});
        if (error) throw error;
        user = data.user;
      } else {
        // 既存セッションのユーザーIDを維持し、名前入力だけで別アカウントを作らない。
        user = sessionData.session.user;
        if (user.user_metadata?.display_name !== name) {
          throw new Error("このブラウザは「" + (user.user_metadata.display_name || "登録済みユーザー") + "」でログイン中です。別の名前で使う場合は、先にログアウトしてから登録してください。");
        }
      }
      if (!user) throw new Error("ユーザー情報を取得できませんでした。");
      await enterApp(user, name);
      setStatus(registerStatus, "");
    } catch (err) {
      setStatus(registerStatus, "登録できませんでした：" + (err.message || String(err)));
    } finally { registerButton.disabled = false; }
  });

  function addAIMessage(role, content, opts = {}) {
    const row = document.createElement("div"); row.className = role === "user" ? "line__right" : "line__left";
    if (opts.error) row.classList.add("bubble-error");
    if (role !== "user") {
      const fig = document.createElement("figure"), avatar = document.createElement("img"); avatar.src = "icon.png"; avatar.alt = "うさきち"; fig.append(avatar); row.append(fig);
      const wrap = document.createElement("div"); wrap.className = "line__left-text";
      const name = document.createElement("div"); name.className = "name"; name.textContent = opts.name || "うさきち AI";
      const bubble = document.createElement("div"); bubble.className = "text";
      renderMessageContent(bubble,content,"chat-image");
      wrap.append(name, bubble); row.append(wrap);
    } else {
      const bubble = document.createElement("div"); bubble.className = "text";
      renderMessageContent(bubble,content,"chat-image");
      const date = document.createElement("span"); date.className = "date"; date.textContent = "送信 " + timeNow(opts.created_at); row.append(bubble, date);
    }
    aiMessages.append(row); scrollBottom(aiMessages); return row;
  }
  function addAIStamp(number, role = "user", save = true, createdAt = nowISO()) {
    const row = document.createElement("div"); row.className = role === "user" ? "line__right" : "line__left stamp-row";
    if (role !== "user") { const fig=document.createElement("figure"), im=document.createElement("img"); im.src="icon.png"; im.alt="うさきち"; fig.append(im); row.append(fig); }
    const wrap=document.createElement("div");
wrap.className="stamp";
const img=document.createElement("img");
img.src=`https://masatann0628-sys.github.io/doi-home/stamp/${number}.png`;
img.alt=`スタンプ ${number}`;
img.loading="lazy";
wrap.append(img);
row.append(wrap);
    if (role === "user") { const date=document.createElement("span"); date.className="date"; date.textContent="送信 "+timeNow(createdAt); row.append(date); }
    aiMessages.append(row); scrollBottom(aiMessages);
    if (save) { history.push({role,stamp:number,created_at:createdAt}); persistLocal(); saveRemoteAI({role,content:`[スタンプ:${number}]`}); }
  }
  function renderAIHistory() {
    aiMessages.replaceChildren();
    if (!history.length) { addAIMessage("assistant", "こんにちは！ぼくはうさきちAIだよ🐰 なんでも話しかけてね！"); return; }
    history.slice(-150).forEach(m => m.stamp ? addAIStamp(m.stamp, m.role, false, m.created_at) : addAIMessage(m.role, m.content || "", {created_at:m.created_at}));
  }
  async function saveRemoteAI(m) {
    if (!sb || !currentUser) return;
    const { error } = await sb.from("chat_messages").insert({user_id:currentUser.id, role:m.role, content:m.content});
    if (error) console.warn("AI履歴の保存に失敗しました", error.message);
  }
  async function loadRemoteAI() {
    if (!sb || !currentUser) { renderAIHistory(); return; }
    const {data,error}=await sb.from("chat_messages").select("role,content,created_at").eq("user_id",currentUser.id).order("created_at",{ascending:true}).limit(150);
    if (error) { console.warn("AI履歴の読み込みに失敗しました", error.message); renderAIHistory(); return; }
    if (data) { history=data.map(m=>{ const match=/^\[スタンプ:(\d+)\]$/.exec(m.content||""); return match?{role:m.role,stamp:Number(match[1]),created_at:m.created_at}:{role:m.role,content:m.content,created_at:m.created_at}; }); persistLocal(); }
    renderAIHistory();
  }
  async function askAI() {
    const prompt = aiInput.value.trim(); if (!prompt || aiBusy) return;
    if (!sb || !currentUser) { setStatus(voiceStatus, "先にdatabaseへ名前登録してください。"); return; }
    const userItem = {role:"user",content:prompt,created_at:nowISO()}; history.push(userItem); persistLocal(); addAIMessage("user", prompt, userItem); saveRemoteAI(userItem);
    aiInput.value = ""; aiInput.style.height = "auto"; aiBusy = true; aiSendBtn.disabled = true; setStatus(voiceStatus, "うさきちが考えています…");
    const pending = addAIMessage("assistant", "考え中…");
    try {
      const recent = history.filter(m => m.content && ["user","assistant"].includes(m.role)).slice(-16).map(m=>{
        const image=imageDataFromContent(m.content);
        return image?{role:m.role,content:"この画像についての会話です。画像の内容を踏まえて返答してください。",imageDataUrl:image}:{role:m.role,content:m.content};
      });
      const {data,error}=await sb.functions.invoke(config.EDGE_FUNCTION_NAME || "gemini-chat", {body:{messages:recent}});
      if (error) {
        let detail=error.message || "AIとの通信に失敗しました";
        try { const ctx=error.context; if(ctx && typeof ctx.json==="function"){const payload=await ctx.json();if(payload?.error)detail += "："+payload.error;} } catch {}
        throw new Error(detail);
      }
      if(data?.error) throw new Error(data.error);
      const answer=data?.reply; if (!answer) throw new Error(data?.error || "AIから返事がありませんでした");
      pending.querySelector(".text").textContent=answer;
      const item={role:"assistant",content:answer,created_at:nowISO()}; history.push(item); persistLocal(); saveRemoteAI(item);
      if ($("#autoSpeak").checked) speak(answer); setStatus(voiceStatus, "");
    } catch (err) {
      pending.querySelector(".text").textContent="接続できませんでした："+(err.message || "不明なエラー"); pending.classList.add("bubble-error"); setStatus(voiceStatus, "databaseのEdge FunctionとGEMINI_API_KEYの設定を確認してください。");
    } finally { aiBusy=false; aiSendBtn.disabled=false; scrollBottom(aiMessages); aiInput.focus(); }
  }
  async function sendAIImage(dataUrl){
    if(!sb||!currentUser){setStatus(voiceStatus,"先に名前登録をしてください。");return;}
    if(aiBusy){setStatus(voiceStatus,"AIが返事を考えています。少し待ってください。");return;}
    const item={role:"user",content:IMAGE_PREFIX+dataUrl,created_at:nowISO(),imageDataUrl:dataUrl};
    history.push(item);persistLocal();addAIMessage("user",item.content,item);
    saveRemoteAI({role:"user",content:"[画像を送信しました]"});
    aiBusy=true;aiSendBtn.disabled=true;setStatus(voiceStatus,"画像を見て考えています…");
    const pending=addAIMessage("assistant","画像を見ているよ…");
    try{
      const recent=history.filter(m=>m.content&&["user","assistant"].includes(m.role)).slice(-16).map(m=>{
        const image=imageDataFromContent(m.content);
        return image?{role:m.role,content:"この画像を見て、内容を説明してください。",imageDataUrl:image}:{role:m.role,content:m.content};
      });
      const {data,error}=await sb.functions.invoke(config.EDGE_FUNCTION_NAME||"gemini-chat",{body:{messages:recent}});
      if(error){let detail=error.message||"AIとの通信に失敗しました";try{const ctx=error.context;if(ctx&&typeof ctx.json==="function"){const payload=await ctx.json();if(payload?.error)detail+="："+payload.error;}}catch{}throw new Error(detail);}
      if(data?.error)throw new Error(data.error);
      const answer=data?.reply;if(!answer)throw new Error(data?.error||"AIから返答がありませんでした");
      pending.querySelector(".text").textContent=answer;
      const reply={role:"assistant",content:answer,created_at:nowISO()};history.push(reply);persistLocal();saveRemoteAI(reply);
      if($("#autoSpeak").checked)speak(answer);setStatus(voiceStatus,"");
    }catch(e){pending.querySelector(".text").textContent="画像を読み取れませんでした："+(e.message||"不明なエラー");pending.classList.add("bubble-error");setStatus(voiceStatus,"Geminiの接続設定を確認してください。");}
    finally{aiBusy=false;aiSendBtn.disabled=false;scrollBottom(aiMessages);}
  }
  aiForm.addEventListener("submit", e => { e.preventDefault(); askAI(); });
  [aiInput, $("#directMessageInput"), $("#globalMessageInput")].forEach(input => input.addEventListener("input", () => { input.style.height="auto"; input.style.height=Math.min(input.scrollHeight,120)+"px"; }));

  function makeAvatar() { const im=document.createElement("img"); im.src="icon.png"; im.alt=""; im.className="mini-avatar"; return im; }
  function peerLabel(peer) { return peer?.display_name || "nakologユーザー"; }
  function isSelfProfile(peer) {
    // 名前は重複可能。本人判定はSupabase AuthのUUIDだけで行う。
    if (!peer || !currentUser) return true;
    return String(peer.id || "") === String(currentUser.id || "");
  }
  function renderPersonButton(peer, lastText = "名前をタップしてトーク") {
    const button=document.createElement("button"); button.type="button"; button.className="person-row";
    button.append(makeAvatar()); const wrap=document.createElement("span"); wrap.className="person-copy";
    const name=document.createElement("strong"); name.textContent=peerLabel(peer);
    const last=document.createElement("small"); last.textContent=lastText;
    wrap.append(name,last); const arrow=document.createElement("b"); arrow.textContent="›"; button.append(wrap,arrow);
    button.addEventListener("click",()=>startOrOpenRequest(peer)); return button;
  }
  async function startOrOpenRequest(peer) {
    if (!sb || !currentUser || !peer) return;
    if (isSelfProfile(peer)) { setStatus(directStatus,"自分自身には個人トーク申請を送れません。"); return; }
    try {
      const {data:rows,error}=await sb.from("direct_chat_requests").select("*")
        .or(`and(requester_id.eq.${currentUser.id},recipient_id.eq.${peer.id}),and(requester_id.eq.${peer.id},recipient_id.eq.${currentUser.id})`)
        .in("status",["pending","accepted"]).order("created_at",{ascending:false}).limit(1);
      if (error) throw error;
      const req=rows?.[0];
      if (req?.status==="accepted" && req.requester_approved && req.recipient_approved) {
        await openDirectChat(peer); return;
      }
      if (req) {
        await loadRequests();
        setStatus(directStatus, req.requester_id===currentUser.id ? "申請済みです。相手の承認を待っています。" : "申請が届いています。「トーク申請」から承認してください。");
        $("#peoplePanel").classList.remove("hidden"); $("#globalChatPanel").classList.add("hidden");
        $("#talkListPanel").classList.add("hidden"); setTalkTab("people");
        return;
      }
      const {error:callError}=await sb.rpc("request_direct_chat",{target_user:peer.id});
      if (callError) throw callError;
      await loadRequests();
      setTalkTab("people");
      setStatus(directStatus, "トーク申請を送りました。相手とあなたの両方が承認すると開始できます。");
    } catch(e) {
      setStatus(directStatus, "申請できませんでした："+e.message+"（schema.sqlのSQLを実行してください）");
    }
  }
  function showTalkHome() {
    activePeer=null;
    $("#talkHomePanel").classList.remove("hidden");
    $("#globalChatPanel").classList.add("hidden");
    $("#peoplePanel").classList.add("hidden");
    directPanel.classList.add("hidden");
  }
  function setTalkTab(which) {
    $("#talkHomePanel").classList.add("hidden");
    const global=which==="global";
    $("#globalChatPanel").classList.toggle("hidden",!global);
    $("#peoplePanel").classList.toggle("hidden",global);
    directPanel.classList.add("hidden");
    if(global) { scrollBottom($("#globalMessages")); }
    else { loadRequests(); loadTalkList(); }
  }
  $("#globalTabBtn").addEventListener("click",()=>setTalkTab("global"));
  $("#peopleTabBtn").addEventListener("click",()=>setTalkTab("people"));
  $("#backGlobalBtn").addEventListener("click",showTalkHome);
  $("#backPeopleBtn").addEventListener("click",showTalkHome);
  async function loadRequests() {
    if(!sb||!currentUser) return;
    const el=$("#requestList");
    const {data,error}=await sb.from("direct_chat_requests").select("*")
      .or(`requester_id.eq.${currentUser.id},recipient_id.eq.${currentUser.id}`)
      .in("status",["pending","accepted"]).order("created_at",{ascending:false}).limit(60);
    if(error){el.replaceChildren();const n=document.createElement("div");n.className="error-note";n.textContent="申請一覧を読み込めません："+error.message;el.append(n);return;}
    el.replaceChildren();
    // 同じ2人の申請が複数作られていた場合、一覧では1件だけ表示する
    const pairKey = r => [r.requester_id, r.recipient_id].sort().join(":");
    const sortedRequests=(data||[]).slice().sort((a,b) => {
      const accepted = Number(b.status === "accepted") - Number(a.status === "accepted");
      return accepted || new Date(b.updated_at || b.created_at) - new Date(a.updated_at || a.created_at);
    });
    const requestMap=new Map();
    sortedRequests.forEach(r=>{const key=pairKey(r);if(!requestMap.has(key))requestMap.set(key,r);});
    const uniqueRequests=[...requestMap.values()];
    if(!uniqueRequests.length){const n=document.createElement("div");n.className="empty-note";n.textContent="申請はありません。ユーザーを検索して申請できます。";el.append(n);return;}
    const ids=[...new Set(uniqueRequests.map(r=>r.requester_id===currentUser.id?r.recipient_id:r.requester_id).filter(id=>id!==currentUser.id))];
    const {data:profiles}=await sb.from("profiles").select("id,display_name").in("id",ids);
    const names=new Map((profiles||[]).map(p=>[p.id,p]));
    for(const r of uniqueRequests){
      const otherIdForDedupe=r.requester_id===currentUser.id?r.recipient_id:r.requester_id;
      const peerForDedupe=names.get(otherIdForDedupe);
      const mine = r.requester_id === currentUser.id;
      const otherId=r.requester_id===currentUser.id?r.recipient_id:r.requester_id;
      const peer=names.get(otherId)||{id:otherId,display_name:"nakologユーザー"};
      const row=document.createElement("div");row.className="request-row";
      row.append(makeAvatar());const copy=document.createElement("span");copy.className="person-copy";
      const strong=document.createElement("strong");strong.textContent=r.status==="accepted"?`${peerLabel(peer)}のトーク`:mine?`${peerLabel(peer)}へ申請中`:`${peerLabel(peer)}さんから申請！`;
      const small=document.createElement("small");
      small.textContent=r.status==="accepted"&&r.requester_approved&&r.recipient_approved?"双方が承認済みです":mine?(r.requester_approved?"あなたは承認済み・相手の承認待ち":"あなたの承認が必要"):(r.recipient_approved?"あなたは承認済み・相手の承認待ち":"個人トークの申請が届いています");
      copy.append(strong,small);row.append(copy);
      if(r.status==="accepted"&&r.requester_approved&&r.recipient_approved){
        const open=document.createElement("button");open.type="button";open.className="request-open";open.textContent=`${peerLabel(peer)}のトーク › 開く`;open.addEventListener("click",()=>openDirectChat(peer));row.append(open);
      }else{
        const alreadyApproved=mine?r.requester_approved:r.recipient_approved;
        const approve=document.createElement("button");approve.type="button";approve.textContent=alreadyApproved?"承認済み":"許可";approve.disabled=alreadyApproved;
        approve.addEventListener("click",async()=>{
          approve.disabled=true;
          setStatus(directStatus,"許可を処理しています…");
          try{
            const {data:result,error:e}=await sb.rpc("approve_direct_chat_request",{request_id:r.id});
            if(e)throw e;
            await loadRequests();
            if(result==="accepted"){setStatus(directStatus,"相互承認できました。申請一覧の「"+peerLabel(peer)+"のトーク › 開く」から会話できます。");}
            else{setStatus(directStatus,"許可を保存しました。もう一方の許可を待っています。");}
          } catch(e){
            console.error("approve_direct_chat_request failed",e);
            setStatus(directStatus,"許可できません："+(e?.message||String(e)));
          } finally{approve.disabled=false;}
        });row.append(approve);
        if(!mine && r.status==="pending"){
          const decline=document.createElement("button");decline.type="button";decline.className="request-decline";decline.textContent="断る";
          decline.addEventListener("click",async()=>{
            decline.disabled=true;
            setStatus(directStatus,"断る処理をしています…");
            try{
              const {data:result,error:e}=await sb.rpc("reject_direct_chat_request",{request_id:r.id});
              if(e)throw e;
              await loadRequests();
              setStatus(directStatus,"申請を断りました。");
            }catch(e){
              console.error("reject_direct_chat_request failed",e);
              setStatus(directStatus,"断れません："+(e?.message||String(e)));
            }finally{decline.disabled=false;}
          });row.append(decline);
        }
      }
      el.append(row);
    }
  }
  async function loadGlobalMessages(){
    if(!sb||!currentUser)return;
    const el=$("#globalMessages");
    const {data,error}=await sb.from("global_chat_messages").select("id,user_id,content,created_at").order("created_at",{ascending:true}).limit(200);
    if(error){el.replaceChildren();const n=document.createElement("div");n.className="error-note";n.textContent="みんなのトークを読み込めません："+error.message;el.append(n);return;}
    const ids=[...new Set((data||[]).map(m=>m.user_id))];
    const {data:profiles}=ids.length?await sb.from("profiles").select("id,display_name").in("id",ids):{data:[]};
    const names=new Map((profiles||[]).map(p=>[p.id,p.display_name]));
    el.replaceChildren();
    (data||[]).forEach(m=>{
      const row=document.createElement("div");row.className="global-message"+(m.user_id===currentUser.id?" mine":"");
      const avatar=document.createElement("img");avatar.className="mini-avatar global-message-avatar";avatar.alt="";avatar.src=m.user_id===currentUser.id?(localStorage.getItem("nakolog-profile-icon-"+currentUser.id)||"icon.png"):"icon.png";
      const name=document.createElement("strong");name.textContent=m.user_id===currentUser.id?"あなた":(names.get(m.user_id)||"nakologユーザー");
      let body=document.createElement("p");
      const stampMatch=/^\[スタンプ:(\d+)\]$/.exec(m.content||"");
      if(stampMatch){const img=document.createElement("img");img.className="dm-stamp global-stamp";img.src=`stamp/${Number(stampMatch[1])}.png`;img.alt="スタンプ";body=img;} else {body.className="global-message-body";renderMessageContent(body,m.content,"chat-image");}
      const time=document.createElement("small");time.textContent=timeNow(m.created_at);
      row.append(avatar,name,body,time);el.append(row);
    });
    scrollBottom(el);
  }
  async function sendGlobalMessage(content){
    if(!content||globalBusy||!sb||!currentUser)return false;
    globalBusy=true;$("#globalSendBtn").disabled=true;setStatus($("#globalStatus"),"送信中…");
    try{const {error}=await sb.from("global_chat_messages").insert({user_id:currentUser.id,content});if(error)throw error;if(!content.startsWith(IMAGE_PREFIX)){const input=$("#globalMessageInput");input.value="";input.style.height="auto";}setStatus($("#globalStatus"),"");await loadGlobalMessages();return true;}
    catch(e){setStatus($("#globalStatus"),"送信できません："+e.message);return false;}
    finally{globalBusy=false;$("#globalSendBtn").disabled=false;}
  }
  $("#globalChatForm").addEventListener("submit",async e=>{
    e.preventDefault();const input=$("#globalMessageInput"),content=input.value.trim();
    if(!content)return;
    await sendGlobalMessage(content);
  });
  async function sendGlobalStamp(number){
    if(!sb||!currentUser||globalBusy){setStatus($("#globalStatus"),"送信できません。少し待ってから試してください。");return false;}
    globalBusy=true;$("#globalSendBtn").disabled=true;setStatus($("#globalStatus"),"スタンプ送信中…");
    try{const {error}=await sb.from("global_chat_messages").insert({user_id:currentUser.id,content:`[スタンプ:${number}]`});if(error)throw error;await loadGlobalMessages();setStatus($("#globalStatus"),"");return true;}
    catch(e){setStatus($("#globalStatus"),"スタンプを送れませんでした："+e.message);return false;}
    finally{globalBusy=false;$("#globalSendBtn").disabled=false;}
  }
  function subscribeDirectChatRequests(){
    if(!sb||!currentUser)return;
    if(requestChannel)sb.removeChannel(requestChannel);
    requestChannel=sb.channel("nakolog-requests-"+currentUser.id)
      .on("postgres_changes",{event:"*",schema:"public",table:"direct_chat_requests"},payload=>{
        const r=payload.new||payload.old;
        if(r && (r.requester_id===currentUser.id || r.recipient_id===currentUser.id)){
          loadRequests();
          if(activeView==="talkView") loadTalkList();
        }
      }).subscribe();
  }
  function subscribeGlobalMessages(){
    if(!sb||!currentUser)return;
    if(globalChannel)sb.removeChannel(globalChannel);
    globalChannel=sb.channel("nakolog-global-"+currentUser.id).on("postgres_changes",{event:"INSERT",schema:"public",table:"global_chat_messages"},()=>loadGlobalMessages()).subscribe();
  }

  async function searchPeople(query) {
    if (!sb || !currentUser) { setStatus(peopleResults, "名前登録をしてください。"); return; }
    const term=query.trim(); if (!term) { peopleResults.replaceChildren(); return; }
    if (searchBusy) return; searchBusy=true; peopleResults.replaceChildren();
    const loading=document.createElement("div"); loading.className="empty-note"; loading.textContent="検索しています…"; peopleResults.append(loading);
    try {
      const {data,error}=await sb.from("profiles").select("id,display_name").ilike("display_name", "%"+term.replace(/[%_]/g,"\\$&")+"%").neq("id",currentUser.id).limit(50);
      if (error) throw error;
      const uniquePeople=[...new Map((data||[]).filter(p=>!isSelfProfile(p)).map(p=>[p.id,p])).values()];
      peopleResults.replaceChildren();
      if (!uniquePeople.length) { const empty=document.createElement("div"); empty.className="empty-note"; empty.textContent="見つかりませんでした。相手が名前登録を済ませているか確認してください。"; peopleResults.append(empty); }
      else uniquePeople.slice(0,12).forEach(p=>peopleResults.append(renderPersonButton(p)));
    } catch(e) { peopleResults.replaceChildren(); const msg=document.createElement("div"); msg.className="error-note"; msg.textContent="検索できませんでした："+e.message+"（database/schema.sql のSQLを実行してください）"; peopleResults.append(msg); }
    finally { searchBusy=false; }
  }
  $("#searchPeopleForm").addEventListener("submit", e=>{e.preventDefault();searchPeople($("#peopleSearchInput").value);});

  let talkListLoadToken=0;
  async function loadTalkList() {
    if (!sb || !currentUser) return;
    const loadToken=++talkListLoadToken;
    const {data,error}=await sb.from("direct_messages").select("sender_id,recipient_id,content,stamp_no,created_at").or(`sender_id.eq.${currentUser.id},recipient_id.eq.${currentUser.id}`).order("created_at",{ascending:false}).limit(300);
    if (loadToken!==talkListLoadToken) return;
    if (error) { console.warn("トーク一覧",error.message); talkList.replaceChildren(); const n=document.createElement("div"); n.className="error-note"; n.textContent="トーク機能のSQL設定を確認してください。"; talkList.append(n); return; }
    const latest=new Map();
    (data||[]).forEach(m=>{ const other=m.sender_id===currentUser.id?m.recipient_id:m.sender_id; if(!latest.has(other)) latest.set(other,m); });
    if (!latest.size) { talkList.replaceChildren(); const n=document.createElement("div"); n.className="empty-note"; n.textContent="まだトークはありません。上で名前を検索してください。"; talkList.append(n); renderHomeRecent([]); return; }
    const ids=[...latest.keys()];
    const {data:people,error:peopleError}=await sb.from("profiles").select("id,display_name").in("id",ids);
    if (peopleError) console.warn(peopleError.message);
    const byId=new Map((people||[]).map(p=>[p.id,p]));
    const rows=ids.map(id=>({peer:byId.get(id)||{id,display_name:"nakologユーザー"},message:latest.get(id)})).sort((a,b)=>new Date(b.message.created_at)-new Date(a.message.created_at));
    // 相手のUUID単位で重複を除去する。同じ表示名の別ユーザーは統合しない。
    const uniqueRows=[];const seenIds=new Set();
    rows.forEach(item=>{
      const id=String(item.peer.id);
      if(!seenIds.has(id)){seenIds.add(id);uniqueRows.push(item);}
    });
    talkList.replaceChildren();
    uniqueRows.forEach(({peer,message})=>talkList.append(renderPersonButton(peer, message.stamp_no?"😊 スタンプ":safe(message.content).slice(0,46))));
    renderHomeRecent(uniqueRows);
  }
  function renderHomeRecent(rows) {
    const el=$("#homeRecent"); el.replaceChildren();
    if (!rows.length) { const n=document.createElement("div"); n.className="empty-note"; n.textContent="トークはまだありません。トーク画面で名前を検索してみよう。"; el.append(n); return; }
    rows.slice(0,3).forEach(({peer,message})=>el.append(renderPersonButton(peer,message.stamp_no?"😊 スタンプ":safe(message.content).slice(0,46))));
  }
  async function openDirectChat(peer) {
    if (!sb || !currentUser) { setStatus(directStatus,"先に名前登録をしてください。"); return; }
    if (isSelfProfile(peer)) { setStatus(directStatus,"自分自身のトークは開けません。"); return; }
    const {data:approved,error:approvalError}=await sb.from("direct_chat_requests").select("id").or(`and(requester_id.eq.${currentUser.id},recipient_id.eq.${peer.id}),and(requester_id.eq.${peer.id},recipient_id.eq.${currentUser.id})`).eq("status","accepted").eq("requester_approved",true).eq("recipient_approved",true).limit(1);
    if(approvalError || !approved?.length){setStatus(directStatus,"個人トークは双方の承認後に開始できます。");setTalkTab("people");await loadRequests();return;}
    activePeer=peer; $("#directPeerName").textContent=peerLabel(peer)+"のトーク"; $("#directPeerStatus").textContent="";
    $("#globalChatPanel").classList.add("hidden"); $("#peoplePanel").classList.add("hidden"); $("#talkListPanel").classList.add("hidden"); directPanel.classList.remove("hidden"); directMessages.replaceChildren(); setStatus(directStatus,"メッセージを読み込み中…");
    setView("talkView"); await loadDirectMessages(); $("#directMessageInput").focus();
  }
  async function loadDirectMessages() {
    if (!sb || !currentUser || !activePeer) return;
    const {data,error}=await sb.from("direct_messages").select("id,sender_id,recipient_id,content,stamp_no,created_at,read_at").or(`sender_id.eq.${currentUser.id},recipient_id.eq.${currentUser.id}`).order("created_at",{ascending:true}).limit(500);
    if (error) { setStatus(directStatus,"読み込みエラー："+error.message); return; }
    const relevant=(data||[]).filter(m=>(m.sender_id===currentUser.id&&m.recipient_id===activePeer.id)||(m.sender_id===activePeer.id&&m.recipient_id===currentUser.id));
    directHistory=[...new Map(relevant.map(m=>[String(m.id),m])).values()];
    const unreadIds=directHistory.filter(m=>m.sender_id===activePeer.id&&m.recipient_id===currentUser.id&&!m.read_at).map(m=>m.id);
    if(unreadIds.length){
      const {error:readError}=await sb.from("direct_messages").update({read_at:nowISO()}).in("id",unreadIds);
      if(readError) console.warn("既読の更新に失敗しました",readError.message);
      else directHistory=directHistory.map(m=>unreadIds.includes(m.id)?{...m,read_at:nowISO()}:m);
    }
    renderDirectMessages(); setStatus(directStatus,"");
  }
  function renderDirectMessages() {
    directMessages.replaceChildren();
    if (!directHistory.length) { const n=document.createElement("div"); n.className="direct-empty"; n.textContent=peerLabel(activePeer)+"さんとのトークを始めましょう！"; directMessages.append(n); return; }
    directHistory.forEach(m=>{
      const mine=m.sender_id===currentUser.id; const row=document.createElement("div"); row.className="dm-row "+(mine?"mine":"theirs"); row.dataset.messageId=String(m.id);
      const avatar=document.createElement("img");avatar.className="mini-avatar dm-avatar";avatar.alt="";avatar.src=mine?(localStorage.getItem("nakolog-profile-icon-"+currentUser.id)||"icon.png"):"icon.png";row.append(avatar);
      if (m.stamp_no) { const img=document.createElement("img"); img.className="dm-stamp"; img.src=`stamp/${m.stamp_no}.png`; img.alt="スタンプ"; row.append(img); }
      else { const bubble=document.createElement("div"); bubble.className="dm-bubble"; renderMessageContent(bubble,m.content||"","chat-image"); row.append(bubble); }
      const meta=document.createElement("span"); meta.className="dm-meta";
      const time=document.createElement("small"); time.className="dm-time"; time.textContent=timeNow(m.created_at); meta.append(time);
      if(mine&&m.read_at){const read=document.createElement("small");read.className="dm-read-receipt";read.textContent="既読";meta.append(read);}
      row.append(meta);
      row.addEventListener("contextmenu",e=>{
        e.preventDefault();
        document.querySelectorAll(".dm-context-menu").forEach(n=>n.remove());
        const menu=document.createElement("div");menu.className="dm-context-menu";
        const replay=document.createElement("button");replay.type="button";replay.textContent="🔊 リプレイ";replay.addEventListener("click",()=>{menu.remove();const spoken=m.stamp_no?"スタンプ":(m.content||"");if(spoken)speak(spoken);});menu.append(replay);
        if(mine){const undo=document.createElement("button");undo.type="button";undo.textContent="送信取り消し";undo.addEventListener("click",async()=>{menu.remove();if(!confirm("このメッセージを送信取り消ししますか？"))return;const {error}=await sb.from("direct_messages").delete().eq("id",m.id).eq("sender_id",currentUser.id);if(error){setStatus(directStatus,"取り消せませんでした："+error.message);return;}directHistory=directHistory.filter(x=>x.id!==m.id);renderDirectMessages();setStatus(directStatus,"メッセージを送信取り消ししました。");});menu.append(undo);}
        document.body.append(menu);menu.style.left=Math.min(e.clientX,window.innerWidth-180)+"px";menu.style.top=Math.min(e.clientY,window.innerHeight-100)+"px";
        const close=ev=>{if(!menu.contains(ev.target)){menu.remove();document.removeEventListener("pointerdown",close);}};setTimeout(()=>document.addEventListener("pointerdown",close),0);
      });
      directMessages.append(row);
    });
    scrollBottom(directMessages);
  }
  async function sendDirectMessage(content, stampNo = null) {
    if (!sb || !currentUser || !activePeer || talkBusy) { setStatus(directStatus,"トーク相手を開いてください。"); return false; }
    if (!content.trim() && !stampNo) return false;
    talkBusy=true; $("#directSendBtn").disabled=true; setStatus(directStatus,"送信中…");
    try {
      const payload={sender_id:currentUser.id,recipient_id:activePeer.id,content:stampNo?`[スタンプ:${stampNo}]`:content.trim(),stamp_no:stampNo};
      const {data,error}=await sb.from("direct_messages").insert(payload).select("id,sender_id,recipient_id,content,stamp_no,created_at,read_at").single();
      if (error) throw error;
      directHistory.push(data); renderDirectMessages(); setStatus(directStatus,"");
      if (!stampNo) { $("#directMessageInput").value=""; $("#directMessageInput").style.height="auto"; }
      await loadTalkList(); return true;
    } catch(e) { setStatus(directStatus,"送信できませんでした："+e.message); return false; }
    finally { talkBusy=false; $("#directSendBtn").disabled=false; }
  }
  $("#directChatForm").addEventListener("submit",e=>{e.preventDefault();sendDirectMessage($("#directMessageInput").value);});
  $("#backTalkListBtn").addEventListener("click",()=>{activePeer=null;directPanel.classList.add("hidden");setTalkTab("people");loadTalkList();loadRequests();});
  function subscribeDirectMessages() {
    if (!sb || !currentUser) return;
    if (realtimeChannel) sb.removeChannel(realtimeChannel);
    realtimeChannel=sb.channel("nakolog-dm-"+currentUser.id).on("postgres_changes",{event:"*",schema:"public",table:"direct_messages"},payload=>{
      const m=payload.new||payload.old;
      if (m && (m.sender_id===currentUser.id||m.recipient_id===currentUser.id)) {
        loadTalkList();
        if(activePeer && ((m.sender_id===currentUser.id&&m.recipient_id===activePeer.id)||(m.sender_id===activePeer.id&&m.recipient_id===currentUser.id))) loadDirectMessages();
      }
    }).subscribe();
  }

  async function invokeGeminiWith503Retry(messages, onRetry = () => {}) {
    let lastDetail = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await sb.functions.invoke(config.EDGE_FUNCTION_NAME || "gemini-chat", { body: { messages } });
      if (!result.error && !result.data?.error) return result;
      let detail = result.data?.error || result.error?.message || "AIとの通信に失敗しました";
      try {
        const ctx = result.error?.context;
        if (ctx && typeof ctx.json === "function") {
          const payload = await ctx.json();
          if (payload?.error) detail += "：" + payload.error;
        }
      } catch {}
      lastDetail = detail;
      // Gemini の503過負荷だけを1回再試行。400/404等は再試行しない。
      if (attempt === 0 && /(?:Gemini API status\s*503|503)/i.test(detail)) {
        onRetry();
        await new Promise(resolve => setTimeout(resolve, 1800));
        continue;
      }
      throw new Error(/(?:Gemini API status\s*503|503)/i.test(detail)
        ? "AIが混み合っています。少し待って再試行してください"
        : detail);
    }
    throw new Error(/503/.test(lastDetail) ? "AIが混み合っています。少し待って再試行してください" : lastDetail);
  }

  async function askAIAboutStamp(number){
    if(!sb||!currentUser){setStatus($("#stampStatus"),"先に名前登録をしてください。");return;}
    if(aiBusy){setStatus($("#stampStatus"),"AIが返事を考えています。少し待ってください。");return;}
    const createdAt=nowISO();history.push({role:"user",stamp:number,created_at:createdAt});persistLocal();addAIStamp(number,"user",false,createdAt);saveRemoteAI({role:"user",content:`[スタンプ:${number}]`});
    aiBusy=true;aiSendBtn.disabled=true;setStatus(voiceStatus,"うさきちがスタンプに返事しています…");
    const pending=addAIMessage("assistant","スタンプを見ているよ…");
    try{
      const recent=history.filter(m=>m.content&&["user","assistant"].includes(m.role)).slice(-14).map(m=>{const image=imageDataFromContent(m.content);return image?{role:m.role,content:"この画像についての会話です。",imageDataUrl:image}:{role:m.role,content:m.content};});
      const stampReactions=[
        `ユーザーが${number}番のスタンプを送ってくれました。毎回同じ定型文を避け、スタンプの雰囲気に合わせた明るいひとことを返してください。`,
        `${number}番のスタンプへのリアクションを日本語で返してね。前の返事と表現を変え、会話が続く質問や感想もときどき添えてください。`,
        `ユーザーから${number}番のスタンプ！友だちのように自然に反応して。返事の言い回し・絵文字・長さを毎回少し変えてください。`,
        `${number}番のスタンプを受け取ったよ。スタンプの意味を想像して、ユニークだけど短い日本語で返事してください。同じ文を繰り返さないでください。`
      ];
      recent.push({role:"user",content:stampReactions[Math.floor(Math.random()*stampReactions.length)]});
      const {data}=await invokeGeminiWith503Retry(recent,()=>{
        pending.querySelector(".text").textContent="AIが混み合っています。少し待って自動で再試行しています…";
        setStatus(voiceStatus,"AIが混み合っています。再試行中…");
      });
      const answer=data?.reply;if(!answer)throw new Error(data?.error||"AIから返事がありませんでした");
      pending.querySelector(".text").textContent=answer;const item={role:"assistant",content:answer,created_at:nowISO()};history.push(item);persistLocal();saveRemoteAI(item);if($("#autoSpeak").checked)speak(answer);setStatus(voiceStatus,"");
    }catch(e){const message=e?.message||"不明なエラー";pending.querySelector(".text").textContent=message.includes("AIが混み合っています")?"AIが混み合っています。少し待って再試行してください":"返事を取得できませんでした："+message;pending.classList.add("bubble-error");setStatus(voiceStatus,pending.querySelector(".text").textContent);}
    finally{aiBusy=false;aiSendBtn.disabled=false;scrollBottom(aiMessages);}
  }
  function sendStamp(number) {
    const target=$("#stampTarget").value;
    if(target==="global"){
      setView("talkView");setTalkTab("global");sendGlobalStamp(number).then(ok=>{if(ok)setStatus($("#globalStatus"),"スタンプを送りました！");});
    }else if(target==="talk"){
      if(!activePeer){setStatus($("#stampStatus"),"個人トークを開いてからスタンプを選んでください。");setView("talkView");return;}
      sendDirectMessage("",number).then(ok=>{if(ok){setStatus($("#stampStatus"),"個人トークにスタンプを送りました！");setView("talkView");}});
    }else{
      askAIAboutStamp(number);setStatus($("#stampStatus"),"うさきちAIにスタンプを送りました！");setView("aiView");
    }
  }
  for(let i=1;i<=41;i++) {
    const b=document.createElement("button"); b.type="button"; b.className="stamp-choice"; b.setAttribute("aria-label",`スタンプ ${i}`); b.title=`スタンプ ${i}`;
    const im=document.createElement("img"); im.src=`stamp/${i}.png`; im.alt=`スタンプ ${i}`; im.loading="lazy"; b.append(im);
    b.addEventListener("click",()=>sendStamp(i)); stampGrid.append(b);
  }
  $("#aiStampBtn").addEventListener("click",()=>{ $("#stampTarget").value="ai"; setView("stampsView"); });
  $("#directStampBtn").addEventListener("click",()=>{ $("#stampTarget").value="talk"; setView("stampsView"); });
  $("#globalStampBtn").addEventListener("click",()=>{ $("#stampTarget").value="global"; setView("stampsView"); });

  function speak(text) {
    if (!("speechSynthesis" in window)) { setStatus(voiceStatus,"このブラウザは音声読み上げに対応していません。"); return; }
    speechSynthesis.cancel(); const u=new SpeechSynthesisUtterance(text); u.lang="ja-JP"; u.rate=1.02; speechSynthesis.speak(u);
  }
  const SpeechRecognition=window.SpeechRecognition||window.webkitSpeechRecognition;
  const micBtn=$("#micBtn");
  if (SpeechRecognition) {
    recognition=new SpeechRecognition(); recognition.lang="ja-JP"; recognition.interimResults=true; recognition.continuous=false;
    recognition.onstart=()=>{listening=true;micBtn.classList.add("active");micBtn.textContent="⏹️";setStatus(voiceStatus,"聞き取り中… 話し終わったら少し待ってね。");};
    recognition.onresult=e=>{let finalText="",interim="";for(let i=e.resultIndex;i<e.results.length;i++){if(e.results[i].isFinal)finalText+=e.results[i][0].transcript;else interim+=e.results[i][0].transcript;}if(finalText)aiInput.value=(aiInput.value+" "+finalText).trim();setStatus(voiceStatus,interim?"聞き取り中："+interim:"音声を文字に変換しました。送信で送れます。");aiInput.dispatchEvent(new Event("input"));};
    recognition.onerror=e=>setStatus(voiceStatus,e.error==="not-allowed"?"マイクの使用が許可されていません。":"音声入力エラー："+e.error);
    recognition.onend=()=>{listening=false;micBtn.classList.remove("active");micBtn.textContent="🎙️";};
  }
  micBtn.addEventListener("click",()=>{if(!recognition){setStatus(voiceStatus,"このブラウザは音声入力に対応していません。EdgeまたはChromeで試してください。");return;}if(listening)recognition.stop();else{try{recognition.start();}catch{setStatus(voiceStatus,"音声入力を開始できません。少し待ってから試してください。");}}});

  $("#settingsBtn").addEventListener("click",()=>$("#settingsDialog").showModal());
  $("#saveNameBtn").addEventListener("click",async()=>{
    const name=$("#settingsName").value.trim(); if(!name){setStatus($("#settingsStatus"),"名前を入力してください。");return;}
    try {
      if(sb&&currentUser){const {error}=await sb.auth.updateUser({data:{display_name:name}});if(error)throw error;displayName=name;await upsertProfile(name);}
      else displayName=name;
      $("#homeUserName").textContent=displayName;setStatus($("#settingsStatus"),"名前を保存しました。");
    } catch(e){setStatus($("#settingsStatus"),"保存できませんでした："+e.message);}
  });
  $("#clearHistoryBtn").addEventListener("click",()=>{if(confirm("この端末のAI会話履歴を消去しますか？")){history=[];persistLocal();renderAIHistory();$("#settingsDialog").close();}});

  async function init() {
    if (!sb) { setStatus(registerStatus,"未設定です。config.jsのURLとキーを確認してください。"); return; }
    connectionStatus.textContent="databaseに接続中…";
    try {
      const {data,error}=await sb.auth.getSession(); if(error)throw error;
      const user=data.session?.user; const name=user?.user_metadata?.display_name;
      if(user&&name) await enterApp(user,name);
      else if(user&&!name) { registerScreen.classList.remove("hidden"); registerName.focus(); setStatus(registerStatus,"名前を登録してください。"); }
      else { registerScreen.classList.remove("hidden"); registerName.focus(); }
      sb.auth.onAuthStateChange((event,session)=>{
        if(event==="SIGNED_OUT") { currentUser=null; activePeer=null; appShell.classList.add("hidden"); registerScreen.classList.remove("hidden"); }
      });
    } catch(e) { setStatus(registerStatus,"databaseに接続できません："+e.message); }
  }
  init();
})();
