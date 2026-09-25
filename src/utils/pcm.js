// Electron captures 24 kHz mono PCM. Gemini Live expects 16 kHz mono PCM.
function resample24kTo16k(pcm) {
    if (!Buffer.isBuffer(pcm) || pcm.length % 2 !== 0) throw new Error('Expected 16-bit mono PCM');
    const inputSamples = pcm.length / 2;
    const outputSamples = Math.floor((inputSamples * 2) / 3);
    const output = Buffer.allocUnsafe(outputSamples * 2);
    for (let i = 0; i < outputSamples; i++) {
        const position = i * 1.5;
        const before = Math.floor(position);
        const after = Math.min(before + 1, inputSamples - 1);
        const fraction = position - before;
        const value = Math.round(pcm.readInt16LE(before * 2) * (1 - fraction) + pcm.readInt16LE(after * 2) * fraction);
        output.writeInt16LE(value, i * 2);
    }
    return output;
}

module.exports = { resample24kTo16k };
