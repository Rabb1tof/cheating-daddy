const test = require('node:test');
const assert = require('node:assert/strict');
const { resample24kTo16k } = require('../src/utils/pcm');

test('converts 100 ms of 24 kHz mono PCM into 100 ms of 16 kHz mono PCM', () => {
    const input = Buffer.alloc(2400 * 2);
    for (let i = 0; i < 2400; i++) input.writeInt16LE(1000, i * 2);
    const output = resample24kTo16k(input);
    assert.equal(output.length, 1600 * 2);
    for (let i = 0; i < 1600; i++) assert.equal(output.readInt16LE(i * 2), 1000);
});
