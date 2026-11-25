'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const attach = require('../lib/attach');

test('extOf: lower-cased extension, empty when none', () => {
  assert.equal(attach.extOf('shot.PNG'), 'png');
  assert.equal(attach.extOf('archive.tar.gz'), 'gz');
  assert.equal(attach.extOf('Makefile'), '');
  assert.equal(attach.extOf('weird.name.v2'), 'v2');
});

test('classify: known kinds by extension', () => {
  assert.equal(attach.classify('a.png', null).kind, 'image');
  assert.equal(attach.classify('a.jpg', null).kind, 'image');
  assert.equal(attach.classify('a.webp', null).kind, 'image');
  assert.equal(attach.classify('doc.pdf', null).kind, 'pdf');
  assert.equal(attach.classify('report.docx', null).kind, 'office');
  assert.equal(attach.classify('sheet.xlsx', null).kind, 'office');
  assert.equal(attach.classify('src.zip', null).kind, 'zip');
  assert.equal(attach.classify('song.mp3', null).kind, 'audio');
  assert.equal(attach.classify('clip.mp4', null).kind, 'video');
  assert.equal(attach.classify('notes.txt', null).kind, 'text');
  assert.equal(attach.classify('README', null).kind, 'text');
  assert.equal(attach.classify('Dockerfile', null).kind, 'text');
});

test('classify: falls back to content sniffing', () => {
  const textHead = Buffer.from('#!/bin/sh\necho hi\n', 'utf8');
  assert.equal(attach.classify('mystery', textHead).kind, 'text');
  assert.equal(attach.classify('mystery.dat', Buffer.from('%PDF-1.7\n...')).kind, 'pdf');
  assert.equal(attach.classify('blob.bin', Buffer.from([0x00, 0xff, 0x00, 0x01])).kind, 'binary');
  assert.equal(attach.classify('empty', Buffer.alloc(0)).kind, 'text');
});

test('ID_RE: attachment ids stay safe', () => {
  assert.ok(attach.ID_RE.test('abc'));
  assert.ok(attach.ID_RE.test('Screenshot-2024-01-01.png'));
  assert.ok(!attach.ID_RE.test('../evil'));
  assert.ok(!attach.ID_RE.test('.hidden'));
  assert.ok(!attach.ID_RE.test(''));
});

test('imageProblem: complete pictures pass, cut-off / mislabelled / foreign files are flagged', () => {
  const { imageProblem } = require('../lib/attach');
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40), Buffer.from('IEND\xaeB`\x82', 'latin1')]);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xda, 0, 2]), Buffer.alloc(40, 1), Buffer.from([0xff, 0xd9])]);
  assert.equal(imageProblem(png, 'image/png'), '');
  assert.equal(imageProblem(jpg, 'image/jpeg'), '');
  assert.match(imageProblem(jpg.subarray(0, 30), 'image/jpeg'), /cut off/);   // SOS present, EOI missing
  assert.match(imageProblem(png.subarray(0, 30), 'image/png'), /cut off/);
  assert.match(imageProblem(png, 'image/jpeg'), /name says/);
  assert.match(imageProblem(Buffer.alloc(64, 7), 'image/png'), /not a PNG/);
  assert.match(imageProblem(Buffer.alloc(4), 'image/png'), /too small/);
});

test('imageProblem: JPEG with data after the end marker (phone screenshots) is fine; cut-off one is not', () => {
  const { imageProblem } = require('../lib/attach');
  const thumb = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2]), Buffer.alloc(8, 3), Buffer.from([0xff, 0xd9])]);   // EXIF thumbnail with its own SOS/EOI
  const main = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 20]), thumb, Buffer.from([0xff, 0xda, 0, 2]), Buffer.alloc(500, 5), Buffer.from([0xff, 0xd9])]);
  const trailer = Buffer.concat([main, Buffer.from('MiMetaData\0'.repeat(30), 'latin1')]);
  assert.equal(imageProblem(main, 'image/jpeg'), '');
  assert.equal(imageProblem(trailer, 'image/jpeg'), '', 'trailing vendor data must not be reported as truncation');
  assert.match(imageProblem(main.subarray(0, main.length - 200), 'image/jpeg'), /cut off/);
});
