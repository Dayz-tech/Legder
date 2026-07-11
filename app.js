/* =========================================================
   LEDGER — Trading Journal
   All data lives in localStorage. Nothing leaves the browser.
   ========================================================= */

const STORAGE_KEY = 'ledger_trades_v1';
const SETTINGS_KEY = 'ledger_settings_v1';

const DEFAULT_SETTINGS = {
  colorWin: '#2FBF8F',
  colorLoss: '#E5484D',
  colorBE: '#6C7A8C',
  startBalance: 10000
};

const CLOUD_ENABLED = typeof SUPABASE_URL !== 'undefined'
  && SUPABASE_URL && SUPABASE_URL !== 'YOUR_SUPABASE_PROJECT_URL';
const sbClient = CLOUD_ENABLED ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

let currentUser = null;

/* ---- local cache (always used as fallback / instant load) ---- */
function loadLocalTrades(){
  try{ const raw = localStorage.getItem(STORAGE_KEY); return raw ? JSON.parse(raw) : []; }
  catch(e){ return []; }
}
function saveLocalTrades(t){ localStorage.setItem(STORAGE_KEY, JSON.stringify(t)); }
function loadLocalSettings(){
  try{ const raw = localStorage.getItem(SETTINGS_KEY); return raw ? {...DEFAULT_SETTINGS, ...JSON.parse(raw)} : {...DEFAULT_SETTINGS}; }
  catch(e){ return {...DEFAULT_SETTINGS}; }
}
function saveLocalSettings(s){ localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }

let trades = loadLocalTrades();
let settings = loadLocalSettings();
let charts = {}; // canvas id -> Chart instance
let calCursor = new Date(); // current month shown in calendar

function setSyncStatus(text, isErr){
  const el = document.getElementById('syncStatus');
  if(!el) return;
  el.textContent = text;
  el.classList.toggle('err', !!isErr);
}

/* ---- cloud sync (fire-and-forget upsert; local cache is source of truth for instant UI) ---- */
let syncTimer = null;
function pushToCloud(){
  saveLocalTrades(trades);
  saveLocalSettings(settings);
  if(!CLOUD_ENABLED || !currentUser) return;
  setSyncStatus('Saving…');
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async ()=>{
    const {error} = await sbClient.from('journal_data').upsert({
      user_id: currentUser.id, trades, settings, updated_at: new Date().toISOString()
    });
    setSyncStatus(error ? 'Sync failed — saved locally' : 'Synced', !!error);
  }, 500);
}
function saveTrades(t){ trades = t; pushToCloud(); }
function saveSettings(s){ settings = s; pushToCloud(); }

async function pullFromCloud(){
  if(!CLOUD_ENABLED || !currentUser) return;
  setSyncStatus('Loading…');
  const {data, error} = await sbClient.from('journal_data').select('*').eq('user_id', currentUser.id).maybeSingle();
  if(error){ setSyncStatus('Could not load cloud data — showing local copy', true); return; }
  if(!data){
    // first login: seed the cloud row with whatever's in the local cache
    await sbClient.from('journal_data').insert({ user_id: currentUser.id, trades, settings });
    setSyncStatus('Synced');
    return;
  }
  trades = data.trades || [];
  settings = {...DEFAULT_SETTINGS, ...(data.settings||{})};
  saveLocalTrades(trades); saveLocalSettings(settings);
  setSyncStatus('Synced');
}

function uid(){ return 't_' + Math.random().toString(36).slice(2,10) + Date.now().toString(36); }

function fmtMoney(n){
  const v = Number(n)||0;
  const sign = v < 0 ? '-' : '';
  return sign + '$' + Math.abs(v).toLocaleString(undefined,{minimumFractionDigits:2, maximumFractionDigits:2});
}
function fmtPct(n){
  if(!isFinite(n)) return '—';
  return (Number(n)||0).toFixed(1) + '%';
}
function fmtNum(n, d=2){
  if(!isFinite(n)) return '—';
  return (Number(n)||0).toFixed(d);
}

/* =========================================================
   NAVIGATION
   ========================================================= */
const views = ['dashboard','calendar','trades','analytics','journal','import','settings'];
function showView(name){
  views.forEach(v=>{
    document.getElementById('view-'+v).classList.toggle('hidden', v!==name);
  });
  document.querySelectorAll('.nav-item').forEach(btn=>{
    btn.classList.toggle('active', btn.dataset.view===name);
  });
  if(name==='dashboard') renderDashboard();
  if(name==='calendar') renderCalendar();
  if(name==='trades') renderTradeTable();
  if(name==='analytics') renderAnalytics();
  if(name==='journal') renderJournal();
  if(name==='settings') renderSettingsView();
}
document.querySelectorAll('.nav-item').forEach(btn=>{
  btn.addEventListener('click', ()=> showView(btn.dataset.view));
});

/* =========================================================
   METRICS ENGINE
   ========================================================= */
function dayOfWeekName(dateStr){
  const d = new Date(dateStr+'T00:00:00');
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
}
function monthLabel(dateStr){
  const d = new Date(dateStr+'T00:00:00');
  return d.toLocaleString('default',{month:'short', year:'numeric'});
}
function holdingMinutes(t){
  if(!t.timeIn || !t.timeOut) return null;
  const [ih,im] = t.timeIn.split(':').map(Number);
  const [oh,om] = t.timeOut.split(':').map(Number);
  let mins = (oh*60+om) - (ih*60+im);
  if(mins < 0) mins += 24*60;
  return mins;
}
function sortedByDateTime(list){
  return [...list].sort((a,b)=>{
    const da = a.date + ' ' + (a.timeIn||'00:00');
    const db = b.date + ' ' + (b.timeIn||'00:00');
    return da.localeCompare(db);
  });
}
function groupSum(list, keyFn){
  const map = {};
  list.forEach(t=>{
    const k = keyFn(t);
    if(k===undefined || k===null || k==='') return;
    if(!map[k]) map[k] = {sum:0, count:0, wins:0};
    map[k].sum += Number(t.result)||0;
    map[k].count += 1;
    if(Number(t.result) > 0) map[k].wins += 1;
  });
  return map;
}

