const test=require('node:test');
const assert=require('node:assert/strict');
const G=require('./game_core.js');

test('tapping the nut adds the current click power to shared currency',()=>{
 const s=G.newGame();assert.equal(G.tap(s),1);assert.equal(s.money,1);
});

test('buying a press improves tapping; buying a lathe adds passive income',()=>{
 const s=G.newGame();s.money=1000;
 assert.equal(G.buy(s,'press'),true);assert.equal(G.tapPower(s),2);
 assert.equal(G.buy(s,'lathe'),true);assert.equal(G.incomePerSecond(s),0.5);
});

test('a lathe pays its idle income on each simulated second',()=>{
 const s=G.newGame();s.money=100;G.buy(s,'lathe');const afterPurchase=s.money;
 G.tick(s,1);assert.equal(s.money,afterPurchase+0.5);
});

test('conveyor multiplier boosts tapping and idle income',()=>{
 const s=G.newGame();s.money=10000;
 assert.equal(G.buy(s,'lathe'),true);assert.equal(G.buy(s,'belt'),true);
 assert.equal(G.tapPower(s),1.25);assert.equal(G.incomePerSecond(s),0.625);
});

test('factory production converts ore into steel on a two-second cycle',()=>{
 const s=G.newGame(), ore=s.resources.ore;
 G.tick(s,2);assert.equal(s.resources.ore,ore);assert.equal(s.resources.steel,6);
});

test('workshop turns steel into parts and a contract pays currency',()=>{
 const s=G.newGame();s.money=1000;assert.equal(G.buy(s,'workshop'),true);
 G.tick(s,2);assert.equal(s.resources.parts,1);
 s.resources.parts=3;const before=s.money;
 assert.equal(G.deliverContract(s),true);assert.equal(s.resources.parts,0);
 assert.equal(s.money,before+G.CONTRACT_REWARD);assert.equal(s.reputation,1);
});

test('league orders follow the published 3/520, 5/940, 7/1360 progression',()=>{
 assert.deepEqual(G.contractFor(0),{quantity:3,reward:520});
 assert.deepEqual(G.contractFor(1),{quantity:5,reward:940});
 assert.deepEqual(G.contractFor(2),{quantity:7,reward:1360});
 const s=G.newGame();s.resources.parts=8;
 assert.equal(G.deliverContract(s,0),true);assert.equal(s.resources.parts,5);assert.equal(s.money,520);
 assert.equal(G.deliverContract(s,1),true);assert.equal(s.resources.parts,0);assert.equal(s.money,1460);
});

test('market sale and insufficient purchase keep inventory and money consistent',()=>{
 const s=G.newGame();s.money=0;assert.equal(G.buy(s,'gold'),false);
 const p=G.prices(s).steel;assert.equal(G.sell(s,'steel',2),true);
 assert.equal(s.resources.steel,3);assert.equal(s.money,p*2);
});
