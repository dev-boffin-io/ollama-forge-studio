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