function computeMetrics(list){
  const ordered = sortedByDateTime(list);
  const n = ordered.length;
  const wins = ordered.filter(t=>Number(t.result) > 0);
  const losses = ordered.filter(t=>Number(t.result) < 0);
  const be = ordered.filter(t=>Number(t.result) === 0);

  const grossProfit = wins.reduce((s,t)=>s+Number(t.result),0);
  const grossLoss = losses.reduce((s,t)=>s+Number(t.result),0); // negative
  const netProfit = grossProfit + grossLoss;

  const winRate = n ? (wins.length/n*100) : 0;
  const lossRate = n ? (losses.length/n*100) : 0;
  const avgWin = wins.length ? grossProfit/wins.length : 0;
  const avgLoss = losses.length ? grossLoss/losses.length : 0; // negative
  const largestWin = wins.length ? Math.max(...wins.map(t=>Number(t.result))) : 0;
  const largestLoss = losses.length ? Math.min(...losses.map(t=>Number(t.result))) : 0;
  const profitFactor = grossLoss !== 0 ? Math.abs(grossProfit/grossLoss) : (grossProfit>0 ? Infinity : 0);
  const expectancy = n ? ((winRate/100)*avgWin + (lossRate/100)*avgLoss) : 0;

  const rrVals = ordered.map(t=>Number(t.rr)).filter(v=>isFinite(v) && v!==0);
  const avgRR = rrVals.length ? rrVals.reduce((a,b)=>a+b,0)/rrVals.length : 0;

  const holdVals = ordered.map(holdingMinutes).filter(v=>v!==null && isFinite(v));
  const avgHoldMin = holdVals.length ? holdVals.reduce((a,b)=>a+b,0)/holdVals.length : 0;

  // equity & drawdown
  let equity = settings.startBalance || 0;
  const equityCurve = []; // {label, value}
  let peak = equity;
  const drawdownCurve = []; // {label, pct}
  let maxDD = 0; // most negative %
  ordered.forEach(t=>{
    equity += Number(t.result)||0;
    equityCurve.push({label:t.date, value:equity});
    if(equity > peak) peak = equity;
    const ddPct = peak>0 ? ((equity-peak)/peak*100) : 0;
    drawdownCurve.push({label:t.date, value:ddPct});
    if(ddPct < maxDD) maxDD = ddPct;
  });
  const recoveryFactor = maxDD !== 0 ? Math.abs(netProfit/(Math.abs(maxDD)/100*(settings.startBalance||1))) : (netProfit>0?Infinity:0);

  // streaks
  let curStreak = 0, curType = null, maxWinStreak = 0, maxLossStreak = 0, runW=0, runL=0;
  ordered.forEach(t=>{
    const r = Number(t.result);
    if(r>0){ runW+=1; runL=0; maxWinStreak=Math.max(maxWinStreak,runW); }
    else if(r<0){ runL+=1; runW=0; maxLossStreak=Math.max(maxLossStreak,runL); }
    else { runW=0; runL=0; }
  });
  // current streak = trailing run at the end
  for(let i=ordered.length-1;i>=0;i--){
    const r = Number(ordered[i].result);
    if(i===ordered.length-1){ curType = r>0?'win':(r<0?'loss':'be'); }
    const t = r>0?'win':(r<0?'loss':'be');
    if(t!==curType) break;
    curStreak++;
  }

  const byPair = groupSum(ordered, t=>t.pair);
  const bySession = groupSum(ordered, t=>t.session);
  const byDow = groupSum(ordered, t=>dayOfWeekName(t.date));
  const byMonth = groupSum(ordered, t=>monthLabel(t.date));
  const byStrategy = groupSum(ordered, t=>t.strategy);
  const byHour = groupSum(ordered, t=> t.timeIn ? t.timeIn.split(':')[0]+':00' : null);

  const bestOf = (map)=>{
    let best=null,bv=-Infinity;
    Object.entries(map).forEach(([k,v])=>{ if(v.sum>bv){bv=v.sum;best=k;} });
    return best;
  };
  const worstOf = (map)=>{
    let worst=null,wv=Infinity;
    Object.entries(map).forEach(([k,v])=>{ if(v.sum<wv){wv=v.sum;worst=k;} });
    return worst;
  };

  return {
    n, wins, losses, be, grossProfit, grossLoss, netProfit,
    winRate, lossRate, avgWin, avgLoss, largestWin, largestLoss,
    profitFactor, expectancy, avgRR, avgHoldMin,
    equityCurve, drawdownCurve, maxDD, recoveryFactor,
    curStreak, curType, maxWinStreak, maxLossStreak,
    byPair, bySession, byDow, byMonth, byStrategy, byHour,
    bestPair: bestOf(byPair), worstPair: worstOf(byPair),
    bestSession: bestOf(bySession), worstSession: worstOf(bySession),
    bestDay: bestOf(byDow), bestMonth: bestOf(byMonth)
  };
}

/* =========================================================
   DASHBOARD
   ========================================================= */
function filterByRange(range){
  if(range==='all') return trades;
  const now = new Date();
  if(range==='ytd'){
    const start = new Date(now.getFullYear(),0,1);
    return trades.filter(t=> new Date(t.date+'T00:00:00') >= start);
  }
  const days = Number(range);
  const start = new Date(now); start.setDate(start.getDate()-days);
  return trades.filter(t=> new Date(t.date+'T00:00:00') >= start);
}

function statCard(label, value, sub='', cls=''){
  return `<div class="stat-card">
    <div class="stat-label">${label}</div>
    <div class="stat-value ${cls}">${value}</div>
    ${sub ? `<div class="stat-sub">${sub}</div>` : ''}
  </div>`;
}

