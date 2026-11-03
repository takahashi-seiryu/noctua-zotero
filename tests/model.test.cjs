const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const model = require('../lib/model.js');

test('package declares Zotero-required identity, update URL, and compatibility bounds', () => {
  const manifest=require('../manifest.json');
  const app=manifest.applications.zotero;
  assert.equal(manifest.manifest_version,2);
  assert.equal(app.id,'noctua-notes@noctua.app');
  assert.ok(new URL(app.update_url));
  assert.ok(app.strict_min_version && app.strict_max_version);
});

test('source round-trip retains LaTeX, pressure strokes, and images', () => {
  const doc=model.blank('document-1');
  doc.blocks[0].src='\\section{Control}\n$x_{t+1}=Ax_t+Bu_t$';
  doc.blocks.push({id:'ink1',type:'ink',w:1000,h:.6,strokes:[{c:'#8b85ff',w:2.4,p:[[1,2,.5],[3,4,.8]]}]});
  doc.blocks.push({id:'image1',type:'image',data:'data:image/png;base64,aGVsbG8=',caption:'A diagram'});
  assert.deepEqual(model.parse(JSON.stringify(doc)),doc);
});
test('remote revisions cannot silently overwrite another save', () => {
  const doc=model.blank('x');doc.revision='remote-change';
  assert.throws(()=>model.assertRevision(doc,'old'),{code:'NOCTUA_CONFLICT'});
  assert.doesNotThrow(()=>model.assertRevision(doc,'remote-change'));
});
test('rejects executable or remote image sources, duplicate IDs and non-finite drawing input', () => {
  for(const data of ['https://example.test/image.png','data:image/svg+xml;base64,PHN2Zz4=','javascript:alert(1)']) {
    const doc=model.blank('x');doc.blocks=[{id:'i',type:'image',data,caption:''}];
    assert.throws(()=>model.validate(doc));
  }
  const doc=model.blank('x');doc.blocks.push({...doc.blocks[0]});
  assert.throws(()=>model.validate(doc),/Duplicate/);
  doc.blocks=[{id:'i',type:'ink',w:1000,h:.6,strokes:[{c:'#000000',w:2,p:[[Infinity,0,.5]]}]}];
  assert.throws(()=>model.validate(doc),/point/);
});
test('legacy schema v1 preview keys remain readable migration input', () => {
  const doc=model.blank('legacy');doc.previewNoteKey='ABCD1234';
  assert.equal(model.parse(JSON.stringify(doc)).previewNoteKey,'ABCD1234');
  assert.equal(model.importSource(doc,{id:'new'}).doc.previewNoteKey,null);
  assert.equal(model.preview,undefined);
});
test('original Noctua renderer typesets math and escapes markup and unsafe URLs', () => {
  const context={katex:require('../content/vendor/katex/katex.min.js')};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../content/noctua-latex.js'),'utf8')+'\nthis.renderer=NoctuaLatex;',context);
  const [html]=context.renderer.renderDoc(['\\section{Test}\n$x^2$\n<script>alert(1)</script>\n\\href{javascript:alert(1)}{unsafe}']);
  assert.match(html,/katex/);
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('href="javascript:'));
});

test('imports original Noctua note preserving text, preamble, ink, beside layout and raster assets', () => {
  const original={version:1,id:'n-source',title:'Original',created:123,updated:456,preamble:'\\newcommand{\\R}{\\mathbb{R}}',blocks:[
    {id:'ink',type:'ink',w:1000,h:.6,strokes:[{c:'#000000',w:2,p:[[1,2,.7]]}]},
    {id:'text',type:'text',beside:true,src:'\\includegraphics[width=0.7\\textwidth]{images/diagram-123.png}\n\\cite{paper}'},
  ]};
  const media={'images/diagram-123.png':'data:image/png;base64,aGVsbG8='};
  const {doc,warnings}=model.importSource(JSON.stringify(original),{id:'new-note',media});
  assert.equal(doc.id,'new-note');
  assert.equal(doc.revision,'');
  assert.equal(doc.previewNoteKey,null);
  assert.deepEqual(doc.origin,{id:'n-source',created:123,updated:456});
  assert.deepEqual(doc.blocks,original.blocks);
  assert.deepEqual(doc.media,media);
  assert.deepEqual(model.parse(JSON.stringify(doc)),doc);
  assert.deepEqual(model.mediaPaths(original),Object.keys(media));
  assert.match(warnings.join(' '),/Citation/);
  assert.equal(original.id,'n-source');
});
test('import rejects missing, unsafe or unsupported media instead of losing images', () => {
  const original={version:1,id:'n',title:'Test',blocks:[]};
  const source=src=>({...original,blocks:[{id:'t',type:'text',src}]});
  assert.throws(()=>model.importSource(source('\\includegraphics{images/missing.png}'),{id:'new'}),/Missing image/);
  for (const name of ['../secret.png','images/../../secret.png','https://example.test/a.png','images/figure.svg','/tmp/file.png']) {
    assert.throws(()=>model.mediaPaths(source(`\\includegraphics{${name}}`)),/Unsupported media path/);
  }
  assert.throws(()=>model.mediaPaths(source('\\includevideo{images/video.mp4}')),/Video/);
  assert.deepEqual(model.mediaPaths(source('% \\includegraphics{images/unused.png}\nText')),[]);
  assert.throws(()=>model.importSource({...original,blocks:[{id:'v',type:'video'}]},{id:'new'}),/Unsupported block/);
});
test('imported plugin sources detach identity and preserve inline media', () => {
  const original=model.blank('old');original.revision='old-revision';original.previewNoteKey='ABCD1234';
  original.blocks[0].src='\\includegraphics{images/a.png}';original.media={'images/a.png':'data:image/png;base64,aGVsbG8='};
  const {doc}=model.importSource(original,{id:'new'});
  assert.equal(doc.id,'new');assert.equal(doc.revision,'');assert.equal(doc.previewNoteKey,null);
  assert.deepEqual(doc.media,original.media);assert.equal(original.revision,'old-revision');
});
test('original import reports metadata omissions and validates layouts and media', () => {
  const original={version:1,id:'n',title:'Test',zotero_source:'old-library',blocks:[{id:'t',type:'text',src:'text'}]};
  assert.match(model.importSource(original,{id:'new'}).warnings.join(' '),/zotero_source/);
  assert.throws(()=>model.importSource({...original,version:2},{id:'new'}),/version 1/);
  const doc=model.blank('d');doc.blocks[0].beside='yes';assert.throws(()=>model.validate(doc),/layout/);
  delete doc.blocks[0].beside;
  doc.media={'images/a.png':'https://example.test/a.png'};assert.throws(()=>model.validate(doc),/raster media/);
});
test('original legacy ink width and raster assets in media folder survive migration', () => {
  const original={version:1,id:'legacy',title:'Legacy note',blocks:[
    {id:'ink',type:'ink',h:.6,strokes:[]},
    {id:'text',type:'text',src:'\\includegraphics{media/photo-123.jpg}'}
  ]};
  const media={'media/photo-123.jpg':'data:image/jpeg;base64,aGVsbG8='};
  const {doc}=model.importSource(original,{id:'new',media});
  assert.equal(doc.blocks[0].w,1000);
  assert.deepEqual(doc.media,media);
  assert.deepEqual(model.parse(JSON.stringify(doc)),doc);
  assert.equal(original.blocks[0].w,undefined);
});
