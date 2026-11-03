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