function renderDashboard(){
  document.getElementById('sidebarNetPnl').textContent = fmtMoney(computeMetrics(trades).netProfit);
  const range = document.getElementById('dashRange').value;
  const list = filterByRange(range);
  const m = computeMetrics(list);

  const cards = [
    statCard('Total trades', m.n),
    statCard('Wins', m.wins.length, `${m.losses.length} losses · ${m.be.length} BE`),
    statCard('Win rate', fmtPct(m.winRate)),
    statCard('Loss rate', fmtPct(m.lossRate)),
    statCard('Net profit', fmtMoney(m.netProfit), '', m.netProfit>=0?'pos':'neg'),
    statCard('Gross profit', fmtMoney(m.grossProfit), '', 'pos'),
    statCard('Gross loss', fmtMoney(m.grossLoss), '', 'neg'),
    statCard('Profit factor', fmtNum(m.profitFactor)),
    statCard('Expectancy / trade', fmtMoney(m.expectancy)),
    statCard('Average win', fmtMoney(m.avgWin), '', 'pos'),
    statCard('Average loss', fmtMoney(m.avgLoss), '', 'neg'),
    statCard('Largest win', fmtMoney(m.largestWin), '', 'pos'),
    statCard('Largest loss', fmtMoney(m.largestLoss), '', 'neg'),
    statCard('Average RR', fmtNum(m.avgRR)),
    statCard('Avg holding time', m.avgHoldMin ? fmtNum(m.avgHoldMin,0)+' min' : '—'),
    statCard('Max drawdown', fmtPct(m.maxDD)),
    statCard('Recovery factor', fmtNum(m.recoveryFactor)),
    statCard('Sharpe ratio', 'Coming soon'),
    statCard('Best pair', m.bestPair || '—'),
    statCard('Worst pair', m.worstPair || '—'),
    statCard('Best session', m.bestSession || '—'),
    statCard('Worst session', m.worstSession || '—'),
    statCard('Best day', m.bestDay || '—'),
    statCard('Best month', m.bestMonth || '—'),
    statCard('Current streak', m.n ? `${m.curStreak} ${m.curType}` : '—'),
    statCard('Max win streak', m.maxWinStreak),
    statCard('Max loss streak', m.maxLossStreak),
  ];
  document.getElementById('dashCards').innerHTML = cards.join('');

  renderChartEquity(m);
  renderChartWinLoss(m);
  renderChartDrawdown(m);
  renderChartByPair(m, 'chartByPair', 6);

  const insights = [];
  if(m.bestPair) insights.push(insightCard('Strongest pair', m.bestPair, fmtMoney(m.byPair[m.bestPair].sum)));
  if(m.worstPair) insights.push(insightCard('Weakest pair', m.worstPair, fmtMoney(m.byPair[m.worstPair].sum)));
  if(m.bestSession) insights.push(insightCard('Best session', m.bestSession, fmtMoney(m.bySession[m.bestSession].sum)));
  if(m.bestDay) insights.push(insightCard('Best day', m.bestDay, fmtMoney(m.byDow[m.bestDay].sum)));
  document.getElementById('insightRow').innerHTML = insights.join('');
}
function insightCard(label, val, sub){
  return `<div class="insight-card"><div class="stat-label">${label}</div><div class="stat-value">${val}</div><div class="stat-sub">${sub}</div></div>`;
}
document.getElementById('dashRange').addEventListener('change', renderDashboard);

/* ---- charts (dashboard) ---- */
function destroyChart(id){ if(charts[id]){ charts[id].destroy(); delete charts[id]; } }
const CHART_GRID = 'rgba(255,255,255,0.06)';
const CHART_TEXT = '#8B93A3';
Chart.defaults.font.family = "'Inter', sans-serif";
Chart.defaults.color = CHART_TEXT;

function renderChartEquity(m){
  destroyChart('chartEquity');
  const ctx = document.getElementById('chartEquity');
  charts.chartEquity = new Chart(ctx, {
    type:'line',
    data:{ labels: m.equityCurve.map(p=>p.label),
      datasets:[{ data: m.equityCurve.map(p=>p.value), borderColor: settings.colorWin, backgroundColor:'transparent', borderWidth:2, pointRadius:0, tension:.15 }]},
    options: baseLineOpts()
  });
}
function renderChartDrawdown(m){
  destroyChart('chartDrawdown');
  const ctx = document.getElementById('chartDrawdown');
  charts.chartDrawdown = new Chart(ctx, {
    type:'line',
    data:{ labels: m.drawdownCurve.map(p=>p.label),
      datasets:[{ data: m.drawdownCurve.map(p=>p.value), borderColor: settings.colorLoss, backgroundColor:'rgba(229,72,77,0.12)', fill:true, borderWidth:1.5, pointRadius:0, tension:.15 }]},
    options: baseLineOpts()
  });
}
function renderChartWinLoss(m){
  destroyChart('chartWinLoss');
  const ctx = document.getElementById('chartWinLoss');
  charts.chartWinLoss = new Chart(ctx, {
    type:'doughnut',
    data:{ labels:['Wins','Losses','Breakeven'], datasets:[{ data:[m.wins.length,m.losses.length,m.be.length],
      backgroundColor:[settings.colorWin, settings.colorLoss, settings.colorBE], borderWidth:0 }]},
    options:{ plugins:{ legend:{ position:'bottom', labels:{boxWidth:10, padding:14} } }, cutout:'62%' }
  });
}
function renderChartByPair(m, canvasId, limit){
  destroyChart(canvasId);
  const ctx = document.getElementById(canvasId);
  let entries = Object.entries(m.byPair).map(([k,v])=>[k,v.sum]).sort((a,b)=>b[1]-a[1]);
  if(limit) entries = entries.slice(0,limit);
  charts[canvasId] = new Chart(ctx, {
    type:'bar',
    data:{ labels: entries.map(e=>e[0]), datasets:[{ data: entries.map(e=>e[1]),
      backgroundColor: entries.map(e=> e[1]>=0 ? settings.colorWin : settings.colorLoss), borderRadius:4 }]},
    options: baseBarOpts()
  });
}
function baseLineOpts(){
  return { plugins:{legend:{display:false}}, scales:{
    x:{ grid:{display:false}, ticks:{maxTicksLimit:6, color:CHART_TEXT} },
    y:{ grid:{color:CHART_GRID}, ticks:{color:CHART_TEXT} } } };
}
function baseBarOpts(){
  return { plugins:{legend:{display:false}}, scales:{
    x:{ grid:{display:false}, ticks:{color:CHART_TEXT} },
    y:{ grid:{color:CHART_GRID}, ticks:{color:CHART_TEXT} } } };
}

/* =========================================================
   CALENDAR
   ========================================================= */
