;(function(){
const FACTORY_COSTS=Object.freeze({mine:110,smelter:180,workshop:240,power:290,automation:360});
const IDLE_MACHINES=Object.freeze({
 press:{base:15,gps:0,tap:1,name:'Ручной пресс «Крутила»'},
 lathe:{base:50,gps:0.5,name:'Токарный «Вжух-3000»'},
 auto:{base:300,gps:4,name:'Автомат «Гайкомёт»'},
 belt:{base:2000,mult:0.25,name:'Конвейер «Не стой»'},
 gold:{base:12000,gps:30,name:'Премиум «Золотая резьба»'}
});
const CONTRACT_REWARD=520;
const BASE_PRICES=Object.freeze({ore:8,steel:32,parts:92});
function newGame(){return{
 version:2,money:0,lifetime:0,resources:{ore:10,steel:5,parts:0},
 buildings:{mine:1,smelter:1,workshop:0,power:0},
 idleOwned:{press:0,lathe:0,auto:0,belt:0,gold:0},automation:0,
 tickCount:0,productionClock:0,reputation:0,deliveries:0,
 log:['Смена началась: тапай по гайке, чтобы заработать первые гайки.']
};}
function multiplier(s){return 1+0.25*s.idleOwned.belt;}
function tapPower(s){return(1+s.idleOwned.press)*multiplier(s);}
function incomePerSecond(s){const i=s.idleOwned;return(0.5*i.lathe+4*i.auto+30*i.gold)*multiplier(s);}
function getCost(s,type){
 if(IDLE_MACHINES[type])return Math.floor(IDLE_MACHINES[type].base*Math.pow(1.6,s.idleOwned[type]));
 return FACTORY_COSTS[type]||0;
}
function prices(s){
 const day=Math.floor(s.tickCount/24),cycle=[0,.08,-.05,.12,-.08,.03][day%6],phase=Math.sin(s.tickCount/8)*.04;
 return Object.fromEntries(Object.entries(BASE_PRICES).map(([k,v])=>[k,Math.max(1,Math.round(v*(1+cycle+phase)))]));
}
function powerCapacity(s){return 5+s.buildings.power*6;}
function powerDemand(s){const b=s.buildings;return b.mine+b.smelter*2+b.workshop*2;}
function addMoney(s,n){s.money+=n;s.lifetime+=n;}
function productionCycle(s){
 const b=s.buildings;let power=powerCapacity(s),mult=multiplier(s);
 const mines=Math.min(b.mine,power);power-=mines;
 s.resources.ore+=mines*(2+s.automation)*mult;
 const smelters=Math.min(b.smelter,Math.floor(power/2));power-=smelters*2;
 for(let i=0;i<smelters;i++)if(s.resources.ore>=2){s.resources.ore-=2;s.resources.steel+=1*mult;}
 const workshops=Math.min(b.workshop,Math.floor(power/2));
 for(let i=0;i<workshops;i++)if(s.resources.steel>=2){s.resources.steel-=2;s.resources.parts+=1*mult;}
}
function tick(s,seconds=1){
 if(!Number.isFinite(seconds)||seconds<=0)return s;
 const rate=incomePerSecond(s);addMoney(s,rate*seconds);
 s.productionClock+=seconds;s.tickCount+=seconds;
 while(s.productionClock>=2){s.productionClock-=2;productionCycle(s);}
 if(Math.floor(s.tickCount/24)>Math.floor((s.tickCount-seconds)/24)){
  const b=s.buildings,fee=b.mine*2+b.smelter*4+b.workshop*5+b.power*3;
  s.money=Math.max(0,s.money-fee);
  s.log.unshift(`Начался день ${Math.floor(s.tickCount/24)+1}: содержание цехов −${fee} гаек.`);s.log=s.log.slice(0,6);
 }
 return s;
}
function buy(s,type){
 const cost=getCost(s,type);if(!cost||s.money<cost)return false;
 s.money-=cost;
 if(IDLE_MACHINES[type]){
  s.idleOwned[type]++;
  if(IDLE_MACHINES[type].tap)s.log.unshift('Ручной пресс улучшен: сила тапа выросла.');
  else s.log.unshift(`${IDLE_MACHINES[type].name} подключён.`);
 }else if(type==='automation'){s.automation++;s.log.unshift('Контур автоматизации улучшен.');}
 else if(Object.hasOwn(s.buildings,type)){s.buildings[type]++;s.log.unshift(`Построено: ${typeName(type)}.`);}
 else{s.money+=cost;return false;}
 s.log=s.log.slice(0,6);return true;
}
function tap(s){const gain=tapPower(s);addMoney(s,gain);return gain;}
function sell(s,resource,quantity){
 const available=s.resources[resource];
 if(!BASE_PRICES[resource]||!Number.isInteger(quantity)||quantity<1||available<quantity)return false;
 const gain=prices(s)[resource]*quantity;s.resources[resource]-=quantity;addMoney(s,gain);
 s.log.unshift(`Продано ${quantity} ${resourceName(resource)} за ${gain} гаек.`);s.log=s.log.slice(0,6);return true;
}
function sellAll(s,resource){const quantity=Math.floor(s.resources[resource]||0);return quantity?sell(s,resource,quantity):false;}
function contractFor(orderIndex=0){
 if(!Number.isSafeInteger(orderIndex)||orderIndex<0)throw new RangeError('Некорректный номер заказа');
 return{quantity:3+2*orderIndex,reward:CONTRACT_REWARD+420*orderIndex};
}
function deliverContract(s,orderIndex=0){
 const order=contractFor(orderIndex);if(s.resources.parts<order.quantity)return false;
 s.resources.parts-=order.quantity;addMoney(s,order.reward);s.reputation++;s.deliveries++;
 s.log.unshift(`Заказ отгружен: ${order.quantity} деталей, +${order.reward} гаек и +1 репутация.`);s.log=s.log.slice(0,6);return true;
}
function typeName(k){return({mine:'рудник',smelter:'плавильный цех',workshop:'мехцех',power:'электростанция'})[k]||k;}
function resourceName(k){return({ore:'руды',steel:'стали',parts:'деталей'})[k]||k;}
const Game={FACTORY_COSTS,IDLE_MACHINES,CONTRACT_REWARD,BASE_PRICES,newGame,multiplier,tapPower,incomePerSecond,getCost,prices,powerCapacity,powerDemand,tick,buy,tap,sell,sellAll,contractFor,deliverContract};
if(typeof module!=='undefined'&&module.exports)module.exports=Game;
if(typeof window!=='undefined')window.IndustryGame=Game;
})();
