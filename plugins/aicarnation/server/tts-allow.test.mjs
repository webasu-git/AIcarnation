import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ttsAllowed } from './tts-allow.mjs'

test('音声の中継は、画面が使う呼び出しだけを通す', () => {
  for (const [method, path] of [
    ['GET', '/version'],
    ['GET', '/speakers'],
    ['POST', '/audio_query'],
    ['POST', '/synthesis'],
    ['GET', '/aivm_models'],
    ['POST', '/aivm_models/install'],
    ['DELETE', '/aivm_models/0123abcd-ef01-2345-6789-abcdef012345/uninstall'],
    ['GET', '/user_dict'],
    ['POST', '/user_dict_word'],
    ['PUT', '/user_dict_word/0123abcd-ef01-2345-6789-abcdef012345'],
    ['DELETE', '/user_dict_word/0123abcd-ef01-2345-6789-abcdef012345'],
  ]) {
    assert.equal(ttsAllowed(method, path), true, `${method} ${path}`)
  }
  for (const [method, path] of [
    ['POST', '/setting'],
    ['GET', '/setting'],
    ['DELETE', '/user_dict'],
    ['POST', '/version'],
    ['GET', '/aivm_models/../setting'],
    ['DELETE', '/aivm_models/x/../../setting/uninstall'],
    ['POST', '/import_user_dict'],
    ['GET', '/'],
  ]) {
    assert.equal(ttsAllowed(method, path), false, `${method} ${path}`)
  }
})