function renderCalendar(){
  const y = calCursor.getFullYear(), mo = calCursor.getMonth();
  document.getElementById('calLabel').textContent = calCursor.toLocaleString('default',{month:'long', year:'numeric'});

  const first = new Date(y,mo,1);
  const startOffset = (first.getDay()+6)%7; // Monday-first
  const daysInMonth = new Date(y,mo+1,0).getDate();
  const daysInPrevMonth = new Date(y,mo,0).getDate();

  const byDate = {};
  trades.forEach(t=>{
    if(!byDate[t.date]) byDate[t.date] = [];
    byDate[t.date].push(t);
  });

  let cellsHtml = '';
  const totalCells = Math.ceil((startOffset+daysInMonth)/7)*7;
  for(let i=0;i<totalCells;i++){
    const dayNum = i - startOffset + 1;
    let dateObj, outMonth=false;
    if(dayNum < 1){ dateObj = new Date(y,mo-1,daysInPrevMonth+dayNum); outMonth=true; }
    else if(dayNum > daysInMonth){ dateObj = new Date(y,mo+1,dayNum-daysInMonth); outMonth=true; }
    else { dateObj = new Date(y,mo,dayNum); }
    const iso = dateObj.toISOString().slice(0,10);
    const dayTrades = byDate[iso] || [];
    const netPnl = dayTrades.reduce((s,t)=>s+Number(t.result),0);
    let bg = 'transparent', color='var(--text-2)';
    if(dayTrades.length){
      if(netPnl>0){ bg = hexAlpha(settings.colorWin, 0.16); color = settings.colorWin; }
      else if(netPnl<0){ bg = hexAlpha(settings.colorLoss, 0.16); color = settings.colorLoss; }
      else { bg = hexAlpha(settings.colorBE, 0.16); color = settings.colorBE; }
    }
    cellsHtml += `<div class="cal-cell ${outMonth?'out-month':''} ${dayTrades.length?'has-trades':''}"
      style="background:${dayTrades.length?bg:'var(--panel)'}" data-date="${iso}">
      <div class="cal-date">${dateObj.getDate()}</div>
      ${dayTrades.length ? `<div><div class="cal-pnl" style="color:${color}">${fmtMoney(netPnl)}</div><div class="cal-count">${dayTrades.length} trade${dayTrades.length>1?'s':''}</div></div>` : ''}
    </div>`;
  }
  document.getElementById('calGrid').innerHTML = cellsHtml;

  document.querySelectorAll('.cal-cell.has-trades').forEach(cell=>{
    cell.addEventListener('click', ()=> openDayModal(cell.dataset.date, byDate[cell.dataset.date]));
  });

  // month summary
  const monthTrades = trades.filter(t=>{
    const d = new Date(t.date+'T00:00:00');
    return d.getFullYear()===y && d.getMonth()===mo;
  });
  const m = computeMetrics(monthTrades);
  document.getElementById('calSummary').innerHTML = `
    <div class="mini">Net P&L<b class="${m.netProfit>=0?'pos':'neg'}">${fmtMoney(m.netProfit)}</b></div>
    <div class="mini">Trades<b>${m.n}</b></div>
    <div class="mini">Win rate<b>${fmtPct(m.winRate)}</b></div>
    <div class="mini">Trading days<b>${Object.keys(byDate).filter(d=>{const dd=new Date(d+'T00:00:00'); return dd.getFullYear()===y && dd.getMonth()===mo;}).length}</b></div>
  `;
}
function hexAlpha(hex, alpha){
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${alpha})`;
}
document.getElementById('calPrev').addEventListener('click', ()=>{ calCursor.setMonth(calCursor.getMonth()-1); renderCalendar(); });
document.getElementById('calNext').addEventListener('click', ()=>{ calCursor.setMonth(calCursor.getMonth()+1); renderCalendar(); });

function openDayModal(dateStr, dayTrades){
  document.getElementById('dayModalTitle').textContent = new Date(dateStr+'T00:00:00').toLocaleDateString('default',{weekday:'long', month:'long', day:'numeric', year:'numeric'});
  const rows = dayTrades.map(t=>`
    <div class="day-trade-row" data-id="${t.id}">
      <div class="day-trade-left">
        <div class="pair">${t.pair} <span class="${t.direction==='long'?'dir-long':'dir-short'}">${t.direction.toUpperCase()}</span></div>
        <div class="meta">${t.strategy||'—'} · ${t.session||'—'}</div>
      </div>
      <div class="day-trade-right ${Number(t.result)>=0?'pos':'neg'}">${fmtMoney(t.result)}</div>
    </div>`).join('');
  document.getElementById('dayModalBody').innerHTML = rows;
  document.querySelectorAll('#dayModalBody .day-trade-row').forEach(row=>{
    row.addEventListener('click', ()=>{
      closeModal('dayModalOverlay');
      openTradeModal(trades.find(t=>t.id===row.dataset.id));
    });
  });
  openModal('dayModalOverlay');
}
document.getElementById('closeDayModal').addEventListener('click', ()=>closeModal('dayModalOverlay'));

/* =========================================================
   TRADES TABLE
   ========================================================= */
function renderTradeTable(){
  const search = document.getElementById('tradeSearch').value.toLowerCase();
  let list = sortedByDateTime(trades).reverse();
  if(search){
    list = list.filter(t => [t.pair,t.strategy,t.mistake,t.session].join(' ').toLowerCase().includes(search));
  }
  document.getElementById('tradesEmpty').classList.toggle('hidden', trades.length>0);
  document.getElementById('tradeTableBody').innerHTML = list.map(t=>`
    <tr data-id="${t.id}">
      <td>${t.date}</td>
      <td class="pair-cell">${t.pair}</td>
      <td><span class="${t.direction==='long'?'dir-long':'dir-short'}">${t.direction==='long'?'LONG':'SHORT'}</span></td>
      <td>${t.entry ?? '—'}</td>
      <td>${t.exit ?? '—'}</td>
      <td>${t.lots ?? '—'}</td>
      <td>${t.rr ?? '—'}</td>
      <td class="${Number(t.result)>=0?'pos':'neg'}">${fmtMoney(t.result)}</td>
      <td>${t.session||'—'}</td>
      <td>${t.strategy||'—'}</td>
      <td>›</td>
    </tr>`).join('');
  document.querySelectorAll('#tradeTableBody tr').forEach(row=>{
    row.addEventListener('click', ()=> openTradeModal(trades.find(t=>t.id===row.dataset.id)));
  });
}
document.getElementById('tradeSearch').addEventListener('input', renderTradeTable);

/* =========================================================
   ANALYTICS VIEW
   ========================================================= */
function renderAnalytics(){
  const m = computeMetrics(trades);
  barFromGroup('chartDow', reorderDow(m.byDow));
  barFromGroup('chartHour', sortHours(m.byHour));
  barFromGroup('chartSession', m.bySession);
  barFromGroup('chartStrategy', m.byStrategy);
  barFromGroup('chartMonthly', m.byMonth);
  renderChartByPair(m, 'chartPairDetail', null);
}
function reorderDow(map){
  const order = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const out = {};
  order.forEach(d=>{ if(map[d]) out[d]=map[d]; });
  return out;
}
function sortHours(map){
  const out = {};
  Object.keys(map).sort().forEach(k=>out[k]=map[k]);
  return out;
}
function barFromGroup(canvasId, map){
  destroyChart(canvasId);
  const ctx = document.getElementById(canvasId);
  const entries = Object.entries(map);
  charts[canvasId] = new Chart(ctx, {
    type:'bar',
    data:{ labels: entries.map(e=>e[0]), datasets:[{ data: entries.map(e=>e[1].sum),
      backgroundColor: entries.map(e=> e[1].sum>=0 ? settings.colorWin : settings.colorLoss), borderRadius:4 }]},
    options: baseBarOpts()
  });
}

/* =========================================================
   JOURNAL VIEW
   ========================================================= */
function renderJournal(){
  const followed = groupSum(trades, t=>t.followedPlan==='yes' ? 'Followed plan' : 'Broke plan');
  const emotion = groupSum(trades, t=>t.emotion);
  const confidence = groupSum(trades, t=>t.confidence ? `Level ${t.confidence}` : null);
  const sleepBuckets = groupSum(trades, t=>{
    const s = Number(t.sleep);
    if(!isFinite(s) || t.sleep==='') return null;
    if(s < 5) return '< 5h';
    if(s < 6) return '5–6h';
    if(s < 7) return '6–7h';
    if(s < 8) return '7–8h';
    return '8h+';
  });
  barFromGroup('chartPlan', followed);
  barFromGroup('chartEmotion', emotion);
  barFromGroup('chartConfidence', confidence);
  barFromGroup('chartSleep', sleepBuckets);

  const mistakes = groupSum(trades.filter(t=>t.mistake), t=>t.mistake);
  const chips = Object.entries(mistakes).sort((a,b)=>b[1].count-a[1].count)
    .map(([k,v])=>`<div class="tag-chip">${k}<b>${v.count}×</b></div>`).join('');
  document.getElementById('mistakeList').innerHTML = chips || '<p class="panel-note">No mistakes logged yet — nice, or you haven\'t tagged any.</p>';
}

/* =========================================================
   ADD / EDIT TRADE MODAL
   ========================================================= */
function openModal(id){ document.getElementById(id).classList.remove('hidden'); }
function closeModal(id){ document.getElementById(id).classList.add('hidden'); }

const tradeFieldMap = {
  pair:'fPair', direction:'fDirection', date:'fDate', timeIn:'fTimeIn', timeOut:'fTimeOut',
  session:'fSession', lots:'fLots', entry:'fEntry', exit:'fExit', sl:'fSL', tp:'fTP',
  result:'fResult', rr:'fRR', strategy:'fStrategy', emotion:'fEmotion', confidence:'fConfidence',
  sleep:'fSleep', stress:'fStress', followedPlan:'fFollowedPlan', mistake:'fMistake', reason:'fReason'
};

function openTradeModal(trade){
  const form = document.getElementById('tradeForm');
  form.reset();
  document.getElementById('deleteTradeBtn').style.display = trade ? 'inline-block' : 'none';
  document.getElementById('modalTitle').textContent = trade ? 'Edit trade' : 'Add trade';
  document.getElementById('tradeId').value = trade ? trade.id : '';
  if(trade){
    Object.entries(tradeFieldMap).forEach(([key, elId])=>{
      const el = document.getElementById(elId);
      if(el && trade[key] !== undefined) el.value = trade[key];
    });
  } else {
    document.getElementById('fDate').value = new Date().toISOString().slice(0,10);
  }
  openModal('tradeModalOverlay');
}
document.getElementById('openAddTrade').addEventListener('click', ()=>openTradeModal(null));
document.getElementById('closeModal').addEventListener('click', ()=>closeModal('tradeModalOverlay'));
document.getElementById('cancelTrade').addEventListener('click', ()=>closeModal('tradeModalOverlay'));

document.getElementById('tradeForm').addEventListener('submit', (e)=>{
  e.preventDefault();
  const id = document.getElementById('tradeId').value || uid();
  const trade = { id };
  Object.entries(tradeFieldMap).forEach(([key, elId])=>{
    trade[key] = document.getElementById(elId).value;
  });
  const idx = trades.findIndex(t=>t.id===id);
  if(idx>-1) trades[idx] = trade; else trades.push(trade);
  saveTrades(trades);
  closeModal('tradeModalOverlay');
  refreshCurrentView();
});
document.getElementById('deleteTradeBtn').addEventListener('click', ()=>{
  const id = document.getElementById('tradeId').value;
  if(!id) return;
  if(confirm('Delete this trade? This cannot be undone.')){
    trades = trades.filter(t=>t.id!==id);
    saveTrades(trades);
    closeModal('tradeModalOverlay');
    refreshCurrentView();
  }
});
function refreshCurrentView(){
  const active = document.querySelector('.nav-item.active').dataset.view;
  showView(active);
}

/* =========================================================
   IMPORT — CSV (MT5 export) + JSON (bridge script)
   ========================================================= */
function parseCSV(text){
  const lines = text.split(/\r?\n/).filter(l=>l.trim().length);
  if(!lines.length) return [];
  const splitLine = (line)=>{
    const out = []; let cur=''; let inQ=false;
    for(let i=0;i<line.length;i++){
      const c = line[i];
      if(c==='"'){ inQ=!inQ; continue; }
      if(c===',' && !inQ){ out.push(cur); cur=''; continue; }
      cur+=c;
    }
    out.push(cur);
    return out.map(s=>s.trim());
  };
  const header = splitLine(lines[0]).map(h=>h.toLowerCase());
  const rows = lines.slice(1).map(splitLine);
  return {header, rows};
}
function findCol(header, candidates){
  for(const c of candidates){
    const idx = header.findIndex(h=>h.includes(c));
    if(idx>-1) return idx;
  }
  return -1;
}
function importCSV(text, divisor=1){
  const {header, rows} = parseCSV(text);
  const col = {
    symbol: findCol(header, ['symbol','pair']),
    type: findCol(header, ['type','direction','side']),
    volume: findCol(header, ['volume','lots','size']),
    priceOpen: findCol(header, ['price open','open price','entry']),
    priceClose: findCol(header, ['price close','close price','exit']),
    sl: findCol(header, ['s/l','stop loss','sl']),
    tp: findCol(header, ['t/p','take profit','tp']),
    profit: findCol(header, ['profit','result','p&l','pnl']),
    timeOpen: findCol(header, ['time open','open time','time']),
    timeClose: findCol(header, ['time close','close time']),
    commission: findCol(header, ['commission']),
    swap: findCol(header, ['swap'])
  };
  if(col.symbol===-1 || col.profit===-1){
    return {imported:0, error:'Could not find recognizable symbol/profit columns in this file. Try exporting a detailed CSV from MT5\'s Account History tab.'};
  }
  let imported = 0;
  rows.forEach(r=>{
    if(!r[col.symbol]) return;
    const profit = parseFloat((r[col.profit]||'0').replace(/[^0-9.-]/g,''));
    if(isNaN(profit) && col.profit>-1) return;
    let dateStr='', timeIn='', timeOut='';
    if(col.timeOpen>-1 && r[col.timeOpen]){
      const parts = r[col.timeOpen].split(/[ T]/);
      dateStr = normalizeDate(parts[0]);
      timeIn = (parts[1]||'').slice(0,5);
    }
    if(col.timeClose>-1 && r[col.timeClose]){
      const parts = r[col.timeClose].split(/[ T]/);
      timeOut = (parts[1]||'').slice(0,5);
    }
    const typeRaw = (col.type>-1 ? r[col.type] : '').toLowerCase();
    trades.push({
      id: uid(),
      pair: r[col.symbol],
      direction: typeRaw.includes('sell') || typeRaw.includes('short') ? 'short' : 'long',
      date: dateStr || new Date().toISOString().slice(0,10),
      timeIn, timeOut,
      session:'', lots: col.volume>-1 ? r[col.volume] : '',
      entry: col.priceOpen>-1 ? r[col.priceOpen] : '',
      exit: col.priceClose>-1 ? r[col.priceClose] : '',
      sl: col.sl>-1 ? r[col.sl] : '', tp: col.tp>-1 ? r[col.tp] : '',
      result: (profit || 0) / divisor, rr:'', strategy:'',
      emotion:'', confidence:'', sleep:'', stress:'', followedPlan:'', mistake:'', reason:'Imported from MT5 CSV'
    });
    imported++;
  });
  saveTrades(trades);
  return {imported};
}
function normalizeDate(d){
  if(!d) return '';
  const m = d.match(/(\d{4})[.\-\/](\d{2})[.\-\/](\d{2})/);
  if(m) return `${m[1]}-${m[2]}-${m[3]}`;
  const m2 = d.match(/(\d{2})[.\-\/](\d{2})[.\-\/](\d{4})/);
  if(m2) return `${m2[3]}-${m2[2]}-${m2[1]}`;
  return d;
}

/* ---- PDF import (best-effort: reads the text layer of an MT5 statement PDF) ---- */
if(typeof pdfjsLib !== 'undefined'){
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}
async function extractPdfLines(arrayBuffer){
  const pdf = await pdfjsLib.getDocument({data: arrayBuffer}).promise;
  const lines = [];
  for(let p=1; p<=pdf.numPages; p++){
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const rows = {};
    content.items.forEach(item=>{
      const y = Math.round(item.transform[5]);
      if(!rows[y]) rows[y] = [];
      rows[y].push({x: item.transform[4], str: item.str});
    });
    Object.keys(rows).map(Number).sort((a,b)=>b-a).forEach(y=>{
      const line = rows[y].sort((a,b)=>a.x-b.x).map(i=>i.str).join(' ').replace(/\s+/g,' ').trim();
      if(line) lines.push(line);
    });
  }
  return lines;
}
function parsePdfTradeLines(lines){
  const results = [];

  // Tier 1: strict match against the standard MT5 "Closed Transactions" row layout —
  // posID, type, openDate, openTime, symbol, openPrice, openVol, closeDate, closeTime,
  // closePrice, closeVol, S/L, T/P, commission, taxes, swap, profit.
  // This is the format used by most brokers' MT5 statement export (Exness, IC Markets, XM, etc).
  const strictRe = /^\d+\s+(buy|sell)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)$/i;

  lines.forEach(line=>{
    if(/cancelled/i.test(line)) return; // pending orders that never filled — no P/L
    const m = line.match(strictRe);
    if(!m) return;
    const [, type, openDate, openTime, symbol, openPrice, openVol, closeDate, closeTime, closePrice, , sl, tp, commission, taxes, swap, profit] = m;
    const totalCost = (parseFloat(commission)||0) + (parseFloat(taxes)||0) + (parseFloat(swap)||0);
    results.push({
      date: closeDate, timeIn: openTime.slice(0,5), timeOut: closeTime.slice(0,5),
      pair: symbol.replace(/c$/i,''), // strip cent-account "c" suffix (e.g. AUDUSDc -> AUDUSD)
      direction: type.toLowerCase()==='sell' ? 'short' : 'long',
      lots: openVol, entry: openPrice, exit: closePrice, sl, tp,
      result: (parseFloat(profit)||0) + totalCost
    });
  });
  if(results.length) return results;

  // Tier 2: loose fallback for statements that don't match the exact layout above —
  // just look for a date, a time, buy/sell, a symbol-looking token, and use the last number as profit.
  const dateRe = /(\d{4})[.\-\/](\d{2})[.\-\/](\d{2})/;
  const timeRe = /(\d{2}):(\d{2})(?::\d{2})?/;
  const dirRe = /\b(buy|sell)\b/i;
  const symRe = /\b([A-Z]{5,8}[A-Z0-9.]{0,4})\b/;
  lines.forEach(line=>{
    if(/cancelled/i.test(line)) return;
    if(!dirRe.test(line)) return;
    const dm = line.match(dateRe);
    if(!dm) return;
    const tm = line.match(timeRe);
    const sm = line.match(symRe);
    if(!sm) return;
    const nums = (line.match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
    if(nums.length < 3) return;
    const profit = nums[nums.length-1];
    results.push({
      date: `${dm[1]}-${dm[2]}-${dm[3]}`,
      timeIn: tm ? `${tm[1]}:${tm[2]}` : '',
      pair: sm[1],
      direction: dirRe.exec(line)[1].toLowerCase()==='sell' ? 'short' : 'long',
      result: isNaN(profit) ? 0 : profit
    });
  });
  return results;
}
async function importPDF(arrayBuffer, divisor=1){
  let lines;
  try{ lines = await extractPdfLines(arrayBuffer); }
  catch(e){ return {imported:0, error:'Could not read this PDF — it may be a scanned image rather than a text-based statement.'}; }
  const rows = parsePdfTradeLines(lines);
  if(!rows.length){
    return {imported:0, error:"Couldn't find recognizable trade rows in this PDF. MT5 statement layouts vary by broker, so this is best-effort — if it keeps failing, try exporting as CSV or HTML from MT5's Account History tab instead, which parses more reliably."};
  }
  rows.forEach(r=>{
    trades.push({
      id: uid(), pair: r.pair, direction: r.direction, date: r.date, timeIn: r.timeIn||'', timeOut: r.timeOut||'',
      session:'', lots: r.lots||'', entry: r.entry||'', exit: r.exit||'', sl: r.sl||'', tp: r.tp||'',
      result: r.result / divisor, rr:'', strategy:'',
      emotion:'', confidence:'', sleep:'', stress:'', followedPlan:'', mistake:'', reason:'Imported from MT5 PDF statement'
    });
  });
  saveTrades(trades);
  return {imported: rows.length};
}

function handleImportFile(file){
  const name = file.name.toLowerCase();
  const divisor = document.getElementById('centAccountToggle').checked ? 100 : 1;
  if(name.endsWith('.pdf')){
    const reader = new FileReader();
    reader.onload = async ()=>{
      const summary = document.getElementById('importSummary');
      summary.innerHTML = `<p class="panel-note">Reading PDF…</p>`;
      const res = await importPDF(reader.result, divisor);
      if(res.error){
        summary.innerHTML = `<p class="neg">${res.error}</p>`;
      } else {
        summary.innerHTML = `<p class="pos">Imported ${res.imported} trade${res.imported===1?'':'s'} from the PDF${divisor>1?' (converted from cents)':''}. Double-check them under Trades — PDF parsing is best-effort, so it's worth a quick scan for anything off.</p>`;
        refreshCurrentView();
      }
    };
    reader.readAsArrayBuffer(file);
    return;
  }
  const reader = new FileReader();
  reader.onload = ()=>{
    const text = reader.result;
    let res;
    if(name.endsWith('.json')) res = importJSON(text, divisor);
    else res = importCSV(text, divisor);
    const summary = document.getElementById('importSummary');
    if(res.error){
      summary.innerHTML = `<p class="neg">${res.error}</p>`;
    } else {
      summary.innerHTML = `<p class="pos">Imported ${res.imported} trade${res.imported===1?'':'s'}${divisor>1?' (converted from cents)':''}. Head to Trades or Calendar to see them.</p>`;
      refreshCurrentView();
    }
  };
  reader.readAsText(file);
}

