const $=id=>document.getElementById(id);
const Game=window.IndustryGame;
const SAVE_KEY='gaika-empire-industrial-v02';
const LEAGUE_API_URL=String(window.GAIKA_LEAGUE_API_URL||'').trim().replace(/\/+$/,'');
let soloState=loadState();
let state=soloState;
let running=true;
let leagueMode=false;
let leagueSnapshot=null;
let leagueError='';
let leagueBusy=false;
let leagueJoinPending=false;
let lastLeagueRefresh=0;
let leagueActionRevision=0;
let leagueRefreshSequence=0;
let latestAppliedLeagueRefresh=0;
let actionQueue=Promise.resolve();
let toastTimer;
function loadState(){try{const x=JSON.parse(localStorage.getItem(SAVE_KEY)||'null');if(x&&x.version===2&&x.resources&&x.idleOwned&&x.buildings)return x;}catch(_){}return Game.newGame();}
function save(){if(leagueMode)return;try{localStorage.setItem(SAVE_KEY,JSON.stringify(soloState));}catch(_){}}
function fmt(n,dec=0){if(!Number.isFinite(n))return '0';return n.toLocaleString('ru-RU',{minimumFractionDigits:dec,maximumFractionDigits:dec});}
function cash(n){return `${fmt(n)} гаек`;}
function escapeHTML(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function notify(text){const e=$('toast');e.textContent=text;e.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>e.classList.remove('show'),1800);}
function telegramInitData(){return window.Telegram&&window.Telegram.WebApp?window.Telegram.WebApp.initData||'':'';}
function updateLeaguePanel(){
 const status=$('league-status'),connect=$('league-connect'),exit=$('league-exit'),data=leagueSnapshot;
 if(!LEAGUE_API_URL)status.textContent='Сервер лиги ещё не настроен. Одиночная игра работает как прежде.';
 else if(!telegramInitData())status.textContent='Открой мини-приложение из меню бота в Telegram: лиге нужна подписанная initData.';
 else if(leagueError)status.textContent=`Не удалось подключить лигу: ${leagueError}`;
 else if(leagueMode)status.textContent='Лиговый завод синхронизируется с сервером. Локальные сохранения одиночной игры не меняются.';
 else if(data)status.textContent='Сезон загружен. Войди в лигу, чтобы играть отдельным заводом и попасть в рейтинг.';
 else status.textContent='Подключись, чтобы загрузить сезон и таблицу лидеров.';
 connect.disabled=!LEAGUE_API_URL||!telegramInitData()||leagueBusy||leagueJoinPending||leagueMode;connect.hidden=leagueMode;exit.hidden=!leagueMode;exit.disabled=leagueBusy;
 const board=$('league-board');board.replaceChildren();
 if(!data){$('league-season').textContent='—';$('league-rank').textContent='—';$('league-points').textContent='0';$('league-deliveries').textContent='0';return;}
 const {season,league}=data,days=Math.max(0,Math.ceil((season.endsAt-Date.now())/86400000));
 $('league-season').textContent=`${season.id} UTC · осталось ${fmt(days)} дн.`;
 $('league-rank').textContent=`#${fmt(league.rank)}`;$('league-points').textContent=fmt(league.points);$('league-deliveries').textContent=fmt(league.deliveries);
 if(!league.leaderboard.length){const empty=document.createElement('li');empty.textContent='В этом сезоне пока нет игроков.';board.append(empty);return;}
 for(const entry of league.leaderboard){const row=document.createElement('li');row.textContent=`${fmt(entry.rank)}. ${entry.displayName} — ${fmt(entry.points)} очк. · заказов ${fmt(entry.deliveries)}`;board.append(row);}
}
async function leagueRequest(path,options={}){
 if(!LEAGUE_API_URL)throw new Error('адрес сервера лиги не настроен');
 const initData=telegramInitData();if(!initData)throw new Error('нет Telegram initData — открой игру из бота');
 const headers={...(options.headers||{}),Authorization:`tma ${initData}`};if(options.body)headers['Content-Type']='application/json';
 const response=await fetch(`${LEAGUE_API_URL}${path}`,{...options,headers});let payload={};try{payload=await response.json();}catch(_){}
 if(!response.ok)throw new Error(payload.error||`ошибка сервера (${response.status})`);return payload;
}
async function refreshLeague({join=false}={}){
 if(!LEAGUE_API_URL||!telegramInitData()||leagueBusy||leagueJoinPending){updateLeaguePanel();return null;}
 if(join){leagueJoinPending=true;updateLeaguePanel();}
 const refreshSequence=++leagueRefreshSequence,actionRevision=leagueActionRevision;
 try{leagueError='';const result=await leagueRequest('/api/league/state');
  const isLatestRequest=refreshSequence===leagueRefreshSequence,canApplySnapshot=isLatestRequest&&refreshSequence>=latestAppliedLeagueRefresh;
  if(actionRevision!==leagueActionRevision||!canApplySnapshot)return null;
  latestAppliedLeagueRefresh=refreshSequence;leagueSnapshot=result;lastLeagueRefresh=Date.now();leagueError='';
  if(join){leagueMode=true;state=result.state;running=true;notify('Лиговый завод загружен с сервера');}
  else if(leagueMode)state=result.state;
  updateLeaguePanel();if(leagueMode)render();return result;
 }catch(error){if(actionRevision!==leagueActionRevision||refreshSequence<latestAppliedLeagueRefresh||refreshSequence<leagueRefreshSequence)return null;leagueError=error.message;updateLeaguePanel();if(join)notify(`Лига недоступна: ${error.message}`);return null;}
 finally{if(join){leagueJoinPending=false;updateLeaguePanel();}}
}
function createActionId(){if(window.crypto&&typeof window.crypto.randomUUID==='function')return window.crypto.randomUUID();return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,14)}`;}
function sendLeagueAction(action){
 const task=actionQueue.then(async()=>{if(!leagueMode)return false;leagueActionRevision++;leagueBusy=true;updateLeaguePanel();render();
  try{const result=await leagueRequest('/api/league/action',{method:'POST',body:JSON.stringify({...action,actionId:createActionId()})});
   leagueSnapshot=result;if(leagueMode)state=result.state;leagueError='';lastLeagueRefresh=Date.now();updateLeaguePanel();render();return true;
  }catch(error){leagueError=error.message;updateLeaguePanel();notify(`Действие не принято: ${error.message}`);return false;}
  finally{leagueBusy=false;updateLeaguePanel();render();}
 });actionQueue=task.catch(()=>{});return task;
}
function statusText(){const demand=Game.powerDemand(state),cap=Game.powerCapacity(state);if(demand>cap)return 'СЕТЬ ПЕРЕГРУЖЕНА';if(!state.buildings.workshop)return 'ЛИНИЯ ЖДЁТ МЕХЦЕХ';return 'ЦЕПОЧКА РАБОТАЕТ';}
function render(){
 $('money').textContent=cash(state.money);
 $('rate').textContent=`${fmt(Game.incomePerSecond(state),1)} / сек`;
 $('tapPower').textContent=`+${fmt(Game.tapPower(state),2)} гайки за тап`;
 $('lifetime').textContent=fmt(state.lifetime);
 $('day').textContent=String(Math.floor(state.tickCount/24)+1).padStart(2,'0');
 const capacity=Game.powerCapacity(state),demand=Game.powerDemand(state);
 $('power-label').textContent=`${demand} / ${capacity} МВт`;
 $('power-fill').style.width=`${Math.min(100,demand/capacity*100)}%`;
 $('power-fill').classList.toggle('over',demand>capacity);
 const status=$('status');status.classList.toggle('warn',demand>capacity);status.innerHTML=`<i class="dot"></i>${escapeHTML(statusText())}`;
 const prices=Game.prices(state);
 for(const k of ['ore','steel','parts']){
   $(k).textContent=fmt(state.resources[k],state.resources[k]%1?1:0);
   $(`${k}-price`).textContent=`${prices[k]} гаек / шт`;
   $(`${k}-market`).textContent=fmt(state.resources[k],state.resources[k]%1?1:0);
   $(`${k}-price-market`).textContent=`${prices[k]} гаек`;
 }
 for(const k of ['mine','smelter','workshop','power']){
   const count=state.buildings[k];
   const main=$(k==='mine'?'mine-count':k==='smelter'?'smelter-count':k==='workshop'?'workshop-count':'power-count');
   if(main)main.textContent=count;
   const copy=$(`${k}-count-copy`);if(copy)copy.textContent=count;
 }
 $('automation-level').textContent=state.automation;
 $('rep').textContent=state.reputation;$('deliveries').textContent=state.deliveries;
 const order=Game.contractFor(leagueMode&&leagueSnapshot?leagueSnapshot.league.deliveries:0);
 $('contract-title').textContent=`Отгрузи ${fmt(order.quantity)} детали`;$('contract-reward').textContent=`+${fmt(order.reward)} гаек`;
 $('contract-button').disabled=state.resources.parts<order.quantity||leagueBusy;
 $('contract-ready').textContent=state.resources.parts>=order.quantity?'ЗАКАЗ ГОТОВ':`Нужно ещё ${fmt(Math.max(0,order.quantity-state.resources.parts),state.resources.parts%1?1:0)} детали`;
 $('log').innerHTML=state.log.map(x=>`<li>${escapeHTML(x)}</li>`).join('');
 document.querySelectorAll('[data-cost]').forEach(btn=>{
   const type=btn.dataset.cost,cost=Game.getCost(state,type);
   btn.disabled=leagueBusy||state.money<cost;
   const c=btn.querySelector('.cost');if(c)c.textContent=cash(cost);
   const count=btn.parentElement.querySelector(`[data-owned="${type}"]`);
   if(count)count.textContent=state.idleOwned[type]||0;
 });
 document.querySelectorAll('[data-sell]').forEach(btn=>{btn.disabled=leagueBusy;});
 $('pause').disabled=leagueMode||leagueBusy;$('reset').disabled=leagueMode||leagueBusy;
 if(!leagueMode)save();
}
function actBuy(type){if(leagueMode)return sendLeagueAction({type:'buy',machine:type});if(!Game.buy(state,type)){notify('Не хватает гаек — тапай, продавай или выполни заказ.');return;}notify('Оборудование запущено');render();}
function actSell(resource,amount){
 if(leagueMode){if(amount==='max')return sendLeagueAction({type:'sellAll',resource});return sendLeagueAction({type:'sell',resource,quantity:Math.min(Number(amount),Math.floor(state.resources[resource]))});}
 const ok=amount==='max'?Game.sellAll(state,resource):Game.sell(state,resource,Math.min(Number(amount),Math.floor(state.resources[resource])));
 if(!ok){notify('Недостаточно запасов на складе');return;}notify('Продажа завершена');render();
}
function setTab(tab){document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('selected',b.dataset.tab===tab));document.querySelectorAll('.panel').forEach(p=>p.classList.toggle('hidden',p.id!==`panel-${tab}`));if(tab==='league')refreshLeague();}
function tap(event){if(leagueMode){sendLeagueAction({type:'tap'});return;}const gain=Game.tap(state);$('money').textContent=cash(state.money);$('lifetime').textContent=fmt(state.lifetime);const area=document.querySelector('.tap-area'),r=area.getBoundingClientRect(),pop=document.createElement('span');pop.className='float';pop.textContent=`+${fmt(gain,2)}`;pop.style.left=`${Math.max(20,Math.min(r.width-90,(event.clientX||r.left+r.width/2)-r.left))}px`;pop.style.top=`${Math.max(18,(event.clientY||r.top+40)-r.top-10)}px`;area.appendChild(pop);setTimeout(()=>pop.remove(),750);save();}
$('bigNut').addEventListener('click',tap);
document.querySelectorAll('[data-cost]').forEach(b=>b.addEventListener('click',()=>actBuy(b.dataset.cost)));
document.querySelectorAll('[data-sell]').forEach(b=>b.addEventListener('click',()=>actSell(b.dataset.sell,b.dataset.amount==='max'?'max':Number(b.dataset.amount))));
document.querySelectorAll('.tab').forEach(b=>b.addEventListener('click',()=>setTab(b.dataset.tab)));
$('contract-button').addEventListener('click',()=>{
 if(leagueMode){sendLeagueAction({type:'deliver'});return;}
 if(Game.deliverContract(state)){notify('Заказ отгружен · репутация +1');render();}
});
$('league-connect').addEventListener('click',()=>refreshLeague({join:true}));
$('league-exit').addEventListener('click',()=>{if(leagueBusy)return;leagueMode=false;state=soloState;running=true;leagueError='';render();updateLeaguePanel();notify('Вернулись к одиночному заводу');});
$('pause').addEventListener('click',()=>{running=!running;$('pause').textContent=running?'Ⅱ ПАУЗА':'▶ СТАРТ';notify(running?'Производство запущено':'Производство остановлено');});
$('reset').addEventListener('click',()=>{if(leagueMode)return;if(confirm('Сбросить прогресс и начать заново?')){soloState=Game.newGame();state=soloState;running=true;render();notify('Новый завод готов');}});
$('help').addEventListener('click',()=>notify('Тапай гайку → покупай автоматы → строй цепочку → продавай или отгружай заказ.'));
render();
updateLeaguePanel();
if(window.Telegram&&window.Telegram.WebApp){const tg=window.Telegram.WebApp;tg.ready();tg.expand();try{tg.setHeaderColor('#111813');tg.setBackgroundColor('#111813');}catch(_){}}
setInterval(()=>{if(leagueMode){if(!leagueBusy&&Date.now()-lastLeagueRefresh>=15000)refreshLeague();return;}if(running){Game.tick(state,1);render();}},1000);
