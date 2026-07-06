import assert from 'node:assert/strict';
import test from 'node:test';
import { loadProperties, storeProperties } from '../cxs';
import { KeyframeGate } from '../h264';
import {
  buildTalkbackPacket,
  parsePeerPacket,
  registerPacket,
} from '../p2p';

test('Java properties round-trip CXS metadata', () => {
  const values = {
    CorrelationID: 'LOG-test',
    CX_DSTID: 'myq:test',
    multiline: 'one\ntwo',
  };
  assert.deepEqual(loadProperties(storeProperties(values)), values);
});

test('Java properties comment matches the legacy store format', () => {
  const encoded = storeProperties({ a: 'b' }, 'Mon Jul 06 15:34:38 CDT 2026');
  assert.equal(encoded.toString('latin1'), '#Mon Jul 06 15:34:38 CDT 2026\na=b\n');
});

test('SDNK registration matches recovered packet layout', () => {
  const value = registerPacket('A', 'myq123', '10.0.1.2', 20_000, false);
  assert.equal(value.subarray(0, 4).toString(), 'SDNK');
  assert.equal(value[7], 1);
  assert.equal(value.readUInt32BE(16), value.length - 20);
  assert.equal(value[24], 'A'.charCodeAt(0));
  assert.equal(value.readUInt16BE(45), 20_000);
});

test('peer parser rejects malformed rendezvous packets', () => {
  assert.deepEqual(parsePeerPacket(Buffer.alloc(109)), []);
});

test('talkback packet uses μ-law RTP and exact envelope lengths', () => {
  const audio = Buffer.alloc(160, 0xff);
  const value = buildTalkbackPacket(
    7,
    0x4cf10f81,
    Buffer.from('myq-camera:00:11:22:33:44:55'),
    Buffer.from('1783363097171'),
    audio,
    0x09,
    0,
    0xc3b7,
  );
  assert.equal(value.readUInt32LE(0), 7);
  assert.equal(value[8], 0x80);
  assert.equal(value[9], 0x08);
  assert.equal(value.readUInt16BE(10), 7);
  assert.equal(value.readUInt32BE(16), 0x4cf10f81);
  assert.equal(value.subarray(20, 24).toString(), 'SDNK');
  assert.equal(value.at(-1), 0);
  assert.ok(value.includes(Buffer.alloc(160, 0xff)));
});

test('H264 gate withholds interframes until SPS, PPS and IDR', () => {
  const gate = new KeyframeGate();
  const nal = (type: number): Buffer => Buffer.from([0, 0, 0, 1, type]);
  assert.deepEqual(gate.feed(nal(1)), []);
  assert.deepEqual(gate.feed(nal(7)), []);
  assert.deepEqual(gate.feed(nal(8)), []);
  assert.equal(gate.feed(nal(5)).length, 3);
  assert.equal(gate.feed(nal(1)).length, 1);
});