function importJSON(text, divisor=1){
  let data;
  try{ data = JSON.parse(text); }catch(e){ return {imported:0, error:'Invalid JSON file.'}; }
  const list = Array.isArray(data) ? data : (data.trades || []);
  let imported=0;
  list.forEach(item=>{
    trades.push({
      id: uid(),
      pair: item.pair || item.symbol || '',
      direction: (item.direction || item.type || 'long').toLowerCase().includes('sell') ? 'short' : (item.direction||'long'),
      date: item.date || (item.time ? String(item.time).slice(0,10) : new Date().toISOString().slice(0,10)),
      timeIn: item.timeIn || '', timeOut: item.timeOut || '',
      session: item.session || '', lots: item.lots || item.volume || '',
      entry: item.entry || item.priceOpen || '', exit: item.exit || item.priceClose || '',
      sl: item.sl || '', tp: item.tp || '',
      result: Number(item.result ?? item.profit ?? 0) / divisor, rr: item.rr || '',
      strategy: item.strategy || '', emotion: item.emotion || '', confidence: item.confidence || '',
      sleep: item.sleep || '', stress: item.stress || '', followedPlan: item.followedPlan || '',
      mistake: item.mistake || '', reason: item.reason || item.notes || ''
    });
    imported++;
  });
  saveTrades(trades);
  return {imported};
}

