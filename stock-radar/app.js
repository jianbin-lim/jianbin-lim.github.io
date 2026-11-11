
(function(){
"use strict";

/* =========================================================
   0. 基础工具
   ========================================================= */
function $(s,r){ return (r||document).querySelector(s); }
function $$(s,r){ return Array.prototype.slice.call((r||document).querySelectorAll(s)); }
function esc(v){ return String(v==null?"":v).replace(/[&<>"']/g,function(c){
  return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
function num(v){ var x=parseFloat(v); return Number.isFinite(x)?x:null; }
function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }
function fmt(v,d,sign){
  if(v==null||!Number.isFinite(Number(v))) return "—";
  d=d==null?2:d;
  var x=Number(v), s=x.toFixed(d);
  if(sign && x>0) s="+"+s;
  return s;
}
function fmtPct(v,d,sign){ return v==null?"—":fmt(v,d,sign===false?false:true)+"%"; }
function fmtMD(date){ return date?String(date).slice(5).replace("-","/"):""; }
function fmtRange(r){ return r&&r.startDate&&r.endDate?fmtMD(r.startDate)+"–"+fmtMD(r.endDate)+(r.days?" · "+r.days+"日":""):""; }
function nextTradeDate(date){
  var d=new Date(String(date||"")+"T00:00:00");
  if(isNaN(d.getTime())) return "";
  do{ d.setDate(d.getDate()+1); }while(d.getDay()===0||d.getDay()===6);
  var m=String(d.getMonth()+1).padStart(2,"0"), day=String(d.getDate()).padStart(2,"0");
  return d.getFullYear()+"-"+m+"-"+day;
}
function isTimeClosed(hm){
  var m=String(hm||"").match(/(\d{1,2}):(\d{2})/);
  if(!m) return true;
  var t=Number(m[1])*60+Number(m[2]);
  return t>=15*60 || t<9*60+15;
}
function nowHm(){
  var d=new Date();
  return String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0");
}
function fmtPrice(v){
  if(v==null||!Number.isFinite(Number(v))) return "—";
  return Number(v).toLocaleString("zh-CN",{minimumFractionDigits:2,maximumFractionDigits:2});
}
function cls(v){ var x=Number(v); return x>0?"up":(x<0?"dn":"dm"); }
function toneCls(v){ var x=Number(v); return x>0?"up":(x<0?"dn":"amber"); }
function pctWidth(p){ return clamp(p*100,0,100).toFixed(1)+"%"; }

/* =========================================================
   1. 市场映射与阈值
   ========================================================= */
var INDEXES = {
  shmain:{ secid:"1.000002", code:"000002", name:"上证A指", tx:"sh000002" },
  szmain:{ secid:"0.399107", code:"399107", name:"深证A指", tx:"sz399107" },
  gem:   { secid:"0.399102", code:"399102", name:"创业板综", tx:"sz399102" },
  star:  { secid:"1.000688", code:"000688", name:"科创50",   tx:"sh000688" }
};
var BOARD_NAMES = { shmain:"沪市主板", szmain:"深市主板", gem:"创业板", star:"科创板" };

function boardOf(code){
  if(/^68/.test(code)) return "star";
  if(/^30/.test(code)) return "gem";
  if(/^60/.test(code)) return "shmain";
  if(/^00/.test(code)) return "szmain";
  return null;
}
function parseInput(raw){
  var s=String(raw==null?"":raw).trim().toLowerCase().replace(/\s+/g,"");
  s=s.replace(/\.(sh|sz|bj)$/,"").replace(/^(sh|sz|bj)/,"");
  if(!/^\d{6}$/.test(s)) throw new Error("请输入 6 位股票代码，例如 600519、300750、000001");
  if(/^(8|4|920)/.test(s)) throw new Error("暂不支持北交所股票；当前覆盖沪深主板、创业板、科创板。");
  var board=boardOf(s);
  if(!board) throw new Error("暂不支持该代码；当前覆盖 60 / 68 / 00 / 30 开头的沪深个股。");
  var market=(s.charAt(0)==="6")?"sh":"sz";
  return {
    code:s, market:market, board:board, boardName:BOARD_NAMES[board],
    secid:(market==="sh"?"1.":"0.")+s, tx:market+s, index:INDEXES[board]
  };
}
function stockSearchUrl(q){
  return "https://searchapi.eastmoney.com/api/suggest/get?type=14&count=10&input="+encodeURIComponent(q);
}
async function searchStocks(q){
  var data=await jsonp(stockSearchUrl(q),8000);
  var table=data&&data.QuotationCodeTable;
  var rows=table&&Array.isArray(table.Data)?table.Data:[];
  var out=[], seen={};
  rows.forEach(function(x){
    var code=String(x&&x.Code||"").trim();
    var cls=String(x&&x.Classify||"");
    if(cls && cls!=="AStock") return;
    if(seen[code]) return;
    try{
      var info=parseInput(code);
      info.name=String(x.Name||"").trim()||info.code;
      out.push(info); seen[code]=1;
    }catch(e){}
  });
  return out;
}
async function resolveStockInput(raw){
  try{ return parseInput(raw); }catch(e){}
  var q=String(raw==null?"":raw).trim();
  if(!/[\u4e00-\u9fa5A-Za-z]/.test(q)){
    throw new Error("请输入 6 位股票代码或股票名称，例如 600519、贵州茅台。");
  }
  var list;
  try{ list=await searchStocks(q); }
  catch(e){ throw new Error("股票名称搜索失败，请改为直接输入 6 位代码。"); }
  if(!list.length) throw new Error("没有找到“"+q+"”，请检查名称或直接输入 6 位代码。");
  var exact=list.filter(function(x){ return x.name===q; });
  if(exact.length===1) return exact[0];
  if(list.length===1) return list[0];
  var err=new Error("“"+q+"”匹配到多只股票，请选择一只。");
  err.candidates=list.slice(0,8);
  throw err;
}

function thresholds(board,isST){
  var abn=board==="gem"||board==="star"?30:20;
  var repeat=board==="gem"||board==="star"?3:4;
  if(isST && (board==="shmain"||board==="szmain")) abn=12;
  var limit=board==="gem"||board==="star"?20:(isST?5:10);
  return {abn:abn,repeat:repeat,limit:limit};
}

/* =========================================================
   1b. 异动池 / 关注清单的本地状态
   ========================================================= */
var WATCH_KEY="abn.watch.v1";
var WATCH_GROUPS_KEY="abn.watch.groups.v1";
var WATCH_GROUP_ACTIVE_KEY="abn.watch.group.active.v1";
var DEFAULT_WATCH_GROUPS=[{id:"g1",name:"分组1"},{id:"g2",name:"分组2"},{id:"g3",name:"分组3"}];
var POOL_CACHE_KEY="abn.pool.v3";
var EM_CHANGE_UT="7eea3edcaed734bea9cbfc24409ed989";
var CHANGE_TYPES=[
  {id:1,label:"火箭发射"},
  {id:3,label:"大笔买入"},
  {id:4,label:"封涨停板"},
  {id:10,label:"60日新高"},
  {id:11,label:"60日大幅上涨"},
  {id:12,label:"加速下跌"},
  {id:14,label:"大笔卖出"},
  {id:15,label:"封跌停板"}
];
var watchList=[];
var pool={mode:"near",items:[],scanning:false,source:"",lastAt:0,error:"",done:0,total:0,token:0};
var watchState={items:[],loading:false,lastAt:0,token:0};
function readWatchGroups(){
  try{
    var a=JSON.parse(localStorage.getItem(WATCH_GROUPS_KEY)||"null");
    if(Array.isArray(a)){
      var seen={}, out=[];
      a.forEach(function(g){
        var id=String(g&&g.id||"").replace(/[^\w-]/g,"").slice(0,32);
        var name=String(g&&g.name||"").trim().slice(0,20);
        if(!id||!name||seen[id]) return;
        seen[id]=1; out.push({id:id,name:name});
      });
      if(out.length) return out;
    }
  }catch(e){}
  return DEFAULT_WATCH_GROUPS.map(function(g){ return {id:g.id,name:g.name}; });
}
var watchGroups=readWatchGroups();
var activeWatchGroup=(function(){
  try{ var id=localStorage.getItem(WATCH_GROUP_ACTIVE_KEY)||""; if(watchGroups.some(function(g){return g.id===id;})) return id; }catch(e){}
  return watchGroups[0].id;
})();
function saveWatchGroups(){
  try{ localStorage.setItem(WATCH_GROUPS_KEY,JSON.stringify(watchGroups)); localStorage.setItem(WATCH_GROUP_ACTIVE_KEY,activeWatchGroup); }catch(e){}
}
function groupById(id){ return watchGroups.filter(function(g){ return g.id===id; })[0]||null; }
function groupName(id){ var g=groupById(id); return g?g.name:"未分组"; }
function activeGroupId(){ return groupById(activeWatchGroup)?activeWatchGroup:watchGroups[0].id; }
function groupItems(){ var gid=activeGroupId(); return watchList.filter(function(x){ return x.group===gid; }); }
function activeWatchIndex(code){ var list=groupItems(); for(var i=0;i<list.length;i++) if(list[i].code===code) return i; return -1; }
function addWatchGroup(name){
  name=String(name||"").trim().slice(0,20);
  if(!name) return null;
  if(watchGroups.some(function(g){ return g.name===name; })){ toast("已有同名分组。"); return null; }
  if(watchGroups.length>=8){ toast("最多 8 个分组。"); return null; }
  var g={id:"g"+Date.now().toString(36),name:name};
  watchGroups.push(g); saveWatchGroups(); renderWatchGroups(); return g;
}
var MONITOR_URL="https://mobappconfig.securities.eastmoney.com/emcfg/stock_monitor.json";
var MONITOR_SEVERE_URL="https://datacenter-web.eastmoney.com/api/data/v1/get";
var MONITOR_FALLBACK=[
  {code:"002724",name:"海洋王",start:"2026-11-02",end:"2026-11-13"},
  {code:"603278",name:"大业股份",start:"2026-11-02",end:"2026-11-13"},
  {code:"600825",name:"新华传媒",start:"2026-10-30",end:"2026-11-12"},
  {code:"605255",name:"天普股份",start:"2026-10-30",end:"2026-11-12"},
  {code:"301313",name:"凡拓数创",start:"2026-10-26",end:"2026-11-06"}
];
var monitor={items:[],loading:false,lastAt:0,error:"",token:0};
var monitorSet={};
var PREDICT_URL="https://dycalchis.eastmoney.com/price-anomaly/list?team=h5&product=EastMoney&client=WAP&version=9001&name=WAP&user=123&pageSize=200&pageNo=1&type=2";
var predict={items:[],loading:false,lastAt:0,error:"",date:"",token:0};
var PREDICT_BOARD={1:"沪市主板",4:"创业板",5:"科创板",8:"北交所"};
var PREDICT_RULE={4:"10日 +100%",5:"10日 -50%",6:"30日 +200%",7:"30日 -70%"};

function readWatch(){
  try{
    var a=JSON.parse(localStorage.getItem(WATCH_KEY)||"[]");
    if(!Array.isArray(a)) return [];
    return a.filter(function(x){ return x&&/^\d{6}$/.test(String(x.code||"")); })
      .map(function(x){ var gid=String(x.group||""); if(!groupById(gid)) gid=watchGroups[0].id; return {code:String(x.code),name:String(x.name||""),group:gid}; })
      .slice(0,80);
  }catch(e){ return []; }
}
function saveWatch(){
  try{ localStorage.setItem(WATCH_KEY,JSON.stringify(watchList)); }catch(e){}
}
function isWatched(code){ return watchList.some(function(x){ return x.code===code; }); }
function watchOf(code){ return watchList.filter(function(x){ return x.code===code; })[0]||null; }
function addWatch(code,name,group){
  if(!code||isWatched(code)) return false;
  if(watchList.length>=80){ toast("关注清单最多 80 只，请先移除一些。"); return false; }
  var gid=groupById(group)?group:activeGroupId();
  watchList.unshift({code:code,name:name||"",group:gid});
  activeWatchGroup=gid;
  saveWatch();
  toast("已关注 "+(name||code)+" → "+groupName(gid)+"。");
  return true;
}
function removeWatch(code){
  var before=watchList.length;
  watchList=watchList.filter(function(x){ return x.code!==code; });
  watchState.items=watchState.items.filter(function(x){ return x.code!==code; });
  if(watchList.length!==before){
    saveWatch();
    toast("已移出关注。");
    return true;
  }
  return false;
}
function toggleWatch(code,name,anchor){
  if(isWatched(code)){
    removeWatch(code);
    updateWatchButtons(code);
    if(pool.mode==="watch") renderPoolList();
    renderWatchCount();
    return;
  }
  openGroupPicker(code,name||"",anchor);
}
function watchIndex(code){ return activeWatchIndex(code); }
function syncWatchStateOrder(){
  var by={};
  watchState.items.forEach(function(x){ by[x.code]=x; });
  watchState.items=watchList.map(function(w){ return by[w.code]; }).filter(Boolean);
}
function afterWatchMove(){
  saveWatch();
  syncWatchStateOrder();
  renderWatchGroups();
  if(pool.mode==="watch") renderPoolList();
}
function moveWatch(code,dir){
  var list=groupItems(), i=activeWatchIndex(code), targetCode="";
  if(i<0) return false;
  if(dir==="top"){ if(i===0) return false; targetCode=list[0].code; }
  else if(dir==="bottom"){ if(i===list.length-1) return false; targetCode=list[list.length-1].code; }
  else{
    var j=i+Number(dir);
    if(!isFinite(j)||j<0||j>=list.length) return false;
    targetCode=list[j].code;
  }
  var item=watchList[watchIndexGlobal(code)];
  if(!item||!targetCode) return false;
  watchList.splice(watchIndexGlobal(code),1);
  var tp=watchIndexGlobal(targetCode);
  var after=(dir==="bottom"||Number(dir)>0);
  watchList.splice(tp+(after?1:0),0,item);
  afterWatchMove();
  toast(dir==="top"?"已在本组内置顶。":dir==="bottom"?"已在本组内置底。":"已调整本组顺序。");
  return true;
}
function watchIndexGlobal(code){
  for(var i=0;i<watchList.length;i++) if(watchList[i].code===code) return i;
  return -1;
}
function moveWatchTo(code,targetCode,after){
  if(!code||!targetCode||code===targetCode) return false;
  var from=watchIndexGlobal(code); if(from<0) return false;
  var item=watchList.splice(from,1)[0];
  var tp=watchIndexGlobal(targetCode);
  if(tp<0){ watchList.splice(from,0,item); return false; }
  watchList.splice(tp+(after?1:0),0,item);
  afterWatchMove();
  toast("已调整本组顺序，下次打开保持。");
  return true;
}

var groupPickerCtx=null;
function closeGroupPicker(){
  groupPickerCtx=null;
  var el=$("#groupPicker"); if(el){ el.classList.add("hidden"); el.innerHTML=""; }
}
function openGroupPicker(code,name,anchor){
  groupPickerCtx={code:code,name:name||""};
  var el=$("#groupPicker");
  if(!el){ el=document.createElement("div"); el.id="groupPicker"; el.className="group-picker hidden"; document.body.appendChild(el); }
  el.innerHTML='<div class="gp-title">添加到分组</div>'+
    watchGroups.map(function(g){
      var n=watchList.filter(function(x){ return x.group===g.id; }).length;
      return '<button type="button" data-pick-group="'+esc(g.id)+'"><span>'+esc(g.name)+'</span><i>'+n+'</i></button>';
    }).join("")+
    '<button type="button" class="gp-new" data-pick-new-group="1">＋ 新建分组</button>';
  el.classList.remove("hidden");
  var r=anchor&&anchor.getBoundingClientRect?anchor.getBoundingClientRect():null;
  var w=210, left=r?Math.min(window.innerWidth-w-10,Math.max(8,r.right-w)):Math.max(8,(window.innerWidth-w)/2);
  var top=r?r.bottom+6:120;
  el.style.width=w+"px"; el.style.left=left+"px"; el.style.top=top+"px";
  if(r&&top+el.offsetHeight>window.innerHeight-8) el.style.top=Math.max(8,r.top-el.offsetHeight-6)+"px";
}
function addWatchFromPicker(group){
  if(!groupPickerCtx) return;
  var ctx=groupPickerCtx;
  if(addWatch(ctx.code,ctx.name,group)){
    activeWatchGroup=groupById(group)?group:activeGroupId();
    saveWatchGroups();
    closeGroupPicker();
    updateWatchButtons(ctx.code);
    renderWatchCount();
    renderPool();
    refreshWatch(true);
  }else{
    closeGroupPicker();
  }
}
function renderWatchGroups(){
  var box=$("#watchGroups");
  if(!box) return;
  if(pool.mode!=="watch"){ box.classList.add("hidden"); box.innerHTML=""; return; }
  box.classList.remove("hidden");
  var total=watchList.length;
  box.innerHTML='<div class="wg-tabs">'+watchGroups.map(function(g){
      var n=watchList.filter(function(x){ return x.group===g.id; }).length;
      return '<button type="button" class="wg-tab'+(g.id===activeGroupId()?" on":"")+'" data-watch-group="'+esc(g.id)+'" title="双击重命名">'+esc(g.name)+'<i>'+n+'</i></button>';
    }).join("")+'<button type="button" class="wg-add" data-watch-group-add="1" title="新建分组">＋ 分组</button></div>'+
    '<span class="wg-hint">拖动行首 ⋮⋮ 排序 · 本组 '+groupItems().length+' 只 / 全部 '+total+' 只</span>';
}

function dateStamp(){
  var d=new Date();
  return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
}
function exportWatch(){
  if(!watchList.length){ toast("关注列表为空，没有可导出的内容。"); return; }
  var payload={
    app:"异动雷达",
    version:2,
    exportedAt:new Date().toISOString(),
    groups:watchGroups.map(function(g){ return {id:g.id,name:g.name}; }),
    activeGroup:activeGroupId(),
    watchlist:watchList.map(function(x){ return {code:x.code,name:x.name||"",group:x.group}; })
  };
  var blob=new Blob([JSON.stringify(payload,null,2)],{type:"application/json;charset=utf-8"});
  var url=URL.createObjectURL(blob);
  var a=document.createElement("a");
  a.href=url;
  a.download="异动雷达-关注列表-"+dateStamp()+".json";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function(){ URL.revokeObjectURL(url); },1500);
  toast("已导出 "+watchList.length+" 只关注股票。");
}
function importWatchData(data){
  var list=Array.isArray(data)?data:(data&&Array.isArray(data.watchlist)?data.watchlist:(data&&Array.isArray(data.watch)?data.watch:(data&&Array.isArray(data.items)?data.items:null)));
  if(!list){ toast("JSON 格式不对：需要数组，或包含 watchlist 数组的对象。"); return; }
  var old={};
  watchList.forEach(function(x){ old[x.code]=x.name||""; });
  var seen={}, out=[], skipped=0;
  try{
    if(Array.isArray(data&&data.groups)){
      data.groups.forEach(function(g){
        var id=String(g&&g.id||"").replace(/[^\w-]/g,"").slice(0,32);
        var nm=String(g&&g.name||"").trim().slice(0,20);
        if(!id||!nm||groupById(id)||watchGroups.some(function(x){return x.name===nm;})) return;
        if(watchGroups.length>=8) return;
        watchGroups.push({id:id,name:nm});
      });
      saveWatchGroups();
    }
  }catch(e){}
  list.forEach(function(x){
    var raw=typeof x==="string"?x:(x&&(x.code||x.symbol)||"");
    raw=String(raw||"").replace(/^(SH|SZ|BJ)/i,"").replace(/\.(SH|SZ|BJ)$/i,"").trim();
    if(!/^\d{6}$/.test(raw)){ skipped++; return; }
    try{ parseInput(raw); }catch(e){ skipped++; return; }
    if(seen[raw]) return;
    seen[raw]=1;
    var gid=String(x&&x.group||"");
    if(!groupById(gid)) gid=activeGroupId();
    out.push({code:raw,name:String((x&&x.name)||old[raw]||""),group:gid});
  });
  if(!out.length){ toast("没有可导入的有效 A 股代码。"); return; }
  if(watchList.length && !window.confirm("导入会覆盖当前 "+watchList.length+" 只关注，继续？")) return;
  watchList=out.slice(0,80);
  if(out.length>80) skipped+=out.length-80;
  if(data&&groupById(String(data.activeGroup||""))) activeWatchGroup=String(data.activeGroup);
  saveWatch();
  watchState.items=[];
  watchState.lastAt=0;
  renderWatchCount();
  setPoolMode("watch");
  refreshWatch(true);
  toast("已导入 "+watchList.length+" 只关注"+(skipped?"，跳过 "+skipped+" 条无效记录":"")+"。");
}
async function importWatchFile(file){
  if(!file) return;
  try{
    var txt=await file.text();
    importWatchData(JSON.parse(txt));
  }catch(e){
    toast("导入失败：文件不是有效的 JSON。");
  }
}

/* =========================================================
   2. 行情拉取
   ========================================================= */
var EM_UT="fa5fd1943c7b386f172d6893dbfba10b";
var CB_SEQ=0;
function emUrl(secid,lmt){
  var p=new URLSearchParams({
    secid:secid, ut:EM_UT,
    fields1:"f1,f2,f3,f4,f5,f6",
    fields2:"f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61",
    klt:"101", fqt:"1", beg:"0", end:"20500101", lmt:String(lmt), _:String(Date.now())
  });
  return "https://push2his.eastmoney.com/api/qt/stock/kline/get?"+p.toString();
}
function jsonp(url,timeout){
  timeout=timeout||7000;
  return new Promise(function(resolve,reject){
    var cb="__em_cb_"+(++CB_SEQ)+"_"+Date.now().toString(36);
    var script=document.createElement("script");
    var settled=false,timer=null;
    function cleanup(keepNoop){
      if(settled) return;
      settled=true;
      if(timer) clearTimeout(timer);
      if(script.parentNode) script.parentNode.removeChild(script);
      if(keepNoop){ window[cb]=function(){}; }
      else { try{ delete window[cb]; }catch(e){ window[cb]=undefined; } }
    }
    window[cb]=function(data){
      if(settled) return;
      cleanup(false);
      resolve(data);
    };
    script.async=true;
    script.onerror=function(){
      if(settled) return;
      cleanup(true);
      reject(new Error("行情脚本加载失败"));
    };
    script.src=url+(url.indexOf("?")>=0?"&":"?")+"cb="+encodeURIComponent(cb);
    timer=setTimeout(function(){
      if(settled) return;
      cleanup(true);
      reject(new Error("行情请求超时"));
    },timeout);
    document.head.appendChild(script);
  });
}
async function fetchJson(url,timeout){
  timeout=timeout||7000;
  var ctl=new AbortController();
  var timer=setTimeout(function(){ ctl.abort(); },timeout);
  try{
    var r=await fetch(url,{signal:ctl.signal,cache:"no-store"});
    if(!r.ok) throw new Error("HTTP "+r.status);
    return await r.json();
  } finally { clearTimeout(timer); }
}
function parseEm(json){
  var d=json&&json.data;
  if(!d||!Array.isArray(d.klines)||!d.klines.length) throw new Error("东方财富返回空行情");
  var rows=d.klines.map(function(line){
    var a=String(line).split(",");
    return {
      date:a[0], open:num(a[1]), close:num(a[2]), high:num(a[3]), low:num(a[4]),
      volume:num(a[5]), amount:num(a[6]), amplitude:num(a[7]),
      pct:num(a[8]), chg:num(a[9]), turnover:num(a[10])
    };
  }).filter(function(r){ return r.date && r.close!=null; });
  if(!rows.length) throw new Error("东方财富返回的K线为空");
  return { name:d.name||"", code:d.code||"", rows:normalizeRows(rows), source:"东方财富" };
}
function parseTx(json,info){
  var node=json&&json.data&&json.data[info.tx];
  var arr=node&&(info.isIndex?node.day:(node.qfqday||node.day));
  if(!Array.isArray(arr)||!arr.length) throw new Error("腾讯行情返回空K线");
  var rows=arr.map(function(a){
    return {date:a[0],open:num(a[1]),close:num(a[2]),high:num(a[3]),low:num(a[4]),volume:num(a[5]),pct:null,turnover:null};
  }).filter(function(r){ return r.date && r.close!=null; });
  if(!rows.length) throw new Error("腾讯行情返回的K线为空");
  return { name:"", code:info.code, rows:normalizeRows(rows), source:"腾讯行情" };
}
function normalizeRows(rows){
  rows.sort(function(a,b){ return String(a.date).localeCompare(String(b.date)); });
  var out=[], seen={};
  rows.forEach(function(r){
    if(seen[r.date]) return;
    seen[r.date]=1;
    out.push(r);
  });
  for(var i=0;i<out.length;i++){
    if(out[i].pct==null){
      out[i].pct = i>0 && out[i-1].close ? (out[i].close/out[i-1].close-1)*100 : 0;
    }
  }
  return out;
}
function cacheKey(secid,lmt){ return "abn.kline.v2:"+secid+":"+lmt; }
function readCache(key,allowStale){
  try{
    var raw=localStorage.getItem(key);
    if(!raw) return null;
    var o=JSON.parse(raw);
    if(!o||!o.v||!o.v.rows||!o.v.rows.length) return null;
    var age=Date.now()-o.t;
    if(!allowStale && age>10*60*1000) return null;
    var v=JSON.parse(JSON.stringify(o.v));
    v.cacheAge=Math.max(0,Math.round(age/60000));
    return v;
  }catch(e){ return null; }
}
function writeCache(key,v){
  try{ localStorage.setItem(key,JSON.stringify({t:Date.now(),v:v})); }catch(e){}
}
var SINA_SEQ=0;
function loadScriptVar(url,varName,timeout){
  return new Promise(function(resolve,reject){
    var s=document.createElement("script");
    var done=false;
    var timer=setTimeout(function(){ fail(new Error("脚本超时")); },timeout||9000);
    function cleanup(){
      clearTimeout(timer);
      s.onload=null; s.onerror=null;
      if(s.parentNode) s.parentNode.removeChild(s);
    }
    function fail(err){ if(done)return; done=true; cleanup(); reject(err); }
    s.onload=function(){
      if(done)return;
      var val=window[varName];
      if(val==null){ fail(new Error("脚本未返回数据")); return; }
      done=true; cleanup();
      try{ delete window[varName]; }catch(e){ window[varName]=undefined; }
      resolve(val);
    };
    s.onerror=function(){ fail(new Error("脚本加载失败")); };
    s.async=true;
    s.src=url;
    document.head.appendChild(s);
  });
}
function loadJsonpCallback(url,varName,timeout){
  return new Promise(function(resolve,reject){
    var done=false, s=document.createElement("script");
    function cleanup(){
      clearTimeout(timer);
      s.onload=null; s.onerror=null;
      if(s.parentNode) s.parentNode.removeChild(s);
      try{ delete window[varName]; }catch(e){ window[varName]=undefined; }
    }
    function fail(err){ if(done)return; done=true; cleanup(); reject(err); }
    window[varName]=function(data){
      if(done)return; done=true; cleanup(); resolve(data);
    };
    var timer=setTimeout(function(){ fail(new Error("脚本超时")); },timeout||9000);
    s.onload=function(){
      if(done)return;
      setTimeout(function(){ if(!done) fail(new Error("脚本未返回数据")); },80);
    };
    s.onerror=function(){ fail(new Error("脚本加载失败")); };
    s.async=true;
    s.src=url;
    document.head.appendChild(s);
  });
}
function parseSina(arr,info){
  if(!Array.isArray(arr)||!arr.length) throw new Error("新浪行情返回空K线");
  var rows=arr.map(function(x){
    return {date:String(x.day||"").slice(0,10),open:num(x.open),close:num(x.close),
      high:num(x.high),low:num(x.low),volume:num(x.volume),pct:null,turnover:null};
  }).filter(function(r){ return r.date && r.close!=null; });
  if(!rows.length) throw new Error("新浪行情返回的K线为空");
  return {name:info.isIndex?(info.name||""):"",code:info.code,rows:normalizeRows(rows),source:"新浪行情"};
}
async function loadSinaQuoteName(info){
  if(info.isIndex) return "";
  var varName="v_"+info.tx;
  var txt=await loadScriptVar("https://qt.gtimg.cn/q="+info.tx,varName,4000);
  var parts=String(txt||"").split("~");
  return parts.length>1?String(parts[1]||"").trim():"";
}
function parseTencentQuote(txt){
  var p=String(txt||"").split("~");
  if(p.length<35) return null;
  var raw=String(p[30]||"").replace(/\D/g,"");
  if(raw.length<12) return null;
  var date=raw.slice(0,4)+"-"+raw.slice(4,6)+"-"+raw.slice(6,8);
  var time=raw.slice(8,10)+":"+raw.slice(10,12)+":"+raw.slice(12,14);
  var price=num(p[3]), open=num(p[5]), prev=num(p[4]);
  if(price==null||open==null||prev==null) return null;
  return {
    name:String(p[1]||"").trim(), code:String(p[2]||"").trim(),
    date:date, time:time, price:price, open:open, prevClose:prev,
    pct:num(p[32]), high:num(p[33]), low:num(p[34]),
    turnover:num(p[38]),
    openPct:open?((price/open-1)*100):null
  };
}
async function loadRealtimeQuote(info){
  if(!info||!info.tx) return null;
  var varName="v_"+info.tx;
  var txt=await loadScriptVar("https://qt.gtimg.cn/q="+info.tx+"&_="+Date.now(),varName,4000);
  return parseTencentQuote(txt);
}
async function loadSinaKline(info,lmt){
  var want=Math.max(60,Math.min(260,Number(lmt)||60));
  var varName="_abn_sina_"+(++SINA_SEQ)+"_"+Date.now();
  var url="https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20"+varName+"=/CN_MarketDataService.getKLineData?symbol="+encodeURIComponent(info.tx)+"&scale=240&ma=no&datalen="+want;
  var arr=await loadScriptVar(url,varName,9000);
  return parseSina(arr,info);
}
async function loadKline(info,lmt){
  var key=cacheKey(info.secid,lmt);
  var fresh=readCache(key,false);
  if(fresh) return fresh;
  var errors=[];
  try{
    var j=await jsonp(emUrl(info.secid,lmt));
    var em=parseEm(j);
    writeCache(key,em);
    return em;
  }catch(e){
    errors.push("东财JSONP: "+e.message);
    try{
      var sina=await loadSinaKline(info,lmt);
      sina.name=info.name||sina.name;
      writeCache(key,sina);
      return sina;
    }catch(e2){ errors.push("新浪: "+e2.message); }
  }
  try{
    var j2=await fetchJson(emUrl(info.secid,lmt));
    var em2=parseEm(j2);
    writeCache(key,em2);
    return em2;
  }catch(e){ errors.push("东财CORS: "+e.message); }
  try{
    var sym=info.tx;
    var txUrl="https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param="+sym+",day,,,"+lmt+",qfq&_="+Date.now();
    var j3=await fetchJson(txUrl);
    var tx=parseTx(j3,info);
    tx.name=info.code;
    writeCache(key,tx);
    return tx;
  }catch(e){ errors.push("腾讯: "+e.message); }
  var stale=readCache(key,true);
  if(stale){ stale.stale=true; return stale; }
  var err=new Error(errors.join("；"));
  err.detail=errors.join("\n");
  throw err;
}

/* =========================================================
   2b. 东方财富盘口异动池
   ========================================================= */
async function loadKlineQuick(info,lmt){
  var key=cacheKey(info.secid,lmt);
  var fresh=readCache(key,false);
  if(fresh) return fresh;
  try{
    var sina=await loadSinaKline(info,lmt);
    sina.name=info.name||sina.name;
    writeCache(key,sina);
    return sina;
  }catch(e){}
  try{
    var j=await jsonp(emUrl(info.secid,lmt),6000);
    var em=parseEm(j);
    writeCache(key,em);
    return em;
  }catch(e){}
  try{
    var j2=await fetchJson(emUrl(info.secid,lmt),6000);
    var em2=parseEm(j2);
    writeCache(key,em2);
    return em2;
  }catch(e){}
  try{
    var txUrl="https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param="+info.tx+",day,,,"+lmt+",qfq&_="+Date.now();
    var j3=await fetchJson(txUrl,6000);
    var tx=parseTx(j3,info);
    tx.name="";
    tx.code=info.code;
    writeCache(key,tx);
    return tx;
  }catch(e){}
  var stale=readCache(key,true);
  if(stale){ stale.stale=true; return stale; }
  return null;
}
function changeTypeLabel(id){
  var t=CHANGE_TYPES.filter(function(x){ return x.id===Number(id); })[0];
  return t?t.label:"盘口异动";
}
function poolEventText(x){
  var evs=(x&&x.events&&x.events.length)?x.events:[(x&&x.event)||"盘口异动"];
  var uniq=[];
  evs.forEach(function(v){ if(v&&uniq.indexOf(v)<0) uniq.push(v); });
  var head=uniq.slice(0,2).join(" / ");
  return head+(uniq.length>2?" +"+(uniq.length-2):"");
}
function parseChanges(json,label){
  var d=json&&json.data;
  var arr=d&&(d.allstock||d.list||d.changes||d.data);
  if(!Array.isArray(arr)&&Array.isArray(d)) arr=d;
  if(!Array.isArray(arr)) return [];
  var out=[];
  arr.forEach(function(x){
    if(!x) return;
    var code=String(x.c!=null?x.c:(x.code!=null?x.code:"")).trim();
    if(!/^\d{6}$/.test(code)) return;
    var board=boardOf(code);
    if(!board) return;
    var price=num(x.p!=null?x.p:x.price);
    if(price!=null && price>3000) price=price/1000;
    var chg=num(x.zd!=null?x.zd:x.chg);
    var pct=num(x.zdf!=null?x.zdf:x.pct);
    if(pct==null && chg!=null && price!=null && price-chg!==0) pct=chg/(price-chg)*100;
    var rawTm=String(x.tm!=null?x.tm:"");
    var tm="";
    if(rawTm.indexOf(":")>=0){
      tm=rawTm.slice(0,5);
    }else{
      var td=rawTm.replace(/\D/g,"");
      if(td.length===3) td="0"+td;
      if(td.length===4 && Number(td.slice(0,2))>23) td="0"+td;
      if(td.length===5) td="0"+td;
      if(td.length>=6) tm=td.slice(0,2)+":"+td.slice(2,4);
      else if(td.length===4) tm=td.slice(0,2)+":"+td.slice(2,4);
      else tm=rawTm;
    }
    var ev=label||changeTypeLabel(x.t);
    out.push({
      code:code, name:String(x.n!=null?x.n:(x.name||code)), board:board, boardName:BOARD_NAMES[board],
      price:price, pct:pct, industry:String(x.hy||x.industry||""), event:ev, eventTime:tm
    });
  });
  return out;
}
async function fetchChangesType(type,label){
  var p=new URLSearchParams({
    type:String(type), ut:EM_CHANGE_UT, pageindex:"0", pagesize:"300",
    dpt:"wzchanges", _:String(Date.now())
  });
  var url="https://push2ex.eastmoney.com/getAllStockChanges?"+p.toString();
  var err="";
  try{
    var j=await fetchJson(url,4500);
    if(j&&j.data) return {items:parseChanges(j,label),error:""};
    var a=parseChanges(j,label);
    if(a.length) return {items:a,error:""};
  }catch(e){ err=e.message; }
  try{
    var j2=await jsonp(url,5000);
    var a2=parseChanges(j2,label);
    if(a2.length) return {items:a2,error:""};
  }catch(e2){ err=err||e2.message; }
  return {items:[],error:err};
}
async function mapLimit(items,limit,fn){
  var i=0, out=new Array(items.length);
  async function worker(){
    while(i<items.length){
      var at=i++;
      out[at]=await fn(items[at],at);
    }
  }
  var n=Math.min(limit,items.length);
  var ws=[];
  for(var k=0;k<n;k++) ws.push(worker());
  await Promise.all(ws);
  return out;
}
function mergeChanges(map,items,label){
  items.forEach(function(x){
    var old=map[x.code];
    if(old){
      if(label && old.events.indexOf(label)<0) old.events.push(label);
      if(!old.name && x.name) old.name=x.name;
      if(old.pct==null && x.pct!=null) old.pct=x.pct;
      if(old.price==null && x.price!=null) old.price=x.price;
    }else{
      x.events=[x.event||label||"盘口异动"];
      map[x.code]=x;
    }
  });
}
async function fetchGainers(){
  var url="https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=80&po=1&np=1"+
    "&ut=bd1d9ddb04089700cf9c27f6f7426281&fltt=2&invt=2&fid=f3"+
    "&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23&fields=f2,f3,f12,f14&_="+Date.now();
  var json=null;
  try{ json=await fetchJson(url,5000); }catch(e){
    try{ json=await jsonp(url,5000); }catch(e2){ return {items:[],error:e2.message}; }
  }
  var d=json&&json.data, arr=d&&(d.diff||d.list);
  if(!Array.isArray(arr)) return {items:[],error:"涨幅榜返回为空"};
  var map={};
  arr.forEach(function(x){
    var code=String(x.f12||"");
    var board=boardOf(code);
    if(!board) return;
    map[code]={
      code:code, name:String(x.f14||code), board:board, boardName:BOARD_NAMES[board],
      price:num(x.f2), pct:num(x.f3), industry:"", event:"涨幅榜",
      eventTime:"", events:["涨幅榜"]
    };
  });
  return {items:Object.keys(map).map(function(k){return map[k];}),error:""};
}
async function fetchChanges(){
  var map={};
  var first=await fetchChangesType(CHANGE_TYPES[0].id,CHANGE_TYPES[0].label);
  if(first.error && !first.items.length){
    var g=await fetchGainers();
    if(g.items.length) return {items:g.items,source:"东财涨幅榜（盘口异动接口失败）"};
    throw new Error("盘口异动接口不可用："+first.error);
  }
  mergeChanges(map,first.items,CHANGE_TYPES[0].label);
  var rest=await mapLimit(CHANGE_TYPES.slice(1),3,function(t){
    return fetchChangesType(t.id,t.label);
  });
  rest.forEach(function(r,i){
    if(r&&r.items&&r.items.length) mergeChanges(map,r.items,CHANGE_TYPES[i+1].label);
  });
  var items=Object.keys(map).map(function(k){return map[k];});
  if(!items.length){
    var g2=await fetchGainers();
    if(g2.items.length) return {items:g2.items,source:"东财涨幅榜（异动池为空）"};
    throw new Error("异动池暂时没有返回标的，请稍后再试。");
  }
  return {items:items,source:"东方财富盘口异动"};
}
function nearestCheck(a){
  var withData=a.checks.filter(function(c){
    return (c.id==="d10"||c.id==="d30")&&c.value!=null;
  });
  if(!withData.length) return null;
  var hit=withData.filter(function(c){ return c.hit; }).sort(function(x,y){ return y.progress-x.progress; })[0];
  if(hit) return hit;
  function gap(c){
    var line=c.value<0?-(c.id==="d10"?50:70):(c.id==="d10"?100:200);
    return Math.abs(line-c.value);
  }
  return withData.slice().sort(function(x,y){ return gap(x)-gap(y); })[0];
}
function spaceFromDev(dev,line){
  if(dev==null||!isFinite(Number(dev))||!isFinite(Number(line))) return null;
  return Math.round(((1+Number(line)/100)/(1+Number(dev)/100)-1)*10000)/100;
}
function triggerSpace(check){
  if(!check || check.value==null) return null;
  var line=check.value<0?-(check.id==="d10"?50:70):(check.id==="d10"?100:200);
  return spaceFromDev(check.value,line);
}
function triggerRule(check){
  if(!check) return "";
  var line=check.value<0?-(check.id==="d10"?50:70):(check.id==="d10"?100:200);
  return (check.id==="d10"?"10日":"30日")+line+"%";
}
function requiredSpaceAt(a,check,offset){
  if(!check||!a||!a.daily||!a.daily.length) return {space:null,hit:false};
  var d=a.daily, last=d[d.length-1];
  if(last.close==null||last.idxClose==null||!last.close) return {space:null,hit:false};
  var w=check.id==="d10"?10:30;
  var line=check.value<0?-(check.id==="d10"?50:70):(check.id==="d10"?100:200);
  if(line<=0) return {space:null,hit:false};
  var price=last.close;
  function devAt(gainPct){
    var rows;
    if(offset){
      rows=d.slice();
      var nd=last.date;
      for(var j=1;j<=offset;j++){
        nd=nextTradeDate(nd);
        rows.push({date:nd,close:j===offset?price*(1+gainPct/100):price,idxClose:last.idxClose});
      }
    }else{
      rows=d.slice();
      rows[rows.length-1]=Object.assign({},last,{close:price*(1+gainPct/100)});
    }
    var arr=maxIntervalDev(rows,w);
    return arr[arr.length-1];
  }
  var dev0=devAt(0);
  if(dev0==null) return {space:null,hit:false};
  if(dev0>=line) return {space:0,hit:true,dev:dev0};
  var lo=0, hi=100;
  while(devAt(hi)<line){
    hi*=2;
    if(hi>10000) return {space:null,hit:false,dev:dev0};
  }
  for(var k=0;k<60;k++){
    var mid=(lo+hi)/2;
    if(devAt(mid)>=line) hi=mid; else lo=mid;
  }
  return {space:Math.round(hi*100)/100,hit:false,dev:dev0};
}
function poolStatusOf(a,best){
  var focusHit=a.checks.some(function(c){ return (c.id==="d10"||c.id==="d30")&&c.hit; });
  if(focusHit) return {key:"sev",text:"严重异动"};
  var p=best?best.progress:0;
  if(p>=0.8) return {key:"near",text:"接近红线"};
  if(p>=0.55) return {key:"watch",text:"值得留意"};
  return {key:"ok",text:"未接近"};
}
async function evaluatePoolItem(item){
  var info=parseInput(item.code);
  var stock=await loadKlineQuick(info,45);
  if(!stock||!stock.rows.length) throw new Error("个股日K拉取失败");
  var idxInfo={
    code:info.index.code, market:info.index.tx.slice(0,2)==="sh"?"sh":"sz",
    board:info.board, boardName:info.boardName, secid:info.index.secid,
    tx:info.index.tx, isIndex:true, index:info.index
  };
  var idx=await loadKlineQuick(idxInfo,60);
  if(!idx||!idx.rows.length) throw new Error("指数日K拉取失败");
  var rows=stock.rows.slice(-45);
  if(rows.length<8) throw new Error("上市时间太短");
  var maxDate=rows[rows.length-1].date;
  var idxRows=idx.rows.filter(function(r){ return r.date<=maxDate; }).slice(-60);
  if(idxRows.length<8) throw new Error("指数数据不足");
  // 盘口价已经属于今天：补一根当日K线，让预测按现价而不是昨收计算。
  // 指数当天涨跌在盘口接口里不可得，这里按 0 处理，只用于池内快速预测；
  // 点开个股后会拉腾讯实时指数，结果以个股详情为准。
  var today=todayYmd();
  var lastRow=rows[rows.length-1];
  if(item.price>0 && lastRow.date<today){
    var prev=lastRow.close;
    var livePct=item.pct!=null?item.pct:(prev?(item.price/prev-1)*100:0);
    rows=rows.concat([{date:today,open:prev,high:item.price,low:prev,close:item.price,volume:0,pct:livePct,turnover:null}]);
    idxRows=idxRows.concat([{date:today,open:idxRows[idxRows.length-1].close,high:idxRows[idxRows.length-1].close,low:idxRows[idxRows.length-1].close,close:idxRows[idxRows.length-1].close,volume:0,pct:0,turnover:null}]);
  }
  var name=stock.name||item.name;
  var isST=/ST/i.test(name);
  var th=thresholds(info.board,isST);
  var a=analyze(rows,idxRows,{
    board:info.board, boardName:info.boardName, isST:isST,
    abn:th.abn, repeat:th.repeat, limit:th.limit,
    name:name, indexName:idx.name||info.index.name, indexCode:info.index.code
  });
  var best=nearestCheck(a);
  var st=poolStatusOf(a,best);
  var last=a.last;
  var pct=item.pct!=null?item.pct:last.pct;
  var bestRange=best?(best.id==="d10"?a.range10:a.range30):null;
  var sp=best?requiredSpaceAt(a,best,0):{space:null,hit:false};
  // 30 日窗口更长，收盘后旧高点基数的影响更大；若当天空间仍小于涨停幅度，
  // 用下一交易日的滚动窗口再核一次，避免“上面小于10%、下面+10%却不触发”的矛盾。
  if(best&&best.id==="d30"&&sp.space!=null&&sp.space<th.limit&&!sp.hit){
    sp=requiredSpaceAt(a,best,1);
  }
  var nsp=best?requiredSpaceAt(a,best,1):{space:null,hit:false};
  return {
    code:item.code, name:name, board:info.board, boardName:info.boardName,
    industry:item.industry||"", pct:pct, price:item.price>0?item.price:last.close,
    event:poolEventText(item),
    eventTime:item.eventTime||"", statusKey:st.key, statusText:st.text,
    progress:best?best.progress:0,
    nearestLabel:best?best.label:"—", nearestValue:best?best.valueText:"—",
    nearestThreshold:best?best.thresholdText:"—", nearestRange:fmtRange(bestRange),
    space:sp.space, spaceRule:best?triggerRule(best):"", spaceHit:!!sp.hit,
    limit:th.limit,
    nextSpace:nsp.space, nextSpaceHit:!!nsp.hit,
    foot:best?best.foot:"数据不足", analysis:a, error:""
  };
}
function compactPoolItem(x){
  return {
    code:x.code,name:x.name,board:x.board,boardName:x.boardName,industry:x.industry,
    pct:x.pct,price:x.price,event:x.event,eventTime:x.eventTime,
    statusKey:x.statusKey,statusText:x.statusText,progress:x.progress,
    nearestLabel:x.nearestLabel,nearestValue:x.nearestValue,
    nearestThreshold:x.nearestThreshold,nearestRange:x.nearestRange||"",
    limit:x.limit,
    space:x.space,spaceRule:x.spaceRule||"",spaceHit:!!x.spaceHit,
    nextSpace:x.nextSpace,nextSpaceHit:!!x.nextSpaceHit,foot:x.foot,error:x.error||""
  };
}
function cachePool(){
  try{
    var items=pool.items.filter(function(x){ return x.statusKey; }).map(compactPoolItem);
    localStorage.setItem(POOL_CACHE_KEY,JSON.stringify({t:Date.now(),source:pool.source,items:items}));
  }catch(e){}
}
function readPoolCache(){
  try{
    var o=JSON.parse(localStorage.getItem(POOL_CACHE_KEY)||"null");
    if(!o||!Array.isArray(o.items)||!o.items.length) return null;
    if(Date.now()-o.t>2*60*60*1000) return null;
    return {items:o.items,source:o.source,age:Math.round((Date.now()-o.t)/60000)};
  }catch(e){ return null; }
}

/* =========================================================
   2c. 交易所重点监控名单
   ========================================================= */
function ymd(v){
  var s=String(v==null?"":v).replace(/\D/g,"").slice(0,8);
  return s.length===8?s.slice(0,4)+"-"+s.slice(4,6)+"-"+s.slice(6):"";
}
function todayYmd(){
  var d=new Date();
  return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
}
function parseMonitor(json){
  var arr=Array.isArray(json)?json:[];
  if(!arr.length && json){
    if(Array.isArray(json.data)) arr=json.data;
    else if(json.data&&Array.isArray(json.data.list)) arr=json.data.list;
    else if(Array.isArray(json.list)) arr=json.list;
  }
  if(!Array.isArray(arr)) return [];
  var today=todayYmd(), out=[], seen={};
  arr.forEach(function(x){
    if(!x) return;
    var code=String(x.STKCODE!=null?x.STKCODE:(x.code||"")).trim();
    var board=boardOf(code);
    var name=String(x.STKNAME!=null?x.STKNAME:(x.name||code)).trim();
    if(!board||seen[code]||/^\*?ST/i.test(name)) return;
    var start=ymd(x.VALIDATESTARTDATE), end=ymd(x.VALIDATEENDDATE);
    if(start && start>today) return;
    if(end && end<today) return;
    seen[code]=1;
    out.push({
      code:code, name:name,
      board:board, boardName:BOARD_NAMES[board], industry:"",
      pct:null, price:null, event:"重点监控", eventTime:"交易所", events:["重点监控"],
      statusKey:"warn", statusText:"重点监控", progress:0,
      startDate:start, endDate:end,
      nearestValue:(start&&end)?(start.slice(5)+"–"+end.slice(5)):"监控中",
      nearestLabel:"监管期",
      nearestThreshold:start?("起 "+start.slice(5)):"重点监控",
      foot:end?("监控至 "+end.slice(5)):"交易所重点监控", monitor:true
    });
  });
  return out;
}
function severeMonitorUrl(cb){
  var p=new URLSearchParams({
    reportName:"RPT_APP_UNUSUALBASIC",
    columns:"SECUCODE,SECURITY_CODE,SECURITY_NAME_ABBR,UNUSUAL_TYPE,START_DATE,END_DATE,INFO_CODE,NOTICE_DATE,PREDICT_START_DATE,PREDICT_END_DATE,IS_HIS,MRAKET_TYPE",
    filter:'(UNUSUAL_TYPE="002")',
    sortColumns:"NOTICE_DATE,END_DATE",
    sortTypes:"-1,-1",
    pageNumber:"1",
    pageSize:"200",
    source:"SECURITIES",
    client:"APP",
    callback:cb
  });
  return MONITOR_SEVERE_URL+"?"+p.toString()+"&_="+Date.now();
}
function parseSevereMonitor(json){
  var arr=json&&json.result&&Array.isArray(json.result.data)?json.result.data:[];
  var today=todayYmd(), out=[], seen={};
  arr.forEach(function(x){
    if(!x) return;
    var code=String(x.SECURITY_CODE||"").trim();
    var name=String(x.SECURITY_NAME_ABBR||code).trim();
    var board=boardOf(code);
    if(!board||seen[code]||/^\*?ST/i.test(name)) return;
    var start=ymd(x.PREDICT_START_DATE), end=ymd(x.PREDICT_END_DATE);
    if(!start||!end||start>today||end<today) return;
    seen[code]=1;
    out.push({
      code:code, name:name,
      board:board, boardName:BOARD_NAMES[board], industry:"",
      pct:null, price:null, event:"严重异动监管", eventTime:"交易所", events:["严重异动监管"],
      statusKey:"warn", statusText:"重点监控", progress:0,
      startDate:start, endDate:end,
      nearestValue:start.slice(5)+"–"+end.slice(5), nearestLabel:"监管期",
      nearestThreshold:"起 "+start.slice(5),
      foot:"监控至 "+end.slice(5), monitor:true
    });
  });
  return out;
}
function parseFallbackMonitor(){
  var today=todayYmd(), out=[];
  MONITOR_FALLBACK.forEach(function(x){
    var board=boardOf(x.code);
    if(!board||/^\*?ST/i.test(x.name)) return;
    if(x.start>today||x.end<today) return;
    out.push({
      code:x.code, name:x.name,
      board:board, boardName:BOARD_NAMES[board], industry:"",
      pct:null, price:null, event:"严重异动监管", eventTime:"交易所", events:["严重异动监管"],
      statusKey:"warn", statusText:"重点监控", progress:0,
      startDate:x.start, endDate:x.end,
      nearestValue:x.start.slice(5)+"–"+x.end.slice(5), nearestLabel:"监管期",
      nearestThreshold:"起 "+x.start.slice(5), foot:"监控至 "+x.end.slice(5), monitor:true
    });
  });
  return out;
}
function mergeMonitorLists(a,b){
  var seen={}, out=[];
  (a||[]).concat(b||[]).forEach(function(x){
    if(!x||!x.code||seen[x.code]) return;
    seen[x.code]=1; out.push(x);
  });
  out.sort(function(x,y){
    return String(y.startDate||"").localeCompare(String(x.startDate||"")) ||
      String(x.code).localeCompare(String(y.code));
  });
  return out;
}
function rebuildMonitorSet(){
  monitorSet={};
  monitor.items.forEach(function(x){ monitorSet[x.code]=true; });
}
function isMonitored(code){ return !!monitorSet[code]; }
async function loadSevereMonitor(){
  var cb="__sm_cb_"+(++CB_SEQ)+"_"+Date.now().toString(36);
  return loadJsonpCallback(severeMonitorUrl(cb),cb,9000);
}
async function loadMonitor(force){
  if(monitor.loading) return;
  if(!force && monitor.items.length) return;
  var token=++monitor.token;
  monitor.loading=true; monitor.error="";
  renderPool();
  try{
    var rs=await Promise.all([
      fetchJson(MONITOR_URL+"?_="+Date.now(),7000).then(function(j){
        return {items:parseMonitor(j),error:""};
      }).catch(function(e){ return {items:[],error:e.message||"风险提示名单失败"}; }),
      loadSevereMonitor().then(function(j){
        return {items:parseSevereMonitor(j),error:""};
      }).catch(function(e){ return {items:[],error:e.message||"严重异动监管名单失败"}; })
    ]);
    if(token!==monitor.token) return;
    var severe=rs[1].items.length?rs[1].items:parseFallbackMonitor();
    monitor.items=mergeMonitorLists(rs[0].items,severe);
    monitor.lastAt=Date.now();
    if(!monitor.items.length && rs[0].error && rs[1].error){
      monitor.error="重点监控名单拉取失败："+rs[0].error+" / "+rs[1].error;
    }
    rebuildMonitorSet();
  }catch(e){
    if(token===monitor.token) monitor.error=e.message||"重点监控名单拉取失败";
  }finally{
    if(token===monitor.token){ monitor.loading=false; renderPool(); }
  }
}

/* 东方财富“严重异动预测”原始表：type=2
   o=2 次日 / o=0 当日；t 为触发所需收盘涨幅。 */
function parsePredict(json){
  var arr=json&&Array.isArray(json.data)?json.data:[];
  var date=json&&json.date?String(json.date):"";
  if(date.length===8) date=date.slice(0,4)+"-"+date.slice(4,6)+"-"+date.slice(6);
  var out=[];
  arr.forEach(function(x){
    if(!x) return;
    var code=String(x.c||"").trim();
    var board=boardOf(code);
    if(!board) return;
    var e=Number(x.e), dev=Number(x.x), trig=Number(x.t), days=Number(x.d);
    if(!(e===4||e===6)) return;
    if(!isFinite(dev)||dev<=0||!isFinite(trig)||trig<=0) return;
    if(!(Number(x.a)>0)) return;
    var state=Number(x.o)===2?"next":"today";
    var line=e===6?200:100;
    var pth=thresholds(board,/ST/i.test(String(x.n||"")));
    out.push({
      code:code, name:String(x.n||code), board:board, boardName:PREDICT_BOARD[Number(x.s)]||BOARD_NAMES[board],
      pct:Number(x.a), days:days, dev:dev, trigger:trig, line:line, limit:pth.limit,
      state:state, statusKey:state, statusText:state==="next"?"次日":"当日",
      rule:PREDICT_RULE[e]||"",
      progress:clamp(dev/line,0,1),
      foot:"距红线 "+(line-dev).toFixed(2)+"pct"
    });
  });
  out.sort(function(a,b){
    var ra=a.state==="next"?0:1, rb=b.state==="next"?0:1;
    return ra-rb;
  });
  return {date:date,items:out};
}
async function loadPredict(force){
  if(predict.loading) return;
  if(!force && predict.items.length) return;
  var token=++predict.token;
  predict.loading=true; predict.error="";
  setPredictBusy(true);
  renderPool();
  try{
    var j=await jsonp(PREDICT_URL+"&_="+Date.now(),8000);
    if(token!==predict.token) return;
    var r=parsePredict(j);
    predict.items=r.items; predict.date=r.date; predict.lastAt=Date.now();
    renderPool();
    // 官方预测只给触发涨幅，触发价需要按现价换算；失败时保留涨幅、触发价显示 —
    await hydratePredictPrices(predict.items);
    await hydratePredictRanges(predict.items,predict.date);
  }catch(e){
    if(token===predict.token) predict.error=e.message||"严重异动预测拉取失败";
  }finally{
    if(token===predict.token){ predict.loading=false; setPredictBusy(false); renderPool(); }
  }
}
async function hydratePredictSpaces(items){
  await mapLimit(items,2,async function(x){
    try{
      var r=await evaluatePoolItem({code:x.code,name:x.name,price:x.price,pct:x.pct});
      x.space=r.space; x.limit=r.limit;
    }catch(e){}
  });
}
async function hydratePredictRanges(items,date){
  if(!items.length||!date) return;
  try{
    var ix=INDEXES.shmain;
    if(!ix) return;
    var k=await loadKlineQuick({secid:ix.secid,code:ix.code,name:ix.name,board:"shmain",tx:ix.tx,isIndex:true},60);
    if(!k||!k.rows||!k.rows.length) return;
    var dates=k.rows.map(function(r){return r.date;});
    if(date>dates[dates.length-1]) dates.push(date);
    var endIdx=dates.length-1;
    while(endIdx>=0&&dates[endIdx]>date) endIdx--;
    if(endIdx<0) return;
    var end=dates[endIdx];
    items.forEach(function(x){
      var si=endIdx-(Number(x.days)||0)+1;
      x.rangeStart=si>=0?dates[si]:"";
      x.rangeEnd=end;
      x.rangeDays=Number(x.days)||0;
      x.rangeText=si>=0?(fmtMD(dates[si])+"–"+fmtMD(end)+" · "+x.days+"日"):("截至 "+fmtMD(end)+" · "+x.days+"日");
    });
  }catch(e){}
}
async function hydratePredictPrices(items){
  var seen={}, uniq=[], prices={};
  items.forEach(function(x){ if(x&&x.code&&!seen[x.code]){ seen[x.code]=1; uniq.push(x); } });
  await mapLimit(uniq,3,async function(x){
    try{
      var info=parseInput(x.code);
      if(!info) return;
      var q=await loadRealtimeQuote(info);
      if(!q||q.price==null) return;
      prices[x.code]={price:q.price,prevClose:q.prevClose,time:q.time};
    }catch(e){}
  });
  // 同一只股票可能同时出现在“次日”和“当日”两条记录里，价格要回填到每一条
  items.forEach(function(x){
    var p=prices[x.code];
    if(!p) return;
    x.price=p.price; x.prevClose=p.prevClose; x.priceTime=p.time;
    // “次日”的 t 是相对今天收盘；“当日”的 t 是相对昨收的当日总涨幅
    var base=x.state==="today"?(p.prevClose!=null?p.prevClose:p.price):p.price;
    x.triggerPrice=base*(1+x.trigger/100);
  });
}
function predictRowHtml(x){
  var watched=isWatched(x.code);
  var isNext=x.state==="next";
  var triggerCls=isNext?"amber":"up";
  var trigPrice=x.triggerPrice!=null?"¥"+fmtPrice(x.triggerPrice):"—";
  var nowPrice=x.price!=null?"¥"+fmtPrice(x.price):"—";
  var line=Number(x.line)||100;
  var todaySpace=spaceFromDev(x.dev,line);
  var nextSpace=isNext&&x.trigger!=null?Number(x.trigger):null;
  var todayHit=x.dev!=null&&Number(x.dev)>=line;
  var spaceCell=function(label,val,hit){
    var tone=hit?"up":"amber";
    var lim=Number(x.limit)||(/^(30|68)/.test(x.code)?20:10);
    var over=val!=null&&val>lim+0.001;
    return '<div class="trigger-space"><span class="space-label">'+label+'</span><b class="'+tone+'"'+(over?' title="触发所需涨幅超过单日涨停，单日涨停也无法触发"':'')+'>'+(hit?"已触发":(val==null?"—":fmtPct(val)+(over?"*":"")))+'</b><small>'+esc(x.rule)+'</small></div>';
  };
  var currentMeta='<small class="pred-x">'+x.days+'日最大涨幅 '+fmtPct(x.dev)+'</small><small class="pred-range">区间 '+esc(x.rangeText||("截至 "+fmtMD(predict.date)))+'</small>';
  var nextMeta=currentMeta;
  if(isNext){
    var nd=nextTradeDate(predict.date);
    var nDays=(Number(x.days)||0)+1;
    var nDev=((1+(Number(x.dev)||0)/100)*(1+(Number(x.trigger)||0)/100)-1)*100;
    var nLine=Number(x.line)||100;
    if(nDev>nLine-0.02) nDev=nLine-0.02; // 触发价就是红线价，展示红线内的最大偏离
    var nStart=x.rangeStart?fmtMD(x.rangeStart):"";
    var nRange=nStart&&nd?(nStart+"–"+fmtMD(nd)+" · "+nDays+"日"):("截至 "+fmtMD(nd||predict.date)+" · "+nDays+"日");
    nextMeta='<small class="pred-x">'+nDays+'日最大涨幅 '+fmtPct(nDev)+'</small><small class="pred-range">区间 '+esc(nRange)+'</small>';
  }
  return '<article class="pool-row predict '+(isNext?"next":"today")+'" data-code="'+esc(x.code)+'">'+
    '<div class="pr-id" data-open-code="'+esc(x.code)+'" role="button" tabindex="0" title="复核 '+esc(x.name)+'">'+
      '<b>'+esc(x.name)+'</b>'+
      '<span>'+esc(x.code)+' · '+esc(x.boardName)+'</span>'+
    '</div>'+
    '<div class="pr-quote"><small class="pred-cap quote-cap">今日</small><span class="pq-line"><b class="'+cls(x.pct)+'">'+fmtPct(x.pct)+'</b><span class="price-hl">'+nowPrice+'</span></span>'+currentMeta+'</div>'+
    '<div class="pr-dev"><small class="pred-cap trig-cap">次日</small><span class="pd-line"><b class="'+triggerCls+'">'+fmtPct(x.trigger)+'</b><span class="price-hl">'+trigPrice+'</span></span>'+nextMeta+'</div>'+
    '<div class="pr-progress"><div class="trigger-spaces pred-spaces">'+spaceCell("当日触发",todaySpace,todayHit)+spaceCell("次日触发",nextSpace,false)+'</div><small class="pred-trigger">触发：'+esc(x.rule)+'</small></div>'+
    '<div class="pr-act">'+
      '<button type="button" class="add'+(watched?" on":"")+'" data-watch-code="'+esc(x.code)+'" data-watch-name="'+esc(x.name)+'">'+(watched?"★ 已关注":"＋ 关注")+'</button>'+
      '<button type="button" class="open" data-open-code="'+esc(x.code)+'">复核 →</button>'+
    '</div>'+
  '</article>';
}

/* =========================================================
   3. 规则分析
   ========================================================= */
function rollingSum(arr,w){
  var out=new Array(arr.length), sum=0;
  for(var i=0;i<arr.length;i++){
    sum+=Number(arr[i])||0;
    if(i>=w) sum-=Number(arr[i-w])||0;
    out[i]=i>=w-1?sum:null;
  }
  return out;
}
function countPriceEvents(events,index,span,dir){
  var c=0;
  for(var i=0;i<events.length;i++){
    var e=events[i];
    if(e.kind!=="abn") continue;
    if(dir && e.dir!==dir) continue;
    if(e.triggerIndex<=index && e.triggerIndex>=index-span+1) c++;
  }
  return c;
}
function collectEpisodes(n,conditionsAt){
  var active={}, out=[];
  for(var i=0;i<n;i++){
    var list=conditionsAt(i)||[], seen={};
    for(var k=0;k<list.length;k++){
      var c=list[k];
      if(!c||!c.key) continue;
      seen[c.key]=1;
      var e=active[c.key];
      if(e){
        e.end=i; e.lastValue=c.value;
        if(c.value!=null && (e.value==null || Math.abs(c.value)>Math.abs(e.value))) e.value=c.value;
        if(c.detail) e.detail=c.detail;
      }else{
        e={
          key:c.key, kind:c.kind, dir:c.dir||0, label:c.label, subtype:c.subtype||"",
          start:c.start==null?i:c.start, triggerIndex:i, end:i,
          value:c.value, firstValue:c.value, lastValue:c.value,
          detail:c.detail||"", threshold:c.threshold==null?null:c.threshold,
          triggerDate:"", startDate:"", endDate:""
        };
        active[c.key]=e;
        out.push(e);
      }
    }
    Object.keys(active).forEach(function(key){
      if(!seen[key]) delete active[key];
    });
  }
  return out;
}
function forwardStats(daily,i,n){
  var j=i+n;
  if(i<0||j>=daily.length) return null;
  var a=daily[i], b=daily[j];
  if(!a.close||!b.close) return null;
  var stock=(b.close/a.close-1)*100;
  var excess=null;
  if(a.idxClose && b.idxClose){
    var idx=(b.idxClose/a.idxClose-1)*100;
    excess=stock-idx;
  }
  return {stock:stock,excess:excess,endDate:b.date};
}
// 区间偏离：个股区间涨幅 − 对应指数区间涨幅（规则原文口径）
function intervalDev(daily,w){
  return daily.map(function(d,i){
    if(i<w) return null;
    var a=daily[i-w];
    if(a.close==null||d.close==null||a.idxClose==null||d.idxClose==null) return null;
    if(!a.close||!a.idxClose) return null;
    return ((d.close/a.close-1)-(d.idxClose/a.idxClose-1))*100;
  });
}
// 10/30日最大涨幅口径：在窗口内逐日尝试起点，取涨幅最大的那个起点。
// 20日、21日下跌时，22日可能才是真正起点；不能固定取窗口首日。
function maxIntervalDev(daily,w){
  return daily.map(function(d,i){
    if(i<w) return null;
    var best=-1, bestGain=-Infinity;
    for(var s=i-w+1;s<=i;s++){
      var b=s-1;
      if(b<0) continue;
      var base=daily[b];
      if(base.close==null||base.idxClose==null||!base.close||!base.idxClose) continue;
      var g=d.close/base.close;
      if(g>bestGain){ bestGain=g; best=b; }
    }
    if(best<0) return null;
    var a=daily[best];
    return ((d.close/a.close-1)-(d.idxClose/a.idxClose-1))*100;
  });
}
function maxIntervalRange(daily,w){
  var last=daily.length-1;
  if(last<w) return null;
  var best=null,bestGain=-Infinity;
  for(var s=last-w+1;s<=last;s++){
    var b=s-1;
    if(b<0) continue;
    var base=daily[b],end=daily[last];
    if(!base||!end||base.close==null||base.idxClose==null||!base.close||!base.idxClose) continue;
    var g=end.close/base.close;
    if(g>bestGain){ bestGain=g; best={startDate:daily[s].date,endDate:end.date,days:last-s+1}; }
  }
  return best;
}
// 未来 10 个交易日：指数不动、逐日取“不触发价格异动”的最大单日涨幅
function futurePlan(daily,opt){
  var last=daily.length-1;
  if(last<30||daily[last].idxClose==null) return [];
  var closes=daily.map(function(d){return d.close;});
  var idxCloses=daily.map(function(d){return d.idxClose;});
  var idxLast=daily[last].idxClose;
  var limit=opt.limit||10;
  var out=[];
  var futureDate=nextTradeDate(daily[last].date);
  for(var k=1;k<=11;k++){
    var i=last+k;
    var prev=closes[i-1];
    if(prev==null) break;
    var cap=prev*(1+limit/100);
    var binding="涨停上限", maxP=cap;
    function bestBase(w){
      // 10日最大涨幅：在最近 w 个交易日里找“起点到当前”涨幅最大的基准日
      // 10日/30日窗口随未来日滚动：每天只看最近 w 个交易日
      var from=Math.max(1,i-w+1), best=-1, bestGain=-Infinity;
      for(var s=from;s<=i;s++){
        var b=s-1;
        if(b<0||closes[b]==null||!closes[b]) continue;
        var g=prev/closes[b];
        if(g>bestGain){ bestGain=g; best=b; }
      }
      return best;
    }
    function applyBound(w,thr,label){
      var b=bestBase(w);
      if(b<0) return;
      var base=closes[b], ib=idxCloses[b];
      if(base==null||ib==null||!base||!ib) return;
      var idxRet=(idxLast/ib-1)*100;
      // 留 0.02pct 余量，避免“最大可涨”刚好落在触发线上
      var p=base*(1+(thr-0.02+idxRet)/100);
      if(p<maxP){ maxP=p; binding=label; }
    }
    applyBound(10,100,"10日 +100%");
    applyBound(30,200,"30日 +200%");
    // 0% 是下限：前一天已经卡住时，第二天不能再跌出“最大可涨”的负数
    var safePx=Math.min(cap,maxP);
    var zeroOver=safePx<prev;
    var px=Math.max(prev,safePx);
    var gain=(px/prev-1)*100;
    closes[i]=px;
    idxCloses[i]=idxLast;
    function devAt(w){
      var b=bestBase(w);
      if(b<0) return null;
      var a=closes[b], ia=idxCloses[b];
      if(a==null||ia==null||!a||!ia) return null;
      return ((px/a-1)-(idxLast/ia-1))*100;
    }
    var d10=devAt(10), d30=devAt(30);
    var b10=daily[bestBase(10)], b30=daily[bestBase(30)];
    var over10=d10!=null&&d10>100.05;
    var over30=d30!=null&&d30>200.05;
    var bindCol=binding.indexOf("10日")===0?"10":(binding.indexOf("30日")===0?"30":"");
    out.push({
      day:k, date:futureDate, gain:gain, maxPrice:px,
      dev10:d10, dev30:d30, binding:binding, bindCol:bindCol,
      zeroOver:zeroOver,
      over10:over10, over30:over30, over:over10||over30,
      base10Date:b10?b10.date:"", base10Pct:b10?b10.pct:null,
      base30Date:b30?b30.date:"", base30Pct:b30?b30.pct:null
    });
    futureDate=nextTradeDate(futureDate);
  }
  return out;
}
function analyze(rows,indexRows,opt){
  var idxMap={};
  indexRows.forEach(function(r){ idxMap[r.date]=r; });
  var missing=0;
  var daily=rows.map(function(r,i){
    var ix=idxMap[r.date];
    if(!ix) missing++;
    var idxPct=ix&&ix.pct!=null?ix.pct:0;
    var pct=r.pct!=null?r.pct:0;
    return {
      i:i,date:r.date,close:r.close,pct:pct,turnover:r.turnover,
      idxClose:ix?ix.close:null,idxPct:idxPct,diff:pct-idxPct,
      dev3:null,dev10:null,dev30:null
    };
  });
  var dev3=intervalDev(daily,3), dev10=maxIntervalDev(daily,10), dev30=maxIntervalDev(daily,30);
  var range10=maxIntervalRange(daily,10), range30=maxIntervalRange(daily,30);
  daily.forEach(function(d,i){ d.dev3=dev3[i]; d.dev10=dev10[i]; d.dev30=dev30[i]; });
  var future=futurePlan(daily,opt);

  var abn=opt.abn;
  var priceConds=function(i){
    var v=dev3[i];
    if(v==null) return [];
    if(v>=abn) return [{key:"abn+",kind:"abn",dir:1,label:"异常波动",subtype:"3日偏离",value:v,start:i-2,threshold:abn,detail:"3日涨幅偏离值首次上穿 +"+abn+"%"}];
    if(v<=-abn) return [{key:"abn-",kind:"abn",dir:-1,label:"异常波动",subtype:"3日偏离",value:v,start:i-2,threshold:abn,detail:"3日跌幅偏离值首次下穿 -"+abn+"%"}];
    return [];
  };
  var priceEvents=collectEpisodes(daily.length,priceConds);

  function turnAt(i){
    if(i<7) return null;
    var t=[],j;
    for(j=i-2;j<=i;j++) t.push(daily[j].turnover);
    var p=[];
    for(j=i-7;j<=i-3;j++) p.push(daily[j].turnover);
    if(t.some(function(x){return x==null;})||p.some(function(x){return x==null;})) return null;
    var sum3=t[0]+t[1]+t[2], sum5=p[0]+p[1]+p[2]+p[3]+p[4];
    if(sum5<=0.001) return null;
    // 规则：3日“日均”换手率 是 前5日“日均”换手率 的 30 倍以上
    var ratio=(sum3/3)/(sum5/5), cum=sum3;
    return {ratio:ratio,cum:cum,avg3:sum3/3,avg5:sum5/5};
  }
  var turnConds=function(i){
    var t=turnAt(i);
    if(!t) return [];
    if(t.ratio>=30 && t.cum>=20){
      return [{key:"turn",kind:"turn",dir:0,label:"换手异动",subtype:"3日换手",value:t.ratio,start:i-2,threshold:30,
        detail:"3日日均换手率为前5日的 "+t.ratio.toFixed(1)+" 倍，累计换手 "+t.cum.toFixed(2)+"%"}];
    }
    return [];
  };
  var turnEvents=collectEpisodes(daily.length,turnConds);

  var sevConds=function(i){
    var out=[], v10=dev10[i], v30=dev30[i];
    if(v10!=null){
      if(v10>=100) out.push({key:"s10+",kind:"sev",dir:1,label:"严重异常波动",subtype:"10日偏离",value:v10,start:i-9,threshold:100,detail:"10日涨幅偏离值累计达到 +100%"});
      if(v10<=-50) out.push({key:"s10-",kind:"sev",dir:-1,label:"严重异常波动",subtype:"10日偏离",value:v10,start:i-9,threshold:50,detail:"10日跌幅偏离值累计达到 -50%"});
    }
    if(v30!=null){
      if(v30>=200) out.push({key:"s30+",kind:"sev",dir:1,label:"严重异常波动",subtype:"30日偏离",value:v30,start:i-29,threshold:200,detail:"30日涨幅偏离值累计达到 +200%"});
      if(v30<=-70) out.push({key:"s30-",kind:"sev",dir:-1,label:"严重异常波动",subtype:"30日偏离",value:v30,start:i-29,threshold:70,detail:"30日跌幅偏离值累计达到 -70%"});
    }
    var cp=countPriceEvents(priceEvents,i,10,1), cn=countPriceEvents(priceEvents,i,10,-1);
    if(cp>=opt.repeat) out.push({key:"rep+",kind:"sev",dir:1,label:"严重异常波动",subtype:"10日同向异动",value:cp,start:i-9,threshold:opt.repeat,detail:"10个交易日内第 "+cp+" 次同向上涨异动"});
    if(cn>=opt.repeat) out.push({key:"rep-",kind:"sev",dir:-1,label:"严重异常波动",subtype:"10日同向异动",value:cn,start:i-9,threshold:opt.repeat,detail:"10个交易日内第 "+cn+" 次同向下跌异动"});
    return out;
  };
  var sevEvents=collectEpisodes(daily.length,sevConds);

  var events=priceEvents.concat(turnEvents,sevEvents);
  events.forEach(function(e){
    e.triggerDate=daily[e.triggerIndex]?daily[e.triggerIndex].date:"";
    e.startDate=daily[e.start]?daily[e.start].date:e.triggerDate;
    e.endDate=daily[e.end]?daily[e.end].date:e.triggerDate;
    e.fwd5=forwardStats(daily,e.triggerIndex,5);
    e.fwd10=forwardStats(daily,e.triggerIndex,10);
    e.fwd20=forwardStats(daily,e.triggerIndex,20);
    if(e.kind==="abn") e.detail=e.detail+"；区间 "+e.startDate+" → "+e.endDate;
    if(e.kind==="sev") e.detail=e.detail+"；区间 "+e.startDate+" → "+e.endDate;
  });
  events.sort(function(a,b){
    if(a.triggerIndex!==b.triggerIndex) return b.triggerIndex-a.triggerIndex;
    var order={sev:0,abn:1,turn:2};
    return (order[a.kind]||9)-(order[b.kind]||9);
  });

  var last=daily.length-1;
  var ld=daily[last];
  var lastTurn=turnAt(last);
  var countUp=countPriceEvents(priceEvents,last,10,1);
  var countDown=countPriceEvents(priceEvents,last,10,-1);
  var hasTurnover=daily.some(function(d){return d.turnover!=null;});

  function devCheck(id,label,value,negLimit,posLimit,thresholdText,span){
    var hit=value!=null && (value>=posLimit || value<=-negLimit);
    var lim=value!=null && value<0?negLimit:posLimit;
    var prog=value==null?0:Math.abs(value)/lim;
    return {
      id:id,group:"sev",label:label,value:value,unit:"%",
      valueText:fmtPct(value),thresholdText:thresholdText,
      hit:hit,near:!hit&&prog>=0.8,
      progress:prog,detail:span+"窗口："+(value==null?"数据不足":fmtPct(value)+"（红线 "+thresholdText+"）"),
      foot:value==null?"数据不足":hit?"已触发":("距红线 "+fmt(Math.abs(lim-Math.abs(value)),2)+"pct")
    };
  }

  var d3hit=ld.dev3!=null && (ld.dev3>=abn || ld.dev3<=-abn);
  var d3prog=ld.dev3==null?0:Math.abs(ld.dev3)/abn;
  var turnHit=!!(lastTurn && lastTurn.ratio>=30 && lastTurn.cum>=20);
  var turnProg=lastTurn?Math.min(lastTurn.ratio/30,lastTurn.cum/20):0;

  var checks=[
    devCheck("d10","10日最大涨幅",ld.dev10,50,100,"+100% / -50%","10日"),
    devCheck("d30","30日最大涨幅",ld.dev30,70,200,"+200% / -70%","30日")
  ];

  var severeHits=checks.filter(function(c){return (c.id==="d10"||c.id==="d30")&&c.hit;});
  var abnHits=[];
  var nearChecks=checks.filter(function(c){return c.near&&(c.id==="d10"||c.id==="d30");});
  var level,title,desc;
  function hitText(c){
    if(c.id==="turn") return "3日换手 "+(c.value?c.value.toFixed(1)+"x":"—")+"（阈值 30x / 累计 20%）";
    if(c.id==="rep") return "10日同向异动 "+c.value+" 次（阈值 "+opt.repeat+" 次）";
    return c.label+" "+c.valueText+"（红线 "+c.thresholdText+"）";
  }
  if(severeHits.length){
    level="sev"; title="触发严重异常波动"; 
    desc=severeHits.map(hitText).join("；")+"。可能进入重点监控与停牌核查范围。";
  }else if(abnHits.length){
    level="abn"; title="触发异常波动";
    desc=abnHits.map(hitText).join("；")+"。达到日常异常波动标准。";
  }else if(nearChecks.length){
    level="watch"; title="接近红线，尚未触发";
    var nrg=nearChecks[0].id==="d10"?range10:range30;
    desc="距离最近的一项："+nearChecks[0].label+" "+nearChecks[0].valueText+"（"+fmtRange(nrg)+"），红线 "+nearChecks[0].thresholdText+"。";
  }else{
    level="ok"; title="当前未触发异常波动";
    desc="10日最大涨幅 "+fmtPct(ld.dev10)+"（"+fmtRange(range10)+"），30日 "+fmtPct(ld.dev30)+"（"+fmtRange(range30)+"）；未触及 10 日 +100% 或 30 日 +200% 严重异动红线。";
  }
  var lastEvent=events.length?events[0]:null;
  var risk=level==="sev"?"高风险":level==="abn"?"关注":level==="watch"?"观察":"正常";

  return {
    daily:daily,events:events,checks:checks,priceEvents:priceEvents,turnEvents:turnEvents,sevEvents:sevEvents,
    last:ld,lastTurn:lastTurn,level:level,title:title,desc:desc,risk:risk,lastEvent:lastEvent,
    countUp:countUp,countDown:countDown,hasTurnover:hasTurnover,missingIndex:missing,
    range10:range10,range30:range30,dev30:ld.dev30,future:future,opt:opt
  };
}

/* =========================================================
   4. 演示数据（虚构）
   ========================================================= */
function mulberry32(a){
  return function(){
    a|=0; a=a+0x6D2B79F5|0;
    var t=Math.imul(a^a>>>15,1|a);
    t=t+Math.imul(t^t>>>7,61|t)^t;
    return ((t^t>>>14)>>>0)/4294967296;
  };
}
function gauss(rng){
  var u=0,v=0;
  while(!u) u=rng();
  while(!v) v=rng();
  return Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);
}
function demoDates(n){
  var d=new Date(Date.UTC(2026,9,30));
  var out=[];
  while(out.length<n){
    var w=d.getUTCDay();
    if(w!==0&&w!==6) out.push(d.toISOString().slice(0,10));
    d.setUTCDate(d.getUTCDate()-1);
  }
  return out.reverse();
}
function makeDemo(){
  var n=260, dates=demoDates(n), rng=mulberry32(20261101);
  var rows=[], idxRows=[];
  var sc=32, ic=3150;
  for(var i=0;i<n;i++){
    var ip=0.03+gauss(rng)*0.85;
    var sp=ip*1.15+gauss(rng)*1.7;
    var turn=1.6+Math.abs(gauss(rng))*1.3;

    if(i>=55&&i<61){ sp=-7.4+gauss(rng)*1.1; turn=8+rng()*8; }
    if(i>=100&&i<103){ sp=11.6+gauss(rng)*0.8; turn=28+rng()*15; }
    if(i>=104&&i<107){ sp=-9.6+gauss(rng)*0.7; turn=22+rng()*12; }
    if(i>=120&&i<130){ sp=9.75+gauss(rng)*0.45; turn=30+rng()*18; }
    if(i>=131&&i<136){ sp=-6.6+gauss(rng)*0.9; turn=18+rng()*10; }
    if(i>=170&&i<174){ sp=12.1+gauss(rng)*0.5; turn=34+rng()*14; }
    if(i>=176&&i<180){ sp=-10.2+gauss(rng)*0.6; turn=24+rng()*12; }
    if(i>=200&&i<204){ sp=11.2+gauss(rng)*0.6; turn=32+rng()*16; }
    if(i>=206&&i<210){ sp=-9.2+gauss(rng)*0.8; turn=20+rng()*10; }
    if(i>=250&&i<257){ sp=10.28+gauss(rng)*0.25; turn=2.0+rng()*1.0; }
    if(i>=257&&i<260){ sp=10.28+gauss(rng)*0.25; turn=118+rng()*28; }

    var open=sc*(1+(gauss(rng)*0.35)/100);
    var close=Math.max(1,sc*(1+sp/100));
    var hi=Math.max(open,close)*(1+Math.abs(gauss(rng))*0.006);
    var lo=Math.min(open,close)*(1-Math.abs(gauss(rng))*0.006);
    rows.push({date:dates[i],open:open,close:close,high:hi,low:lo,volume:1000000+rng()*400000,pct:sp,turnover:turn});
    ic=Math.max(100,ic*(1+ip/100));
    idxRows.push({date:dates[i],open:ic,close:ic,high:ic*1.003,low:ic*0.997,volume:0,pct:ip,turnover:null});
    sc=close;
  }
  return {
    stock:{name:"演示科技（虚构）",code:"300999",rows:rows,source:"演示数据"},
    index:{name:"创业板综（演示）",code:"399102",rows:idxRows,source:"演示数据"},
    info:{code:"300999",market:"sz",board:"gem",boardName:"创业板",secid:"0.300999",tx:"sz300999",index:INDEXES.gem},
    demo:true
  };
}

/* =========================================================
   5. 状态与页面渲染
   ========================================================= */
var state={ data:null, analysis:null, filter:"all", demo:false, loading:false };
var lastQuery=null;
var runSeq=0;
var toastTimer=null;

function toast(msg){
  var el=$("#toast");
  if(!el) return;
  el.textContent=msg;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer=setTimeout(function(){ el.classList.remove("show"); },3200);
}
function setLoading(on,text){
  state.loading=on;
  $("#loadingBox").classList.toggle("hidden",!on);
  if(text) $("#loadingText").textContent=text;
  var b=$("#btnAnalyze");
  b.disabled=on;
  b.textContent=on?"拉取中…":"开始分析";
  if(!on) b.innerHTML='开始分析<kbd>↵</kbd>';
}
function showError(err,code){
  $("#errorBox").classList.remove("hidden");
  $("#emptyState").classList.add("hidden");
  $("#result").classList.add("hidden");
  $("#errorTitle").textContent=code?("无法分析 "+code):"行情拉取失败";
  var msg="行情接口没有返回可用数据。可能是网络 / 代理限制，或接口临时不可用。";
  if(err&&/暂不支持|请输入/.test(err.message)) msg=err.message;
  else if(err&&/不足|无法计算|返回空行情|返回的K线为空/.test(err.message)) msg=err.message;
  $("#errorMsg").textContent=msg;
  var detail=err&&err.detail?err.detail:(err&&err.message!==msg?err.message:"");
  $("#errorDetail").textContent=detail;
}
function clearError(){
  $("#errorBox").classList.add("hidden");
}
function showResult(){
  clearError();
  $("#emptyState").classList.add("hidden");
  $("#result").classList.remove("hidden");
}
function setSourceNote(d){
  var parts=[d.source||"行情"];
  if(d.stale) parts.push("本地缓存：约 "+d.cacheAge+" 分钟前");
  else if(d.cacheAge!=null&&d.cacheAge>0) parts.push("缓存 "+d.cacheAge+" 分钟前");
  if(d.source==="新浪行情") parts.push("复权口径以新浪接口为准");
  else parts.push("前复权");
  if(d.source==="腾讯行情"||d.source==="新浪行情") parts.push("无换手率");
  return parts.join(" · ");
}

function render(data){
  state.data=data;
  state.analysis=data.analysis;
  lastHover=null;
  var s=data.stock, a=data.analysis, rows=a.daily;
  var last=rows[rows.length-1];
  var prev=rows.length>1?rows[rows.length-2]:null;
  var chg=last.pct;
  var rt=a.realtime;
  var closed=!!a.closed;
  var name=s.name||data.info.code;
  var isST=/ST/i.test(name);
  var q=data.info;
  $("#demoBanner").classList.toggle("hidden",!data.demo);

  $("#stockBar").innerHTML=
    '<div style="min-width:0">'+
      '<div class="stock-id"><h2>'+esc(name)+'</h2><span class="code">'+esc(q.code)+'.'+q.market.toUpperCase()+'</span>'+
        '<span class="tag board">'+esc(q.boardName)+'</span>'+(isST?'<span class="tag st">ST / *ST</span>':'')+
        '<button type="button" class="watch-inline'+(isWatched(q.code)?" on":"")+'" data-watch-code="'+esc(q.code)+'" data-watch-name="'+esc(name)+'">'+(isWatched(q.code)?"★ 已关注":"＋ 关注")+'</button>'+
      '</div>'+
      '<div class="stock-date">'+(rt?(closed?'收盘':'实时')+' <b style="color:var(--tx2)">'+esc(rt.date)+' '+esc(rt.time)+'</b>':'数据截至 <b style="color:var(--tx2)">'+esc(last.date)+'</b>')+' · '+esc(setSourceNote(s))+
        (rt?(closed?' · 腾讯行情':' · 实时腾讯'):'')+(a.missingIndex&&!rt?' · 指数缺失 '+a.missingIndex+' 日':'')+
      '</div>'+
    '</div>'+
    '<div class="stock-quote">'+
      '<div><div class="px">'+fmtPrice(last.close)+'</div><div class="meta">'+(rt?(closed?'收盘价':'现价 · 今日实时'):'收盘价')+(s.source==="新浪行情"?"":" · 前复权")+'</div></div>'+
      '<div class="chg '+cls(chg)+'">'+fmtPct(chg)+'</div>'+
      '<div class="meta">'+(prev?'前收 '+fmtPrice(prev.close):'')+'<br>'+esc(a.opt.indexName)+' '+fmtPct(last.idxPct)+(rt?'<br>今开 '+fmtPrice(rt.open)+' · 开盘至今 <b class="'+cls(rt.openPct)+'">'+fmtPct(rt.openPct)+'</b>':'')+'</div>'+
    '</div>';

  renderVerdict(a,last);
  renderMetrics(a);
  renderFuture(a);
  renderRules(data);
  showResult();
}

function renderVerdict(a,last){
  var icon=a.level==="sev"?"!":a.level==="abn"?"!":a.level==="watch"?"·":"✓";
  var rt=a.realtime;
  var closed=!!a.closed;
  var title=a.title;
  if(rt){
    var prefix=closed?"今日收盘：":"当日预测：";
    title=a.level==="sev"?prefix+"触发严重异动":a.level==="watch"?prefix+"接近红线":prefix+"未触发严重异动";
  }
  var meta=rt?((closed?'收盘':'实时')+' <b>'+esc(rt.time)+'</b><br>开盘至今 <b class="'+cls(rt.openPct)+'">'+fmtPct(rt.openPct)+'</b>'):
    ('数据截至 <b>'+esc(last.date)+'</b><br>最近异动 <b>'+(a.lastEvent?esc(a.lastEvent.triggerDate):"—")+'</b>');
  var desc=a.desc;
  if(rt) desc="今日开盘至今 "+fmtPct(rt.openPct)+"（今开 "+fmtPrice(rt.open)+" → "+(closed?"收盘 ":"现价 ")+fmtPrice(rt.price)+"）。"+desc;
  $("#verdict").innerHTML=
    '<div class="verdict '+a.level+'">'+
      '<div class="vmark">'+icon+'</div>'+
      '<div class="vtext"><div class="vtitle">'+esc(title)+'<span class="vbadge">'+esc(a.risk)+'</span></div>'+
        '<p>'+esc(desc)+'</p></div>'+
      '<div class="vmeta">'+meta+'</div>'+
    '</div>';
}

function renderMetrics(a){
  var order=["d10","d30"];
  var html=order.map(function(id){
    var c=a.checks.filter(function(x){return x.id===id;})[0];
    if(!c) return "";
    var hit=c.hit,near=c.near,ref=c.group==="ref";
    var stateCls=ref?"ref":hit?"hit":near?"near":"ok";
    var stateTxt=ref?"参考":hit?"已触发":near?"接近":"未触发";
    if(c.id==="turn"&&c.value==null) { stateTxt="无数据"; stateCls=""; }
    var tone=ref?"refval":(c.id==="turn"||c.id==="rep")?"amber":toneCls(c.value);
    var v=c.valueText;
    if(c.id!=="turn"&&c.id!=="rep"&&c.value!=null) v=v.replace("%","<small>%</small>");
    var prior="";
    if(a.prior && (c.id==="d10"||c.id==="d30")){
      prior='截至昨收 '+fmtPct(c.id==="d10"?a.prior.dev10:a.prior.dev30);
    }
    var label=c.label+(a.realtime?(a.closed?" · 收盘":" · 实时"):"");
    var rg=c.id==="d10"?a.range10:c.id==="d30"?a.range30:null;
    return '<article class="metric '+stateCls+'">'+
      '<div class="m-top"><span class="m-label">'+esc(label)+'</span><span class="state '+stateCls+'">'+stateTxt+'</span></div>'+
      '<div class="m-value '+tone+'">'+v+'</div>'+
      (rg?'<div class="m-range">最大区间 '+esc(fmtRange(rg))+'</div>':'')+
      (prior?'<div class="m-prior">'+prior+'</div>':'')+
      '<div class="m-meter"><i class="'+(tone==="dn"?"dn":tone==="amber"?"amb":"")+'" style="width:'+(ref?0:pctWidth(c.progress))+'"></i><em></em></div>'+
      '<div class="m-foot"><span>'+(ref?"":"红线 ")+esc(c.thresholdText)+'</span><b>'+esc(c.foot)+'</b></div>'+
    '</article>';
  }).join("");
  $("#metrics").innerHTML=html;
}

function buildTodayRow(a){
  var daily=a.daily||[], last=daily.length-1;
  if(last<0) return null;
  var rt=a.realtime;
  var closed=rt?isTimeClosed(rt.time):true;
  var cur=rt&&rt.price!=null?rt.price:daily[last].close;
  var prev=rt&&rt.prevClose!=null?rt.prevClose:(last>0?daily[last-1].close:cur);
  var pct=rt&&rt.dayPct!=null?rt.dayPct:(daily[last].pct!=null?daily[last].pct:0);
  var row={day:0,date:daily[last].date,closed:closed,price:cur,prevClose:prev,currentPct:pct,
           gain:pct,maxPrice:cur,remaining:0,binding:closed?"已收盘":"涨停上限",bindCol:"",
           dev10:a.last.dev10,dev30:a.last.dev30,zeroOver:false,over10:false,over30:false};
  if(closed){
    row.over10=row.dev10!=null&&row.dev10>100.05;
    row.over30=row.dev30!=null&&row.dev30>200.05;
    return row;
  }
  var idxLast=daily[last].idxClose;
  var limit=a.opt&&a.opt.limit||10;
  var cap=prev*(1+limit/100), maxPx=cap, binding="涨停上限", bindCol="";
  function minBase(w){
    var best=null;
    for(var s=Math.max(1,last-w+1);s<=last;s++){
      var b=s-1, d=daily[b];
      if(!d||d.close==null||d.idxClose==null||!d.close||!d.idxClose) continue;
      if(!best||d.close<best.close) best=d;
    }
    return best;
  }
  if(idxLast!=null){
    [[10,100,"10日 +100%","10"],[30,200,"30日 +200%","30"]].forEach(function(t){
      var base=minBase(t[0]);
      if(!base) return;
      var idxRet=(idxLast/base.idxClose-1)*100;
      var bound=base.close*(1+(t[1]-0.02+idxRet)/100);
      if(bound<maxPx){ maxPx=bound; binding=t[2]; bindCol=t[3]; }
    });
  }
  row.zeroOver=maxPx<cur;
  if(row.zeroOver){ maxPx=cur; binding="已越线"; }
  row.maxPrice=maxPx;
  row.gain=(maxPx/prev-1)*100;
  row.remaining=(maxPx/cur-1)*100;
  row.binding=binding; row.bindCol=bindCol;
  if(idxLast!=null){
    [[10,"d10"],[30,"d30"]].forEach(function(t){
      var b=minBase(t[0]);
      if(!b) return;
      row[t[1]]=((maxPx/b.close-1)-(idxLast/b.idxClose-1))*100;
    });
  }
  row.over10=row.dev10!=null&&row.dev10>100.05;
  row.over30=row.dev30!=null&&row.dev30>200.05;
  return row;
}
function todayRowHtml(a){
  var t=buildTodayRow(a);
  if(!t) return "";
  var gain=t.closed?t.currentPct:t.gain;
  var maxPx=t.maxPrice;
  var sub=t.closed?"今日收盘":("当前 "+fmtPct(t.currentPct)+" · 剩余 "+fmtPct(t.remaining));
  var bind=t.closed?"已收盘":(t.zeroOver?(t.bindCol?(t.bindCol==="10"?"10日线":"30日线")+" · 0% 仍越线":"已越线"):t.binding);
  var dev10=t.closed?t.dev10:(a.last.dev10!=null?a.last.dev10+(maxPx/t.price-1)*100:null);
  var dev30=t.closed?t.dev30:(a.last.dev30!=null?a.last.dev30+(maxPx/t.price-1)*100:null);
  var over10=dev10!=null&&dev10>100.05, over30=dev30!=null&&dev30>200.05;
  var d10Cls=(t.bindCol==="10"||over10)?"bindline":"";
  var d30Cls=(t.bindCol==="30"||over30)?"bindline":"";
  var gainCls=cls(gain);
  return '<tr class="today-row'+(t.closed?" closed":"")+'">'+
    '<td><span class="daytag t0">T+0</span><small class="future-extra">'+ (t.closed?"今日收盘":"今日盘中") +' '+fmtMD(t.date)+'</small></td>'+
    '<td><span class="future-gain"><b class="'+gainCls+'">'+fmtPct(gain)+'</b><span class="price-hl">'+(maxPx!=null?"¥"+fmtPrice(maxPx):"—")+'</span></span><small class="day-sub">'+sub+'</small></td>'+
    '<td class="'+d10Cls+'">'+fmtPct(dev10)+(over10?'<small class="bindsmall">已越线</small>':'')+'</td>'+
    '<td class="'+d30Cls+'">'+fmtPct(dev30)+(over30?'<small class="bindsmall">已越线</small>':'')+'</td>'+
    '<td class="dm">'+esc(bind)+'</td>'+
  '</tr>';
}
function renderFuture(a){
  var body=$("#futureBody"), note=$("#futureNote"), todayEl=$("#futureToday");
  if(!body) return;
  if(todayEl){
    if(a.realtime){
      var rt=a.realtime;
      var nd0=a.future&&a.future[0]?a.future[0].date:nextTradeDate(a.last.date);
      if(a.closed){
        todayEl.innerHTML='<span class="ft-label">T+0 下一交易日</span>'+
          '<b class="'+(a.level==="sev"?"up":a.level==="watch"?"amber":"g")+'">'+(a.level==="sev"?"今日触发严重异动":a.level==="watch"?"今日接近红线":"今日未触发")+'</b>'+
          '<span>今日收盘 <b>'+fmtPrice(rt.price)+'</b> <b class="'+cls(rt.dayPct)+'">'+fmtPct(rt.dayPct)+'</b></span>'+
          '<span>当前 10日 <b>'+fmtPct(a.last.dev10)+'</b>（'+esc(fmtRange(a.range10))+'） / 30日 <b>'+fmtPct(a.last.dev30)+'</b>（'+esc(fmtRange(a.range30))+'）</span>'+
          '<em>今天已收盘：T+0 已切到 '+fmtMD(nd0)+'；明早 09:15 起按实时重算。</em>';
      }else{
        todayEl.innerHTML='<span class="ft-label">T+0 盘中</span>'+
          '<b class="'+(a.level==="sev"?"up":a.level==="watch"?"amber":"g")+'">'+(a.level==="sev"?"触发严重异动":a.level==="watch"?"接近红线":"未触发")+'</b>'+
          '<span>今开→现价 <b class="'+cls(rt.openPct)+'">'+fmtPct(rt.openPct)+'</b></span>'+
          '<span>当前 10日 <b>'+fmtPct(a.last.dev10)+'</b>（'+esc(fmtRange(a.range10))+'） / 30日 <b>'+fmtPct(a.last.dev30)+'</b>（'+esc(fmtRange(a.range30))+'）</span>'+
          '<em>T+1 起以现价为起点；今日实际涨幅已计入当前值。</em>';
      }
    }else{
      todayEl.innerHTML='';
    }
  }
  var assumptions='测算假设：T+0 在 09:15–15:00 为当日盘中；15:00 收盘后自动切到下一交易日。T+1 起按大盘不变逐日推算，起点为当日收盘价；指数每天涨跌幅为 0；10/30 日窗口随未来日滚动，每天在最近 10/30 个交易日内搜索涨幅最大的起点；旧涨幅滚出窗口后空间会恢复；再按 10 日 +100%、30 日 +200% 与涨停上限取当天最大值。高亮数字为该日理论收盘价。0% 表示当天已不能再涨；若 0% 仍越线，对应偏离列会标红并注明“已越线”。不含 10 日同向异动次数、停牌与四舍五入，仅为理论空间。';
  if(!a.future||!a.future.length){
    body.innerHTML='<tr><td colspan="5" class="empty">数据不足，至少需要 31 个交易日才能推算</td></tr>';
    if(note) note.textContent=assumptions;
    return;
  }
  var first=a.future[0], bindEl=$("#futureBind"), t0=buildTodayRow(a);
  if(bindEl){
    if(t0&&t0.closed) bindEl.textContent="当前：已收盘 · T+0 为下一交易日";
    else if(t0&&t0.bindCol) bindEl.textContent="当前：卡 "+(t0.bindCol==="10"?"10日":"30日")+"线"+(t0.zeroOver?"（已越线）":"");
    else if(first&&first.zeroOver) bindEl.textContent="当前：卡 "+(first.bindCol==="10"?"10日":"30日")+"线（0% 仍越线）";
    else if(first&&first.bindCol) bindEl.textContent="当前：卡 "+(first.bindCol==="10"?"10日":"30日")+"线";
    else bindEl.textContent="当前：未卡红线";
  }
  if(note){
    var lead=first.zeroOver?'<b>当前 0% 仍会越线。</b> 表中对应偏离列标红；这是滚动窗口换出旧价格造成的，并不代表可以继续上涨。 ':'';
    var zero=a.future.filter(function(f){return f.zeroOver;})[0];
    var next=zero?a.future.filter(function(f){return f.day>zero.day&&f.gain>0;})[0]:null;
    var d2=a.future[1];
    var audit=(d2?'<span class="audit">10日基准取窗口内涨幅最大的起点：T+'+(d2.day)+' 取 '+esc(d2.base10Date||"—")+'（当日 '+fmtPct(d2.base10Pct)+'），而不是窗口首日。</span> ':'')+
      (zero?'<span class="audit">T+'+zero.day+' 为 0%：已贴住 '+(zero.bindCol==="30"?"30":"10")+' 日线，再涨就会突破，所以这里不能按涨停推演'+(next?'；T+'+next.day+' 起旧涨幅滚出窗口，空间恢复。':'。')+'</span> ':'');
    note.innerHTML=lead+audit+assumptions;
  }
  // 15:00 收盘后 T+0 已经切到下一交易日；盘中 T+0 才是今天。
  var isClosed=!!a.closed;
  var rows=(a.future||[]).slice(0,isClosed?11:10);
  body.innerHTML=(isClosed?"":todayRowHtml(a))+rows.map(function(f){
    var label=isClosed?f.day-1:f.day;
    var gainCls=f.gain>0?"r":"dm";
    var bindTxt=f.zeroOver?((f.bindCol==="10"?"10日线":f.bindCol==="30"?"30日线":f.binding)+" · 0% 仍越线"):f.binding;
    var d10Cls=(f.bindCol==="10"||f.over10)?"bindline":"";
    var d30Cls=(f.bindCol==="30"||f.over30)?"bindline":"";
    var d10Over=f.over10?'<small class="bindsmall">已越线</small>':'';
    var d30Over=f.over30?'<small class="bindsmall">已越线</small>':'';
    var t10='10日基准日 '+(f.base10Date||"—")+(f.base10Pct==null?"":"（当日 "+fmtPct(f.base10Pct)+"）");
    var t30='30日基准日 '+(f.base30Date||"—")+(f.base30Pct==null?"":"（当日 "+fmtPct(f.base30Pct)+"）");
    return '<tr class="'+(isClosed&&f.day===1?"today-row ":"")+(f.zeroOver?"binding":"")+'">'+
      '<td><span class="daytag'+(isClosed&&f.day===1?" t0":"")+'">T+'+label+'</span><small class="future-extra">'+(f.date?fmtMD(f.date)+" · ":"")+esc(bindTxt)+'</small></td>'+
      '<td><span class="future-gain"><b class="'+gainCls+'">'+fmtPct(f.gain)+'</b><span class="price-hl">'+(f.maxPrice!=null?"¥"+fmtPrice(f.maxPrice):"—")+'</span></span></td>'+
      '<td class="'+d10Cls+'" title="'+esc(t10)+'">'+fmtPct(f.dev10)+d10Over+'</td>'+
      '<td class="'+d30Cls+'" title="'+esc(t30)+'">'+fmtPct(f.dev30)+d30Over+'</td>'+
      '<td class="dm">'+esc(bindTxt)+'</td>'+
    '</tr>';
  }).join("");
}

function renderChecks(a,last){
  $("#checkSub").textContent="截至 "+last.date+" · "+a.opt.boardName+(a.opt.isST?" · ST":"")+" · 重点关注 10日 +100% / 30日 +200%";
  var order=["d10","d30"];
  $("#checks").innerHTML=order.map(function(id){
    var c=a.checks.filter(function(x){return x.id===id;})[0];
    if(!c) return "";
    var ref=c.group==="ref";
    var noData=(c.id==="turn"&&c.value==null)||c.valueText==="—";
    var stateCls=ref?"ref":noData?"":c.hit?"hit":c.near?"near":"ok";
    var st=ref?"参考":noData?"无数据":c.hit?"触发":c.near?"接近":"未触发";
    return '<div class="check-row '+stateCls+'">'+
      '<span class="dot"></span>'+
      '<div class="check-main"><b>'+esc(c.label)+'</b><small>'+esc(c.detail)+'</small></div>'+
      '<div class="check-val"><b>'+esc(c.valueText)+'</b><small>'+esc(st)+' · 红线 '+esc(c.thresholdText)+'</small></div>'+
    '</div>';
  }).join("");
  var lastEv=a.lastEvent;
  $("#checkNote").innerHTML='<b>最近一次异动：</b>'+(lastEv?esc(lastEv.triggerDate)+' · '+esc(lastEv.label)+' · '+esc(lastEv.subtype):'窗口内未记录')+
    '<br><b>口径：</b>区间“个股涨幅 − 指数涨幅”之差；同向异动按首次上穿计次。'+
    '<br><b>展示：</b>页面只展示 10 日 +100% 与 30 日 +200% 两条价格红线；3 日异常波动仍在后台参与判定。';
}

function eventType(e){
  if(e.kind==="sev") return '<span class="type sev">严重异动</span>';
  if(e.kind==="turn") return '<span class="type turn">换手异动</span>';
  return '<span class="type abn">价格异动</span>';
}
function eventReading(e){
  if(e.kind==="turn"){
    var t=e.detail.match(/累计换手 ([\d.]+)%/);
    return '<div class="read"><b>'+e.value.toFixed(1)+'x</b><small>累计 '+(t?t[1]:'—')+'%</small></div>';
  }
  if(e.kind==="sev"){
    if(e.subtype==="10日同向异动") return '<div class="read"><b>'+e.value+' 次</b><small>10日同向</small></div>';
    return '<div class="read"><b>'+fmtPct(e.value)+'</b><small>'+esc(e.subtype)+'</small></div>';
  }
  return '<div class="read"><b>'+fmtPct(e.value)+'</b><small>'+esc(e.subtype)+' 峰值</small></div>';
}
function fwdCell(f){
  if(!f) return '<div class="fwd"><b class="dm">—</b><small>数据不足</small></div>';
  return '<div class="fwd"><b class="'+cls(f.stock)+'">'+fmtPct(f.stock)+'</b><small class="'+cls(f.excess)+'">超额 '+fmtPct(f.excess)+'</small></div>';
}
function renderRules(data){
  $$("#rules .rule-table tr").forEach(function(tr){ tr.classList.remove("active"); });
  var board=data.info.board;
  var isST=/ST/i.test(data.stock.name||"");
  var sel=isST&&(board==="shmain"||board==="szmain")?"st":board;
  var tr=$('#rules .rule-table tr[data-board="'+sel+'"]');
  if(tr) tr.classList.add("active");
  $("#ruleSub").textContent="当前："+data.info.boardName+(isST?" · ST":"")+" · 只看 10日 +100% / 30日 +200%";
}

/* =========================================================
   5b. 异动池渲染
   ========================================================= */
var POOL_RANK={sev:0,abn:1,near:2,watch:3,warn:3.5,ok:4,error:5,pending:5};
function poolTime(ts){
  if(!ts) return "";
  var d=new Date(ts);
  return String(d.getHours()).padStart(2,"0")+":"+String(d.getMinutes()).padStart(2,"0");
}
function renderWatchCount(){
  var el=$("#watchCount");
  if(el) el.textContent=String(watchList.length);
  var mc=$("#monitorCount");
  if(mc) mc.textContent=monitor.items.length?String(monitor.items.length):(monitor.loading?"…":"0");
}
function poolRowHtml(x){
  var st=x.statusKey||"pending";
  var stText=x.statusText||"计算中…";
  var watched=isWatched(x.code);
  var pct=x.pct;
  var prog=x.progress==null?0:x.progress;
  var barW=st==="sev"||st==="abn"?100:clamp(prog*100,2,100);
  var ev=x.event||"盘口异动";
  var evCls=st==="sev"?"sev":(pct!=null&&pct<0?"dn":"");
  var foot=x.error?x.error:(x.foot||"数据不足");
  var todayTxt=st==="sev"?"当日预测：触发":st==="near"?"当日预测：接近":st==="warn"?"当日：监控":"当日预测：未触发";
  var extra="";
  if(isMonitored(x.code)&&st!=="warn") extra+=' <i class="pool-badge warn">监控中</i>';
  var spaceHtml="";
  if(pool.mode==="watch" && x.space!=null){
    var spaceCell=function(label,val,hit){
      var lim=Number(x.limit)||(/^(30|68)/.test(x.code)?20:10);
      var overLimit=val!=null&&val>lim+0.001;
      var tone=hit?"up":(st==="near"?"amber":"dm");
      return '<div class="trigger-space"><span class="space-label">'+label+'</span><b class="'+tone+'"'+(overLimit?' title="触发所需涨幅超过单日涨停，单日涨停也无法触发"':'')+'>'+(hit?"已触发":(val==null?"—":fmtPct(val)+(overLimit?"*":"")))+'</b><small>'+esc(x.spaceRule)+'</small></div>';
    };
    spaceHtml='<div class="pr-progress"><div class="trigger-spaces">'+spaceCell("当日触发",x.space,x.spaceHit)+spaceCell("次日触发",x.nextSpace,x.nextSpaceHit)+'</div></div>';
  }
  var order="";
  if(pool.mode==="watch"){
    var wi=watchIndex(x.code);
    order='<span class="drag-handle" draggable="true" data-drag-code="'+esc(x.code)+'" title="拖动排序">⋮⋮</span>'+
      '<span class="order-btns">'+
      '<button type="button" class="ord" data-move-code="'+esc(x.code)+'" data-move-dir="top" title="本组置顶" aria-label="本组置顶"'+(wi<=0?" disabled":"")+'>⇈</button>'+
      '<button type="button" class="ord" data-move-code="'+esc(x.code)+'" data-move-dir="-1" title="上移" aria-label="上移"'+(wi<=0?" disabled":"")+'>↑</button>'+
      '<button type="button" class="ord" data-move-code="'+esc(x.code)+'" data-move-dir="1" title="下移" aria-label="下移"'+(wi<0||wi>=groupItems().length-1?" disabled":"")+'>↓</button>'+
      '<button type="button" class="ord" data-move-code="'+esc(x.code)+'" data-move-dir="bottom" title="本组置底" aria-label="本组置底"'+(wi<0||wi>=groupItems().length-1?" disabled":"")+'>⇊</button>'+
    '</span>';
  }
  return '<article class="pool-row '+esc(st)+'" data-code="'+esc(x.code)+'"'+(pool.mode==="watch"?' draggable="true"':'')+'>'+
    '<div class="pr-id" data-open-code="'+esc(x.code)+'" role="button" tabindex="0" title="复核 '+esc(x.name||x.code)+'">'+
      '<b>'+esc(x.name||x.code)+'</b>'+
      '<span>'+esc(x.code)+' · '+esc(x.boardName||"")+' <i class="pool-badge '+esc(st)+'">'+esc(stText)+'</i>'+extra+'</span>'+
    '</div>'+
    '<div class="pr-quote"><b class="'+cls(pct)+'">'+fmtPct(pct)+'</b><span>'+(x.price==null?"—":"¥"+fmtPrice(x.price))+'</span></div>'+
    '<div class="pr-signal"><span class="evtag '+evCls+'" title="'+esc(ev)+'">'+esc(ev)+'</span><small>'+esc(x.eventTime||"盘中")+'</small></div>'+
    '<div class="pr-dev"><b class="'+(st==="sev"||st==="abn"?"up":st==="near"?"amber":"dm")+'">'+esc(x.nearestValue||"—")+'</b><small>'+esc(x.nearestLabel||"最近红线")+' · '+esc(x.nearestThreshold||"")+(x.nearestRange?'<br>最大区间 '+esc(x.nearestRange):'')+'</small></div>'+
    (spaceHtml || '<div class="pr-progress"><div class="pbar"><i style="width:'+barW.toFixed(1)+'%"></i></div><small>'+esc(foot)+'</small><small class="today-flag">'+esc(todayTxt)+'</small></div>')+
    '<div class="pr-act">'+order+
      '<button type="button" class="add'+(watched?" on":"")+'" data-watch-code="'+esc(x.code)+'" data-watch-name="'+esc(x.name||"")+'">'+(watched?(pool.mode==="watch"?"移除":"★ 已关注"):"＋ 关注")+'</button>'+
      '<button type="button" class="open" data-open-code="'+esc(x.code)+'">复核 →</button>'+
    '</div>'+
  '</article>';
}
function sortedPoolItems(){
  return pool.items.slice().sort(function(a,b){
    var ra=POOL_RANK[a.statusKey]==null?9:POOL_RANK[a.statusKey];
    var rb=POOL_RANK[b.statusKey]==null?9:POOL_RANK[b.statusKey];
    if(ra!==rb) return ra-rb;
    return (b.progress||0)-(a.progress||0);
  });
}
function renderPoolList(){
  var box=$("#poolList");
  if(!box) return;
  if(pool.mode==="monitor"){
    if(!monitor.items.length){
      if(monitor.loading) box.innerHTML='<div class="pool-empty"><b>正在拉取重点监控名单</b>交易所重点监控股票，按公告有效期过滤。</div>';
      else if(monitor.error) box.innerHTML='<div class="pool-empty"><b>重点监控名单没有拿到数据</b>点“重点监控”可重试。</div>';
      else box.innerHTML='<div class="pool-empty"><b>当前没有沪深重点监控股票</b>名单只保留仍在监控有效期内的标的。</div>';
      return;
    }
    box.innerHTML=monitor.items.map(poolRowHtml).join("");
    return;
  }
  if(pool.mode==="watch"){
    if(!watchList.length){
      box.innerHTML='<div class="pool-empty"><b>还没有关注股票</b>在“严重异动预测 / 重点监控”里点“＋ 关注”，之后只追踪这些股票。</div>';
      return;
    }
    if(!watchState.items.length){
      box.innerHTML='<div class="pool-empty"><b>正在刷新关注项</b>关注列表每 60 秒自动刷新一次。</div>';
      return;
    }
    var active=groupItems();
    if(!active.length){
      box.innerHTML='<div class="pool-empty"><b>“'+esc(groupName(activeGroupId()))+'”还没有股票</b>点上方其他分组切换，或在添加关注时选择这个分组。</div>';
      return;
    }
    var by={};
    watchState.items.forEach(function(x){ by[x.code]=x; });
    box.innerHTML=active.map(function(w){ return by[w.code]; }).filter(Boolean).map(poolRowHtml).join("");
    return;
  }
  var nexts=predict.items.filter(function(x){return x.state==="next";});
  if(!nexts.length){
    if(predict.loading) box.innerHTML='<div class="pool-empty"><b>正在拉取严重异动预测</b>直接读取东方财富“次日”触发测算。</div>';
    else if(predict.error) box.innerHTML='<div class="pool-empty"><b>严重异动预测没有拿到数据</b>点“扫描异动池”重试；也可以直接输入代码复核个股。</div>';
    else box.innerHTML='<div class="pool-empty"><b>当前没有需要提示的严重异动预测</b>只保留涨幅为正、次日可能触发 10 日 / 30 日红线的标的。</div>';
    return;
  }
  box.innerHTML=nexts.map(predictRowHtml).join("");
}
function renderPoolMeta(){
  var status=$("#poolStatus"), time=$("#poolTime"), prog=$("#poolProgress");
  if(!status) return;
  var rb=$("#btnPredictRefresh");
  if(rb) rb.classList.toggle("hidden", pool.mode!=="near");
  var io=$("#watchIO");
  if(io) io.classList.toggle("hidden", pool.mode!=="watch");
  if(pool.mode==="near"){
    status.textContent=predict.loading?"预测拉取中":"严重异动预测";
    time.textContent=predict.error?predict.error:(predict.date?("东财 · "+predict.date+(predict.lastAt?" "+poolTime(predict.lastAt):"")):"尚未拉取");
    var nn=predict.items.filter(function(x){return x.state==="next";}).length;
    prog.textContent=nn?("次日 "+nn+" 只"):"";
    return;
  }
  if(pool.mode==="watch"){
    status.textContent=watchState.loading?"关注项刷新中":("我的关注 · "+groupName(activeGroupId()));
    time.textContent=watchState.lastAt?("刷新于 "+poolTime(watchState.lastAt)):"关注后每 60 秒刷新";
    prog.textContent=watchList.length?("本组 "+groupItems().length+" 只 / 全部 "+watchList.length+" 只 · 可拖动排序"):"";
    return;
  }
  if(pool.mode==="monitor"){
    status.textContent=monitor.loading?"监控名单拉取中":"重点监控";
    time.textContent=monitor.error?monitor.error:(monitor.lastAt?("东财 · "+poolTime(monitor.lastAt)):"尚未拉取");
    prog.textContent=monitor.items.length?("监管期 "+monitor.items.length+" 只"):"";
    return;
  }
  if(pool.scanning){
    status.textContent="扫描中";
    time.textContent=pool.total?("已算 "+pool.done+" / "+pool.total):"正在拉取盘口异动";
    prog.textContent=pool.total?(Math.round(pool.done/pool.total*100)+"%"):"";
  }else if(pool.lastAt){
    status.textContent="已更新";
    time.textContent=pool.source+" · "+poolTime(pool.lastAt);
    prog.textContent=pool.items.length?("候选 "+pool.items.length+" 只"):"";
  }else{
    status.textContent="等待扫描";
    time.textContent="尚未拉取";
    prog.textContent="";
  }
}
function renderPool(){
  renderWatchCount();
  $$("#poolTabs button").forEach(function(b){ b.classList.toggle("on",b.dataset.mode===pool.mode); });
  renderWatchGroups();
  renderPoolMeta();
  var err=$("#poolError");
  var modeErr=pool.mode==="monitor"?monitor.error:(pool.mode==="near"?predict.error:pool.error);
  if(err){
    if(modeErr){
      err.classList.remove("hidden");
      var retry=pool.mode==="monitor"?' data-monitor-retry="1"':' data-pool-scan="1"';
      err.innerHTML='<b>'+(pool.mode==="monitor"?"重点监控":"扫描")+'失败：</b>'+esc(modeErr)+' <button type="button" class="btn"'+retry+' style="height:24px;padding:2px 8px;font-size:10px;margin-left:6px">重试</button>';
    }else{
      err.classList.add("hidden");
      err.innerHTML="";
    }
  }
  renderPoolList();
}
function setPoolBusy(on){
  var b=$("#btnScan");
  if(!b) return;
  b.disabled=on;
  b.textContent=on?"扫描中…":"扫描异动池";
}
function setPredictBusy(on){
  var b=$("#btnPredictRefresh");
  if(!b) return;
  b.disabled=on;
  b.textContent=on?"刷新中…":"刷新预测";
}
function setPoolMode(mode){
  var valid={near:1,monitor:1,watch:1};
  pool.mode=valid[mode]?mode:"near";
  if(pool.mode==="near" && !predict.items.length && !predict.loading) loadPredict(false);
  if(pool.mode==="watch" && !watchState.items.length && !watchState.loading) refreshWatch(true);
  if(pool.mode==="monitor" && !monitor.items.length && !monitor.loading) loadMonitor(false);
  renderPool();
}
async function scanPool(auto){
  if(pool.mode==="monitor"){ await loadMonitor(true); return; }
  if(pool.mode==="watch"){ await refreshWatch(true); return; }
  if(predict.loading) return;
  setPoolBusy(true);
  try{ await loadPredict(true); }
  finally{ setPoolBusy(false); }
}
async function refreshWatch(force){
  if(!watchList.length){ watchState.items=[]; renderPool(); return; }
  if(watchState.loading) return;
  if(!force && Date.now()-watchState.lastAt<30*1000) return;
  var token=++watchState.token;
  watchState.loading=true;
  watchState.items=watchList.map(function(w){
    return {code:w.code,name:w.name,group:w.group,board:"",boardName:"",pct:null,price:null,event:"个股复核",eventTime:"",statusKey:"pending",statusText:"刷新中",progress:0,nearestValue:"—",nearestLabel:"—",nearestThreshold:"—",foot:"等待计算"};
  });
  if(pool.mode==="watch") renderPool();
  try{
    await mapLimit(watchState.items,3,async function(it){
      try{
        var r=await evaluatePoolItem(it);
        Object.assign(it,r);
      }catch(e){
        it.statusKey="error"; it.statusText="计算失败"; it.foot=e.message||"计算失败"; it.error=e.message||"计算失败";
      }
      if(token!==watchState.token) return;
      if(pool.mode==="watch") renderPool();
    });
    if(token!==watchState.token) return;
    watchState.lastAt=Date.now();
  }finally{
    if(token===watchState.token){
      watchState.loading=false;
      if(pool.mode==="watch") renderPool();
    }
  }
}
function updateWatchButtons(code){
  $$('[data-watch-code="'+code+'"]').forEach(function(b){
    var on=isWatched(code);
    b.classList.toggle("on",on);
    b.textContent=on?(pool.mode==="watch"?"移除":"★ 已关注"):"＋ 关注";
  });
}

/* =========================================================
   6. 图表
   ========================================================= */
var chartGeom=null;
function drawChart(hover){
  var cv=$("#chart");
  if(!cv||!state.analysis) return;
  var rect=cv.getBoundingClientRect();
  var W=Math.max(300,Math.round(rect.width));
  var H=Math.max(300,Math.round(rect.height));
  var dpr=Math.min(2,window.devicePixelRatio||1);
  cv.width=Math.round(W*dpr);
  cv.height=Math.round(H*dpr);
  var ctx=cv.getContext("2d");
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.clearRect(0,0,W,H);

  var all=state.analysis.daily;
  var start=Math.max(0,all.length-120);
  var data=all.slice(start);
  var n=data.length;
  if(n<2) return;

  var padL=52,padR=16,padT=16;
  var priceH=Math.round(H*0.60);
  var devTop=padT+priceH+34;
  var devH=H-devTop-24;
  var plotW=W-padL-padR;
  var step=plotW/n;
  var x=function(i){ return padL+step*(i+0.5); };

  var min=Infinity,max=-Infinity;
  data.forEach(function(d){ if(d.close<min)min=d.close; if(d.close>max)max=d.close; });
  var span=max-min||1;
  min-=span*0.10; max+=span*0.10;
  var y=function(v){ return padT+priceH-(v-min)/(max-min)*priceH; };

  // grid
  ctx.strokeStyle="#182331"; ctx.lineWidth=1;
  for(var g=0;g<=4;g++){
    var gy=padT+priceH*g/4;
    ctx.beginPath(); ctx.moveTo(padL,gy); ctx.lineTo(W-padR,gy); ctx.stroke();
    ctx.fillStyle="#5c6a7d"; ctx.font='10px "Segoe UI","Microsoft YaHei"'; ctx.textAlign="right"; ctx.textBaseline="middle";
    ctx.fillText(fmtPrice(max-(max-min)*g/4),padL-7,gy);
  }

  // area
  var grad=ctx.createLinearGradient(0,padT,0,padT+priceH);
  grad.addColorStop(0,"rgba(77,163,255,.20)");
  grad.addColorStop(.65,"rgba(77,163,255,.045)");
  grad.addColorStop(1,"rgba(77,163,255,0)");
  ctx.beginPath();
  data.forEach(function(d,i){ i?ctx.lineTo(x(i),y(d.close)):ctx.moveTo(x(i),y(d.close)); });
  ctx.lineTo(x(n-1),padT+priceH); ctx.lineTo(x(0),padT+priceH); ctx.closePath();
  ctx.fillStyle=grad; ctx.fill();

  // price line
  ctx.beginPath();
  data.forEach(function(d,i){ i?ctx.lineTo(x(i),y(d.close)):ctx.moveTo(x(i),y(d.close)); });
  ctx.strokeStyle="#8cc6ff"; ctx.lineWidth=1.7; ctx.lineJoin="round"; ctx.lineCap="round";
  ctx.shadowColor="rgba(77,163,255,.45)"; ctx.shadowBlur=7; ctx.stroke(); ctx.shadowBlur=0;

  // deviation panel
  var th=100;
  var maxAbs=th*1.2;
  data.forEach(function(d){ if(d.dev10!=null&&Math.abs(d.dev10)>maxAbs) maxAbs=Math.abs(d.dev10)*1.08; });
  var mid=devTop+devH/2;
  var dy=function(v){ return mid-(v/maxAbs)*(devH/2-4); };

  ctx.strokeStyle="#182331";
  ctx.beginPath(); ctx.moveTo(padL,mid); ctx.lineTo(W-padR,mid); ctx.stroke();
  [th,-th].forEach(function(v){
    ctx.strokeStyle="rgba(243,181,68,.32)"; ctx.setLineDash([4,4]);
    ctx.beginPath(); ctx.moveTo(padL,dy(v)); ctx.lineTo(W-padR,dy(v)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle="rgba(243,181,68,.7)"; ctx.font='9px "Segoe UI"'; ctx.textAlign="left"; ctx.textBaseline="middle";
    ctx.fillText((v>0?"+":"")+v+"%",padL+3,dy(v)-6);
  });

  var bw=Math.max(1.5,step*0.55);
  data.forEach(function(d,i){
    if(d.dev10==null) return;
    var v=clamp(d.dev10,-maxAbs,maxAbs);
    var y0=mid, y1=dy(v);
    ctx.fillStyle=d.dev10>=0?(Math.abs(d.dev10)>=th?"rgba(255,77,87,.85)":"rgba(255,77,87,.35)"):(Math.abs(d.dev10)>=th?"rgba(32,199,122,.85)":"rgba(32,199,122,.35)");
    ctx.fillRect(x(i)-bw/2,Math.min(y0,y1),bw,Math.max(1,Math.abs(y1-y0)));
  });
  ctx.fillStyle="#5c6a7d"; ctx.font='9px "Segoe UI"'; ctx.textAlign="left"; ctx.textBaseline="top";
  ctx.fillText("10日偏离",padL,devTop-12);

  // x labels
  ctx.fillStyle="#5c6a7d"; ctx.font='10px "Segoe UI"'; ctx.textAlign="center"; ctx.textBaseline="top";
  var ticks=Math.min(6,n);
  for(var t=0;t<ticks;t++){
    var idx=Math.round(t*(n-1)/(ticks-1));
    ctx.fillText(data[idx].date.slice(5),x(idx),H-18);
  }

  // event markers
  var marks={};
  state.analysis.events.forEach(function(e){
    if(e.kind==="turn") return;
    if(e.triggerIndex<start) return;
    var i=e.triggerIndex-start;
    if(i<0||i>=n) return;
    var key=e.kind+"|"+e.triggerIndex+"|"+e.dir;
    if(marks[key]) return;
    marks[key]=1;
    var px=x(i), py=y(data[i].close);
    if(e.kind==="sev"){
      ctx.save(); ctx.translate(px,py+(e.dir>0?-20:20)); ctx.rotate(Math.PI/4);
      ctx.fillStyle="#f3b544"; ctx.strokeStyle="#151006"; ctx.lineWidth=1;
      ctx.fillRect(-3.5,-3.5,7,7); ctx.strokeRect(-3.5,-3.5,7,7); ctx.restore();
    }else{
      ctx.beginPath();
      if(e.dir>0){ ctx.moveTo(px,py-9); ctx.lineTo(px-5,py-17); ctx.lineTo(px+5,py-17); }
      else { ctx.moveTo(px,py+9); ctx.lineTo(px-5,py+17); ctx.lineTo(px+5,py+17); }
      ctx.closePath(); ctx.fillStyle=e.dir>0?"#ff4d57":"#20c77a"; ctx.fill();
    }
  });

  // last price dot
  var li=n-1;
  ctx.beginPath(); ctx.arc(x(li),y(data[li].close),3.2,0,Math.PI*2);
  ctx.fillStyle="#8cc6ff"; ctx.fill();
  ctx.strokeStyle="rgba(140,198,255,.25)"; ctx.lineWidth=5; ctx.stroke();

  // hover
  if(hover!=null&&hover>=0&&hover<n){
    var hx=x(hover), hd=data[hover];
    ctx.strokeStyle="rgba(255,255,255,.18)"; ctx.setLineDash([3,3]); ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(hx,padT); ctx.lineTo(hx,devTop+devH); ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(hx,y(hd.close),3.4,0,Math.PI*2); ctx.fillStyle="#fff"; ctx.fill();
    if(hd.dev10!=null){
      var hy=dy(clamp(hd.dev10,-maxAbs,maxAbs));
      ctx.beginPath(); ctx.arc(hx,hy,2.6,0,Math.PI*2); ctx.fillStyle=hd.dev10>=0?"#ff4d57":"#20c77a"; ctx.fill();
    }
  }

  chartGeom={W:W,H:H,padL:padL,padR:padR,plotW:plotW,step:step,n:n,start:start,data:data,priceTop:padT,priceH:priceH,devTop:devTop,devH:devH};
}

function showTip(hover,clientX,clientY){
  var tip=$("#chartTip"), cv=$("#chart");
  if(!chartGeom||hover==null){ tip.classList.add("hidden"); return; }
  var d=chartGeom.data[hover];
  if(!d){ tip.classList.add("hidden"); return; }
  tip.innerHTML=
    '<div class="td">'+esc(d.date)+'</div>'+
    '<div class="tr"><span>收盘</span><b>'+fmtPrice(d.close)+'</b></div>'+
    '<div class="tr"><span>当日涨跌</span><b class="'+cls(d.pct)+'">'+fmtPct(d.pct)+'</b></div>'+
    '<div class="tr"><span>指数涨跌</span><b class="'+cls(d.idxPct)+'">'+fmtPct(d.idxPct)+'</b></div>'+
    '<div class="tr"><span>10日偏离</span><b class="'+cls(d.dev10)+'">'+fmtPct(d.dev10)+'</b></div>'+
    (d.turnover!=null?'<div class="tr"><span>换手率</span><b>'+d.turnover.toFixed(2)+'%</b></div>':'');
  tip.classList.remove("hidden");
  var rect=cv.getBoundingClientRect();
  var x=clientX-rect.left, y=clientY-rect.top;
  var tw=tip.offsetWidth||180, th=tip.offsetHeight||100;
  var offX=cv.offsetLeft, offY=cv.offsetTop;
  var left=x+16+offX;
  if(left+tw>offX+chartGeom.W-8) left=x-tw-16+offX;
  left=Math.max(offX+8,left);
  var top=Math.max(8,Math.min(chartGeom.H-th-8,y-th/2))+offY;
  tip.style.left=left+"px"; tip.style.top=top+"px";
}
function onMove(ev){
  if(!chartGeom) return;
  var cv=$("#chart");
  var rect=cv.getBoundingClientRect();
  var px=ev.clientX-rect.left;
  if(px<chartGeom.padL||px>chartGeom.W-chartGeom.padR){
    if(lastHover!=null){ lastHover=null; drawChart(null); $("#chartTip").classList.add("hidden"); }
    return;
  }
  var idx=Math.floor((px-chartGeom.padL)/chartGeom.step);
  idx=clamp(idx,0,chartGeom.n-1);
  if(idx!==lastHover){
    lastHover=idx;
    drawChart(idx);
    showTip(idx,ev.clientX,ev.clientY);
  }else{
    showTip(idx,ev.clientX,ev.clientY);
  }
}
var lastHover=null;
function onLeave(){
  lastHover=null;
  drawChart(null);
  $("#chartTip").classList.add("hidden");
}

/* =========================================================
   7. 交互与启动
   ========================================================= */
function hideNameSuggest(){
  var box=$("#nameSuggest");
  if(box){ box.classList.add("hidden"); box.innerHTML=""; }
}
function showNameSuggest(items){
  var box=$("#nameSuggest");
  if(!box) return;
  if(!items || !items.length){ hideNameSuggest(); return; }
  box.innerHTML=items.map(function(x){
    return '<button type="button" data-name-code="'+esc(x.code)+'">'+
      '<span class="ns-name">'+esc(x.name||x.code)+'</span>'+
      '<span class="ns-board">'+esc(x.boardName||"")+'</span>'+
      '<span class="ns-code">'+esc(x.code)+'</span>'+
    '</button>';
  }).join("");
  box.classList.remove("hidden");
}
async function runAnalyze(code,opts){
  opts=opts||{};
  var seq=++runSeq;
  var info;
  try{ info=parseInput(code); }
  catch(parseErr){
    if(!/[\u4e00-\u9fa5A-Za-z]/.test(String(code))){
      lastQuery=null; setLoading(false); showError(parseErr,code); return;
    }
    setLoading(true,"正在匹配股票名称…");
    try{ info=await resolveStockInput(code); }
    catch(e){
      if(seq!==runSeq) return;
      setLoading(false);
      if(e.candidates && e.candidates.length){
        showNameSuggest(e.candidates);
        toast("找到多只股票，请从名称列表中选择。");
      }else{
        lastQuery=null;
        showError(e,code);
      }
      return;
    }
    if(seq!==runSeq) return;
    setLoading(false);
  }
  lastQuery=info.code;
  if(!opts.silent) clearError();
  $("#emptyState").classList.add("hidden");
  if(!opts.silent) setLoading(true, opts.demo?"正在生成演示数据…":"正在拉取日K与指数行情…");
  try{
    var lmt=900;
    var indexInfo={code:info.index.code,market:info.index.tx.slice(0,2)==="sh"?"sh":"sz",board:info.board,secid:info.index.secid,tx:info.index.tx,isIndex:true};
    var results=await Promise.all([loadKline(info,lmt),loadKline(indexInfo,600)]);
    var stock=results[0], idx=results[1];
    if(stock && stock.source==="新浪行情" && !stock.name){
      try{ stock.name=await loadSinaQuoteName(info)||stock.name; }catch(e){}
    }
    var asof=$("#asofInput").value;
    var rows=stock.rows;
    if(asof) rows=rows.filter(function(r){ return r.date<=asof; });
    if(rows.length<8) throw new Error("截止 "+asof+" 的有效交易日不足 8 天，无法计算。");
    var maxDate=rows[rows.length-1].date;
    var idxRows=idx.rows.filter(function(r){ return r.date<=maxDate; });
    if(idxRows.length<8) throw new Error("对应指数在截止日前的数据不足。");
    var name=stock.name||info.code;
    var isST=/ST/i.test(name);
    var th=thresholds(info.board,isST);
    var opt={
      board:info.board,boardName:info.boardName,isST:isST,
      abn:th.abn,repeat:th.repeat,limit:th.limit,
      name:name,indexName:idx.name||info.index.name,indexCode:info.index.code
    };
    var priorRows=rows.slice(), priorIdx=idxRows.slice();
    var quote=null, idxQuote=null;
    if(!asof){
      try{
        var qs=await Promise.all([loadRealtimeQuote(info),loadRealtimeQuote(indexInfo)]);
        quote=qs[0]; idxQuote=qs[1];
      }catch(e){}
    }
    if(quote && idxQuote && quote.date===todayYmd() && idxQuote.date===quote.date && quote.price && quote.open && idxQuote.price){
      priorRows=rows.filter(function(r){ return r.date<quote.date; });
      priorIdx=idxRows.filter(function(r){ return r.date<quote.date; });
      if(priorRows.length>=8 && priorIdx.length>=8){
        var liveStock={date:quote.date,open:quote.open,close:quote.price,high:quote.high,low:quote.low,volume:null,pct:quote.pct,turnover:quote.turnover};
        var liveIdx={date:quote.date,open:idxQuote.open,close:idxQuote.price,high:idxQuote.high,low:idxQuote.low,volume:null,pct:idxQuote.pct,turnover:null};
        rows=priorRows.concat(liveStock);
        idxRows=priorIdx.concat(liveIdx);
      }
    }
    var analysis=analyze(rows,idxRows,opt);
    if(quote && rows.length && rows[rows.length-1].date===quote.date && priorRows.length>=8){
      var pa=analyze(priorRows,priorIdx,opt);
      var pc10=pa.checks.filter(function(c){return c.id==="d10";})[0];
      var pc30=pa.checks.filter(function(c){return c.id==="d30";})[0];
      analysis.prior={dev10:pc10?pc10.value:null,dev30:pc30?pc30.value:null,date:priorRows[priorRows.length-1].date};
      analysis.realtime={
        date:quote.date,time:quote.time,open:quote.open,price:quote.price,prevClose:quote.prevClose,
        openPct:quote.openPct,dayPct:quote.pct,
        indexOpenPct:idxQuote.open?((idxQuote.price/idxQuote.open-1)*100):null,
        indexPct:idxQuote.pct
      };
      analysis.closed=isTimeClosed(quote.time);
    }
    var data={stock:stock,index:idx,rows:rows,info:info,analysis:analysis,demo:false};
    if(seq!==runSeq) return;
    render(data);
    if(opts.scroll) setTimeout(function(){ var el=$("#result"); if(el) el.scrollIntoView({behavior:"smooth",block:"start"}); },60);
    if(analysis.daily.length<35) toast("可用交易日不足 35 天，30 日指标与回测会显示“—”。");
    else if(stock.stale) toast("网络不可用，已使用本地缓存（约 "+stock.cacheAge+" 分钟前）。");
  }catch(e){
    if(seq===runSeq && !opts.silent) showError(e,code);
  }finally{
    if(seq===runSeq && !opts.silent) setLoading(false);
  }
}
function loadDemo(){
  var seq=++runSeq;
  lastQuery=null;
  clearError();
  $("#emptyState").classList.add("hidden");
  setLoading(true,"正在生成演示数据…");
  setTimeout(function(){
    if(seq!==runSeq) return;
    try{
      var d=makeDemo();
      var th=thresholds(d.info.board,false);
      d.analysis=analyze(d.stock.rows,d.index.rows,{
        board:d.info.board,boardName:d.info.boardName,isST:false,
        abn:th.abn,repeat:th.repeat,limit:th.limit,
        name:d.stock.name,indexName:d.index.name,indexCode:d.index.code
      });
      d.rows=d.stock.rows;
      render(d);
      toast("演示数据为虚构，仅用于展示计算逻辑。");
    }catch(e){
      if(seq===runSeq) showError(e,"DEMO");
    }finally{
      if(seq===runSeq) setLoading(false);
    }
  },220);
}
function bind(){
  $("#searchForm").addEventListener("submit",function(ev){
    ev.preventDefault();
    var v=$("#codeInput").value.trim();
    if(!v){ $("#codeInput").focus(); return; }
    hideNameSuggest();
    runAnalyze(v);
  });
  var nameTimer=null, nameSeq=0;
  $("#codeInput").addEventListener("input",function(){
    var v=this.value.trim();
    clearTimeout(nameTimer);
    hideNameSuggest();
    if(!/[\u4e00-\u9fa5A-Za-z]/.test(v)||v.length<2) return;
    var seq=++nameSeq;
    nameTimer=setTimeout(async function(){
      try{
        var list=await searchStocks(v);
        if(seq!==nameSeq) return;
        if(list.length) showNameSuggest(list.slice(0,8));
      }catch(e){}
    },280);
  });
  $("#codeInput").addEventListener("keydown",function(ev){
    if(ev.key==="Escape") hideNameSuggest();
  });
  $("#btnDemo").addEventListener("click",loadDemo);
  $("#btnErrorDemo").addEventListener("click",loadDemo);
  $("#btnRetry").addEventListener("click",function(){
    if(lastQuery) runAnalyze(lastQuery);
    else loadDemo();
  });
  $("#btnRules").addEventListener("click",function(){
    var el=$("#rules");
    if(el) el.scrollIntoView({behavior:"smooth",block:"start"});
  });
  $("#btnScan").addEventListener("click",function(){ scanPool(false); });
  $("#btnPredictRefresh").addEventListener("click",function(){ scanPool(false); });
  $("#btnWatchExport").addEventListener("click",exportWatch);
  $("#btnWatchImport").addEventListener("click",function(){ $("#watchFile").click(); });
  $("#watchFile").addEventListener("change",async function(){
    var f=this.files&&this.files[0];
    this.value="";
    await importWatchFile(f);
  });
  $("#btnWatchView").addEventListener("click",function(){
    setPoolMode("watch");
    $("#radar").scrollIntoView({behavior:"smooth",block:"start"});
  });
  $("#poolTabs").addEventListener("click",function(ev){
    var b=ev.target.closest?ev.target.closest("button[data-mode]"):null;
    if(b) setPoolMode(b.dataset.mode);
  });
  $("#watchGroups").addEventListener("click",function(ev){
    var g=ev.target.closest?ev.target.closest("[data-watch-group]"):null;
    if(g){ ev.preventDefault(); activeWatchGroup=g.dataset.watchGroup; saveWatchGroups(); renderPool(); return; }
    var a=ev.target.closest?ev.target.closest("[data-watch-group-add]"):null;
    if(a){
      ev.preventDefault();
      var name=window.prompt("新建分组名称（最多 8 个分组）","分组"+(watchGroups.length+1));
      var created=addWatchGroup(name);
      if(created){ activeWatchGroup=created.id; saveWatchGroups(); renderPool(); }
    }
  });
  $("#watchGroups").addEventListener("dblclick",function(ev){
    var g=ev.target.closest?ev.target.closest("[data-watch-group]"):null;
    if(!g) return;
    var obj=groupById(g.dataset.watchGroup); if(!obj) return;
    var name=window.prompt("重命名分组",obj.name);
    name=String(name||"").trim().slice(0,20);
    if(!name||name===obj.name) return;
    if(watchGroups.some(function(x){return x.id!==obj.id&&x.name===name;})){ toast("已有同名分组。"); return; }
    obj.name=name; saveWatchGroups(); renderPool();
  });
  var dragWatchCode="";
  $("#poolList").addEventListener("dragstart",function(ev){
    var row=ev.target.closest?ev.target.closest(".pool-row"):null;
    if(!row) return;
    var h=ev.target.closest("[data-drag-code]");
    if(!h && ev.target.closest("button,a,input,select")){ ev.preventDefault(); return; }
    dragWatchCode=h?h.dataset.dragCode:row.dataset.code;
    try{ ev.dataTransfer.setData("text/plain",dragWatchCode); ev.dataTransfer.effectAllowed="move"; }catch(e){}
    row.classList.add("dragging");
  });
  $("#poolList").addEventListener("dragover",function(ev){
    if(!dragWatchCode) return;
    var row=ev.target.closest?ev.target.closest(".pool-row"):null;
    if(row){
      ev.preventDefault();
      try{ ev.dataTransfer.dropEffect="move"; }catch(e){}
      $$("#poolList .pool-row").forEach(function(x){ x.classList.toggle("drag-over",x===row); });
    }
  });
  $("#poolList").addEventListener("drop",function(ev){
    if(!dragWatchCode) return;
    var row=ev.target.closest?ev.target.closest(".pool-row"):null;
    if(!row) return;
    ev.preventDefault();
    var target=row.dataset.code;
    var after=false;
    try{ after=ev.clientY>row.getBoundingClientRect().top+row.getBoundingClientRect().height/2; }catch(e){}
    moveWatchTo(dragWatchCode,target,after);
    dragWatchCode="";
    $$("#poolList .pool-row").forEach(function(x){ x.classList.remove("dragging","drag-over"); });
  });
  $("#poolList").addEventListener("dragend",function(){
    dragWatchCode="";
    $$("#poolList .pool-row").forEach(function(x){ x.classList.remove("dragging","drag-over"); });
  });
  document.addEventListener("click",function(ev){
    var pick=ev.target.closest?ev.target.closest("[data-pick-group]"):null;
    if(pick){ ev.preventDefault(); addWatchFromPicker(pick.dataset.pickGroup); return; }
    var pickNew=ev.target.closest?ev.target.closest("[data-pick-new-group]"):null;
    if(pickNew){
      ev.preventDefault();
      var nm=window.prompt("新建分组名称","分组"+(watchGroups.length+1));
      var ng=addWatchGroup(nm);
      if(ng) addWatchFromPicker(ng.id);
      return;
    }
    if(!ev.target.closest("#groupPicker") && !ev.target.closest("[data-watch-code]")) closeGroupPicker();
    if(!ev.target.closest(".search-box")) hideNameSuggest();
    var nb=ev.target.closest?ev.target.closest("[data-name-code]"):null;
    if(nb){
      ev.preventDefault();
      $("#codeInput").value=nb.dataset.nameCode;
      hideNameSuggest();
      runAnalyze(nb.dataset.nameCode);
      return;
    }
    var mb=ev.target.closest?ev.target.closest("[data-move-code]"):null;
    if(mb){
      ev.preventDefault();
      if(!mb.disabled){
        var md=mb.dataset.moveDir;
        moveWatch(mb.dataset.moveCode,md==="top"||md==="bottom"?md:Number(md));
      }
      return;
    }
    var wb=ev.target.closest?ev.target.closest("[data-watch-code]"):null;
    if(wb){
      ev.preventDefault();
      toggleWatch(wb.dataset.watchCode,wb.dataset.watchName||"",wb);
      return;
    }
    var ob=ev.target.closest?ev.target.closest("[data-open-code]"):null;
    if(ob){
      ev.preventDefault();
      runAnalyze(ob.dataset.openCode,{scroll:true});
      return;
    }
    var sb=ev.target.closest?ev.target.closest("[data-pool-scan]"):null;
    if(sb){ ev.preventDefault(); scanPool(false); return; }
    var mrb=ev.target.closest?ev.target.closest("[data-monitor-retry]"):null;
    if(mrb){ ev.preventDefault(); loadMonitor(true); return; }
    var q=ev.target.closest?ev.target.closest(".quick"):null;
    if(q){
      $("#codeInput").value=q.dataset.code;
      runAnalyze(q.dataset.code);
    }
  });
  document.addEventListener("visibilitychange",function(){
    if(!document.hidden && watchList.length && Date.now()-watchState.lastAt>60*1000){
      refreshWatch(true);
    }
  });
  setInterval(function(){
    if(document.hidden) return;
    if(!watchList.length) return;
    if(watchState.loading) return;
    if(Date.now()-watchState.lastAt<60*1000) return;
    refreshWatch(true);
  },60*1000);
  // 当前个股盘中实时刷新：只重拉现价，不改动异动池
  setInterval(function(){
    if(document.hidden || !lastQuery || state.loading) return;
    if($("#result").classList.contains("hidden")) return;
    runAnalyze(lastQuery,{silent:true});
  },30000);
  // 严重异动预测：只在这个 tab 可见时每 30 秒刷新；页面隐藏不自刷
  setInterval(function(){
    if(document.hidden || pool.mode!=="near" || predict.loading) return;
    if(Date.now()-predict.lastAt<30*1000) return;
    loadPredict(true);
  },30000);
  var d=new Date();
  var localDate=d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");
  $("#asofInput").max=localDate;
}
function boot(){
  watchList=readWatch();
  var saved=readPoolCache();
  if(saved){
    pool.items=saved.items;
    pool.source=saved.source||"东方财富盘口异动";
    pool.lastAt=Date.now()-saved.age*60*1000;
  }
  bind();
  loadMonitor(false);
  renderPool();
  var p=new URLSearchParams(location.search);
  if(p.get("demo")==="1"){ loadDemo(); return; }
  var code=p.get("code");
  if(code){ $("#codeInput").value=code; runAnalyze(code); return; }
  var mode=p.get("mode");
  if(mode){ setPoolMode(mode); return; }
  setTimeout(function(){
    if(!document.hidden) scanPool(true);
    $("#codeInput").focus();
  },450);
}

// 计算核心暴露给 Node 测试（浏览器里也可用）
if(typeof window!=="undefined"){
  window.AbnormalCore={parseInput:parseInput,searchStocks:searchStocks,resolveStockInput:resolveStockInput,thresholds:thresholds,analyze:analyze,makeDemo:makeDemo,normalizeRows:normalizeRows,forwardStats:forwardStats,parseChanges:parseChanges,parseMonitor:parseMonitor,parseSevereMonitor:parseSevereMonitor,mergeMonitorLists:mergeMonitorLists,indexes:INDEXES};
}
if(typeof document==="undefined") return;
if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",boot);
else boot();

})();
