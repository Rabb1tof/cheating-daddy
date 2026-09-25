const HEADER = 'Recent completed answers from this session (use only when relevant):\n';

function clipUtf8(value, maxBytes) {
    const text = String(value || '').trim();
    if (maxBytes <= 0) return '';
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
    const suffix = '…';
    const available = maxBytes - Buffer.byteLength(suffix, 'utf8');
    if (available <= 0) return '';
    let clipped = '';
    let bytes = 0;
    for (const char of text) {
        const size = Buffer.byteLength(char, 'utf8');
        if (bytes + size > available) break;
        clipped += char;
        bytes += size;
    }
    return clipped.trimEnd() + suffix;
}

function buildRecentAnswerContext(conversationHistory = [], screenAnalysisHistory = [], maxBytes = 1800, maxTurns = 3) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 160 || !Number.isSafeInteger(maxTurns) || maxTurns < 1) return '';
    const turns = [
        ...conversationHistory.map(turn => ({
            timestamp: turn.timestamp,
            question: turn.transcription,
            answer: turn.ai_response,
            source: 'Question',
        })),
        ...screenAnalysisHistory.map(turn => ({ timestamp: turn.timestamp, question: turn.prompt, answer: turn.response, source: 'Screenshot' })),
    ]
        .filter(turn => typeof turn.question === 'string' && turn.question.trim() && typeof turn.answer === 'string' && turn.answer.trim())
        .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0))
        .slice(0, maxTurns)
        .reverse();
    if (!turns.length) return '';

    const availablePerTurn = Math.floor((maxBytes - Buffer.byteLength(HEADER, 'utf8')) / turns.length);
    const lines = turns.map(turn => {
        const labels = `${turn.source}: \nAnswer: \n`;
        const contentBytes = availablePerTurn - Buffer.byteLength(labels, 'utf8') - 2;
        const questionBytes = Math.min(240, Math.floor(contentBytes / 4));
        return `${turn.source}: ${clipUtf8(turn.question, questionBytes)}\nAnswer: ${clipUtf8(turn.answer, contentBytes - questionBytes)}`;
    });
    const context = HEADER + lines.join('\n\n');
    return Buffer.byteLength(context, 'utf8') <= maxBytes ? context : clipUtf8(context, maxBytes);
}

module.exports = { buildRecentAnswerContext };