document.getElementById('fileInput').addEventListener('change', (e)=>{
  if(e.target.files[0]) handleImportFile(e.target.files[0]);
});
const dropzone = document.getElementById('dropzone');
['dragover','dragenter'].forEach(evt=>dropzone.addEventListener(evt, e=>{ e.preventDefault(); dropzone.style.borderColor='var(--accent)'; }));
['dragleave','drop'].forEach(evt=>dropzone.addEventListener(evt, e=>{ e.preventDefault(); dropzone.style.borderColor='var(--border-strong)'; }));
dropzone.addEventListener('drop', e=>{
  if(e.dataTransfer.files[0]) handleImportFile(e.dataTransfer.files[0]);
});

const MT5_BRIDGE_SCRIPT = `"""
Ledger — MT5 bridge export script
Run locally where MetaTrader 5 is installed and logged in.
Requires: pip install MetaTrader5

Usage:
    python mt5_export.py [days_back]

Produces ledger_export.json in the same folder — import that
file from the Ledger app's Import screen.
"""
import sys, json
from datetime import datetime, timedelta

try:
    import MetaTrader5 as mt5
except ImportError:
    print("Install the MetaTrader5 package first:  pip install MetaTrader5")
    sys.exit(1)

days_back = int(sys.argv[1]) if len(sys.argv) > 1 else 365

if not mt5.initialize():
    print("Could not connect to a running MT5 terminal. Make sure it's open and logged in.")
    sys.exit(1)

from_date = datetime.now() - timedelta(days=days_back)
to_date = datetime.now()

deals = mt5.history_deals_get(from_date, to_date)
trades = []
if deals:
    # group deals by position id so each round-trip trade becomes one entry
    positions = {}
    for d in deals:
        if d.entry not in (0, 1):  # 0 = in, 1 = out
            continue
        positions.setdefault(d.position_id, []).append(d)

    for pos_id, ds in positions.items():
        opens = [d for d in ds if d.entry == 0]
        closes = [d for d in ds if d.entry == 1]
        if not opens or not closes:
            continue
        o, c = opens[0], closes[-1]
        profit = sum(d.profit + d.commission + d.swap for d in ds)
        trades.append({
            "pair": o.symbol,
            "direction": "long" if o.type == 0 else "short",
            "date": datetime.fromtimestamp(o.time).strftime("%Y-%m-%d"),
            "timeIn": datetime.fromtimestamp(o.time).strftime("%H:%M"),
            "timeOut": datetime.fromtimestamp(c.time).strftime("%H:%M"),
            "lots": o.volume,
            "entry": o.price,
            "exit": c.price,
            "result": round(profit, 2),
            "strategy": "",
            "reason": "Imported via mt5_export.py",
        })

mt5.shutdown()

with open("ledger_export.json", "w") as f:
    json.dump(trades, f, indent=2)

print(f"Wrote {len(trades)} trades to ledger_export.json")
`;
document.getElementById('downloadBridge').addEventListener('click', ()=>{
  const blob = new Blob([MT5_BRIDGE_SCRIPT], {type:'text/x-python'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'mt5_export.py';
  a.click();
  URL.revokeObjectURL(url);
});

/* =========================================================
   SETTINGS
   ========================================================= */
function renderSettingsView(){
  document.getElementById('colorWin').value = settings.colorWin;
  document.getElementById('colorLoss').value = settings.colorLoss;
  document.getElementById('colorBE').value = settings.colorBE;
  document.getElementById('startBalance').value = settings.startBalance;
}
['colorWin','colorLoss','colorBE','startBalance'].forEach(id=>{
  document.getElementById(id).addEventListener('change', ()=>{
    settings.colorWin = document.getElementById('colorWin').value;
    settings.colorLoss = document.getElementById('colorLoss').value;
    settings.colorBE = document.getElementById('colorBE').value;
    settings.startBalance = Number(document.getElementById('startBalance').value) || 0;
    saveSettings(settings);
    refreshCurrentView();
  });
});
document.getElementById('exportData').addEventListener('click', ()=>{
  const blob = new Blob([JSON.stringify({trades, settings}, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'ledger_export_' + new Date().toISOString().slice(0,10) + '.json';
  a.click();
  URL.revokeObjectURL(url);
});
document.getElementById('wipeData').addEventListener('click', ()=>{
  if(confirm("Delete every trade you've logged? This cannot be undone.")){
    trades = [];
    saveTrades(trades);
    refreshCurrentView();
  }
});

/* =========================================================
   AUTH
   ========================================================= */
let authMode = 'login'; // 'login' | 'signup'

function showApp(){
  document.getElementById('authOverlay').classList.add('hidden');
  document.getElementById('appRoot').classList.remove('hidden');
  showView('dashboard');
}
function showAuth(){
  document.getElementById('appRoot').classList.add('hidden');
  document.getElementById('authOverlay').classList.remove('hidden');
}
function setAuthError(msg){
  const el = document.getElementById('authError');
  el.textContent = msg || '';
  el.classList.toggle('hidden', !msg);
}

if(document.getElementById('authSwitchBtn')){
  document.getElementById('authSwitchBtn').addEventListener('click', ()=>{
    authMode = authMode === 'login' ? 'signup' : 'login';
    document.getElementById('authTitle').textContent = authMode === 'login' ? 'Log in' : 'Create your account';
    document.getElementById('authSubmit').textContent = authMode === 'login' ? 'Log in' : 'Sign up';
    document.getElementById('authSwitchText').textContent = authMode === 'login' ? "Don't have an account?" : 'Already have an account?';
    document.getElementById('authSwitchBtn').textContent = authMode === 'login' ? 'Sign up' : 'Log in';
    setAuthError('');
  });

  document.getElementById('authForm').addEventListener('submit', async (e)=>{
    e.preventDefault();
    setAuthError('');
    const email = document.getElementById('authEmail').value.trim();
    const password = document.getElementById('authPassword').value;
    const submitBtn = document.getElementById('authSubmit');
    submitBtn.textContent = 'Please wait…'; submitBtn.disabled = true;

    let result;
    if(authMode === 'login'){
      result = await sbClient.auth.signInWithPassword({email, password});
    } else {
      result = await sbClient.auth.signUp({email, password});
    }
    submitBtn.disabled = false;
    submitBtn.textContent = authMode === 'login' ? 'Log in' : 'Sign up';

    if(result.error){
      setAuthError(result.error.message);
      return;
    }
    if(authMode === 'signup' && !result.data.session){
      setAuthError('Check your email to confirm your account, then log in.');
      authMode = 'login';
      document.getElementById('authTitle').textContent = 'Log in';
      document.getElementById('authSubmit').textContent = 'Log in';
      return;
    }
    currentUser = result.data.user;
    await pullFromCloud();
    showApp();
  });

  document.getElementById('signOutBtn').addEventListener('click', async ()=>{
    if(CLOUD_ENABLED) await sbClient.auth.signOut();
    currentUser = null;
    showAuth();
  });
}

/* =========================================================
   INIT
   ========================================================= */
async function init(){
  if(!CLOUD_ENABLED){
    // No Supabase configured — run in local-only mode, same as before.
    document.getElementById('authOverlay').classList.add('hidden');
    document.getElementById('appRoot').classList.remove('hidden');
    document.getElementById('signOutBtn').classList.add('hidden');
    setSyncStatus('Local only — add config.js keys to enable sync');
    showView('dashboard');
    return;
  }
  const {data:{session}} = await sbClient.auth.getSession();
  if(session){
    currentUser = session.user;
    await pullFromCloud();
    showApp();
  } else {
    showAuth();
  }
}
init();