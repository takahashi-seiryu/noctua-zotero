"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Phone = require("../lib/phonecam.js");

test("only tailnet peers are served", () => {
  for (const ok of ["100.64.0.1", "100.73.132.124", "100.127.255.254", "::ffff:100.125.209.65"]) assert.equal(Phone.isTailnetAddress(ok), true, ok);
  for (const bad of ["100.63.0.1", "100.128.0.1", "192.168.1.5", "10.0.0.2", "8.8.8.8", "", null, "100.73.132", "100.73.132.124.1"]) assert.equal(Phone.isTailnetAddress(bad), false, String(bad));
  assert.equal(Phone.isLoopback("127.0.0.1"), true);
  assert.equal(Phone.isLoopback("192.168.1.5"), false);
});

test("tokens compare exactly", () => {
  assert.equal(Phone.sameToken("abc", "abc"), true);
  assert.equal(Phone.sameToken("abc", "abd"), false);
  assert.equal(Phone.sameToken("abc", "abcd"), false);
  assert.equal(Phone.sameToken(undefined, "abc"), false);
});

test("requests are parsed and routed by token", () => {
  const head = Phone.parseHead("POST /tok/up?name=a.jpg HTTP/1.1\r\nHost: x\r\nContent-Length: 12\r\n\r\n");
  assert.deepEqual([head.method, head.path, head.query, head.headers["content-length"]], ["POST", "/tok/up", "name=a.jpg", "12"]);
  assert.equal(Phone.route(head, "tok").kind, "upload");
  assert.equal(Phone.route(head, "other").kind, "denied");
  assert.equal(Phone.route(Phone.parseHead("GET /tok/ HTTP/1.1\r\n\r\n"), "tok").kind, "page");
  assert.equal(Phone.route(Phone.parseHead("GET /tok/secret HTTP/1.1\r\n\r\n"), "tok").kind, "missing");
  assert.equal(Phone.route(Phone.parseHead("GET / HTTP/1.1\r\n\r\n"), "tok").kind, "denied");
  assert.equal(Phone.route(Phone.parseHead("GET /tok/../x HTTP/1.1\r\n\r\n"), "tok").kind, "missing");
  assert.equal(Phone.parseHead("garbage"), null);
  assert.equal(Phone.parseHead("GET nope HTTP/1.1\r\n\r\n"), null);
});

test("photos are checked, named safely and encoded", () => {
  assert.equal(Phone.isJPEG(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1])), true);
  assert.equal(Phone.isJPEG(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1])), false);
  assert.equal(Phone.isJPEG(new Uint8Array(0)), false);
  assert.equal(Phone.photoName("name=photo-2.jpg", 2), "photo-2.jpg");
  assert.equal(Phone.photoName("name=..%2F..%2Fetc%2Fpasswd", 3), "iphone-photo-3.jpg");
  assert.equal(Phone.photoName("name=%E0%A4%A.jpg", 4), "iphone-photo-4.jpg");
  assert.equal(Phone.photoName("", 1), "iphone-photo-1.jpg");
  for (const text of ["", "f", "fo", "foo", "foob", "fooba", "foobar"]) assert.equal(Phone.base64(Buffer.from(text)), Buffer.from(text).toString("base64"));
  const random = Buffer.from(Array.from({length: 1000}, (_, i) => (i * 37) % 256));
  assert.equal(Phone.base64(random), random.toString("base64"));
});

test("the camera page posts to its own token path", () => {
  const html = Phone.page();
  assert.match(html, /capture="environment"/);
  assert.match(html, /location\.pathname\.split\("\/"\)\[1\]/);
  assert.doesNotMatch(html, /https?:\/\//);
});
