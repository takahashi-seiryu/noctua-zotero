const {test}=require('node:test');
const assert=require('node:assert/strict');
const refs=require('../lib/references.js');

test('citation aliases resolve without shadowing canonical Zotero keys',()=>{
  const index=refs.index([
    {key:'ABCD1234',title:'Engine',creators:['Ada Lovelace','Charles Babbage'],year:1843,citeKeys:['engine'],extra:'Citation Key: lovelace1843\ncitationKey: another'},
    {key:'engine',title:'Canonical item',creators:[],year:null}
  ]);
  assert.equal(index.resolve('engine').title,'Canonical item');
  assert.equal(index.resolve('lovelace1843').key,'ABCD1234');
  assert.equal(index.resolve('another').key,'ABCD1234');
  assert.equal(index.resolve('missing'),null);
  assert.match(index.renderCitation(['lovelace1843']),/Lovelace and Babbage 1843/);
  assert.match(index.renderCitation(['lovelace1843']),/data-noctua-cite="ABCD1234"/);
});

test('author-year output matches Noctua textual and parenthetical citations',()=>{
  const index=refs.index([{key:'A',title:'Study',creators:['A Smith','B Jones','C White'],year:2024}]);
  assert.match(index.renderCitation(['A'],{textual:true,note:'p. 2'}),/>Smith et al\. \(2024, p\. 2\)<\/a>/);
  assert.match(index.renderCitation(['A'],{note:'p. 2'}),/^\(.*Smith et al\. 2024.*?, p\. 2\)$/);
  assert.match(index.renderCitation(['unknown']),/unknown\?/);
});

test('bibliography sorts by author and deduplicates aliases',()=>{
  const index=refs.index([
    {key:'B',title:'Second',creators:['Z Zulu'],year:2024},
    {key:'A',title:'First',creators:['A Alpha'],year:2023,citeKeys:['alias']}
  ]);
  const html=index.references(['B','alias','A','missing','missing']);
  assert.equal((html.match(/<li/g)||[]).length,3);
  assert.ok(html.indexOf('First')<html.indexOf('Second'));
  assert.match(html,/missing.*not in My Library/);
  assert.equal(index.references([]),'');
});

test('hostile metadata, aliases and citation notes stay escaped',()=>{
  const index=refs.index([{key:'A"<',title:'<script>alert(1)</script>',creators:['<img>'],year:'<b>',citeKeys:['x']}]);
  for(const html of [index.renderCitation(['x','<iframe>'],{note:'<svg>'}),index.references(['x','<iframe>'])]) {
    assert.ok(!html.includes('<script>'));
    assert.ok(!html.includes('<img>'));
    assert.ok(!html.includes('<iframe>'));
    assert.match(html,/&lt;/);
  }
  assert.match(index.renderCitation(['x']),/data-noctua-cite="A&quot;&lt;"/);
});

test("search ranks citation keys, authors, years and titles, requires every word and prefers newer ties",()=>{
  const index=refs.index([
    {key:"AAA111",title:"Learning World Models from Pixels",creators:[{firstName:"Yann",lastName:"LeCun"}],year:2025,extra:"Citation Key: lecun2025world"},
    {key:"BBB222",title:"Order-Embeddings of Images and Language",creators:[{firstName:"Ivan",lastName:"Vendrov"}],year:2016},
    {key:"CCC333",title:"World Models",creators:[{firstName:"David",lastName:"Ha"}],year:2018}]);
  assert.deepEqual(index.search("").map(i=>i.key),["AAA111","CCC333","BBB222"]);
  assert.deepEqual(index.search("lecun").map(i=>i.key),["AAA111"]);
  assert.deepEqual(index.search("lecun2025").map(i=>i.key),["AAA111"]);
  assert.deepEqual(index.search("world models").map(i=>i.key),["AAA111","CCC333"]);
  assert.deepEqual(index.search("vend 2016").map(i=>i.key),["BBB222"]);
  assert.deepEqual(index.search("ord emb lang").map(i=>i.key),["BBB222"]);
  assert.deepEqual(index.search("pixels 2016"),[]);
  assert.equal(index.search("",2).length,2);
});
