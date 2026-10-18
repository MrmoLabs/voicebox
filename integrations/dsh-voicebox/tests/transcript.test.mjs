import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTranscript } from '../src/listening.js';

test('Chinese transcription defaults to simplified without rewriting names, numbers or ambiguous phrases', () => {
  const source = '請讓 Voicebox 1.7B 將語音辨識結果傳給 AI；頭髮、乾燥與乾坤。';
  const simplified = '请让 Voicebox 1.7B 将语音辨识结果传给 AI；头发、干燥与乾坤。';
  assert.equal(normalizeTranscript(source, {}), simplified);
  assert.equal(normalizeTranscript(simplified, {}), simplified);
  assert.equal(normalizeTranscript('', {}), '');
  assert.equal(normalizeTranscript('API request_id=42', {}), 'API request_id=42');
});

test('original script and non-Chinese recognition preserve their exact text', () => {
  const text = '圖書館の東京語音辨識';
  for (const config of [
    { recognitionLanguage: 'zh', recognitionScript: 'original' },
    { recognitionLanguage: 'ja', recognitionScript: 'simplified' },
    { recognitionLanguage: '', recognitionScript: 'simplified' },
  ]) assert.equal(normalizeTranscript(text, config), text);
});
