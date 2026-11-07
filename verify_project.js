const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const html=fs.readFileSync('index.html','utf8'),app=fs.readFileSync('app.js','utf8');
assert(!html.includes('__CORE__')&&!html.includes('__APP__'));
const ids=new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]));
const refs=new Set([...app.matchAll(/\$\('([^']+)'\)/g)].map(m=>m[1]));
const missing=[...refs].filter(x=>!ids.has(x));assert.deepEqual(missing,[]);
class El{constructor(){this.textContent='';this.innerHTML='';this.disabled=false;this.hidden=false;this.style={};this.dataset={};this.children=[];this.classList={add(){},remove(){},toggle(){}};}addEventListener(){}querySelector(){return new El();}replaceChildren(...items){this.children=items;}append(item){this.children.push(item);}}
const els=new Map(),document={getElementById(id){if(!els.has(id))els.set(id,new El());return els.get(id);},querySelectorAll(){return[];},querySelector(){return new El();},createElement(){return new El();}};
const store=new Map(),sandbox={window:{IndustryGame:require('./game_core.js')},document,localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v)},setInterval(){},setTimeout(){return 1},clearTimeout(){},confirm(){return true},console};
vm.runInNewContext(app,sandbox);
assert.equal(els.get('money').textContent,'0 гаек');assert.equal(els.get('ore').textContent,'10');
console.log(`standalone HTML smoke passed: ${ids.size} IDs, ${refs.size} direct references, app initialized`);
const htmlScripts=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map(m=>m[1].trim()).filter(Boolean);
assert.equal(htmlScripts.length,3);
class ClickEl{constructor(){this.textContent='';this.innerHTML='';this.disabled=false;this.hidden=false;this.style={};this.dataset={};this.handlers={};this.children=[];this.classList={add(){},remove(){},toggle(){}};}addEventListener(type,fn){this.handlers[type]=fn;}querySelector(){return new ClickEl();}getBoundingClientRect(){return{left:0,top:0,width:300,height:100};}appendChild(){}replaceChildren(...items){this.children=items;}append(item){this.children.push(item);}}
const clickEls=new Map(),tapArea=new ClickEl();
const clickDoc={getElementById(id){if(!clickEls.has(id))clickEls.set(id,new ClickEl());return clickEls.get(id);},querySelectorAll(){return[];},querySelector(sel){return sel==='.tap-area'?tapArea:new ClickEl();},createElement(){return new ClickEl();}};
const shared={window:{},document:clickDoc,localStorage:{getItem(){return null;},setItem(){}},setInterval(){},setTimeout(){return 1;},clearTimeout(){},confirm(){return true;},console};
const sharedCtx=vm.createContext(shared);for(const script of htmlScripts)vm.runInContext(script,sharedCtx);
assert.equal(clickEls.get('money').textContent,'0 гаек');clickEls.get('bigNut').handlers.click({clientX:100,clientY:40});
assert.equal(clickEls.get('money').textContent,'1 гаек','nut click must update balance');
assert.equal(clickEls.get('lifetime').textContent,'1','tap must update lifetime');
console.log('combined-script click regression passed');
